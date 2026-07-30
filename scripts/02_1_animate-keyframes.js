/**
 * 02_1 — Animate song keyframes with Wan 2.2 I2V (LightX2V 4-step).
 *
 * Reads stills from a family-pipeline song folder:
 *   batches/<date>/<song_slug>/keyframes/*.png
 * Writes clips next to them:
 *   batches/<date>/<song_slug>/clips/<same-stem>.mp4
 *   batches/<date>/<song_slug>/clips/manifest.json
 *
 * Usage:
 *   node scripts/02_1_animate-keyframes.js --song batches/20260729/spin-and-listen
 *   node scripts/02_1_animate-keyframes.js --batch batches/20260729
 *   node scripts/02_1_animate-keyframes.js --song <path> --force --only 01,02
 *
 * Optional:
 *   --comfy http://127.0.0.1:8188
 *   --width 640 --height 1136 --length 49 --fps 16 --steps 4 --cfg 1 --shift 8
 *   --seed 123
 *   --force          overwrite existing clips
 *   --only 01,03     only keyframe filename prefixes / indices
 *
 * Do NOT run while LoRA training is occupying the GPU.
 */
import { mkdir, readFile, writeFile, readdir, stat, copyFile } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname, basename, resolve, extname, relative } from "path";
import { fileURLToPath } from "url";
import {
  COMFY_ROOT,
  parseArgs,
  sleep,
  stripBom,
  comfy,
  uploadImage,
  queueAndWait,
} from "../lib/comfy-client.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { flag, has } = parseArgs();

function songArgPath(songDir) {
  return relative(ROOT, songDir).replace(/\\/g, "/");
}
const MOTION_NEGATIVE =
  "blurry, low quality, morphing face, extra limbs, distorted hands, text, watermark, photorealistic, sudden cut, flicker";

function wanI2VWorkflow(cfg, imageName, motionPrompt, negative, seed) {
  return {
    "1": {
      class_type: "CLIPLoader",
      inputs: {
        clip_name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
        type: "wan",
      },
    },
    "2": {
      class_type: "VAELoader",
      inputs: { vae_name: "wan_2.1_vae.safetensors" },
    },
    "3": {
      class_type: "UNETLoader",
      inputs: {
        unet_name: "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors",
        weight_dtype: "default",
      },
    },
    "4": {
      class_type: "UNETLoader",
      inputs: {
        unet_name: "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors",
        weight_dtype: "default",
      },
    },
    "5": {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: ["3", 0],
        lora_name: "wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors",
        strength_model: 1.0,
      },
    },
    "6": {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: ["4", 0],
        lora_name: "wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors",
        strength_model: 1.0,
      },
    },
    "7": {
      class_type: "ModelSamplingSD3",
      inputs: { model: ["5", 0], shift: cfg.shift },
    },
    "8": {
      class_type: "ModelSamplingSD3",
      inputs: { model: ["6", 0], shift: cfg.shift },
    },
    "9": {
      class_type: "CLIPTextEncode",
      inputs: { text: motionPrompt, clip: ["1", 0] },
    },
    "10": {
      class_type: "CLIPTextEncode",
      inputs: { text: negative, clip: ["1", 0] },
    },
    "11": {
      class_type: "LoadImage",
      inputs: { image: imageName },
    },
    "12": {
      class_type: "ImageScale",
      inputs: {
        image: ["11", 0],
        upscale_method: "lanczos",
        width: cfg.width,
        height: cfg.height,
        crop: "center",
      },
    },
    "13": {
      class_type: "WanImageToVideo",
      inputs: {
        positive: ["9", 0],
        negative: ["10", 0],
        vae: ["2", 0],
        start_image: ["12", 0],
        width: cfg.width,
        height: cfg.height,
        length: cfg.length,
        batch_size: 1,
      },
    },
    "14": {
      class_type: "KSamplerAdvanced",
      inputs: {
        model: ["7", 0],
        add_noise: "enable",
        noise_seed: seed,
        steps: cfg.steps,
        cfg: cfg.cfg,
        sampler_name: "euler",
        scheduler: "simple",
        positive: ["13", 0],
        negative: ["13", 1],
        latent_image: ["13", 2],
        start_at_step: 0,
        end_at_step: Math.floor(cfg.steps / 2),
        return_with_leftover_noise: "enable",
      },
    },
    "15": {
      class_type: "KSamplerAdvanced",
      inputs: {
        model: ["8", 0],
        add_noise: "disable",
        noise_seed: seed,
        steps: cfg.steps,
        cfg: cfg.cfg,
        sampler_name: "euler",
        scheduler: "simple",
        positive: ["13", 0],
        negative: ["13", 1],
        latent_image: ["14", 0],
        start_at_step: Math.floor(cfg.steps / 2),
        end_at_step: 10000,
        return_with_leftover_noise: "disable",
      },
    },
    "16": {
      class_type: "VAEDecode",
      inputs: { samples: ["15", 0], vae: ["2", 0] },
    },
    "17": {
      class_type: "CreateVideo",
      inputs: { images: ["16", 0], fps: cfg.fps },
    },
    "18": {
      class_type: "SaveVideo",
      inputs: {
        video: ["17", 0],
        filename_prefix: `video/${cfg.outName}`,
        format: "mp4",
        codec: "h264",
      },
    },
  };
}

