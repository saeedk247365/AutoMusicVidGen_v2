/**
 * Character cutout + scene composite.
 *
 * Primary path: rembg (ML) on a studio plate, then paste onto an UNTOUCHED
 * empty scene. Never inpaint/rewrite the room.
 */
import sharp from "sharp";
import { spawn } from "child_process";
import { mkdtemp, readFile, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { dirname } from "path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, "..");
const REMBG_SCRIPT = join(ROOT, "pipelines", "rembg-cutout.py");

/** Studio plate backdrop — gray, not chroma (clothes can be mint green). */
export const STUDIO_BG_PROMPT =
  "plain solid seamless light gray backdrop #BEBEBE only, completely flat empty void background, NO floor, NO walls, NO room, NO furniture, NO props, NO pedestal, NO lines, NO neon, feet planted at bottom of frame, grounded full-body silhouette, no floating";

export const STUDIO_BG_NEGATIVE =
  "room, interior, exterior, furniture, plants, pots, boxes, cardboard, desk, table, chair, bed, floor, floorboards, floor tiles, ceiling, wall, baseboard, trim, light fixture, neon strips, scenery, window, door, kitchen, bedroom, lawn, outdoor, house, pedestal, platform, cube, geometry, green screen, chroma key, magenta background, pink screen, textured backdrop, environment, second person, perspective lines";

/**
 * Per-location layout so a toddler matches furniture scale and stands on clear floor.
 * scale = fraction of canvas height occupied by character.
 */
export const LOCATION_LAYOUT = {
  kitchen: {
    scale: 0.4,
    bottomPad: 0.1,
    slotBias: "center",
    shadow: "indoor",
    note: "open foreground floor, sink visible mid-left",
  },
  kitchen_sink: {
    scale: 0.44,
    bottomPad: 0.14,
    slotBias: "center",
    shadow: "indoor",
    note: "closer to sink — toddler near counter",
  },
  dining_room: {
    scale: 0.4,
    bottomPad: 0.1,
    slotBias: "center",
    shadow: "indoor",
  },
  bedroom: {
    scale: 0.38,
    bottomPad: 0.12,
    slotBias: "center",
    shadow: "indoor",
  },
  home: {
    scale: 0.4,
    bottomPad: 0.1,
    slotBias: "center",
    shadow: "indoor",
  },
  doorway: {
    scale: 0.4,
    bottomPad: 0.1,
    slotBias: "center",
    shadow: "indoor",
    note: "threshold bridge between rooms",
  },
  hallway: {
    scale: 0.4,
    bottomPad: 0.1,
    slotBias: "center",
    shadow: "indoor",
    note: "short connector bridge",
  },
  lawn: {
    // House dominates frame — keep toddler clearly shorter than the door
    scale: 0.26,
    bottomPad: 0.06,
    slotBias: "center",
    shadow: "outdoor",
  },
  playroom: {
    scale: 0.4,
    bottomPad: 0.1,
    slotBias: "center",
    shadow: "indoor",
    note: "open rug for dance / tidy toys",
  },
  backyard: {
    scale: 0.28,
    bottomPad: 0.06,
    slotBias: "center",
    shadow: "outdoor",
  },
  bathtub: {
    scale: 0.42,
    bottomPad: 0.12,
    slotBias: "center",
    shadow: "indoor",
  },
  porch: {
    scale: 0.34,
    bottomPad: 0.08,
    slotBias: "center",
    shadow: "outdoor",
  },
  living_rug: {
    scale: 0.42,
    bottomPad: 0.12,
    slotBias: "center",
    shadow: "indoor",
    note: "close rug dance / sit with mom",
  },
  default: {
    scale: 0.38,
    bottomPad: 0.09,
    slotBias: "center",
    shadow: "indoor",
  },
};

export function resolveCharacterLayout({
  location,
  camera,
  pose,
  slot,
  depth,
  role,
  cameraMotion,
  proximity,
} = {}) {
  const base = LOCATION_LAYOUT[location] || LOCATION_LAYOUT.default;
  let scale = base.scale;
  let bottomPad = base.bottomPad;
  const cam = String(camera || "full_body").toLowerCase();
  const poseId = String(pose || "stand").toLowerCase();
  const outdoor = (base.shadow || "indoor") === "outdoor";
  const d = String(depth || "mid").toLowerCase();
  const isMom = String(role || "").toLowerCase() === "mom";
  const camMot = String(cameraMotion || "").toLowerCase();
  const prox = String(proximity || "apart").toLowerCase();

  // Mom slightly taller than toddler (1.25×) — avoid giant floating Mom
  if (isMom) scale = scale * 1.25;

  // Mild camera framing — never jump to near-fullscreen
  if (cam === "close" || cam === "portrait" || camMot === "push_in" || camMot === "lower") {
    scale *= 1.08;
    bottomPad = Math.max(0.08, bottomPad - 0.02);
  } else if (cam === "medium") {
    scale *= 1.04;
  } else if (cam === "medium_full") {
    scale *= 1.02;
  }

  if (/sit|kneel|crouch|crawl/.test(poseId)) {
    scale *= 0.82;
    bottomPad = Math.max(bottomPad, 0.1);
  }

  // Soft depth — keep kids-hit characters in a stable play-lane band
  if (d === "near") {
    bottomPad = Math.max(0.06, bottomPad - 0.02);
    scale *= 1.04;
  } else if (d === "far") {
    bottomPad = Math.min(0.16, bottomPad + 0.03);
    scale *= 0.96;
  }

  if (prox === "near" || prox === "close" || prox === "contact") {
    bottomPad = Math.max(0.08, Math.min(0.12, bottomPad));
  }

  bottomPad = Math.max(0.04, bottomPad - 0.01);

  // Hard kids-hit scale bands (fraction of canvas height)
  const minScale = outdoor ? 0.28 : 0.4;
  const maxScale = outdoor
    ? isMom
      ? 0.4
      : 0.34
    : isMom
      ? 0.56
      : 0.48;

  return {
    scale: Math.max(minScale, Math.min(maxScale, scale)),
    bottomPad,
    slot: slot || base.slotBias || "center",
    shadow: base.shadow || "indoor",
    proximity: prox === "close" || prox === "contact" ? "near" : prox,
  };
}

function runPythonRembg(inPath, outPath) {
  return new Promise((resolve, reject) => {
    const child = spawn("py", ["-3", REMBG_SCRIPT, inPath, outPath], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`rembg exited ${code}: ${stderr.slice(-800)}`));
    });
  });
}

