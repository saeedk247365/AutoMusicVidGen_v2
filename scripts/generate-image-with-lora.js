import { mkdir, readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import { platform } from "os";
import { randomUUID } from "crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHAR_PATH = join(ROOT, "characters", "tomchr.json");
const OUT_DIR = join(ROOT, "generations");

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
    throw new Error(`ComfyUI ${path} → ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res.arrayBuffer();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function queueAndWait(url, workflow, timeoutMs = 180000) {
  const clientId = randomUUID();
  const { prompt_id, node_errors } = await comfy(url, "/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
  });
  if (node_errors && Object.keys(node_errors).length) {
    throw new Error(`Queue rejected: ${JSON.stringify(node_errors).slice(0, 800)}`);
  }
  console.log(`Queued ${prompt_id}`);

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
      throw new Error(
        `Timed out after ${Math.round(timeoutMs / 1000)}s — ComfyUI/GPU may be stuck. Restart ComfyUI and try again.`,
      );
    }

    await sleep(700);
    const hist = await comfy(url, `/history/${prompt_id}`);
    const entry = hist[prompt_id];
    if (!entry) {
      if (Date.now() - lastLog > 5000) {
        const q = await comfy(url, "/queue");
        console.log(
          `  waiting… running=${q.queue_running?.length || 0} pending=${q.queue_pending?.length || 0}`,
        );
        lastLog = Date.now();
      }
      continue;
    }
    if (entry.status?.status_str === "error") {
      throw new Error(`ComfyUI error: ${JSON.stringify(entry.status).slice(0, 800)}`);
    }
    if (entry.outputs) {
      for (const nodeId of Object.keys(entry.outputs)) {
        const imgs = entry.outputs[nodeId].images;
        if (imgs?.length) {
          const img = imgs[0];
          const qs = new URLSearchParams({
            filename: img.filename,
            subfolder: img.subfolder || "",
            type: img.type || "output",
          });
          return Buffer.from(await comfy(url, `/view?${qs}`));
        }
      }
    }
  }
}

function buildWorkflow(cfg, prompt, negative, seed) {
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
      inputs: {
        width: cfg.width,
        height: cfg.height,
        batch_size: 1,
      },
    },
    "6": {
      class_type: "KSampler",
      inputs: {
        seed,
        steps: cfg.steps,
        cfg: cfg.cfg,
        sampler_name: cfg.sampler,
        scheduler: cfg.scheduler,
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
      inputs: {
        filename_prefix: `tomchr_gen`,
        images: ["7", 0],
      },
    },
  };
}

async function main() {
  if (!existsSync(CHAR_PATH)) {
    throw new Error("characters/tomchr.json missing");
  }
  const character = JSON.parse(stripBom(await readFile(CHAR_PATH, "utf8")));
  const test = has("--test");

  const cfg = {
    comfyUrl: character.comfyUrl || "http://127.0.0.1:8888",
    checkpoint: character.checkpoint || "realcartoon3d_v15.safetensors",
    loraName: flag("--lora", "tomchr_character_v1.safetensors"),
    loraStrength: Number(flag("--strength", "0.85")),
    width: Number(flag("--width", String(character.width || 512))),
    height: Number(flag("--height", String(character.height || 768))),
    steps: Number(flag("--steps", test ? "20" : String(character.steps || 28))),
    cfg: Number(flag("--cfg", String(character.cfg || 7))),
    sampler: character.sampler || "dpmpp_2m",
    scheduler: character.scheduler || "karras",
    openImages: !has("--no-open"),
  };

  const defaultPrompt = [
    character.trigger,
    character.appearance,
    character.outfit,
    "front view, standing, looking at camera, full body",
    character.style,
  ]
    .filter(Boolean)
    .join(", ");

  const prompt = flag("--prompt", test
    ? `${character.trigger}, cute cartoon boy Tom, navy blue t-shirt, navy pants, white sneakers, standing front view, flat 2D anime, plain gray background`
    : defaultPrompt);

  const negative = flag("--negative", character.negative || "blurry, low quality, watermark");
  const seed = flag("--seed")
    ? Number(flag("--seed"))
    : test
      ? 42
      : (character.seed || Math.floor(Math.random() * 1e9));

  const name = flag("--name", test ? "test_front" : `gen_${Date.now()}`);

  console.log(`LoRA:     ${cfg.loraName} @ ${cfg.loraStrength}`);
  console.log(`Seed:     ${seed}`);
  console.log(`Steps:    ${cfg.steps}`);
  console.log(`Prompt:   ${prompt.slice(0, 140)}${prompt.length > 140 ? "…" : ""}`);

  await comfy(cfg.comfyUrl, "/system_stats");
  await mkdir(OUT_DIR, { recursive: true });

  const buf = await queueAndWait(
    cfg.comfyUrl,
    buildWorkflow(cfg, prompt, negative, seed),
  );

  const outPath = join(OUT_DIR, `${name}.png`);
  await writeFile(outPath, buf);
  console.log(`Saved: ${outPath}`);
  if (cfg.openImages) openFile(outPath);
}

main().catch((err) => {
  console.error("\nFailed:", err.message || err);
  process.exit(1);
});