async function findNewestVideo(prefix) {
  const dir = join(COMFY_ROOT, "output", "video");
  if (!existsSync(dir)) return null;
  const files = (await readdir(dir))
    .filter((f) => f.toLowerCase().endsWith(".mp4") && f.includes(prefix))
    .map((f) => join(dir, f));
  if (!files.length) {
    const all = (await readdir(dir))
      .filter((f) => f.toLowerCase().endsWith(".mp4"))
      .map((f) => join(dir, f));
    files.push(...all);
  }
  if (!files.length) return null;
  const withStat = await Promise.all(
    files.map(async (f) => ({ f, m: (await stat(f)).mtimeMs })),
  );
  withStat.sort((a, b) => b.m - a.m);
  return withStat[0].f;
}

function resolveSongDir(raw) {
  if (!raw) return null;
  const abs = raw.match(/^[A-Za-z]:[\\/]/) || raw.startsWith("/") ? raw : join(ROOT, raw);
  return abs;
}

async function listSongDirs(batchOrSong) {
  const abs = resolveSongDir(batchOrSong);
  if (!abs || !existsSync(abs)) throw new Error(`Path not found: ${batchOrSong}`);
  const kf = join(abs, "keyframes");
  if (existsSync(kf)) return [abs];
  const kids = await readdir(abs);
  const songs = [];
  for (const name of kids) {
    const songDir = join(abs, name);
    if (existsSync(join(songDir, "keyframes"))) songs.push(songDir);
  }
  if (!songs.length) {
    throw new Error(`No song folders with keyframes/ under ${abs}`);
  }
  return songs.sort();
}

async function loadActions(songDir) {
  const p = join(songDir, "scenes", "actions.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(stripBom(await readFile(p, "utf8")));
  } catch {
    return null;
  }
}

/** keyframe name: 01_01_intro.png (composite) or legacy 01_01_intro_adam.png */
function parseKeyframeName(stem) {
  // Legacy: N_beatId_charId
  const legacy = /^(\d+)_(.+)_([a-z0-9]+)$/i.exec(stem);
  if (legacy) {
    const charId = legacy[3].toLowerCase();
    // beat ids never end with known cast names alone when composited as N_beatId
    if (/^(tom|adam|sasha)$/i.test(charId)) {
      return { index: legacy[1], beatId: legacy[2], charId };
    }
  }
  // Composite: N_beatId
  const m = /^(\d+)_(.+)$/i.exec(stem);
  if (!m) return { index: stem, beatId: null, charId: null };
  return { index: m[1], beatId: m[2], charId: null };
}

