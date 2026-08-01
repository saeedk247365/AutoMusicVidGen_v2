import { mkdir, readFile, writeFile, copyFile, readdir, rm, unlink, rename } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname, basename, resolve } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import {
  setGpuBackend,
  resolveComfyUrl,
  isSaladUrl,
  comfyAuthHeaders,
  getGpuBackend,
} from "../lib/gpu-backend.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SYNC_ONLY = args.includes("--sync-only");
function flag(name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}
const stepsOverride = (() => {
  const i = args.indexOf("--steps");
  return i >= 0 ? Number(args[i + 1]) : null;
})();

if (args.includes("--salad") || flag("--backend") === "salad") {
  const sw = setGpuBackend("salad");
  if (!sw.ok) {
    console.error(sw.error);
    process.exit(2);
  }
}

const TRAIN_CONFIG_PATH = join(ROOT, flag("--train-config", "train-config.json"));
const CHAR_CONFIG_PATH = join(ROOT, flag("--character", "characters/tomchr.json"));

function stripBom(raw) {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

async function loadJson(path) {
  return JSON.parse(stripBom(await readFile(path, "utf8")));
}

async function loadConfig() {
  const train = await loadJson(TRAIN_CONFIG_PATH);
  let character = {};
  if (existsSync(CHAR_CONFIG_PATH)) {
    character = await loadJson(CHAR_CONFIG_PATH);
  }

  const trigger = character.trigger || "tomchr";
  const name = character.name || "Tom";

  const comfyRootRaw = train.comfyRoot || "ComfyUI";
  const comfyRoot = resolve(ROOT, comfyRootRaw);
  // --salad sets GPU_BACKEND; do not trust train-config.comfyUrl (usually localhost).
  // resolveComfyUrl(override) returns the override as-is, so localhost would disable remote.
  const salad = getGpuBackend() === "salad";

  // Salad 16GB+ can full-load; offloading+no-bypass hangs TrainLoraNode (CPU thrash, ~1–2GB VRAM forever).
  // If offloading is kept on, bypass_mode MUST be true (Comfy only logs "forcing bypass" — it does not set it).
  let offloading = train.offloading ?? false;
  let bypassMode = train.bypassMode ?? train.bypass_mode ?? false;
  if (salad) {
    offloading = false;
    bypassMode = false;
  } else if (offloading && !bypassMode) {
    bypassMode = true;
  }

  return {
    ...train,
    comfyRoot,
    comfyUrl: salad
      ? resolveComfyUrl()
      : train.comfyUrl || character.comfyUrl || resolveComfyUrl(),
    remote: salad,
    checkpoint: train.checkpoint || character.checkpoint || "realcartoon3d_v15.safetensors",
    loraName: train.loraName || `${trigger}_character_v1`,
    datasetFolder: train.datasetFolder || `character_lora_${trigger}`,
    trigger,
    name,
    steps: stepsOverride ?? train.steps ?? 200,
    offloading,
    bypassMode,
  };
}

async function comfy(url, path, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? (isSaladUrl(url) ? 120000 : 60000);
  const { timeoutMs: _t, headers: extraHeaders, ...fetchOpts } = opts;
  const res = await fetch(`${url}${path}`, {
    ...fetchOpts,
    headers: comfyAuthHeaders(url, extraHeaders || {}),
    signal: fetchOpts.signal || AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ComfyUI ${path} → ${res.status}: ${text.slice(0, 800)}`);
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return Buffer.from(await res.arrayBuffer());
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Read --flag value from ComfyUI process argv (system_stats). */
function argvFlag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

/**
 * Live ComfyUI may use different input/output/models dirs than repo ComfyUI/
 * (e.g. ProdesecStudio AppData). Prefer the running server's paths.
 */
async function resolveLiveComfyDirs(cfg) {
  if (cfg.remote) {
    return {
      inputDir: null,
      outputDir: null,
      modelsDir: null,
    };
  }
  const stats = await comfy(cfg.comfyUrl, "/system_stats");
  const argv = stats?.system?.argv || [];
  const inputDir = argvFlag(argv, "--input-directory");
  const outputDir = argvFlag(argv, "--output-directory");
  const modelsDir = argvFlag(argv, "--models-directory");

  const resolved = {
    inputDir: inputDir || join(cfg.comfyRoot, "input"),
    outputDir: outputDir || join(cfg.comfyRoot, "output"),
    modelsDir: modelsDir || join(cfg.comfyRoot, "models"),
  };

  if (inputDir || outputDir || modelsDir) {
    console.log("Live ComfyUI paths (from /system_stats):");
    console.log(`  input:  ${resolved.inputDir}`);
    console.log(`  output: ${resolved.outputDir}`);
    console.log(`  models: ${resolved.modelsDir}`);
  }

  return resolved;
}

async function listDatasetImages(datasetDir) {
  const files = await readdir(datasetDir);
  const images = files
    .filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f))
    .sort();
  const pairs = [];
  for (const img of images) {
    const base = img.replace(/\.(png|jpg|jpeg|webp)$/i, "");
    const txtName = `${base}.txt`;
    const imgPath = join(datasetDir, img);
    const txtPath = join(datasetDir, txtName);
    if (!existsSync(txtPath)) {
      console.warn(`  warn: missing caption for ${img} — using trigger caption`);
    }
    pairs.push({
      img,
      imgPath,
      txtName,
      txtPath: existsSync(txtPath) ? txtPath : null,
    });
  }
  return pairs;
}

async function uploadInputFile(cfg, filename, buffer, mime) {
  const form = new FormData();
  form.append("image", new Blob([buffer], { type: mime }), filename);
  form.append("overwrite", "true");
  form.append("type", "input");
  form.append("subfolder", cfg.datasetFolder);
  const res = await fetch(`${cfg.comfyUrl}/upload/image`, {
    method: "POST",
    headers: comfyAuthHeaders(cfg.comfyUrl),
    body: form,
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    throw new Error(`Upload ${filename} failed: ${(await res.text()).slice(0, 400)}`);
  }
  return res.json();
}

/**
 * Sync local dataset → Salad ComfyUI input/<datasetFolder> via /upload/image.
 */
async function syncDatasetRemote(cfg) {
  const datasetDir = resolve(ROOT, cfg.datasetDir);
  if (!existsSync(datasetDir)) {
    throw new Error(`Dataset not found: ${datasetDir}\nRun: npm run generate`);
  }
  const pairs = await listDatasetImages(datasetDir);
  if (pairs.length === 0) {
    throw new Error(`No images in ${datasetDir}`);
  }

  // Salad input dirs can't be wiped via API — use a fresh subfolder each run
  // so leftover probe/junk files (tiny PNGs) don't break MakeTrainingDataset.
  cfg.datasetFolder = `${cfg.datasetFolder}_${Date.now()}`;

  console.log(`Uploading ${pairs.length} pairs → Salad input/${cfg.datasetFolder}`);
  let n = 0;
  for (const p of pairs) {
    const imgBuf = await readFile(p.imgPath);
    const mime = /\.png$/i.test(p.img)
      ? "image/png"
      : /\.webp$/i.test(p.img)
        ? "image/webp"
        : "image/jpeg";
    await uploadInputFile(cfg, p.img, imgBuf, mime);
    const caption = p.txtPath
      ? await readFile(p.txtPath, "utf8")
      : cfg.trigger || "";
    await uploadInputFile(
      cfg,
      p.txtName,
      Buffer.from(caption, "utf8"),
      "text/plain",
    );
    n += 1;
    if (n % 5 === 0 || n === pairs.length) {
      console.log(`  uploaded ${n}/${pairs.length}`);
    }
  }
  return { destDir: `input/${cfg.datasetFolder}`, count: pairs.length };
}

/**
 * Sync local dataset/images → <live ComfyUI input>/<folder>
 * Clears previous png/txt in that folder first (keeps other files).
 */
async function syncDatasetLocal(cfg) {
  const datasetDir = resolve(ROOT, cfg.datasetDir);
  if (!existsSync(datasetDir)) {
    throw new Error(`Dataset not found: ${datasetDir}\nRun: npm run generate`);
  }

  const pairs = await listDatasetImages(datasetDir);
  if (pairs.length === 0) {
    throw new Error(`No images in ${datasetDir}`);
  }

  const inputRoot = cfg.inputDir || join(cfg.comfyRoot, "input");
  const destDir = join(inputRoot, cfg.datasetFolder);
  await mkdir(destDir, { recursive: true });

  const existing = await readdir(destDir);
  for (const f of existing) {
    if (/\.(png|jpg|jpeg|webp|txt)$/i.test(f)) {
      await rm(join(destDir, f), { force: true });
    }
  }

  for (const p of pairs) {
    await copyFile(p.imgPath, join(destDir, p.img));
    if (p.txtPath) {
      await copyFile(p.txtPath, join(destDir, p.txtName));
    } else {
      await writeFile(join(destDir, p.txtName), cfg.trigger || "", "utf8");
    }
  }

  console.log(`Synced ${pairs.length} image+caption pairs →`);
  console.log(`  ${destDir}`);
  return { destDir, count: pairs.length };
}

async function listTrainFolders(cfg) {
  const info = await comfy(cfg.comfyUrl, "/object_info/LoadImageTextDataSetFromFolder");
  return (
    info?.LoadImageTextDataSetFromFolder?.input?.required?.folder?.[1]?.options ||
    []
  );
}

async function ensureFolderVisible(cfg) {
  let opts = await listTrainFolders(cfg);
  if (opts.includes(cfg.datasetFolder)) return opts;

  for (let i = 0; i < 8; i++) {
    await sleep(1000);
    opts = await listTrainFolders(cfg);
    if (opts.includes(cfg.datasetFolder)) return opts;
  }

  console.warn(
    `\nFolder "${cfg.datasetFolder}" not in ComfyUI's folder combo yet.`,
  );
  throw new Error(
    `ComfyUI has not refreshed its input-folder list.\n` +
      `Known folders: ${opts.slice(0, 12).join(", ")}`,
  );
}

function buildTrainWorkflow(cfg) {
  const offloading = !!cfg.offloading;
  // Comfy TrainLoraNode with offloading=true + bypass_mode=false deadlocks / crawls on CPU.
  const bypassMode = !!(cfg.bypassMode || offloading);
  return {
    "4": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: cfg.checkpoint },
    },
    "20": {
      class_type: "LoadImageTextDataSetFromFolder",
      inputs: { folder: cfg.datasetFolder },
    },
    "21": {
      class_type: "MakeTrainingDataset",
      inputs: {
        images: ["20", 0],
        texts: ["20", 1],
        vae: ["4", 2],
        clip: ["4", 1],
      },
    },
    "22": {
      class_type: "TrainLoraNode",
      inputs: {
        model: ["4", 0],
        latents: ["21", 0],
        positive: ["21", 1],
        batch_size: cfg.batchSize,
        grad_accumulation_steps: cfg.gradAccumulationSteps,
        steps: cfg.steps,
        learning_rate: cfg.learningRate,
        rank: cfg.rank,
        optimizer: cfg.optimizer,
        loss_function: cfg.lossFunction,
        seed: cfg.seed,
        training_dtype: cfg.trainingDtype,
        lora_dtype: cfg.loraDtype,
        quantized_backward: false,
        algorithm: cfg.algorithm,
        gradient_checkpointing: cfg.gradientCheckpointing,
        checkpoint_depth: cfg.checkpointDepth,
        offloading,
        existing_lora: cfg.existingLora || "[None]",
        bucket_mode: false,
        bypass_mode: bypassMode,
      },
    },
    "23": {
      class_type: "SaveLoRA",
      inputs: {
        lora: ["22", 0],
        prefix: `loras/${cfg.loraName}`,
        steps: ["22", 2],
      },
    },
    "24": {
      class_type: "LossGraphNode",
      inputs: {
        loss: ["22", 1],
        filename_prefix: `loras/${cfg.loraName}_loss`,
      },
    },
  };
}

