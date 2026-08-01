import { mkdir, readFile, writeFile, copyFile, readdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import { platform } from "os";
import { randomUUID } from "crypto";

/**
 * Scene video: Tom LoRA still in a real environment → Wan 2.2 I2V.
 * Not a plain gray studio background.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHAR_PATH = join(ROOT, "characters", "tomchr.json");
const OUT_DIR = join(ROOT, "videos");
const COMFY_ROOT = join(ROOT, "ComfyUI");

const STYLE =
  "flat 2D anime cartoon illustration, clean cel shading, simple bold lineart, cinematic composition, detailed background environment";

/** Preset scenes: still framing + motion for Wan */
const SCENES = {
  park: {
    still:
      "sunny public park, green grass, trees, walking path, wooden bench, distant playground, blue sky with soft clouds, warm daylight",
    pose: "standing on the path, slight smile, looking toward camera, full body in frame, environment visible around him",
    motion:
      "cartoon boy standing in a sunny park, gentle breeze moving hair and leaves, soft camera push-in, birds flying in distant sky, natural ambient motion, flat 2D anime",
  },
  street: {
    still:
      "busy city street sidewalk, storefronts, street lamps, crosswalk, parked cars, afternoon sunlight, urban buildings",
    pose: "walking along the sidewalk toward camera, mid-stride, city street filling the background, full body",
    motion:
      "cartoon boy walking down a city street, natural walking motion, cars and people softly moving in background, camera tracks forward, flat 2D anime",
  },
  beach: {
    still:
      "sandy beach shoreline, ocean waves, blue sky, seagulls, distant pier, bright sunny day, sparkling water",
    pose: "standing on the sand near the water, looking at the ocean, full body, beach scenery around him",
    motion:
      "cartoon boy on a beach, ocean waves rolling in, wind moving hair, seagulls flying, gentle camera pan, flat 2D anime",
  },
  bedroom: {
    still:
      "cozy kid bedroom interior, bed with blue blanket, desk with lamp, posters on wall, window with curtains, warm indoor light",
    pose: "sitting on the edge of the bed, waving hello, bedroom interior clearly visible, medium full shot",
    motion:
      "cartoon boy in his bedroom waving hello, curtains gently moving, soft indoor lighting, subtle camera push-in, flat 2D anime",
  },
  school: {
    still:
      "school hallway with lockers, classroom doors, bulletin board, polished floor, bright fluorescent lights, backpacks on hooks",
    pose: "standing in the school hallway, looking at camera, friendly smile, hallway perspective behind him, full body",
    motion:
      "cartoon boy in a school hallway, students softly moving in distance, locker reflections, gentle camera dolly, flat 2D anime",
  },
  forest: {
    still:
      "lush forest path, tall trees, dappled sunlight through leaves, mossy ground, wildflowers, nature trail",
    pose: "standing on the forest path, looking ahead, surrounded by trees, full body, deep environment depth",
    motion:
      "cartoon boy on a forest path, leaves falling gently, light rays shifting, soft wind, camera slowly orbits, flat 2D anime",
  },
  cafe: {
    still:
      "cozy cafe interior, wooden tables, coffee counter, pastries display, large window with street view, warm lamps",
    pose: "standing near a cafe table by the window, slight smile, cafe interior and window view visible, medium full shot",
    motion:
      "cartoon boy in a cafe, steam rising from cups in background, people softly moving outside window, gentle camera push-in, flat 2D anime",
  },
  playground: {
    still:
      "colorful playground, swings, slide, monkey bars, sand pit, sunny park trees behind, bright daylight",
    pose: "standing in front of the playground equipment, excited smile, full body, playground filling the scene",
    motion:
      "cartoon boy at a playground, swings moving gently, kids playing softly in background, camera push-in, flat 2D anime",
  },
  rainy: {
    still:
      "rainy city street at dusk, wet reflections on asphalt, glowing neon signs, umbrellas, puddles, moody blue-orange light",
    pose: "standing on the wet sidewalk, looking at camera, rain atmosphere and neon city behind him, full body",
    motion:
      "cartoon boy on a rainy street, rain falling, puddle ripples, neon lights flickering softly, gentle camera push-in, flat 2D anime",
  },
  rooftop: {
    still:
      "city rooftop at sunset, skyline silhouette, water tower, string lights, warm orange-pink sky, urban skyline depth",
    pose: "standing near the rooftop edge railing, looking at the skyline, sunset city behind him, full body",
    motion:
      "cartoon boy on a rooftop at sunset, clouds drifting, city lights beginning to glow, soft wind, camera slowly pans, flat 2D anime",
  },
};

const SCENE_NEGATIVE = [
  "plain gray background",
  "solid color background",
  "empty studio backdrop",
  "white void",
  "character sheet",
  "reference sheet",
  "no background",
  "isolated on white",
  "photorealistic",
  "3d render",
  "blurry",
  "low quality",
  "morphing face",
  "extra limbs",
  "distorted hands",
  "text",
  "watermark",
  "two people",
  "duplicate",
  "collage",
].join(", ");

const argv = process.argv.slice(2);
function flag(name, fallback = null) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
}
function has(name) {
  return argv.includes(name);
}
function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function openFile(path) {
  const cmd =
    platform() === "win32"
      ? `start "" "${path}"`
      : platform() === "darwin"
        ? `open "${path}"`
        : `xdg-open "${path}"`;
  exec(cmd);
}

