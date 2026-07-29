import { mkdir, readFile, writeFile, copyFile } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import { platform } from "os";
import { randomUUID } from "crypto";
import { buildOpenPosePng } from "../lib/openpose-maps.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const args = new Set(argv);
const FACE_ONLY = args.has("--face-only");
const SHOTS_ONLY = args.has("--shots-only");
function flag(name, fallback = null) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
}
const onlyIdx = argv.indexOf("--only");
const ONLY_IDS = onlyIdx >= 0 && argv[onlyIdx + 1]
  ? new Set(argv[onlyIdx + 1].split(",").map((s) => s.trim()).filter(Boolean))
  : null;

const CONFIG_PATH = join(ROOT, flag("--character", "character.json"));
const OUT_DIR = join(ROOT, flag("--out", "dataset"));
const IMAGES_DIR = join(OUT_DIR, "images");
const POSES_DIR = join(OUT_DIR, "poses");
const FACE_LOCK = join(OUT_DIR, "face_lock.png");

async function loadConfigAsync() {
  let raw = await readFile(CONFIG_PATH, "utf8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  return JSON.parse(raw);
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
    const text = await res.text();
    throw new Error(`ComfyUI ${path} → ${res.status}: ${text.slice(0, 500)}`);
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res.arrayBuffer();
}

async function uploadImage(url, filename, buffer) {
  const form = new FormData();
  form.append("image", new Blob([buffer], { type: "image/png" }), filename);
  form.append("overwrite", "true");
  const res = await fetch(`${url}/upload/image`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`Upload failed: ${await res.text()}`);
  return res.json();
}

async function queueAndWait(url, workflow) {
  const clientId = randomUUID();
  const { prompt_id } = await comfy(url, "/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
  });

  for (;;) {
    await sleep(800);
    const hist = await comfy(url, `/history/${prompt_id}`);
    const entry = hist[prompt_id];
    if (!entry) continue;
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
          const buf = await comfy(url, `/view?${qs}`);
          return Buffer.from(buf);
        }
      }
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function characterPrompt(cfg, shot) {
  const angled = shot.angleKey && shot.angleKey !== "front";
  const parts = [
    cfg.trigger,
    cfg.appearance,
    cfg.outfit,
    shot.angle,
    shot.pose,
    angled
      ? "head facing same direction as body, gaze looking forward in body direction, not looking at camera"
      : null,
    "single solitary character only, one child alone, full body centered, empty plain background, no other faces",
    cfg.style,
  ];
  if (shot.bust) {
    parts[4] = shot.pose;
    parts[5] = null;
    parts[6] =
      "close-up bust portrait, head and shoulders only, single character, no other faces";
  }
  return parts.filter(Boolean).join(", ");
}

function captionFor(cfg, shot) {
  return `${cfg.trigger}, ${shot.captionExtra || ""}, ${cfg.appearance}, ${cfg.outfit}, ${cfg.style}`
    .replace(/\s+/g, " ")
    .trim();
}

/** Pass 1 — canonical face lock (no FaceID). */
function faceLockWorkflow(cfg) {
  const prompt = [
    cfg.trigger,
    cfg.appearance,
    "front view close-up bust portrait, head and shoulders, looking at camera, friendly expression",
    cfg.outfit,
    cfg.style,
  ].join(", ");

  return {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: cfg.checkpoint },
    },
    "2": {
      class_type: "CLIPTextEncode",
      inputs: { text: prompt, clip: ["1", 1] },
    },
    "3": {
      class_type: "CLIPTextEncode",
      inputs: { text: cfg.negative, clip: ["1", 1] },
    },
    "4": {
      class_type: "EmptyLatentImage",
      inputs: { width: cfg.width, height: cfg.height, batch_size: 1 },
    },
    "5": {
      class_type: "KSampler",
      inputs: {
        seed: cfg.seed,
        steps: cfg.steps,
        cfg: cfg.cfg,
        sampler_name: cfg.sampler,
        scheduler: cfg.scheduler,
        denoise: 1,
        model: ["1", 0],
        positive: ["2", 0],
        negative: ["3", 0],
        latent_image: ["4", 0],
      },
    },
    "6": {
      class_type: "VAEDecode",
      inputs: { samples: ["5", 0], vae: ["1", 2] },
    },
    "7": {
      class_type: "SaveImage",
      inputs: { filename_prefix: "lora_face_lock", images: ["6", 0] },
    },
  };
}