function motionPromptFor(stem, actions) {
  const { beatId, charId } = parseKeyframeName(stem);
  const POSE_MOTION = {
    stand: "standing still, tiny breath sway, arms at sides",
    kneel: "kneeling, slight torso sway",
    wave: "waving one hand gently",
    clap: "clapping hands slowly once or twice",
    walk: "walking in place, short steps",
    sit: "sitting, soft posture shift",
    hands_up: "arms raised, gentle bounce",
    point: "pointing arm held steady with tiny motion",
  };

  let parts = [];
  let location = "";
  let camera = "";
  if (actions?.beats && beatId) {
    const beat = actions.beats.find((b) => b.id === beatId);
    if (beat) {
      location = beat.location || "";
      camera = beat.camera || "";
      const chars = Array.isArray(beat.characters) ? beat.characters : [];
      const selected = charId
        ? chars.filter(
            (c) =>
              typeof c === "object" &&
              String(c.name || "").toLowerCase() === charId,
          )
        : chars.filter((c) => typeof c === "object" && c.name);

      if (selected.length) {
        for (const entry of selected) {
          const poseId = String(entry.pose || "stand")
            .toLowerCase()
            .replace(/[\s-]+/g, "_");
          parts.push(
            `${entry.name}: ${POSE_MOTION[poseId] || POSE_MOTION.stand}`,
          );
        }
      } else {
        // Legacy keyframes[]
        const frames = Array.isArray(beat.keyframes) ? beat.keyframes : [];
        const frame = frames.find(
          (f) => String(f.character || "").toLowerCase() === charId,
        );
        if (frame) {
          const poseId = String(frame.pose || "stand")
            .toLowerCase()
            .replace(/[\s-]+/g, "_");
          parts.push(POSE_MOTION[poseId] || POSE_MOTION.stand);
        }
      }
    }
  }
  if (!parts.length) parts = ["gentle natural motion"];

  return [
    "cartoon family music video still",
    parts.join("; "),
    location ? `in ${location}` : null,
    camera ? camera.replace(/_/g, " ") : null,
    "gentle natural motion, keep pose geometry, soft camera push-in",
    "flat 2D anime cartoon style, keep identity and outfit fixed",
    "no sudden pose changes, no morphing, no extra limbs",
  ]
    .filter(Boolean)
    .join(", ");
}

function passesOnlyFilter(stem, onlySet) {
  if (!onlySet) return true;
  for (const token of onlySet) {
    if (stem === token || stem.startsWith(token) || stem.startsWith(`${token}_`)) {
      return true;
    }
  }
  return false;
}