/**
 * Remove plate background with ML segmentation (not color keying).
 * Returns RGBA PNG buffer.
 */
export async function removePlateBackground(inputPathOrBuf) {
  const tmp = await mkdtemp(join(tmpdir(), "amvg-rembg-"));
  const inPath = join(tmp, "in.png");
  const outPath = join(tmp, "out.png");
  try {
    if (Buffer.isBuffer(inputPathOrBuf)) {
      await writeFile(inPath, inputPathOrBuf);
    } else {
      await sharp(inputPathOrBuf).png().toFile(inPath);
    }
    await runPythonRembg(inPath, outPath);
    const cut = await readFile(outPath);

    // Harden alpha + 1px erode to kill rembg white/gray fringe
    const { data, info } = await sharp(cut)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    const src = Buffer.from(data);
    const out = Buffer.from(data);

    for (let i = 0; i < width * height; i++) {
      const a = src[i * channels + 3];
      if (a < 48) out[i * channels + 3] = 0;
      else if (a > 210) out[i * channels + 3] = 255;
    }

    // Erode: any pixel next to transparent becomes transparent (kills halo)
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const o = (y * width + x) * channels;
        if (out[o + 3] === 0) continue;
        let clearN = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const n = ((y + dy) * width + (x + dx)) * channels;
            if (src[n + 3] < 48) clearN++;
          }
        }
        if (clearN >= 2) out[o + 3] = 0;
      }
    }

    const cleaned = await sharp(out, { raw: { width, height, channels } })
      .png()
      .toBuffer();

    return trimToOpaqueBounds(cleaned, 1);
  } finally {
    try {
      await rm(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export async function trimToOpaqueBounds(pngBuf, pad = 2) {
  const { data, info } = await sharp(pngBuf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * channels + 3] > 0) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) {
    return sharp({
      create: {
        width: 1,
        height: 1,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();
  }

  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);

  return sharp(pngBuf)
    .extract({
      left: minX,
      top: minY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    })
    .png()
    .toBuffer();
}

/**
 * Horizontal anchor (0–1) for a placement slot.
 * Near keeps a visible gap (kids-safe, no body overlap).
 */
export function slotAnchorX(slot, proximity = "apart") {
  const s = String(slot || "center").toLowerCase();
  const prox = String(proximity || "apart").toLowerCase();
  const leftish = s === "left" || s === "mid_left" || s === "close_left";
  const rightish = s === "right" || s === "mid_right" || s === "close_right";

  // Legacy "close/contact" treated as near — never force body overlap
  if (prox === "close" || prox === "contact" || prox === "near") {
    if (leftish) return 0.34;
    if (rightish) return 0.64;
    return 0.5;
  }
  if (s === "left") return 0.2;
  if (s === "mid_left") return 0.32;
  if (s === "mid_right") return 0.68;
  if (s === "right") return 0.8;
  return 0.5;
}

export async function placeCutout(
  cutoutPng,
  canvasW,
  canvasH,
  slot,
  {
    scale = 0.78,
    bottomPad = 0.03,
    proximity = "apart",
  } = {},
) {
  const meta = await sharp(cutoutPng).metadata();
  if (!meta.width || !meta.height || meta.width < 2 || meta.height < 2) {
    return { input: cutoutPng, left: 0, top: 0, width: 1, height: 1 };
  }

  const targetH = Math.round(canvasH * scale);
  const resized = await sharp(cutoutPng)
    .resize({ height: targetH, fit: "inside", withoutEnlargement: false })
    .png()
    .toBuffer();
  const rMeta = await sharp(resized).metadata();
  const w = rMeta.width || Math.round((meta.width / meta.height) * targetH);
  const h = rMeta.height || targetH;

  const anchor = slotAnchorX(slot, proximity);
  let left = Math.round(anchor * canvasW - w / 2);
  left = Math.max(0, Math.min(canvasW - w, left));
  const top = Math.max(0, Math.round(canvasH * (1 - bottomPad) - h));

  return { input: resized, left, top, width: w, height: h };
}

/**
 * After placing 2+ cutouts: shared floor + optional near spacing.
 * Kids-safe: never force body overlap — keep a visible gap for "near".
 */
export function enforcePairContact(placed, canvasW, canvasH, {
  minOverlapFrac = 0,
  proximity = "near",
} = {}) {
  if (!Array.isArray(placed) || placed.length < 2) return placed;
  const prox = String(proximity || "").toLowerCase();
  if (prox !== "close" && prox !== "contact" && prox !== "near") return placed;

  const sorted = [...placed].sort((a, b) => a.left - b.left);
  const a = sorted[0];
  const b = sorted[sorted.length - 1];
  if (a === b) return placed;

  // Kids-safe gap: ~6% of canvas between silhouettes (no hug overlap)
  const minGap = Math.round(canvasW * 0.06);
  const gap = b.left - (a.left + a.width);
  if (gap < minGap) {
    const need = minGap - gap;
    const shiftA = Math.floor(need / 2);
    const shiftB = need - shiftA;
    a.left = Math.max(0, a.left - shiftA);
    b.left = Math.min(canvasW - b.width, b.left + shiftB);
  }
  void minOverlapFrac;

  // Shared floor plane — same foot line (anti-float Mom)
  const bottomA = a.top + a.height;
  const bottomB = b.top + b.height;
  const floorY = Math.min(
    canvasH - 2,
    Math.max(bottomA, bottomB, Math.round(canvasH * 0.92)),
  );
  a.top = Math.max(0, floorY - a.height);
  b.top = Math.max(0, floorY - b.height);

  return placed;
}

async function softContactShadow(width, height, mode = "indoor") {
  // Stronger contact shadow so cutouts read planted, not stickered
  const opacity = mode === "outdoor" ? 0.38 : 0.34;
  const rx = mode === "outdoor" ? 0.58 : 0.5;
  const ry = mode === "outdoor" ? 0.36 : 0.42;
  const cx = mode === "outdoor" ? "58%" : "50%";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <radialGradient id="g" cx="${cx}" cy="50%" r="50%">
      <stop offset="0%" stop-color="black" stop-opacity="${opacity}"/>
      <stop offset="55%" stop-color="black" stop-opacity="${opacity * 0.4}"/>
      <stop offset="100%" stop-color="black" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <ellipse cx="${width / 2}" cy="${height / 2}" rx="${width * rx}" ry="${height * ry}" fill="url(#g)"/>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Optional fringe cleanup — off by default (classic path unchanged). */
async function featherCutoutEdges(pngBuf) {
  const { data, info } = await sharp(pngBuf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const src = Buffer.from(data);
  const out = Buffer.from(data);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const o = (y * width + x) * channels;
      const a = src[o + 3];
      if (a === 0 || a === 255) continue;
      // Soften semi-transparent fringe
      if (a < 160) out[o + 3] = Math.max(0, a - 40);
    }
  }
  return sharp(out, { raw: { width, height, channels } }).png().toBuffer();
}

async function groundWashOverlay(width, height) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="55%" stop-color="black" stop-opacity="0"/>
      <stop offset="100%" stop-color="black" stop-opacity="0.12"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * Composite RGBA cutouts onto an empty scene. Scene is NEVER regenerated.
 * Optional kids-hit polish: featherEdges, groundWash (default false).
 */
export async function compositeScene(
  scenePath,
  layers,
  {
    width = 768,
    height = 768,
    removeBg = true,
    featherEdges = false,
    groundWash = false,
    proximity = null,
  } = {},
) {
  const base = await sharp(scenePath)
    .resize(width, height, { fit: "cover" })
    .ensureAlpha()
    .png()
    .toBuffer();

  const prox =
    proximity ||
    layers.find((l) => l.proximity)?.proximity ||
    "apart";

  // Dual-cast: lock one floor pad so feet share a ground line
  let sharedBottomPad = null;
  if (layers.length >= 2 && (prox === "close" || prox === "contact" || prox === "near")) {
    sharedBottomPad = Math.max(
      ...layers.map((l) => Number(l.bottomPad ?? 0.1)),
      0.1,
    );
  }

  const placedList = [];
  for (const layer of layers) {
    let cut = layer.buffer;
    if (removeBg !== false && layer.skipRemoveBg !== true) {
      cut = await removePlateBackground(cut);
    } else {
      cut = await trimToOpaqueBounds(
        await sharp(cut).ensureAlpha().png().toBuffer(),
        2,
      );
    }
    if (featherEdges) {
      cut = await featherCutoutEdges(cut);
      cut = await trimToOpaqueBounds(cut, 1);
    }

    const scale = layer.scale ?? (layer.role === "toddler" ? 0.55 : 0.7);
    const bottomPad = sharedBottomPad ?? layer.bottomPad ?? 0.06;
    const layerProx = layer.proximity || prox;

    const placed = await placeCutout(cut, width, height, layer.slot || "center", {
      scale,
      bottomPad,
      proximity: layerProx,
    });
    placedList.push({ ...placed, layer, proximity: layerProx });
  }

  if (placedList.length >= 2) {
    enforcePairContact(placedList, width, height, { proximity: prox });
  }

  const composites = [];
  for (const placed of placedList) {
    const layer = placed.layer;
    const shadowW = Math.max(36, Math.round(placed.width * 0.75));
    const shadowH = Math.max(16, Math.round(placed.height * (layer.shadow === "outdoor" ? 0.07 : 0.065)));
    const shadow = await softContactShadow(
      shadowW,
      shadowH,
      layer.shadow || "indoor",
    );
    const shadowLeft =
      placed.left +
      Math.round((placed.width - shadowW) / 2) +
      (layer.shadow === "outdoor" ? Math.round(shadowW * 0.06) : 0);
    const shadowTop = Math.min(
      height - shadowH - 2,
      placed.top + placed.height - Math.round(shadowH * 0.45),
    );
    composites.push({
      input: shadow,
      left: Math.max(0, shadowLeft),
      top: Math.max(0, shadowTop),
      blend: "multiply",
    });

    let charInput = placed.input;
    if (groundWash) {
      const wash = await groundWashOverlay(placed.width, placed.height);
      charInput = await sharp(placed.input)
        .composite([{ input: wash, blend: "multiply" }])
        .png()
        .toBuffer();
    }

    composites.push({
      input: charInput,
      left: placed.left,
      top: placed.top,
      blend: "over",
    });
  }

  return sharp(base)
    .composite(composites)
    .removeAlpha()
    .png()
    .toBuffer();
}

/** @deprecated */
export async function cutChromaBackground(input) {
  return removePlateBackground(input);
}

/** @deprecated */
export async function cutGrayBackground(input) {
  return removePlateBackground(input);
}

export const CHROMA_KEY_PROMPT = STUDIO_BG_PROMPT;
export const CHROMA_KEY_NEGATIVE = STUDIO_BG_NEGATIVE;