/** Pass 2 — FaceID + OpenPose controlled shot. */
function shotWorkflow(cfg, shot, faceLockName, poseMapName) {
  const prompt = characterPrompt(cfg, shot);
  const negative = [cfg.negative, shot.extraNegative].filter(Boolean).join(", ");
  const angled = shot.angleKey && shot.angleKey !== "front";
  // FaceID locks a front face and fights non-front head turn — front shots only.
  const useFaceId = shot.useFaceId ?? !angled;
  const poseStrength = angled
    ? Math.min(1, (cfg.openPoseStrength ?? 0.9) + 0.08)
    : cfg.openPoseStrength;
  const faceWeight = shot.faceIdWeight ?? cfg.faceIdWeight;
  const faceWeightV2 = shot.faceIdWeightV2 ?? cfg.faceIdWeightV2;
  const faceEnd = shot.faceIdEnd ?? 1;
  const modelOut = useFaceId ? ["9", 0] : ["1", 0];

  const workflow = {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: cfg.checkpoint },
    },
    "2": {
      class_type: "CLIPTextEncode",
      inputs: { text: prompt, clip: ["1", 1] },
    },
    "3": {
      class_type: "CLIPTextEncode",
      inputs: { text: negative, clip: ["1", 1] },
    },
    "5": {
      class_type: "LoadImage",
      inputs: { image: poseMapName },
    },
    "10": {
      class_type: "ControlNetLoader",
      inputs: { control_net_name: "control_v11p_sd15_openpose_fp16.safetensors" },
    },
    "11": {
      class_type: "ControlNetApplyAdvanced",
      inputs: {
        positive: ["2", 0],
        negative: ["3", 0],
        control_net: ["10", 0],
        image: ["5", 0],
        strength: poseStrength,
        start_percent: 0,
        end_percent: 0.95,
      },
    },
    "12": {
      class_type: "EmptyLatentImage",
      inputs: { width: cfg.width, height: cfg.height, batch_size: 1 },
    },
    "13": {
      class_type: "KSampler",
      inputs: {
        seed: cfg.seed + (shot.seedOffset || 0),
        steps: cfg.steps,
        cfg: cfg.cfg,
        sampler_name: cfg.sampler,
        scheduler: cfg.scheduler,
        denoise: 1,
        model: modelOut,
        positive: ["11", 0],
        negative: ["11", 1],
        latent_image: ["12", 0],
      },
    },
    "14": {
      class_type: "VAEDecode",
      inputs: { samples: ["13", 0], vae: ["1", 2] },
    },
    "15": {
      class_type: "SaveImage",
      inputs: {
        filename_prefix: `lora_${shot.id}`,
        images: ["14", 0],
      },
    },
  };

  if (useFaceId) {
    workflow["4"] = {
      class_type: "LoadImage",
      inputs: { image: faceLockName },
    };
    workflow["6"] = {
      class_type: "IPAdapterUnifiedLoaderFaceID",
      inputs: {
        model: ["1", 0],
        preset: "FACEID PLUS V2",
        lora_strength: 0.7,
        provider: "CUDA",
      },
    };
    workflow["7"] = {
      class_type: "CLIPVisionLoader",
      inputs: { clip_name: "CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors" },
    };
    workflow["8"] = {
      class_type: "IPAdapterInsightFaceLoader",
      inputs: { provider: "CUDA", model_name: "buffalo_l" },
    };
    workflow["9"] = {
      class_type: "IPAdapterFaceID",
      inputs: {
        model: ["6", 0],
        ipadapter: ["6", 1],
        image: ["4", 0],
        weight: faceWeight,
        weight_faceidv2: faceWeightV2,
        weight_type: "linear",
        combine_embeds: "concat",
        start_at: 0,
        end_at: faceEnd,
        embeds_scaling: "V only",
        clip_vision: ["7", 0],
        insightface: ["8", 0],
      },
    };
  }

  return workflow;
}