async function animateSong(songDir, cfg, comfyUrl) {
  const keyframesDir = join(songDir, "keyframes");
  const clipsDir = join(songDir, "clips");
  await mkdir(clipsDir, { recursive: true });

  const actions = await loadActions(songDir);
  const files = (await readdir(keyframesDir))
    .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
    .filter((f) => !/_prepolish\./i.test(f))
    .filter((f) => !/^plates$/i.test(f))
    .sort();

  const onlyRaw = flag("--only", null);
  const onlySet = onlyRaw
    ? new Set(onlyRaw.split(",").map((s) => s.trim()).filter(Boolean))
    : null;

  const manifest = {
    songDir,
    createdAt: new Date().toISOString(),
    wan: {
      width: cfg.width,
      height: cfg.height,
      length: cfg.length,
      fps: cfg.fps,
      steps: cfg.steps,
    },
    clips: [],
  };

  console.log(`\nSong: ${songDir}`);
  console.log(`Keyframes: ${files.length}`);

  if (!files.length) {
    throw new Error(
      `No keyframe images in ${keyframesDir}\n` +
        `Re-run 02_0 for this song (after fixing copyNewestOutput arg order), then retry 02_1.`,
    );
  }

  let n = 0;
  for (const file of files) {
    const stem = basename(file, extname(file));
    if (!passesOnlyFilter(stem, onlySet)) continue;
    n += 1;
    const src = join(keyframesDir, file);
    const dest = join(clipsDir, `${stem}.mp4`);
    const motion = motionPromptFor(stem, actions);

    if (existsSync(dest) && !has("--force")) {
      console.log(`  (${n}) ${stem} reuse`);
      manifest.clips.push({ stem, file: dest, reused: true, motion });
      continue;
    }

    const outName = `kf_${stem}_${Date.now().toString(36)}`.replace(/[^\w.-]+/g, "_");
    console.log(`  (${n}) ${stem} → Wan I2V`);
    console.log(`      motion: ${motion.slice(0, 140)}…`);

    const buf = await readFile(src);
    const uploaded = await uploadImage(comfyUrl, `family_kf_${stem}.png`, buf);
    const seed = flag("--seed")
      ? Number(flag("--seed")) + n
      : (Date.now() + n * 17) >>> 0;

    await queueAndWait(
      comfyUrl,
      wanI2VWorkflow(
        { ...cfg, outName },
        uploaded.name,
        motion,
        MOTION_NEGATIVE,
        seed,
      ),
      900000,
      stem,
    );

    await sleep(800);
    const videoPath = await findNewestVideo(outName);
    if (!videoPath) {
      throw new Error(`No Wan output found for ${stem} (prefix ${outName})`);
    }
    await copyFile(videoPath, dest);
    console.log(`      → ${dest}`);
    manifest.clips.push({
      stem,
      file: dest,
      reused: false,
      motion,
      seed,
      comfySource: videoPath,
    });
  }

  const manPath = join(clipsDir, "manifest.json");
  await writeFile(manPath, JSON.stringify(manifest, null, 2), "utf8");
  console.log(`  clips manifest: ${manPath}`);
  return manifest;
}

async function main() {
  const songArg = flag("--song", null);
  const batchArg = flag("--batch", null);
  if (!songArg && !batchArg) {
    throw new Error(
      "Pass --song batches/<date>/<slug> or --batch batches/<date>",
    );
  }

  let length = Number(flag("--length", "49"));
  if ((length - 1) % 4 !== 0) {
    length = Math.max(1, Math.round((length - 1) / 4) * 4 + 1);
  }

  const cfg = {
    width: Number(flag("--width", "640")),
    height: Number(flag("--height", "1136")),
    length,
    steps: Number(flag("--steps", "4")),
    cfg: Number(flag("--cfg", "1")),
    shift: Number(flag("--shift", "8")),
    fps: Number(flag("--fps", "16")),
  };

  const comfyUrl = flag("--comfy", "http://127.0.0.1:8188");
  console.log("02_1 Animate keyframes — Wan 2.2 I2V");
  console.log(
    `  ${cfg.width}x${cfg.height} length=${cfg.length} fps=${cfg.fps} steps=${cfg.steps}`,
  );

  await comfy(comfyUrl, "/system_stats");

  const targets = await listSongDirs(songArg || batchArg);
  for (const songDir of targets) {
    await animateSong(songDir, cfg, comfyUrl);
  }

  console.log("\n────────────────────────────────────────────────────────");
  console.log(" Next — stitch clips + song → final.mp4:");
  for (const songDir of targets) {
    console.log(
      `  node scripts/02_2_stitch-song.js --song ${songArgPath(songDir)}`,
    );
  }
  if (targets.length > 1 && batchArg) {
    const batchRel = relative(ROOT, resolveSongDir(batchArg)).replace(/\\/g, "/");
    console.log(" Or stitch the whole batch:");
    console.log(`  node scripts/02_2_stitch-song.js --batch ${batchRel}`);
  }
  console.log("────────────────────────────────────────────────────────");
}

main().catch((err) => {
  console.error("\nFailed:", err.message || err);
  process.exit(1);
});
