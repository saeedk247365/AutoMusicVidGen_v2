import { mkdir, readFile, writeFile, copyFile, readdir, stat } from "fs/promises";
import { existsSync, createReadStream } from "fs";
import { join, dirname, basename, resolve } from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import { platform } from "os";
import { randomUUID } from "crypto";

/**
 * Tom LoRA (SD1.5) cannot load into Wan.
 * Pipeline: still image (LoRA) → Wan 2.2 I2V → mp4
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHAR_PATH = join(ROOT, "characters", "tomchr.json");
const OUT_DIR = join(ROOT, "videos");
const COMFY_ROOT = join(ROOT, "ComfyUI");

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
    if (entry.outputs || entry.status?.completed) {
      return entry;
    }
  }
}

/** Still frame with Tom SD1.5 LoRA */
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
      inputs: { filename_prefix: "tomchr_video_still", images: ["7", 0] },
    },
  };
}

/** Wan 2.2 I2V with LightX2V 4-step LoRAs */
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
    // any recent mp4
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

async function main() {
  const character = existsSync(CHAR_PATH)
    ? JSON.parse(stripBom(await readFile(CHAR_PATH, "utf8")))
    : {};

  const test = has("--test");
  const imagePath = flag("--image");
  const comfyUrl = character.comfyUrl || "http://127.0.0.1:8888";

  const cfg = {
    checkpoint: character.checkpoint || "realcartoon3d_v15.safetensors",
    loraName: flag("--lora", "tomchr_character_v1.safetensors"),
    loraStrength: Number(flag("--strength", "0.85")),
    stillWidth: 512,
    stillHeight: 768,
    stillSteps: Number(flag("--still-steps", "24")),
    stillCfg: 7,
    width: Number(flag("--width", test ? "480" : "640")),
    height: Number(flag("--height", test ? "832" : "1136")),
    // Wan length must follow step-4 grid; 33 ≈ 2s @16fps (good smoke test)
    length: Number(flag("--length", test ? "33" : "49")),
    steps: Number(flag("--steps", "4")),
    cfg: Number(flag("--cfg", "1")),
    shift: Number(flag("--shift", "8")),
    fps: Number(flag("--fps", "16")),
    outName: flag("--name", test ? "tomchr_test" : `tomchr_${Date.now()}`),
  };

  // Snap length to valid Wan values (1 + 4k)
  if ((cfg.length - 1) % 4 !== 0) {
    cfg.length = Math.max(1, Math.round((cfg.length - 1) / 4) * 4 + 1);
  }

  const seed = flag("--seed") ? Number(flag("--seed")) : 123;
  const motionPrompt =
    flag("--prompt") ||
    (test
      ? "a cartoon boy waving hello, gentle hand wave, slight smile, natural motion, flat 2D anime style"
      : "a cartoon boy waving hello, full body, natural motion, flat 2D anime style");
  const negative =
    flag("--negative") ||
    "blurry, low quality, morphing face, extra limbs, distorted hands, text, watermark, photorealistic";

  console.log("Pipeline: Tom LoRA still → Wan 2.2 I2V → mp4");
  console.log(`Size: ${cfg.width}x${cfg.height}, frames=${cfg.length}, fps=${cfg.fps}`);
  console.log(`Motion: ${motionPrompt.slice(0, 120)}`);

  await comfy(comfyUrl, "/system_stats");
  await mkdir(OUT_DIR, { recursive: true });

  let stillBuf;
  let stillLocalPath;

  if (imagePath) {
    stillLocalPath = resolve(imagePath);
    if (!existsSync(stillLocalPath)) throw new Error(`Image not found: ${stillLocalPath}`);
    stillBuf = await readFile(stillLocalPath);
    console.log(`Using still: ${stillLocalPath}`);
  } else {
    const stillPrompt =
      flag("--still-prompt") ||
      [
        character.trigger || "tomchr",
        "flat 2D anime cartoon",
        character.appearance || "cute cartoon boy Tom",
        character.outfit || "navy blue t-shirt, navy pants, white sneakers",
        "front view, standing, looking at camera, full body, plain gray background",
      ].join(", ");

    console.log("\n[1/2] Generating still with Tom LoRA…");
    const stillEntry = await queueAndWait(
      comfyUrl,
      stillWorkflow(cfg, stillPrompt, character.negative || negative, seed),
      180000,
    );
    stillBuf = await extractStillFromHistory(comfyUrl, stillEntry);
    stillLocalPath = join(OUT_DIR, `${cfg.outName}_still.png`);
    await writeFile(stillLocalPath, stillBuf);
    console.log(`  → ${stillLocalPath}`);
  }

  const uploaded = await uploadImage(
    comfyUrl,
    `tomchr_i2v_${cfg.outName}.png`,
    stillBuf,
  );

  console.log("\n[2/2] Animating with Wan 2.2 I2V (4-step LightX2V)…");
  console.log("  First run may take longer while models load into VRAM.");
  await queueAndWait(
    comfyUrl,
    wanI2VWorkflow(cfg, uploaded.name, motionPrompt, negative, seed),
    900000,
  );

  await sleep(800);
  const videoPath = await findNewestVideo(cfg.outName);
  if (!videoPath) {
    throw new Error(
      `Video not found under ${join(COMFY_ROOT, "output", "video")} — check ComfyUI output folder.`,
    );
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
