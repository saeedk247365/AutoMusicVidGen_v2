import { randomUUID } from "crypto";
import { exec } from "child_process";
import { platform } from "os";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { readdir, stat, copyFile, mkdir } from "fs/promises";

/** Project-local ComfyUI (copied under repo root). */
export const COMFY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "ComfyUI",
);

/** Cached live Comfy dirs from /system_stats (ProdesecStudio may differ from COMFY_ROOT). */
let _liveDirs = null;

/** Clear cached Comfy dirs (call when output path may have changed). */
export function clearComfyDirsCache() {
  _liveDirs = null;
}

/**
 * Resolve the output/input/models directories the *running* ComfyUI is using.
 * Falls back to project-local ComfyUI when stats are unavailable.
 */
export async function resolveComfyDirs(comfyUrl = "http://127.0.0.1:8188") {
  if (_liveDirs?.output) return _liveDirs;
  const fallback = {
    root: COMFY_ROOT,
    output: join(COMFY_ROOT, "output"),
    input: join(COMFY_ROOT, "input"),
    models: join(COMFY_ROOT, "models"),
  };
  try {
    const res = await fetch(`${comfyUrl}/system_stats`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      _liveDirs = fallback;
      return _liveDirs;
    }
    const data = await res.json();
    const argv = data?.system?.argv || [];
    const pick = (flag) => {
      const i = argv.indexOf(flag);
      return i >= 0 ? argv[i + 1] : null;
    };
    const output = pick("--output-directory") || fallback.output;
    const input = pick("--input-directory") || fallback.input;
    const models = pick("--models-directory") || fallback.models;
    _liveDirs = {
      root: dirname(output),
      output,
      input,
      models,
    };
    return _liveDirs;
  } catch {
    _liveDirs = fallback;
    return _liveDirs;
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

export function parseArgs(argv = process.argv.slice(2)) {
  return {
    flag(name, fallback = null) {
      const i = argv.indexOf(name);
      return i >= 0 ? argv[i + 1] : fallback;
    },
    has(name) {
      return argv.includes(name);
    },
  };
}

export function openFile(path) {
  const cmd =
    platform() === "win32"
      ? `start "" "${path}"`
      : platform() === "darwin"
        ? `open "${path}"`
        : `xdg-open "${path}"`;
  exec(cmd);
}

export async function comfy(url, path, opts = {}) {
  const res = await fetch(`${url}${path}`, opts);
  if (!res.ok) {
    throw new Error(`ComfyUI ${path} → ${res.status}: ${(await res.text()).slice(0, 700)}`);
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return Buffer.from(await res.arrayBuffer());
}

export async function uploadImage(url, filename, buffer) {
  const form = new FormData();
  form.append("image", new Blob([buffer], { type: "image/png" }), filename);
  form.append("overwrite", "true");
  const res = await fetch(`${url}/upload/image`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`Upload failed: ${await res.text()}`);
  return res.json();
}

export async function uploadAudio(url, filename, buffer, mime = "audio/wav") {
  const form = new FormData();
  form.append("image", new Blob([buffer], { type: mime }), filename);
  // ComfyUI uses /upload/image for generic uploads in many builds; also try /upload/mask
  form.append("overwrite", "true");
  let res = await fetch(`${url}/upload/image`, { method: "POST", body: form });
  if (!res.ok) {
    const form2 = new FormData();
    form2.append("audio", new Blob([buffer], { type: mime }), filename);
    form2.append("overwrite", "true");
    res = await fetch(`${url}/upload/image`, { method: "POST", body: form2 });
  }
  if (!res.ok) throw new Error(`Audio upload failed: ${await res.text()}`);
  return res.json();
}

export async function queueAndWait(url, workflow, timeoutMs = 900000, label = "") {
  const clientId = randomUUID();
  const queued = await comfy(url, "/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
  });
  if (queued.node_errors && Object.keys(queued.node_errors).length) {
    throw new Error(`Queue rejected: ${JSON.stringify(queued.node_errors).slice(0, 1200)}`);
  }
  const promptId = queued.prompt_id;
  console.log(`Queued ${promptId}${label ? ` (${label})` : ""}`);

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
      if (Date.now() - lastLog > 10000) {
        const q = await comfy(url, "/queue");
        console.log(
          `  waiting… running=${q.queue_running?.length || 0} pending=${q.queue_pending?.length || 0}`,
        );
        lastLog = Date.now();
      }
      continue;
    }
    if (entry.status?.status_str === "error") {
      throw new Error(`ComfyUI error: ${JSON.stringify(entry.status).slice(0, 1200)}`);
    }
    if (entry.outputs || entry.status?.completed) return entry;
  }
}