/** Generate a featureless mannequin guided by a synthetic OpenPose map. */
function mannequinWorkflow(cfg, shot, poseMapName) {
  const prompt = [
    "featureless gray plastic mannequin, smooth blank face, no hair, no clothes",
    shot.angle,
    shot.pose,
    "single mannequin only, full body, plain white background, studio photo",
  ].join(", ");
  const negative =
    "detailed face, eyes, hair, clothes, multiple people, character sheet, collage, text, watermark";

  return {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: cfg.checkpoint },
    },
    "2": {
      class_type: "CLIPTextEncode",
      inputs: { text: prompt, clip: ["1", 1] },
    },
    "3": {
      class_type: "CLIPTextEncode",
      inputs: { text: negative, clip: ["1", 1] },
    },
    "5": {
      class_type: "LoadImage",
      inputs: { image: poseMapName },
    },
    "10": {
      class_type: "ControlNetLoader",
      inputs: { control_net_name: "control_v11p_sd15_openpose_fp16.safetensors" },
    },
    "11": {
      class_type: "ControlNetApplyAdvanced",
      inputs: {
        positive: ["2", 0],
        negative: ["3", 0],
        control_net: ["10", 0],
        image: ["5", 0],
        strength: 1.0,
        start_percent: 0,
        end_percent: 1.0,
      },
    },
    "12": {
      class_type: "EmptyLatentImage",
      inputs: { width: cfg.width, height: cfg.height, batch_size: 1 },
    },
    "13": {
      class_type: "KSampler",
      inputs: {
        seed: cfg.seed + 91 + (shot.seedOffset || 0),
        steps: 20,
        cfg: 6,
        sampler_name: cfg.sampler,
        scheduler: cfg.scheduler,
        denoise: 1,
        model: ["1", 0],
        positive: ["11", 0],
        negative: ["11", 1],
        latent_image: ["12", 0],
      },
    },
    "14": {
      class_type: "VAEDecode",
      inputs: { samples: ["13", 0], vae: ["1", 2] },
    },
    "15": {
      class_type: "SaveImage",
      inputs: {
        filename_prefix: `lora_mannequin_${shot.id}`,
        images: ["14", 0],
      },
    },
  };
}

/** Extract a real OpenPose map from a mannequin image. */
function openPoseExtractWorkflow(mannequinName) {
  return {
    "1": {
      class_type: "LoadImage",
      inputs: { image: mannequinName },
    },
    "2": {
      class_type: "OpenposePreprocessor",
      inputs: {
        image: ["1", 0],
        detect_hand: "enable",
        detect_body: "enable",
        detect_face: "enable",
        resolution: 512,
      },
    },
    "3": {
      class_type: "SaveImage",
      inputs: {
        filename_prefix: "lora_openpose_real",
        images: ["2", 0],
      },
    },
  };
}

