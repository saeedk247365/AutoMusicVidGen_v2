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
  "plain solid seamless light gray backdrop #BEBEBE only, completely flat empty void background, NO floor, NO walls, NO room, NO furniture, NO props, NO pedestal, NO lines, NO neon, character floating on blank gray";

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
    note: "open foreground floor, table pushed back",
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
  lawn: {
    // House dominates frame — keep toddler clearly shorter than the door
    scale: 0.26,
    bottomPad: 0.06,
    slotBias: "center",
    shadow: "outdoor",
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
} = {}) {
  const base = LOCATION_LAYOUT[location] || LOCATION_LAYOUT.default;
  let scale = base.scale;
  let bottomPad = base.bottomPad;
  const cam = String(camera || "full_body").toLowerCase();
  const poseId = String(pose || "stand").toLowerCase();
  const outdoor = (base.shadow || "indoor") === "outdoor";

  if (cam === "close" || cam === "portrait") {
    scale = Math.min(outdoor ? 0.34 : 0.46, scale * 1.12);
    bottomPad = Math.max(0.12, bottomPad);
  } else if (cam === "medium") {
    scale = Math.min(outdoor ? 0.3 : 0.44, scale * 1.06);
  } else if (cam === "medium_full") {
    scale = Math.min(outdoor ? 0.28 : 0.42, scale * 1.04);
  }

  // Crouch/sit cutouts are already short vs standing height
  if (/sit|kneel|crouch|crawl/.test(poseId)) {
    scale *= 0.72;
    bottomPad = Math.max(bottomPad, 0.14);
  }

  const outSlot = slot || base.slotBias || "center";

  return {
    scale: Math.max(0.2, Math.min(outdoor ? 0.34 : 0.46, scale)),
    bottomPad,
    slot: outSlot,
    shadow: base.shadow || "indoor",
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

export async function placeCutout(
  cutoutPng,
  canvasW,
  canvasH,
  slot,
  {
    scale = 0.78,
    bottomPad = 0.03,
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

  let left;
  if (slot === "left") left = Math.round(canvasW * 0.08);
  else if (slot === "right") left = Math.round(canvasW * 0.92 - w);
  else left = Math.round((canvasW - w) / 2);

  left = Math.max(0, Math.min(canvasW - w, left));
  const top = Math.max(0, Math.round(canvasH * (1 - bottomPad) - h));

  return { input: resized, left, top, width: w, height: h };
}

async function softContactShadow(width, height, mode = "indoor") {
  // Outdoor: slightly longer/softer cast; indoor: tight oval under feet
  const opacity = mode === "outdoor" ? 0.28 : 0.22;
  const rx = mode === "outdoor" ? 0.55 : 0.45;
  const ry = mode === "outdoor" ? 0.32 : 0.38;
  const cx = mode === "outdoor" ? "58%" : "50%";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <radialGradient id="g" cx="${cx}" cy="50%" r="50%">
      <stop offset="0%" stop-color="black" stop-opacity="${opacity}"/>
      <stop offset="55%" stop-color="black" stop-opacity="${opacity * 0.35}"/>
      <stop offset="100%" stop-color="black" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <ellipse cx="${width / 2}" cy="${height / 2}" rx="${width * rx}" ry="${height * ry}" fill="url(#g)"/>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * Composite RGBA cutouts onto an empty scene. Scene is NEVER regenerated.
 */
export async function compositeScene(
  scenePath,
  layers,
  {
    width = 768,
    height = 768,
    removeBg = true,
  } = {},
) {
  const base = await sharp(scenePath)
    .resize(width, height, { fit: "cover" })
    .ensureAlpha()
    .png()
    .toBuffer();

  const composites = [];
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

    const scale = layer.scale ?? (layer.role === "toddler" ? 0.55 : 0.7);
    const bottomPad = layer.bottomPad ?? 0.06;

    const placed = await placeCutout(cut, width, height, layer.slot || "center", {
      scale,
      bottomPad,
    });

    const shadowW = Math.max(28, Math.round(placed.width * 0.65));
    const shadowH = Math.max(12, Math.round(placed.height * (layer.shadow === "outdoor" ? 0.05 : 0.045)));
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

    composites.push({
      input: placed.input,
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