export async function extractImageFromHistory(url, entry) {
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
  throw new Error("No image in ComfyUI output");
}

export async function findNewestInDir(dir, predicate, prefix = "") {
  if (!existsSync(dir)) return null;
  let files = (await readdir(dir))
    .filter((f) => predicate(f) && (!prefix || f.includes(prefix)))
    .map((f) => join(dir, f));
  // Do NOT fall back to unrelated files when a prefix was requested —
  // that silently reuses stale outputs from other runs.
  if (!files.length) return null;
  const withStat = await Promise.all(
    files.map(async (f) => ({ f, m: (await stat(f)).mtimeMs })),
  );
  withStat.sort((a, b) => b.m - a.m);
  return withStat[0].f;
}

export async function copyNewestOutput(kind, prefix, destPath, comfyUrl) {
  const dirs = await resolveComfyDirs(comfyUrl || "http://127.0.0.1:8188");
  const outRoot = dirs.output || join(COMFY_ROOT, "output");
  const dir =
    kind === "video"
      ? join(outRoot, "video")
      : kind === "audio"
        ? join(outRoot, "audio")
        : outRoot;
  const pred =
    kind === "video"
      ? (f) => f.toLowerCase().endsWith(".mp4")
      : kind === "audio"
        ? (f) => /\.(mp3|wav|flac|ogg)$/i.test(f)
        : (f) => f.toLowerCase().endsWith(".png");
  await sleep(500);
  let found = await findNewestInDir(dir, pred, prefix);
  if (!found && kind === "audio") {
    found = await findNewestInDir(outRoot, pred, prefix);
  }
  // Fallback: project-local Comfy output if live path differs
  if (!found && outRoot !== join(COMFY_ROOT, "output")) {
    found = await findNewestInDir(
      kind === "video"
        ? join(COMFY_ROOT, "output", "video")
        : join(COMFY_ROOT, "output"),
      pred,
      prefix,
    );
  }
  if (!found) throw new Error(`No ${kind} output found for prefix ${prefix} in ${dir}`);
  await mkdir(join(destPath, ".."), { recursive: true });
  await copyFile(found, destPath);
  return { found, destPath };
}

/** Checkpoint still (no LoRA) — landscapes / scenic backgrounds */
export function checkpointStillWorkflow(cfg, prompt, negative, seed, prefix = "scenic_still") {
  return {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: cfg.checkpoint },
    },
    "3": {
      class_type: "CLIPTextEncode",
      inputs: { text: prompt, clip: ["1", 1] },
    },
    "4": {
      class_type: "CLIPTextEncode",
      inputs: { text: negative, clip: ["1", 1] },
    },
    "5": {
      class_type: "EmptyLatentImage",
      inputs: { width: cfg.width, height: cfg.height, batch_size: 1 },
    },
    "6": {
      class_type: "KSampler",
      inputs: {
        seed,
        steps: cfg.steps,
        cfg: cfg.cfg,
        sampler_name: "dpmpp_2m",
        scheduler: "karras",
        denoise: 1,
        model: ["1", 0],
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
      inputs: { filename_prefix: prefix, images: ["7", 0] },
    },
  };
}

