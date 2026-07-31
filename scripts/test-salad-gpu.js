/**
 * Probe Salad / local Comfy: health → simple image → optional I2V if Wan nodes exist.
 *
 *   node scripts/test-salad-gpu.js
 *   node scripts/test-salad-gpu.js --backend salad
 *   node scripts/test-salad-gpu.js --skip-animate
 */
import { mkdir, writeFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  comfy,
  queueAndWait,
  extractImageFromHistory,
  uploadImage,
  parseArgs,
} from "../lib/comfy-client.js";
import {
  gpuStatus,
  setGpuBackend,
  resolveComfyUrl,
  isSaladUrl,
} from "../lib/gpu-backend.js";
import { isComfyUp } from "../lib/ensure-comfy.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "batches", "_salad_probe");

function simpleTxt2ImgWorkflow({ prompt, seed = 42 }) {
  // Minimal SD1.5-style graph common to local + many Salad recipes
  return {
    "3": {
      class_type: "KSampler",
      inputs: {
        seed,
        steps: 12,
        cfg: 7,
        sampler_name: "euler",
        scheduler: "normal",
        denoise: 1,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
      },
    },
    "4": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: "realcartoon3d_v15.safetensors" },
    },
    "5": {
      class_type: "EmptyLatentImage",
      inputs: { width: 512, height: 512, batch_size: 1 },
    },
    "6": {
      class_type: "CLIPTextEncode",
      inputs: { text: prompt, clip: ["4", 1] },
    },
    "7": {
      class_type: "CLIPTextEncode",
      inputs: { text: "blurry, low quality, text, watermark", clip: ["4", 1] },
    },
    "8": {
      class_type: "VAEDecode",
      inputs: { samples: ["3", 0], vae: ["4", 2] },
    },
    "9": {
      class_type: "SaveImage",
      inputs: { filename_prefix: "salad_probe", images: ["8", 0] },
    },
  };
}

async function main() {
  const { flag, has } = parseArgs();
  if (flag("--backend") || has("--salad")) {
    const want = has("--salad") ? "salad" : flag("--backend");
    const switched = setGpuBackend(want);
    if (!switched.ok) {
      console.error(switched.error);
      process.exit(2);
    }
  }

  const status = gpuStatus();
  const url = resolveComfyUrl(flag("--comfy", null));
  console.log("GPU status:", JSON.stringify(status, null, 2));
  console.log("Using Comfy URL:", url, isSaladUrl(url) ? "(Salad)" : "(local)");

  if (status.backend === "salad" && !status.saladConfigured) {
    console.error(
      "\nSalad not configured. Set SALAD_API_KEY and SALAD_COMFY_URL in .env\n" +
        "Get the gateway URL from portal.salad.com → your ComfyUI container group → Gateway.",
    );
    process.exit(2);
  }

  const t0 = Date.now();
  const up = await isComfyUp(url);
  const healthMs = Date.now() - t0;
  console.log(`Health check: ${up ? "OK" : "FAIL"} (${healthMs}ms)`);
  if (!up) {
    // Try listing object_info as fallback for some gateways
    try {
      const t = Date.now();
      await comfy(url, "/object_info", { timeoutMs: 30000 });
      console.log(`object_info OK (${Date.now() - t}ms) — treating as up`);
    } catch (err) {
      console.error("Cannot reach Comfy:", err.message || err);
      process.exit(1);
    }
  }

  await mkdir(OUT_DIR, { recursive: true });

  const prompt =
    "cute cartoon toddler boy waving, mint green shirt, soft pastel room, simple flat anime style";
  console.log("\n── Image generation ──");
  const imgStart = Date.now();
  let imgBuf;
  try {
    const entry = await queueAndWait(
      url,
      simpleTxt2ImgWorkflow({ prompt, seed: Date.now() % 1e9 }),
      isSaladUrl(url) ? 180000 : 300000,
      "salad-probe-image",
    );
    imgBuf = await extractImageFromHistory(url, entry);
  } catch (err) {
    console.error("Image gen failed:", err.message || err);
    console.error(
      "Tip: Salad recipe checkpoints differ (e.g. dreamshaper / flux). Deploy a container that has your local checkpoints, or edit the probe workflow ckpt_name.",
    );
    process.exit(1);
  }
  const imgMs = Date.now() - imgStart;
  const imgPath = join(OUT_DIR, `probe_${Date.now()}.png`);
  await writeFile(imgPath, imgBuf);
  console.log(`Image OK in ${(imgMs / 1000).toFixed(1)}s → ${imgPath}`);

  if (has("--skip-animate")) {
    console.log("\nSkipped animate (--skip-animate).");
    console.log(
      JSON.stringify({ healthMs, imageMs: imgMs, imagePath: imgPath }, null, 2),
    );
    return;
  }

  console.log("\n── Animate probe (upload + check Wan nodes) ──");
  const anStart = Date.now();
  try {
    const uploaded = await uploadImage(url, "salad_probe_in.png", imgBuf);
    console.log("Uploaded:", uploaded?.name || uploaded);
    let hasWan = false;
    try {
      const info = await comfy(url, "/object_info", { timeoutMs: 60000 });
      hasWan = Object.keys(info || {}).some((k) => /wan/i.test(k));
      console.log(`Wan-related nodes present: ${hasWan}`);
    } catch (err) {
      console.warn("Could not read object_info:", err.message || err);
    }
    if (!hasWan) {
      console.log(
        "No Wan I2V nodes on this endpoint — image-only Salad recipe is fine for stills, but kids-hit animate needs a Wan-capable Comfy container.",
      );
      console.log(
        JSON.stringify(
          {
            healthMs,
            imageMs: imgMs,
            imagePath: imgPath,
            animateMs: Date.now() - anStart,
            animate: "skipped_no_wan",
          },
          null,
          2,
        ),
      );
      return;
    }
    console.log(
      "Wan present — full I2V probe not auto-run (workflow is heavy). Use mvid Clips with GPU=Salad once models match.",
    );
    console.log(
      JSON.stringify(
        {
          healthMs,
          imageMs: imgMs,
          imagePath: imgPath,
          animateMs: Date.now() - anStart,
          animate: "wan_detected_not_run",
        },
        null,
        2,
      ),
    );
  } catch (err) {
    console.error("Animate probe failed:", err.message || err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