async function comfy(url, path, opts = {}) {
  const res = await fetch(`${url}${path}`, opts);
  if (!res.ok) {
    throw new Error(`ComfyUI ${path} → ${res.status}: ${(await res.text()).slice(0, 600)}`);
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return Buffer.from(await res.arrayBuffer());
}

async function uploadImage(url, filename, buffer) {
  const form = new FormData();
  form.append("image", new Blob([buffer], { type: "image/png" }), filename);
  form.append("overwrite", "true");
  const res = await fetch(`${url}/upload/image`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`Upload failed: ${await res.text()}`);
  return res.json();
}

async function queueAndWait(url, workflow, timeoutMs = 900000) {
  const clientId = randomUUID();
  const queued = await comfy(url, "/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
  });
  if (queued.node_errors && Object.keys(queued.node_errors).length) {
    throw new Error(`Queue rejected: ${JSON.stringify(queued.node_errors).slice(0, 1000)}`);
  }
  const promptId = queued.prompt_id;
  console.log(`Queued ${promptId}`);

  const started = Date.now();
  let lastLog = 0;
  for (;;) {
    if (Date.now() - started > timeoutMs) {
      try {
        await comfy(url, "/interrupt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
      } catch {
        /* ignore */
      }
      throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    await sleep(1500);
    const hist = await comfy(url, `/history/${promptId}`);
    const entry = hist[promptId];
    if (!entry) {
      if (Date.now() - lastLog > 8000) {
        const q = await comfy(url, "/queue");
        console.log(
          `  waiting… running=${q.queue_running?.length || 0} pending=${q.queue_pending?.length || 0}`,
        );
        lastLog = Date.now();
      }
      continue;
    }
    if (entry.status?.status_str === "error") {
      throw new Error(`ComfyUI error: ${JSON.stringify(entry.status).slice(0, 1000)}`);
    }
    if (entry.outputs || entry.status?.completed) return entry;
  }
}

function stillWorkflow(cfg, prompt, negative, seed) {
  return {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: cfg.checkpoint },
    },
    "2": {
      class_type: "LoraLoader",
      inputs: {
        model: ["1", 0],
        clip: ["1", 1],
        lora_name: cfg.loraName,
        strength_model: cfg.loraStrength,
        strength_clip: cfg.loraStrength,
      },
    },
    "3": {
      class_type: "CLIPTextEncode",
      inputs: { text: prompt, clip: ["2", 1] },
    },
    "4": {
      class_type: "CLIPTextEncode",
      inputs: { text: negative, clip: ["2", 1] },
    },
    "5": {
      class_type: "EmptyLatentImage",
      inputs: { width: cfg.stillWidth, height: cfg.stillHeight, batch_size: 1 },
    },
    "6": {
      class_type: "KSampler",
      inputs: {
        seed,
        steps: cfg.stillSteps,
        cfg: cfg.stillCfg,
        sampler_name: "dpmpp_2m",
        scheduler: "karras",
        denoise: 1,
        model: ["2", 0],
        positive: ["3", 0],
        negative: ["4", 0],
        latent_image: ["5", 0],
      },
    },
    "7": {
      class_type: "VAEDecode",
      inputs: { samples: ["6", 0], vae: ["1", 2] },
    },
    "8": {
      class_type: "SaveImage",
      inputs: { filename_prefix: "tomchr_scene_still", images: ["7", 0] },
    },
  };
}

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

async function extractStillFromHistory(url, entry) {
  for (const nodeId of Object.keys(entry.outputs || {})) {
    const imgs = entry.outputs[nodeId].images;
    if (imgs?.length) {
      const img = imgs[0];
      const qs = new URLSearchParams({
        filename: img.filename,
        subfolder: img.subfolder || "",
        type: img.type || "output",
      });
      return await comfy(url, `/view?${qs}`);
    }
  }
  throw new Error("No still image in ComfyUI output");
}

function buildStillPrompt(character, scene, customScene) {
  const env = customScene || scene.still;
  return [
    character.trigger || "tomchr",
    STYLE,
    character.appearance || "cute cartoon boy Tom",
    character.outfit || "navy blue t-shirt, navy pants, white sneakers",
    env,
    scene.pose,
    "single character only, rich detailed background scenery, environmental storytelling",
  ].join(", ");
}