/** Checkpoint + optional LoRA still (txt2img) */
export function loraStillWorkflow(cfg, prompt, negative, seed, prefix = "lora_still") {
  const useLora = Boolean(cfg.loraName);
  const wf = {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: cfg.checkpoint },
    },
  };
  if (useLora) {
    wf["2"] = {
      class_type: "LoraLoader",
      inputs: {
        model: ["1", 0],
        clip: ["1", 1],
        lora_name: cfg.loraName,
        strength_model: cfg.loraStrength ?? 0.9,
        strength_clip: cfg.loraStrength ?? 0.9,
      },
    };
  }
  const modelRef = useLora ? ["2", 0] : ["1", 0];
  const clipRef = useLora ? ["2", 1] : ["1", 1];
  wf["3"] = {
    class_type: "CLIPTextEncode",
    inputs: { text: prompt, clip: clipRef },
  };
  wf["4"] = {
    class_type: "CLIPTextEncode",
    inputs: { text: negative, clip: clipRef },
  };
  wf["5"] = {
    class_type: "EmptyLatentImage",
    inputs: { width: cfg.width, height: cfg.height, batch_size: 1 },
  };
  wf["6"] = {
    class_type: "KSampler",
    inputs: {
      seed,
      steps: cfg.steps,
      cfg: cfg.cfg,
      sampler_name: "dpmpp_2m",
      scheduler: "karras",
      denoise: 1,
      model: modelRef,
      positive: ["3", 0],
      negative: ["4", 0],
      latent_image: ["5", 0],
    },
  };
  wf["7"] = {
    class_type: "VAEDecode",
    inputs: { samples: ["6", 0], vae: ["1", 2] },
  };
  wf["8"] = {
    class_type: "SaveImage",
    inputs: { filename_prefix: prefix, images: ["7", 0] },
  };
  return wf;
}

/**
 * Place character into an existing scene still (img2img).
 * cfg.loraName optional — when set, loads LoRA after checkpoint.
 */
export function loraImg2ImgWorkflow(
  cfg,
  { imageName, prompt, negative, seed, denoise = 0.58, prefix = "lora_i2i" },
) {
  const useLora = Boolean(cfg.loraName);
  const wf = {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: cfg.checkpoint },
    },
  };
  if (useLora) {
    wf["2"] = {
      class_type: "LoraLoader",
      inputs: {
        model: ["1", 0],
        clip: ["1", 1],
        lora_name: cfg.loraName,
        strength_model: cfg.loraStrength ?? 0.9,
        strength_clip: cfg.loraStrength ?? 0.9,
      },
    };
  }
  const modelRef = useLora ? ["2", 0] : ["1", 0];
  const clipRef = useLora ? ["2", 1] : ["1", 1];
  wf["3"] = {
    class_type: "CLIPTextEncode",
    inputs: { text: prompt, clip: clipRef },
  };
  wf["4"] = {
    class_type: "CLIPTextEncode",
    inputs: { text: negative, clip: clipRef },
  };
  wf["5"] = {
    class_type: "LoadImage",
    inputs: { image: imageName },
  };
  wf["6"] = {
    class_type: "VAEEncode",
    inputs: { pixels: ["5", 0], vae: ["1", 2] },
  };
  wf["7"] = {
    class_type: "KSampler",
    inputs: {
      seed,
      steps: cfg.steps,
      cfg: cfg.cfg,
      sampler_name: "dpmpp_2m",
      scheduler: "karras",
      denoise,
      model: modelRef,
      positive: ["3", 0],
      negative: ["4", 0],
      latent_image: ["6", 0],
    },
  };
  wf["8"] = {
    class_type: "VAEDecode",
    inputs: { samples: ["7", 0], vae: ["1", 2] },
  };
  wf["9"] = {
    class_type: "SaveImage",
    inputs: { filename_prefix: prefix, images: ["8", 0] },
  };
  return wf;
}

/**
 * Inpaint a character-sized masked region of an empty scene with LoRA.
 * Uses VAEEncodeForInpaint so only the mask regenerates — Adam is forced large/opaque.
 */
