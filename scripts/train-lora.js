import { mkdir, readFile, writeFile, copyFile, readdir, rm, unlink, rename } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname, basename, extname, resolve } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

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
  const comfyRoot = resolve(
    ROOT,
    // Allow absolute paths; otherwise resolve relative to repo root.
    comfyRootRaw,
  );

  return {
    ...train,
    comfyRoot,
    comfyUrl: train.comfyUrl || character.comfyUrl || "http://127.0.0.1:8188",
    checkpoint: train.checkpoint || character.checkpoint || "realcartoon3d_v15.safetensors",
    loraName: train.loraName || `${trigger}_character_v1`,
    datasetFolder: train.datasetFolder || `character_lora_${trigger}`,
    trigger,
    name,
    steps: stepsOverride ?? train.steps ?? 200,
  };
}

async function comfy(url, path, opts = {}) {
  const res = await fetch(`${url}${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ComfyUI ${path} → ${res.status}: ${text.slice(0, 800)}`);
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res.arrayBuffer();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
      console.warn(`  warn: missing caption for ${img} — using empty caption`);
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

/**
 * Sync local dataset/images → ComfyUI/input/<folder>
 * Clears previous png/txt in that folder first (keeps other files).
 */
async function syncDataset(cfg) {
  const datasetDir = resolve(ROOT, cfg.datasetDir);
  if (!existsSync(datasetDir)) {
    throw new Error(`Dataset not found: ${datasetDir}\nRun: npm run generate`);
  }

  const pairs = await listDatasetImages(datasetDir);
  if (pairs.length === 0) {
    throw new Error(`No images in ${datasetDir}`);
  }

  const inputRoot = join(cfg.comfyRoot, "input");
  const destDir = join(inputRoot, cfg.datasetFolder);
  await mkdir(destDir, { recursive: true });

  // Clear old image/caption pairs in destination
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

async function ensureFolderVisible(cfg) {
  const info = await comfy(cfg.comfyUrl, "/object_info/LoadImageTextDataSetFromFolder");
  const opts =
    info?.LoadImageTextDataSetFromFolder?.input?.required?.folder?.[1]?.options ||
    [];
  if (!opts.includes(cfg.datasetFolder)) {
    console.warn(
      `\nNote: folder "${cfg.datasetFolder}" is not in ComfyUI's cached folder list yet.`,
    );
    console.warn(
      "If queue fails, restart ComfyUI once, or set datasetFolder in train-config.json",
    );
    console.warn(`to an existing folder such as: ${opts.slice(0, 5).join(", ")}`);
  }
  return opts;
}

function buildTrainWorkflow(cfg) {
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
        offloading: cfg.offloading,
        existing_lora: cfg.existingLora || "[None]",
        bucket_mode: false,
        bypass_mode: false,
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

async function queueAndWait(url, workflow) {
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
  console.log(`Queued prompt_id=${promptId}`);
  console.log("Training… (this can take several minutes)");

  let lastMsg = "";
  for (;;) {
    await sleep(2000);
    const hist = await comfy(url, `/history/${promptId}`);
    const entry = hist[promptId];
    if (!entry) {
      // also peek queue
      const q = await comfy(url, "/queue");
      const running = q.queue_running?.length || 0;
      const pending = q.queue_pending?.length || 0;
      const msg = `waiting (running=${running}, pending=${pending})`;
      if (msg !== lastMsg) {
        console.log(`  ${msg}`);
        lastMsg = msg;
      }
      continue;
    }

    const status = entry.status?.status_str;
    if (status === "error") {
      const msgs = entry.status?.messages || [];
      throw new Error(`Training failed: ${JSON.stringify(msgs).slice(0, 1200)}`);
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
        f.toLowerCase().startsWith(loraName.toLowerCase()),
    )
    .map((f) => join(outputLorasDir, f));

  if (files.length === 0) return null;

  const { statSync } = await import("fs");
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return files[0];
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
        console.warn(
          "  Tip: unload the LoRA / free VRAM in ComfyUI, then rename the _new_ file.",
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

  if (cfg.copyToModelsLoras) {
    const destDir = join(cfg.comfyRoot, "models", "loras");
    await mkdir(destDir, { recursive: true });
    const dest = join(destDir, `${cfg.loraName}.safetensors`);
    copies.push(await installLoraFile(trainedPath, dest));
  }

  if (cfg.copyToProject) {
    const destDir = join(ROOT, "loras");
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
  console.log(`ComfyUI:    ${cfg.comfyUrl}`);

  if (!existsSync(cfg.comfyRoot)) {
    throw new Error(`comfyRoot not found: ${cfg.comfyRoot}`);
  }

  await comfy(cfg.comfyUrl, "/system_stats");

  const { count } = await syncDataset(cfg);
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
  await queueAndWait(cfg.comfyUrl, workflow);
  const mins = ((Date.now() - started) / 60000).toFixed(1);
  console.log(`Training finished in ${mins} min`);

  const outputLorasDir = join(cfg.comfyRoot, "output", "loras");
  // Give filesystem a moment
  await sleep(500);
  let trainedPath = await findNewestLora(outputLorasDir, cfg.loraName);
  if (!trainedPath) {
    // fallback: any new safetensors in output/loras
    trainedPath = await findNewestLora(outputLorasDir, "");
  }

  if (!trainedPath) {
    console.warn(`\nCould not find saved LoRA under ${outputLorasDir}`);
    console.warn("Check ComfyUI output/loras manually.");
    return;
  }

  console.log(`\nSaved by ComfyUI:\n  ${trainedPath}`);
  const copies = await copyOutputs(cfg, trainedPath);
  for (const c of copies) console.log(`Copied → ${c}`);

  console.log(`\nUse in ComfyUI with trigger word: ${cfg.trigger}`);
  console.log(`LoRA file: ${cfg.loraName}.safetensors`);
}

main().catch((err) => {
  console.error("\nFailed:", err.message || err);
  process.exit(1);
});
