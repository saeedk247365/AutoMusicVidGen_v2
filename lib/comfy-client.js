import { randomUUID } from "crypto";
import { exec } from "child_process";
import { platform } from "os";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { readdir, stat, copyFile, mkdir } from "fs/promises";
import { comfyAuthHeaders, isSaladUrl } from "./gpu-backend.js";

/** Project-local ComfyUI (copied under repo root). */
export const COMFY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "ComfyUI",
);

/** Cached live Comfy dirs from /system_stats, keyed by Comfy URL. */
const _dirsByUrl = new Map();

/** Clear cached Comfy dirs (call when output path may have changed). */
export function clearComfyDirsCache() {
  _dirsByUrl.clear();
}

/**
 * Resolve the output/input/models directories the *running* ComfyUI is using.
 * Falls back to project-local ComfyUI when stats are unavailable.
 * Salad URLs never expose usable local paths — callers must use /view.
 */
export async function resolveComfyDirs(comfyUrl = "http://127.0.0.1:8888") {
  const key = String(comfyUrl || "http://127.0.0.1:8888").replace(/\/$/, "");
  if (_dirsByUrl.has(key)) return _dirsByUrl.get(key);

  const fallback = {
    root: COMFY_ROOT,
    output: join(COMFY_ROOT, "output"),
    input: join(COMFY_ROOT, "input"),
    models: join(COMFY_ROOT, "models"),
    remote: false,
  };

  if (isSaladUrl(key)) {
    const remote = {
      root: null,
      output: null,
      input: null,
      models: null,
      remote: true,
    };
    _dirsByUrl.set(key, remote);
    return remote;
  }

  try {
    const res = await fetch(`${key}/system_stats`, {
      headers: comfyAuthHeaders(key),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      _dirsByUrl.set(key, fallback);
      return fallback;
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
    const dirs = {
      root: dirname(output),
      output,
      input,
      models,
      remote: false,
    };
    _dirsByUrl.set(key, dirs);
    return dirs;
  } catch {
    _dirsByUrl.set(key, fallback);
    return fallback;
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

/** Salad/Cloudflare edge blips while Wan is still running on the GPU. */
const TRANSIENT_HTTP = new Set([408, 425, 429, 502, 503, 504, 520, 521, 522, 524]);

function isTransientComfyError(err) {
  const msg = String(err?.message || err || "");
  if (/→\s*(408|425|429|502|503|504|520|521|522|524)\b/.test(msg)) return true;
  if (/AbortError|TimeoutError|ETIMEDOUT|ECONNRESET|ECONNREFUSED|fetch failed/i.test(msg)) {
    return true;
  }
  return false;
}

export async function comfy(url, path, opts = {}) {
  const salad = isSaladUrl(url);
  const headers = comfyAuthHeaders(url, opts.headers || {});
  const timeoutMs = opts.timeoutMs ?? (salad ? 120000 : 60000);
  const maxAttempts = opts.retries ?? (salad ? 6 : 2);
  const { timeoutMs: _t, retries: _r, ...fetchOpts } = opts;

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`${url}${path}`, {
        ...fetchOpts,
        headers,
        signal: fetchOpts.signal || AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 700);
        const err = new Error(`ComfyUI ${path} → ${res.status}: ${body}`);
        if (TRANSIENT_HTTP.has(res.status) && attempt < maxAttempts) {
          const wait = Math.min(20_000, 1500 * attempt);
          console.warn(
            `  Comfy ${path} → ${res.status}, retry ${attempt}/${maxAttempts} in ${Math.round(wait / 1000)}s…`,
          );
          await sleep(wait);
          lastErr = err;
          continue;
        }
        throw err;
      }
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("application/json")) return res.json();
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts && isTransientComfyError(err)) {
        const wait = Math.min(20_000, 1500 * attempt);
        console.warn(
          `  Comfy ${path} failed (${err.message || err}), retry ${attempt}/${maxAttempts} in ${Math.round(wait / 1000)}s…`,
        );
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error(`ComfyUI ${path} failed`);
}

export async function uploadImage(url, filename, buffer) {
  const form = new FormData();
  form.append("image", new Blob([buffer], { type: "image/png" }), filename);
  form.append("overwrite", "true");
  const res = await fetch(`${url}/upload/image`, {
    method: "POST",
    headers: comfyAuthHeaders(url),
    body: form,
    signal: AbortSignal.timeout(isSaladUrl(url) ? 120000 : 60000),
  });
  if (!res.ok) throw new Error(`Upload failed: ${await res.text()}`);
  return res.json();
}

export async function uploadAudio(url, filename, buffer, mime = "audio/wav") {
  const form = new FormData();
  form.append("image", new Blob([buffer], { type: mime }), filename);
  // ComfyUI uses /upload/image for generic uploads in many builds; also try /upload/mask
  form.append("overwrite", "true");
  let res = await fetch(`${url}/upload/image`, {
    method: "POST",
    headers: comfyAuthHeaders(url),
    body: form,
  });
  if (!res.ok) {
    const form2 = new FormData();
    form2.append("audio", new Blob([buffer], { type: mime }), filename);
    form2.append("overwrite", "true");
    res = await fetch(`${url}/upload/image`, {
      method: "POST",
      headers: comfyAuthHeaders(url),
      body: form2,
    });
  }
  if (!res.ok) throw new Error(`Audio upload failed: ${await res.text()}`);
  return res.json();
}

/**
 * Salad ComfyUI-API recipes return { images: [base64, ...] } from POST /prompt.
 * Native ComfyUI returns { prompt_id } and requires /history polling.
 */
function saladSyncEntryFromResponse(queued) {
  if (!queued || typeof queued !== "object") return null;
  const images = queued.images || queued.files;
  if (!Array.isArray(images) || !images.length) return null;
  const buffers = images.map((item) => {
    if (Buffer.isBuffer(item)) return item;
    if (typeof item === "string") {
      const raw = item.includes(",") ? item.split(",").pop() : item;
      return Buffer.from(raw, "base64");
    }
    if (item?.data) return Buffer.from(item.data, "base64");
    return null;
  }).filter(Boolean);
  if (!buffers.length) return null;
  return {
    status: { status_str: "success", completed: true },
    outputs: {
      salad: {
        images: buffers.map((_, i) => ({
          filename: `salad_${i}.png`,
          subfolder: "",
          type: "output",
        })),
      },
    },
    _saladImageBuffers: buffers,
  };
}

/**
 * Interrupt + clear queue + unload models.
 * Needed after wedged train/Wan jobs (esp. Salad RTX 50-series) so the next
 * prompt does not sit forever on a dead CUDA context.
 */
export async function resetComfyExecution(url, { label = "" } = {}) {
  const tag = label ? ` (${label})` : "";
  const headers = { "Content-Type": "application/json" };
  try {
    await comfy(url, "/interrupt", {
      method: "POST",
      headers,
      body: "{}",
      timeoutMs: 30_000,
    });
  } catch (err) {
    console.warn(`  interrupt failed${tag}: ${err?.message || err}`);
  }
  try {
    await comfy(url, "/queue", {
      method: "POST",
      headers,
      body: JSON.stringify({ clear: true }),
      timeoutMs: 30_000,
    });
  } catch (err) {
    console.warn(`  clear queue failed${tag}: ${err?.message || err}`);
  }
  try {
    await comfy(url, "/free", {
      method: "POST",
      headers,
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      timeoutMs: 60_000,
    });
  } catch (err) {
    console.warn(`  free memory failed${tag}: ${err?.message || err}`);
  }
  await sleep(isSaladUrl(url) ? 2000 : 500);
  console.log(`  Comfy execution reset${tag}`);
}

async function readVramUsedMb(url) {
  try {
    const stats = await comfy(url, "/system_stats", { timeoutMs: 15_000 });
    const d = stats?.devices?.[0];
    if (!d || !Number.isFinite(d.vram_total) || !Number.isFinite(d.vram_free)) {
      return null;
    }
    return Math.round((d.vram_total - d.vram_free) / 1e6);
  } catch {
    return null;
  }
}

export async function queueAndWait(url, workflow, timeoutMs = 900000, label = "") {
  const clientId = randomUUID();
  const salad = isSaladUrl(url);
  // Salad Wan on a cold/wedged GPU can appear "running" forever with flat VRAM.
  // Keep hard timeout tighter on Salad; local keeps the caller value.
  const effectiveTimeout = salad
    ? Math.min(timeoutMs, 12 * 60 * 1000)
    : timeoutMs;
  /** Flat VRAM while still running ⇒ CUDA hang (common on 5080 + cudaMallocAsync). */
  const stuckVramMs = salad ? 6 * 60 * 1000 : 10 * 60 * 1000;

  const queued = await comfy(url, "/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    timeoutMs: salad ? Math.min(timeoutMs, 95_000) : 60_000,
  });
  if (queued.node_errors && Object.keys(queued.node_errors).length) {
    throw new Error(`Queue rejected: ${JSON.stringify(queued.node_errors).slice(0, 1200)}`);
  }

  const syncEntry = saladSyncEntryFromResponse(queued);
  if (syncEntry) {
    console.log(`Salad sync complete${label ? ` (${label})` : ""}`);
    return syncEntry;
  }

  const promptId = queued.prompt_id;
  if (!promptId) {
    throw new Error(
      `Unexpected /prompt response (no prompt_id / images): ${JSON.stringify(queued).slice(0, 400)}`,
    );
  }
  console.log(`Queued ${promptId}${label ? ` (${label})` : ""}`);

  const started = Date.now();
  let lastLog = 0;
  let lastVram = await readVramUsedMb(url);
  let lastVramChangeAt = Date.now();

  for (;;) {
    if (Date.now() - started > effectiveTimeout) {
      try {
        await resetComfyExecution(url, { label: "timeout" });
      } catch {
        /* ignore */
      }
      throw new Error(
        `Timed out after ${Math.round(effectiveTimeout / 1000)}s` +
          (salad
            ? " (Salad Wan watchdog — often a wedged CUDA job; restart container if interrupt fails)"
            : ""),
      );
    }
    await sleep(salad ? 2500 : 1500);
    const hist = await comfy(url, `/history/${promptId}`);
    const entry = hist[promptId];
    if (!entry) {
      const vram = await readVramUsedMb(url);
      if (vram != null && lastVram != null && Math.abs(vram - lastVram) >= 64) {
        lastVram = vram;
        lastVramChangeAt = Date.now();
      } else if (vram != null && lastVram == null) {
        lastVram = vram;
        lastVramChangeAt = Date.now();
      }

      if (Date.now() - lastVramChangeAt > stuckVramMs) {
        try {
          await resetComfyExecution(url, { label: "vram-stuck" });
        } catch {
          /* ignore */
        }
        throw new Error(
          `Comfy job stuck: VRAM flat at ~${lastVram ?? "?"}MB for ` +
            `${Math.round(stuckVramMs / 60000)}m while prompt still running` +
            (salad
              ? " (RTX 50-series often needs --disable-cuda-malloc; restart Salad image)"
              : ""),
        );
      }

      if (Date.now() - lastLog > 10000) {
        try {
          const q = await comfy(url, "/queue");
          console.log(
            `  waiting… running=${q.queue_running?.length || 0} pending=${q.queue_pending?.length || 0}` +
              (vram != null ? ` vram=${vram}MB` : ""),
          );
        } catch (err) {
          console.log(`  waiting… (${err.message || err})`);
        }
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
  if (entry?._saladImageBuffers?.length) {
    return entry._saladImageBuffers[0];
  }
  for (const nodeId of Object.keys(entry.outputs || {})) {
    const imgs = entry.outputs[nodeId].images;
    if (imgs?.length) {
      const img = imgs[0];
      if (img?.buffer) return img.buffer;
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

/**
 * Pull the first video output from a history entry.
 * SaveVideo (current Comfy) returns ui PreviewVideo as `images` + `animated`.
 * Older nodes used `gifs` / `videos`. Local Comfy: prefer filesystem; Salad: /view.
 * @returns {Promise<{ buffer: Buffer, meta: object } | null>}
 */
export async function extractVideoFromHistory(url, entry) {
  const candidates = [];

  for (const nodeId of Object.keys(entry?.outputs || {})) {
    const node = entry.outputs[nodeId] || {};
    const animated = !!(
      node.animated === true ||
      (Array.isArray(node.animated) && node.animated.some(Boolean))
    );
    for (const key of ["videos", "gifs", "images"]) {
      const arr = node[key];
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        if (!item?.filename) continue;
        // Prefer explicit video lists; allow images when marked animated (SaveVideo)
        if (key === "images" && !animated && !/\.(mp4|webm|mkv|mov)$/i.test(item.filename)) {
          continue;
        }
        candidates.push(item);
      }
    }
  }

  // Also scan ui blobs some gateways attach at entry root
  const ui = entry?.ui || {};
  for (const key of ["videos", "gifs", "images"]) {
    const arr = ui[key];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (item?.filename) candidates.push(item);
    }
  }

  for (const g of candidates) {
    if (g?.buffer) return { buffer: g.buffer, meta: g };

    const dirs = await resolveComfyDirs(url);
    if (dirs.output && g.filename) {
      const candidatesPaths = [
        join(dirs.output, g.subfolder || "", g.filename),
        join(dirs.output, "video", g.filename),
        join(COMFY_ROOT, "output", g.subfolder || "", g.filename),
        join(COMFY_ROOT, "output", "video", g.filename),
      ];
      const local = candidatesPaths.find((p) => existsSync(p));
      if (local) {
        const { readFile } = await import("fs/promises");
        return { buffer: await readFile(local), meta: { ...g, localPath: local } };
      }
    }

    if (g?.filename) {
      const qs = new URLSearchParams({
        filename: g.filename,
        subfolder: g.subfolder || "",
        type: g.type || "output",
      });
      const buffer = await comfy(url, `/view?${qs}`, {
        timeoutMs: isSaladUrl(url) ? 300000 : 120000,
      });
      return {
        buffer: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer),
        meta: g,
      };
    }
  }
  return null;
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
  const dirs = await resolveComfyDirs(comfyUrl || "http://127.0.0.1:8888");
  if (dirs.remote || !dirs.output) {
    throw new Error(
      `Cannot copy ${kind} from remote Comfy filesystem — use /view / history extract instead`,
    );
  }
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
        // Match fp8_scaled weights — "default" can wedge on Salad Blackwell.
        weight_dtype: "fp8_e4m3fn",
      },
    },
    "4": {
      class_type: "UNETLoader",
      inputs: {
        unet_name: "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors",
        weight_dtype: "fp8_e4m3fn",
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