export function loraInpaintWorkflow(
  cfg,
  {
    imageName,
    maskName,
    prompt,
    negative,
    seed,
    denoise = 0.95,
    growMaskBy = 16,
    feather = 24,
    prefix = "lora_inpaint",
  },
) {
  const useLora = Boolean(cfg.loraName);
  const wf = {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: cfg.checkpoint },
    },
  };
  if (useLora) {
    wf["2"] = {
      class_type: "LoraLoader",
      inputs: {
        model: ["1", 0],
        clip: ["1", 1],
        lora_name: cfg.loraName,
        strength_model: cfg.loraStrength ?? 0.95,
        strength_clip: cfg.loraStrength ?? 0.95,
      },
    };
  }
  const modelRef = useLora ? ["2", 0] : ["1", 0];
  const clipRef = useLora ? ["2", 1] : ["1", 1];

  wf["3"] = {
    class_type: "CLIPTextEncode",
    inputs: { text: prompt, clip: clipRef },
  };
  wf["4"] = {
    class_type: "CLIPTextEncode",
    inputs: { text: negative, clip: clipRef },
  };
  wf["5"] = {
    class_type: "LoadImage",
    inputs: { image: imageName },
  };
  wf["6"] = {
    class_type: "LoadImage",
    inputs: { image: maskName },
  };
  wf["7"] = {
    class_type: "ImageToMask",
    inputs: { image: ["6", 0], channel: "red" },
  };
  wf["8"] = {
    class_type: "FeatherMask",
    inputs: {
      mask: ["7", 0],
      left: feather,
      top: feather,
      right: feather,
      bottom: feather,
    },
  };
  wf["9"] = {
    class_type: "VAEEncodeForInpaint",
    inputs: {
      pixels: ["5", 0],
      vae: ["1", 2],
      mask: ["8", 0],
      grow_mask_by: growMaskBy,
    },
  };
  wf["10"] = {
    class_type: "KSampler",
    inputs: {
      seed,
      steps: cfg.steps,
      cfg: cfg.cfg,
      sampler_name: "dpmpp_2m",
      scheduler: "karras",
      denoise,
      model: modelRef,
      positive: ["3", 0],
      negative: ["4", 0],
      latent_image: ["9", 0],
    },
  };
  wf["11"] = {
    class_type: "VAEDecode",
    inputs: { samples: ["10", 0], vae: ["1", 2] },
  };
  wf["12"] = {
    class_type: "SaveImage",
    inputs: { filename_prefix: prefix, images: ["11", 0] },
  };
  return wf;
}

/** Wan 2.2 I2V LightX2V */
export function wanI2VWorkflow(cfg, imageName, motionPrompt, negative, seed, outPrefix) {
  return {
    "1": {
      class_type: "CLIPLoader",
      inputs: { clip_name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors", type: "wan" },
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
      inputs: { model: ["5", 0], shift: cfg.shift ?? 8 },
    },
    "8": {
      class_type: "ModelSamplingSD3",
      inputs: { model: ["6", 0], shift: cfg.shift ?? 8 },
    },
    "9": {
      class_type: "CLIPTextEncode",
      inputs: { text: motionPrompt, clip: ["1", 0] },
    },
    "10": {
      class_type: "CLIPTextEncode",
      inputs: { text: negative, clip: ["1", 0] },
    },
    "11": { class_type: "LoadImage", inputs: { image: imageName } },
    "12": {
      class_type: "ImageScale",
      inputs: {
        image: ["11", 0],
        upscale_method: "lanczos",
        width: cfg.videoWidth,
        height: cfg.videoHeight,
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
        width: cfg.videoWidth,
        height: cfg.videoHeight,
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
        steps: cfg.wanSteps ?? 4,
        cfg: cfg.wanCfg ?? 1,
        sampler_name: "euler",
        scheduler: "simple",
        positive: ["13", 0],
        negative: ["13", 1],
        latent_image: ["13", 2],
        start_at_step: 0,
        end_at_step: Math.floor((cfg.wanSteps ?? 4) / 2),
        return_with_leftover_noise: "enable",
      },
    },
    "15": {
      class_type: "KSamplerAdvanced",
      inputs: {
        model: ["8", 0],
        add_noise: "disable",
        noise_seed: seed,
        steps: cfg.wanSteps ?? 4,
        cfg: cfg.wanCfg ?? 1,
        sampler_name: "euler",
        scheduler: "simple",
        positive: ["13", 0],
        negative: ["13", 1],
        latent_image: ["14", 0],
        start_at_step: Math.floor((cfg.wanSteps ?? 4) / 2),
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
      inputs: { images: ["16", 0], fps: cfg.fps ?? 16 },
    },
    "18": {
      class_type: "SaveVideo",
      inputs: {
        video: ["17", 0],
        filename_prefix: `video/${outPrefix}`,
        format: "mp4",
        codec: "h264",
      },
    },
  };
}