async function queueAndWait(url, workflow, { maxWaitMs = null } = {}) {
  const clientId = randomUUID();
  const queued = await comfy(url, "/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    // Native Comfy returns prompt_id immediately; keep under Salad gateway limit.
    timeoutMs: isSaladUrl(url) ? 95_000 : 60_000,
  });

  if (queued.node_errors && Object.keys(queued.node_errors).length) {
    throw new Error(`Queue rejected: ${JSON.stringify(queued.node_errors).slice(0, 1000)}`);
  }

  const promptId = queued.prompt_id;
  if (!promptId) {
    throw new Error(
      `Unexpected /prompt response: ${JSON.stringify(queued).slice(0, 500)}`,
    );
  }
  console.log(`Queued prompt_id=${promptId}`);
  console.log("Training… (this can take a while on Salad)");

  // Default caps: Salad 40m, local 90m — never wait forever on a wedged TrainLoraNode.
  const limitMs =
    maxWaitMs ??
    (isSaladUrl(url) ? 40 * 60_000 : 90 * 60_000);

  let lastMsg = "";
  const started = Date.now();
  for (;;) {
    if (Date.now() - started > limitMs) {
      try {
        await comfy(url, "/interrupt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          timeoutMs: 15_000,
        });
      } catch {
        /* Salad may already be hung */
      }
      throw new Error(
        `Training timed out after ${Math.round(limitMs / 60000)}m (prompt ${promptId}). ` +
          `Often caused by offloading=true without bypass_mode. Restart Comfy/Salad if the server is unresponsive.`,
      );
    }
    await sleep(isSaladUrl(url) ? 4000 : 2000);
    const hist = await comfy(url, `/history/${promptId}`);
    const entry = hist[promptId];
    if (!entry) {
      const q = await comfy(url, "/queue");
      const running = q.queue_running?.length || 0;
      const pending = q.queue_pending?.length || 0;
      const mins = ((Date.now() - started) / 60000).toFixed(1);
      const msg = `waiting ${mins}m (running=${running}, pending=${pending})`;
      if (msg !== lastMsg) {
        console.log(`  ${msg}`);
        lastMsg = msg;
      }
      continue;
    }

    const status = entry.status?.status_str;
    if (status === "error") {
      const msgs = entry.status?.messages || [];
      throw new Error(`Training failed: ${JSON.stringify(msgs).slice(0, 1500)}`);
    }

    if (entry.outputs || status === "success") {
      return entry;
    }
  }
}