async function main() {
  const cfg = await loadConfigAsync();
  await mkdir(IMAGES_DIR, { recursive: true });
  await mkdir(POSES_DIR, { recursive: true });

  console.log(`Character: ${cfg.name}  trigger: ${cfg.trigger}`);
  console.log(`Config:    ${CONFIG_PATH}`);
  console.log(`ComfyUI:   ${cfg.comfyUrl}`);
  console.log(`Output:    ${OUT_DIR}`);

  // Health check
  await comfy(cfg.comfyUrl, "/system_stats");

  if (!SHOTS_ONLY) {
    console.log("\n[1/2] Generating face lock…");
    const faceBuf = await queueAndWait(cfg.comfyUrl, faceLockWorkflow(cfg));
    await writeFile(FACE_LOCK, faceBuf);
    console.log(`  → ${FACE_LOCK}`);
    if (cfg.openImages) openFile(FACE_LOCK);
  } else if (!existsSync(FACE_LOCK)) {
    throw new Error("No face_lock.png — run without --shots-only first.");
  }

  if (FACE_ONLY) {
    console.log("\nDone (face only). Edit character.json if needed, then:");
    console.log("  npm run generate");
    return;
  }

  // Upload face lock for FaceID
  const faceUpload = await uploadImage(
    cfg.comfyUrl,
    "lora_face_lock_ref.png",
    await readFile(FACE_LOCK),
  );
  const faceName = faceUpload.name;

  const shots = ONLY_IDS
    ? cfg.shots.filter((s) => ONLY_IDS.has(s.id))
    : cfg.shots;
  if (ONLY_IDS && shots.length === 0) {
    throw new Error(`No shots matched --only ${[...ONLY_IDS].join(",")}`);
  }

  console.log(`\n[2/2] Generating ${shots.length} training shots…`);

  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    const poseKey = shot.poseKey || "stand";
    const angleKey = shot.angleKey || "front";
    const angled = angleKey !== "front";

    let posePng = buildOpenPosePng(poseKey, angleKey, {
      lookOverShoulder: Boolean(shot.lookOverShoulder),
    });
    let posePath = join(POSES_DIR, `${shot.id}_${angleKey}_${poseKey}.png`);
    await writeFile(posePath, posePng);

    let poseUpload = await uploadImage(
      cfg.comfyUrl,
      `lora_pose_${shot.id}.png`,
      posePng,
    );
    let poseName = poseUpload.name;

    // Side/back: refine through mannequin → real OpenPose (better silhouette).
    // Three-quarter keeps synthetic maps (mannequin tends to over-rotate to profile/back).
    const refine =
      shot.refinePose === true ||
      (shot.refinePose !== false &&
        (angleKey.startsWith("side_") ||
          angleKey.startsWith("threequarter_back") ||
          angleKey === "back"));

    if (refine) {
      process.stdout.write(
        `  (${i + 1}/${shots.length}) ${shot.id} [${angleKey}/${poseKey}] mannequin… `,
      );
      const mannequinBuf = await queueAndWait(
        cfg.comfyUrl,
        mannequinWorkflow(cfg, shot, poseName),
      );
      const mannequinPath = join(POSES_DIR, `${shot.id}_mannequin.png`);
      await writeFile(mannequinPath, mannequinBuf);
      const mannequinUpload = await uploadImage(
        cfg.comfyUrl,
        `lora_mannequin_${shot.id}.png`,
        mannequinBuf,
      );

      const realPoseBuf = await queueAndWait(
        cfg.comfyUrl,
        openPoseExtractWorkflow(mannequinUpload.name),
      );
      posePath = join(POSES_DIR, `${shot.id}_${angleKey}_${poseKey}_real.png`);
      await writeFile(posePath, realPoseBuf);
      poseUpload = await uploadImage(
        cfg.comfyUrl,
        `lora_pose_${shot.id}_real.png`,
        realPoseBuf,
      );
      poseName = poseUpload.name;
      process.stdout.write("character… ");
    } else {
      process.stdout.write(
        `  (${i + 1}/${shots.length}) ${shot.id} [${angleKey}/${poseKey}]… `,
      );
    }

    const imgBuf = await queueAndWait(
      cfg.comfyUrl,
      shotWorkflow(cfg, shot, faceName, poseName),
    );

    const imgPath = join(IMAGES_DIR, `${cfg.trigger}_${shot.id}.png`);
    const txtPath = join(IMAGES_DIR, `${cfg.trigger}_${shot.id}.txt`);
    await writeFile(imgPath, imgBuf);
    await writeFile(txtPath, captionFor(cfg, shot), "utf8");
    console.log("ok");
    if (cfg.openImages) openFile(imgPath);
  }

  // Convenience copy of face into dataset with caption
  const faceImg = join(IMAGES_DIR, `${cfg.trigger}_00_face_lock.png`);
  const faceTxt = join(IMAGES_DIR, `${cfg.trigger}_00_face_lock.txt`);
  await copyFile(FACE_LOCK, faceImg);
  await writeFile(
    faceTxt,
    `${cfg.trigger}, portrait, close-up, front view, ${cfg.appearance}, ${cfg.style}`,
    "utf8",
  );

  console.log(`\nDone. LoRA-ready dataset: ${IMAGES_DIR}`);
  console.log(`  Images + matching .txt captions (trigger: ${cfg.trigger})`);
  console.log(`  Train with your usual SD1.5 LoRA trainer on this folder.`);
}

main().catch((err) => {
  console.error("\nFailed:", err.message || err);
  process.exit(1);
});