async function main() {
  if (has("--list-scenes")) {
    console.log("Available scenes:");
    for (const key of Object.keys(SCENES)) {
      console.log(`  ${key.padEnd(12)} ${SCENES[key].still.slice(0, 70)}…`);
    }
    return;
  }

  const character = existsSync(CHAR_PATH)
    ? JSON.parse(stripBom(await readFile(CHAR_PATH, "utf8")))
    : {};

  const test = has("--test");
  const sceneKey = flag("--scene", test ? "park" : "park");
  const scene = SCENES[sceneKey];
  if (!scene && !flag("--scene-prompt")) {
    console.error(`Unknown scene "${sceneKey}". Use --list-scenes`);
    process.exit(1);
  }

  const customScene = flag("--scene-prompt");
  const activeScene = scene || {
    still: customScene,
    pose: "full body in the scene, looking toward camera, environment clearly visible",
    motion: flag("--prompt") || `${customScene}, natural ambient motion, flat 2D anime`,
  };

  const comfyUrl = character.comfyUrl || "http://127.0.0.1:8888";
  const seed = flag("--seed") ? Number(flag("--seed")) : 42;

  const cfg = {
    checkpoint: character.checkpoint || "realcartoon3d_v15.safetensors",
    loraName: flag("--lora", "tomchr_character_v1.safetensors"),
    loraStrength: Number(flag("--strength", "0.9")),
    // Landscape for cinematic scenes
    stillWidth: Number(flag("--still-width", "768")),
    stillHeight: Number(flag("--still-height", "512")),
    stillSteps: Number(flag("--still-steps", test ? "22" : "28")),
    stillCfg: Number(flag("--still-cfg", "7")),
    width: Number(flag("--width", test ? "832" : "832")),
    height: Number(flag("--height", test ? "480" : "480")),
    length: Number(flag("--length", test ? "33" : "49")),
    steps: Number(flag("--steps", "4")),
    cfg: Number(flag("--cfg", "1")),
    shift: Number(flag("--shift", "8")),
    fps: Number(flag("--fps", "16")),
    outName: flag(
      "--name",
      `tomchr_scene_${sceneKey || "custom"}_${seed}`,
    ),
  };

  if ((cfg.length - 1) % 4 !== 0) {
    cfg.length = Math.max(1, Math.round((cfg.length - 1) / 4) * 4 + 1);
  }

  const stillPrompt =
    flag("--still-prompt") || buildStillPrompt(character, activeScene, customScene);
  const motionPrompt = flag("--prompt") || activeScene.motion;
  const negative = flag("--negative") || SCENE_NEGATIVE;

  console.log("Pipeline: Tom LoRA scene still → Wan 2.2 I2V");
  console.log(`Scene:  ${sceneKey}${customScene ? " (custom)" : ""}`);
  console.log(`Size:   still ${cfg.stillWidth}x${cfg.stillHeight} → video ${cfg.width}x${cfg.height}`);
  console.log(`Frames: ${cfg.length} @ ${cfg.fps}fps`);
  console.log(`Still:  ${stillPrompt.slice(0, 140)}…`);
  console.log(`Motion: ${motionPrompt.slice(0, 140)}…`);

  await comfy(comfyUrl, "/system_stats");
  await mkdir(OUT_DIR, { recursive: true });

  let stillBuf;
  const imagePath = flag("--image");

  if (imagePath) {
    const p = resolve(imagePath);
    if (!existsSync(p)) throw new Error(`Image not found: ${p}`);
    stillBuf = await readFile(p);
    console.log(`\nUsing existing still: ${p}`);
  } else {
    console.log("\n[1/2] Generating scene still with Tom LoRA…");
    const stillEntry = await queueAndWait(
      comfyUrl,
      stillWorkflow(cfg, stillPrompt, negative, seed),
      180000,
    );
    stillBuf = await extractStillFromHistory(comfyUrl, stillEntry);
    const stillLocal = join(OUT_DIR, `${cfg.outName}_still.png`);
    await writeFile(stillLocal, stillBuf);
    console.log(`  → ${stillLocal}`);
    if (!has("--no-open")) openFile(stillLocal);
  }

  if (has("--still-only")) {
    console.log("\n--still-only set; skipping video.");
    return;
  }

  const uploaded = await uploadImage(
    comfyUrl,
    `tomchr_scene_${cfg.outName}.png`,
    stillBuf,
  );

  console.log("\n[2/2] Animating scene with Wan 2.2 I2V…");
  await queueAndWait(
    comfyUrl,
    wanI2VWorkflow(cfg, uploaded.name, motionPrompt, negative, seed),
    900000,
  );

  await sleep(800);
  const videoPath = await findNewestVideo(cfg.outName);
  if (!videoPath) {
    throw new Error(`Video not found under ${join(COMFY_ROOT, "output", "video")}`);
  }

  const dest = join(OUT_DIR, `${cfg.outName}.mp4`);
  await copyFile(videoPath, dest);
  console.log(`\nSaved: ${dest}`);
  if (!has("--no-open")) openFile(dest);
}

main().catch((err) => {
  console.error("\nFailed:", err.message || err);
  process.exit(1);
});