async function findNewestLora(outputLorasDir, loraName) {
  if (!existsSync(outputLorasDir)) return null;
  const files = (await readdir(outputLorasDir))
    .filter(
      (f) =>
        f.toLowerCase().endsWith(".safetensors") &&
        (!loraName || f.toLowerCase().startsWith(loraName.toLowerCase())),
    )
    .map((f) => join(outputLorasDir, f));

  if (files.length === 0) return null;

  const { statSync } = await import("fs");
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return files[0];
}

function collectOutputFiles(entry) {
  const files = [];
  const outputs = entry?.outputs || {};
  for (const node of Object.values(outputs)) {
    for (const key of Object.keys(node || {})) {
      const arr = node[key];
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        if (item?.filename) files.push(item);
      }
    }
  }
  return files;
}

async function downloadViewFile(cfg, meta, destPath) {
  const qs = new URLSearchParams({
    filename: meta.filename,
    subfolder: meta.subfolder || "",
    type: meta.type || "output",
  });
  const buf = await comfy(cfg.comfyUrl, `/view?${qs}`, { timeoutMs: 300000 });
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, buf);
  return destPath;
}

/**
 * Pull trained LoRA off Salad (or find local output) into project/loras.
 */
async function recoverTrainedLora(cfg, entry) {
  const projectDir = join(ROOT, "loras");
  await mkdir(projectDir, { recursive: true });
  const dest = join(projectDir, `${cfg.loraName}.safetensors`);

  if (cfg.remote) {
    const files = collectOutputFiles(entry);
    const loraMeta =
      files.find(
        (f) =>
          /\.safetensors$/i.test(f.filename || "") &&
          String(f.filename).toLowerCase().includes(cfg.loraName.toLowerCase()),
      ) ||
      files.find((f) => /\.safetensors$/i.test(f.filename || ""));

    const candidates = [];
    if (loraMeta) candidates.push(loraMeta);
    // Common SaveLoRA locations
    candidates.push(
      { filename: `${cfg.loraName}.safetensors`, subfolder: "loras", type: "output" },
      {
        filename: `${cfg.loraName}.safetensors`,
        subfolder: "",
        type: "output",
      },
    );

    let lastErr = null;
    for (const meta of candidates) {
      try {
        await downloadViewFile(cfg, meta, dest);
        console.log(`Downloaded from Salad → ${dest}`);
        return dest;
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(
      `Could not download LoRA from Salad. Last error: ${lastErr?.message || lastErr}`,
    );
  }

  const outputLorasDir = join(cfg.outputDir, "loras");
  await sleep(500);
  let trainedPath = await findNewestLora(outputLorasDir, cfg.loraName);
  if (!trainedPath) trainedPath = await findNewestLora(outputLorasDir, "");
  if (!trainedPath) {
    throw new Error(`Could not find saved LoRA under ${outputLorasDir}`);
  }
  return trainedPath;
}

/** Windows-safe install: old LoRA in models/loras is often locked by ComfyUI. */
async function installLoraFile(src, dest) {
  const tmp = `${dest}.tmp`;
  await copyFile(src, tmp);
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      if (existsSync(dest)) await unlink(dest);
      await rename(tmp, dest);
      return dest;
    } catch (err) {
      if (attempt === 4) {
        const alt = dest.replace(
          /\.safetensors$/i,
          `_new_${Date.now()}.safetensors`,
        );
        try {
          if (existsSync(tmp)) await rename(tmp, alt);
          else await copyFile(src, alt);
        } catch {
          await copyFile(src, alt);
        }
        console.warn(
          `Could not overwrite ${dest} (${err.message || err}).\n  Saved as: ${alt}`,
        );
        return alt;
      }
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  return dest;
}

async function copyOutputs(cfg, trainedPath) {
  const copies = [];

  if (cfg.copyToProject || cfg.remote) {
    const destDir = join(ROOT, "loras");
    await mkdir(destDir, { recursive: true });
    const dest = join(destDir, `${cfg.loraName}.safetensors`);
    if (resolve(trainedPath) !== resolve(dest)) {
      copies.push(await installLoraFile(trainedPath, dest));
    } else {
      copies.push(dest);
    }
  }

  if (cfg.copyToModelsLoras && !cfg.remote) {
    const destDir = join(cfg.modelsDir || join(cfg.comfyRoot, "models"), "loras");
    await mkdir(destDir, { recursive: true });
    const dest = join(destDir, `${cfg.loraName}.safetensors`);
    copies.push(await installLoraFile(trainedPath, dest));
  }

  return copies;
}

async function main() {
  const cfg = await loadConfig();

  console.log(`Character: ${cfg.name}  trigger: ${cfg.trigger}`);
  console.log(`Checkpoint: ${cfg.checkpoint}`);
  console.log(`LoRA name:  ${cfg.loraName}`);
  console.log(`Steps:      ${cfg.steps}  rank: ${cfg.rank}  lr: ${cfg.learningRate}`);
  console.log(
    `Train opts: offloading=${!!cfg.offloading} bypass=${!!cfg.bypassMode}${
      cfg.remote ? " (Salad forces full GPU load)" : ""
    }`,
  );
  console.log(`ComfyUI:    ${cfg.comfyUrl}${cfg.remote ? " (Salad)" : ""}`);

  if (!cfg.remote && !existsSync(cfg.comfyRoot)) {
    throw new Error(`comfyRoot not found: ${cfg.comfyRoot}`);
  }

  const live = await resolveLiveComfyDirs(cfg);
  cfg.inputDir = live.inputDir;
  cfg.outputDir = live.outputDir;
  cfg.modelsDir = live.modelsDir;

  const { count } = cfg.remote
    ? await syncDatasetRemote(cfg)
    : await syncDatasetLocal(cfg);
  if (count < 5) {
    console.warn(
      `\nWarning: only ${count} images — LoRA quality will be limited. Aim for 15–30+.`,
    );
  }

  await ensureFolderVisible(cfg);

  if (SYNC_ONLY || DRY_RUN) {
    console.log(DRY_RUN ? "\nDry run — not training." : "\nSync only — not training.");
    if (DRY_RUN) {
      console.log("Workflow preview:");
      console.log(JSON.stringify(buildTrainWorkflow(cfg), null, 2).slice(0, 1200) + "…");
    }
    return;
  }

  const workflow = buildTrainWorkflow(cfg);
  const started = Date.now();
  const entry = await queueAndWait(cfg.comfyUrl, workflow);
  const mins = ((Date.now() - started) / 60000).toFixed(1);
  console.log(`Training finished in ${mins} min`);

  const trainedPath = await recoverTrainedLora(cfg, entry);
  console.log(`\nSaved:\n  ${trainedPath}`);
  const copies = await copyOutputs(cfg, trainedPath);
  for (const c of copies) console.log(`Copied → ${c}`);

  console.log(`\nUse with trigger word: ${cfg.trigger}`);
  console.log(`LoRA file: ${cfg.loraName}.safetensors`);
}

main().catch((err) => {
  console.error("\nFailed:", err.message || err);
  process.exit(1);
});
