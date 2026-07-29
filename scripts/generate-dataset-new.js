import { mkdir, readFile, writeFile, copyFile } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import { platform } from "os";
import { randomUUID } from "crypto";
import { buildOpenPosePng, ANGLE_YAW } from "../lib/openpose-maps.js";

/**
 * Identity-first LoRA dataset generator.
 *
 * Core philosophy:
 *   Identity is persistent state. Pose is an edit.
 *   Identity is never rediscovered from noise unless a controlled rebuild is required.
 *
 *   Identity is preserved. Pose is edited.
 *   NOT: Generate pose. Rediscover identity.
 *
 * Phase 1 — Master Identity
 *   Single canonical identity via txt2img (EmptyLatent, denoise=1, optional FaceID/LoRA).
 *   This is the only image created entirely from noise.
 *
 * Phase 2 — Canonical Keyframes
 *   front / 45° / profile / rear / smile / bust from master (or nearest keyframe).
 *   img2img + OpenPose. Never invent identity from scratch (unless controlled rebuild).
 *
 * Phase 3 — Training Shots
 *   Closest keyframe (yaw, pose, expression, bust) → img2img + OpenPose.
 *   Identity from latent. OpenPose controls pose only.
 *
 * Adaptive denoise: easy ~0.55 | medium ~0.72 | hard ~0.82 | extreme ~0.88–0.95
 * Controlled rebuilds (sit, front→rear, front→strict profile): EmptyLatent + denoise=1 + strong FaceID.
 * FaceID: master | rebuilds | optional --aux-faceid | stronger weight on difficult edits.
 * Optional --chain; keyframe refresh (disable: --no-keyframe-refresh).
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const args = new Set(argv);

function flag(name, fallback = null) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
}
function has(name) {
  return args.has(name);
}

const CONFIG_PATH = join(ROOT, flag("--character", "character.json"));
const OUT_DIR = join(ROOT, flag("--out", "dataset-new"));
const IMAGES_DIR = join(OUT_DIR, "images");
const POSES_DIR = join(OUT_DIR, "poses");
const KEYFRAMES_DIR = join(OUT_DIR, "keyframes");
const MASTER_PATH = join(OUT_DIR, "master_identity.png");
const FACE_LOCK = join(OUT_DIR, "face_lock.png");

const MASTER_ONLY = has("--master-only");
const KEYFRAMES_ONLY = has("--keyframes-only");
const SHOTS_ONLY = has("--shots-only");
const FORCE = has("--force");
const FORCE_KEYFRAMES = has("--force-keyframes") || FORCE;
const CHAIN = has("--chain");
const AUX_FACEID = has("--aux-faceid");
const NO_KEYFRAME_REFRESH = has("--no-keyframe-refresh");

const onlyIdx = argv.indexOf("--only");
const ONLY_IDS =
  onlyIdx >= 0 && argv[onlyIdx + 1]
    ? new Set(argv[onlyIdx + 1].split(",").map((s) => s.trim()).filter(Boolean))
    : null;

/** Base = small-edit denoise. Adaptive bands climb from here. */
const BASE_DENOISE = Number(flag("--denoise", "0.55"));
const OPENPOSE_STRENGTH = Number(flag("--openpose", "1.0"));
const LORA_NAME = flag("--lora", null);
const LORA_STRENGTH = Number(flag("--lora-strength", "0.9"));
const IDENTITY_BACKEND = flag("--identity", "faceid"); // faceid | none

/** Canonical viewpoint bank — bootstrap via img2img from master; may refresh later. */
const KEYFRAME_SPECS = [
  { id: "front", angleKey: "front", poseKey: "stand", expression: "neutral", caption: "front stand neutral" },
  { id: "left45", angleKey: "threequarter_left", poseKey: "stand", expression: "neutral", caption: "three-quarter left" },
  { id: "right45", angleKey: "threequarter_right", poseKey: "stand", expression: "neutral", caption: "three-quarter right" },
  { id: "left_profile", angleKey: "side_left", poseKey: "stand", expression: "neutral", caption: "left profile" },
  { id: "right_profile", angleKey: "side_right", poseKey: "stand", expression: "neutral", caption: "right profile" },
  { id: "back", angleKey: "threequarter_back_left", poseKey: "stand", expression: "neutral", caption: "rear three-quarter" },
  { id: "smile", angleKey: "front", poseKey: "stand", expression: "smile", caption: "front stand soft smile" },
  { id: "neutral", angleKey: "front", poseKey: "bust", expression: "neutral", caption: "front bust neutral", bust: true },
];

async function loadConfig() {
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

async function comfy(url, path, opts = {}) {
  const res = await fetch(`${url}${path}`, opts);
  if (!res.ok) {
    throw new Error(`ComfyUI ${path} → ${res.status}: ${(await res.text()).slice(0, 1200)}`);
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

/** Strip builder-only keys — ComfyUI 500s if _modelRef etc. are sent as nodes. */
function sanitizeWorkflow(workflow) {
  const out = {};
  for (const [k, v] of Object.entries(workflow)) {
    if (k.startsWith("_")) continue;
    out[k] = v;
  }
  return out;
}

async function queueAndWait(url, workflow, label = "") {
  const clientId = randomUUID();
  const prompt = sanitizeWorkflow(workflow);
  const queued = await comfy(url, "/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, client_id: clientId }),
  });
  if (queued.node_errors && Object.keys(queued.node_errors).length) {
    throw new Error(`Queue rejected: ${JSON.stringify(queued.node_errors).slice(0, 1000)}`);
  }
  const promptId = queued.prompt_id;
  if (label) console.log(`  queued ${label} (${promptId.slice(0, 8)}…)`);

  for (;;) {
    await sleep(900);
    const hist = await comfy(url, `/history/${promptId}`);
    const entry = hist[promptId];
    if (!entry) continue;
    if (entry.status?.status_str === "error") {
      throw new Error(`ComfyUI error: ${JSON.stringify(entry.status).slice(0, 1000)}`);
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

function yawOf(angleKey) {
  return ANGLE_YAW[angleKey] ?? 0;
}

function angularDistance(a, b) {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

function effectivePoseKey(shot) {
  let key = shot.poseKey || "stand";
  const text = `${shot.id || ""} ${shot.pose || ""} ${shot.captionExtra || ""}`.toLowerCase();
  if (key === "stand" && /clap/.test(text)) key = "hand_on_hip";
  if (key === "stand" && /reach/.test(text)) key = "point";
  return key;
}

function expressionOf(shot) {
  if (shot.expression) return shot.expression;
  const text = `${shot.pose || ""} ${shot.captionExtra || ""} ${shot.id || ""}`.toLowerCase();
  if (/smile|happy|joyful|grin/.test(text)) return "smile";
  return "neutral";
}

function isStrictProfile(angleKey) {
  return angleKey === "side_left" || angleKey === "side_right";
}

function isRearView(angleKey) {
  return /back/.test(angleKey || "");
}

/* -------------------------------------------------------------------------- */
/* Difficulty / denoise / rebuild                                              */
/* Philosophy: raise denoise only as needed; rebuild only when img2img fails.  */
/* -------------------------------------------------------------------------- */

function poseEditDifficulty(shot, source) {
  const yawDelta = angularDistance(source.yaw ?? 0, yawOf(shot.angleKey));
  const srcPose = source.poseKey || "stand";
  const dstPose = effectivePoseKey(shot);
  let score = 0;

  if (yawDelta > 120) score += 4;
  else if (yawDelta > 70) score += 3;
  else if (yawDelta > 35) score += 2;
  else if (yawDelta > 12) score += 1;

  if (srcPose !== dstPose) {
    if (dstPose === "sit" || srcPose === "sit") score += 4;
    else if (["wave", "point", "hand_on_hip", "walk"].includes(dstPose)) score += 2;
    else if (dstPose === "bust" || srcPose === "bust") score += 1;
    else score += 1;
  }

  if (shot.bust && !source.bust) score += 1;
  if (!shot.bust && source.bust) score += 2;
  if (expressionOf(shot) !== (source.expression || "neutral")) score += 1;

  return score;
}

/**
 * Adaptive denoise (img2img only — rebuilds use denoise=1):
 *   easy ~0.55 | medium ~0.72 | hard ~0.82 | extreme ~0.88–0.95
 * Walk/sit get a floor bump so old legs are replaced (reduces ghost/double legs).
 */
function denoiseForEdit(shot, source, base = BASE_DENOISE) {
  const difficulty = poseEditDifficulty(shot, source);
  const dstPose = effectivePoseKey(shot);
  let d;
  if (difficulty >= 4) d = clamp(Math.max(base, 0.9), 0.88, 0.95);
  else if (difficulty >= 3) d = clamp(Math.max(base, 0.82), 0.78, 0.88);
  else if (difficulty >= 2) d = clamp(Math.max(base, 0.72), 0.68, 0.8);
  else if (difficulty >= 1) d = clamp(Math.max(base, 0.62), 0.55, 0.72);
  else d = clamp(base, 0.5, 0.58);

  // Limb replacements need enough denoise to erase the source pose's legs/arms
  if (dstPose === "walk" || dstPose === "sit") d = Math.max(d, 0.82);
  if (dstPose === "wave" || dstPose === "point") d = Math.max(d, 0.72);
  return clamp(d, 0.5, 0.95);
}

/**
 * Controlled rebuild — identity reconstructed from FaceID; OpenPose controls pose.
 * Used only when img2img continuity cannot bridge the edit:
 *   standing → sitting, front → rear, front → strict profile, other large jumps.
 */
function needsEmptyLatentRebuild(shot, source) {
  const dstPose = effectivePoseKey(shot);
  const srcPose = source.poseKey || "stand";
  const yawDelta = angularDistance(source.yaw ?? 0, yawOf(shot.angleKey));
  const srcAngle = source.angleKey || "front";
  const dstAngle = shot.angleKey || "front";

  if ((dstPose === "sit" && srcPose !== "sit") || (srcPose === "sit" && dstPose !== "sit")) {
    return true;
  }
  if (isRearView(dstAngle) && !isRearView(srcAngle)) return true;
  if (isRearView(srcAngle) && !isRearView(dstAngle)) return true;
  if (isStrictProfile(dstAngle) && !isStrictProfile(srcAngle) && yawDelta > 25) return true;
  if (isStrictProfile(srcAngle) && !isStrictProfile(dstAngle) && yawDelta > 25) return true;
  if (yawDelta > 100) return true;
  return false;
}

/**
 * FaceID policy:
 *   Primary identity = img2img latent continuity.
 *   Secondary = FaceID for master, controlled rebuilds, or --aux-faceid on all shots.
 * Normal img2img shots do NOT inject FaceID (that would rediscover identity from embeddings).
 */
function shouldUseFaceId(rebuild) {
  return Boolean(rebuild || AUX_FACEID);
}

/** Stronger FaceID weight on rebuilds / harder aux edits; lighter on easy aux. */
function faceIdWeightFor(fromEmptyLatent, denoise) {
  if (fromEmptyLatent) return 0.85; // controlled rebuild — strong FaceID
  if (denoise >= 0.82) return 0.65; // difficult aux edit
  if (denoise >= 0.72) return 0.5;
  return 0.35;
}

function shotAngleText(shot) {
  if (shot.angle) return shot.angle;
  const map = {
    front: "front view, body facing camera, looking at camera",
    threequarter_left:
      "three-quarter view from the left, body turned ~40 degrees left, head and torso facing the same left direction, natural neck, NOT twisted toward camera",
    threequarter_right:
      "three-quarter view from the right, body turned ~40 degrees right, head and torso facing the same right direction, natural neck, NOT twisted toward camera",
    side_left:
      "strict left profile side view, 90 degrees, head and body both facing left, only one eye and one ear visible, nose pointing left, natural neck alignment, NOT looking at camera",
    side_right:
      "strict right profile side view, 90 degrees, head and body both facing right, only one eye and one ear visible, nose pointing right, natural neck alignment, NOT looking at camera",
    threequarter_back_left:
      "rear three-quarter view from behind the left, back mostly toward camera, head facing away with body, back of head visible, natural neck, NOT looking over shoulder at camera",
    back: "back view, facing away from camera, back of head visible, natural neck, NOT looking over shoulder",
  };
  return map[shot.angleKey] || "front view";
}

function normalizeShot(shot) {
  return {
    ...shot,
    angleKey: shot.angleKey || "front",
    poseKey: effectivePoseKey(shot),
    expression: expressionOf(shot),
    angle: shotAngleText(shot),
    pose: shot.pose || "standing straight, arms relaxed at sides",
    bust: Boolean(shot.bust),
  };
}

/** Shared style lock — keeps cel-shaded cartoon consistency across img2img and rebuilds. */
const STYLE_LOCK =
  "flat 2D anime cartoon illustration, clean cel shading, simple bold lineart, soft even studio lighting, plain solid light gray background, consistent cartoon style";

const STYLE_NEGATIVE =
  "photo, photorealistic, realistic skin texture, detailed pores, hyperrealistic, cinematic lighting, dramatic lighting, volumetric lighting, 3d render, octane, unreal engine";

const ANATOMY_NEGATIVE =
  "twisted neck, broken neck, impossible neck, head spun around, looking over shoulder, head facing camera while body turned away, extra legs, ghost legs, double legs, fused legs, overlapping legs, extra feet, three legs, malformed legs, extra limbs, duplicate limbs";

function anatomyPromptLock(shot) {
  const angle = shot.angleKey || "front";
  const parts = [
    "anatomically natural neck, head aligned with torso, no twisted neck",
    "exactly two legs, clear leg separation, no ghost limbs, no extra feet",
  ];
  if (isStrictProfile(angle)) {
    parts.push(
      "true side profile, head and body face the same direction, only one eye visible, only one ear visible",
    );
  } else if (isRearView(angle) && !shot.lookOverShoulder) {
    parts.push(
      "facing away, back of head toward camera, do not turn head toward camera, no over-the-shoulder glance",
    );
  } else if (angle !== "front") {
    parts.push("head facing same direction as body, gaze forward in body direction, not looking at camera");
  }
  return parts.join(", ");
}

function characterPrompt(cfg, shot, { rebuild = false } = {}) {
  const smile =
    shot.expression === "smile"
      ? "soft friendly closed-mouth smile"
      : null;
  const style = [STYLE_LOCK, cfg.style].filter(Boolean).join(", ");
  const styleBoost = rebuild
    ? "strict flat cel-shaded cartoon only, same illustration style as the master identity, not realistic"
    : null;

  if (shot.bust) {
    return [
      cfg.trigger,
      cfg.appearance,
      cfg.outfit,
      shot.angle,
      shot.pose,
      smile,
      "close-up bust portrait, head and shoulders only, single character, same exact identity",
      anatomyPromptLock(shot),
      style,
      styleBoost,
    ]
      .filter(Boolean)
      .join(", ");
  }
  return [
    cfg.trigger,
    cfg.appearance,
    cfg.outfit,
    shot.angle,
    shot.pose,
    smile,
    anatomyPromptLock(shot),
    "same exact character identity, consistent face body proportions hairstyle clothing age",
    "single solitary character only, full body centered, empty plain background, no other faces",
    style,
    styleBoost,
  ]
    .filter(Boolean)
    .join(", ");
}

function shotNegative(cfg, shot) {
  return [cfg.negative, STYLE_NEGATIVE, ANATOMY_NEGATIVE, shot.extraNegative]
    .filter(Boolean)
    .join(", ");
}

function captionFor(cfg, shot) {
  return `${cfg.trigger}, ${shot.captionExtra || shot.caption || ""}, ${cfg.appearance}, ${cfg.outfit}, ${cfg.style}`
    .replace(/\s+/g, " ")
    .trim();
}

/* -------------------------------------------------------------------------- */
/* Identity backends                                                           */
/* -------------------------------------------------------------------------- */

const IdentityBackends = {
  none: { name: "none" },
  faceid: {
    name: "faceid",
    attachMasterFaceId(wf, { faceImageName, weight = 0.75, weightV2 = 0.75 }) {
      wf["20"] = { class_type: "LoadImage", inputs: { image: faceImageName } };
      wf["21"] = {
        class_type: "IPAdapterUnifiedLoaderFaceID",
        inputs: {
          model: wf._modelRef,
          preset: "FACEID PLUS V2",
          lora_strength: 0.7,
          provider: "CUDA",
        },
      };
      wf["22"] = {
        class_type: "CLIPVisionLoader",
        inputs: { clip_name: "CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors" },
      };
      wf["23"] = {
        class_type: "IPAdapterInsightFaceLoader",
        inputs: { provider: "CUDA", model_name: "buffalo_l" },
      };
      wf["24"] = {
        class_type: "IPAdapterFaceID",
        inputs: {
          model: ["21", 0],
          ipadapter: ["21", 1],
          image: ["20", 0],
          weight,
          weight_faceidv2: weightV2,
          weight_type: "linear",
          combine_embeds: "concat",
          start_at: 0,
          end_at: 1,
          embeds_scaling: "V only",
          clip_vision: ["22", 0],
          insightface: ["23", 0],
        },
      };
      wf._modelRef = ["24", 0];
    },
  },
};

function getIdentityBackend(name) {
  const b = IdentityBackends[name];
  if (!b) {
    throw new Error(
      `Unknown --identity ${name}. Available: ${Object.keys(IdentityBackends).join(", ")}`,
    );
  }
  return b;
}

function withCheckpointAndOptionalLora(cfg, loraName) {
  const wf = {
    "1": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: cfg.checkpoint },
    },
  };
  let modelRef = ["1", 0];
  let clipRef = ["1", 1];
  const vaeRef = ["1", 2];
  if (loraName) {
    wf["2"] = {
      class_type: "LoraLoader",
      inputs: {
        model: ["1", 0],
        clip: ["1", 1],
        lora_name: loraName,
        strength_model: LORA_STRENGTH,
        strength_clip: LORA_STRENGTH,
      },
    };
    modelRef = ["2", 0];
    clipRef = ["2", 1];
  }
  wf._modelRef = modelRef;
  wf._clipRef = clipRef;
  wf._vaeRef = vaeRef;
  return wf;
}

function faceLockWorkflow(cfg, loraName) {
  const wf = withCheckpointAndOptionalLora(cfg, loraName);
  const prompt = [
    cfg.trigger,
    cfg.appearance,
    "front view close-up bust portrait, head and shoulders, looking at camera, friendly expression",
    cfg.outfit,
    cfg.style,
  ].join(", ");
  wf["3"] = {
    class_type: "CLIPTextEncode",
    inputs: { text: prompt, clip: wf._clipRef },
  };
  wf["4"] = {
    class_type: "CLIPTextEncode",
    inputs: { text: cfg.negative, clip: wf._clipRef },
  };
  wf["5"] = {
    class_type: "EmptyLatentImage",
    inputs: { width: cfg.width, height: cfg.height, batch_size: 1 },
  };
  wf["6"] = {
    class_type: "KSampler",
    inputs: {
      seed: cfg.seed,
      steps: cfg.steps,
      cfg: cfg.cfg,
      sampler_name: cfg.sampler,
      scheduler: cfg.scheduler,
      denoise: 1,
      model: wf._modelRef,
      positive: ["3", 0],
      negative: ["4", 0],
      latent_image: ["5", 0],
    },
  };
  wf["7"] = {
    class_type: "VAEDecode",
    inputs: { samples: ["6", 0], vae: wf._vaeRef },
  };
  wf["8"] = {
    class_type: "SaveImage",
    inputs: { filename_prefix: "id_face_lock", images: ["7", 0] },
  };
  return wf;
}

/** PHASE 1 — only place that invents identity from noise. */
function masterIdentityWorkflow(cfg, { loraName, poseMapName, faceImageName, backend }) {
  const wf = withCheckpointAndOptionalLora(cfg, loraName);
  const prompt = [
    cfg.trigger,
    cfg.appearance,
    cfg.outfit,
    "front view, body facing camera, looking at camera",
    "standing straight, arms relaxed at sides, feet slightly apart",
    "canonical master identity reference, perfect character consistency",
    "single solitary character only, full body centered, empty plain background",
    cfg.style,
  ].join(", ");

  if (backend.name === "faceid" && faceImageName) {
    backend.attachMasterFaceId(wf, {
      faceImageName,
      weight: cfg.faceIdWeight ?? 0.75,
      weightV2: cfg.faceIdWeightV2 ?? 0.75,
    });
  }

  wf["3"] = {
    class_type: "CLIPTextEncode",
    inputs: { text: prompt, clip: wf._clipRef },
  };
  wf["4"] = {
    class_type: "CLIPTextEncode",
    inputs: { text: cfg.negative, clip: wf._clipRef },
  };
  wf["5"] = { class_type: "LoadImage", inputs: { image: poseMapName } };
  wf["6"] = {
    class_type: "ControlNetLoader",
    inputs: { control_net_name: "control_v11p_sd15_openpose_fp16.safetensors" },
  };
  wf["7"] = {
    class_type: "ControlNetApplyAdvanced",
    inputs: {
      positive: ["3", 0],
      negative: ["4", 0],
      control_net: ["6", 0],
      image: ["5", 0],
      strength: cfg.openPoseStrength ?? 0.92,
      start_percent: 0,
      end_percent: 0.95,
      vae: wf._vaeRef,
    },
  };
  wf["8"] = {
    class_type: "EmptyLatentImage",
    inputs: { width: cfg.width, height: cfg.height, batch_size: 1 },
  };
  wf["9"] = {
    class_type: "KSampler",
    inputs: {
      seed: cfg.seed + 1,
      steps: cfg.steps,
      cfg: cfg.cfg,
      sampler_name: cfg.sampler,
      scheduler: cfg.scheduler,
      denoise: 1,
      model: wf._modelRef,
      positive: ["7", 0],
      negative: ["7", 1],
      latent_image: ["8", 0],
    },
  };
  wf["10"] = {
    class_type: "VAEDecode",
    inputs: { samples: ["9", 0], vae: wf._vaeRef },
  };
  wf["11"] = {
    class_type: "SaveImage",
    inputs: { filename_prefix: "id_master", images: ["10", 0] },
  };
  return wf;
}

/**
 * img2img + OpenPose (default) OR controlled EmptyLatent rebuild + FaceID.
 * Identity primary = source latent; FaceID secondary when flagged.
 */
function img2imgOpenPoseWorkflow(cfg, opts) {
  const {
    loraName,
    sourceImageName,
    poseMapName,
    prompt,
    negative,
    seed,
    denoise,
    openPoseStrength,
    prefix,
    backend,
    faceImageName,
    useFaceId = false,
    fromEmptyLatent = false,
  } = opts;

  const wf = withCheckpointAndOptionalLora(cfg, loraName);

  if (useFaceId && backend.name === "faceid" && faceImageName) {
    const w = faceIdWeightFor(fromEmptyLatent, denoise);
    backend.attachMasterFaceId(wf, {
      faceImageName,
      weight: w,
      weightV2: w,
    });
  }

  wf["3"] = {
    class_type: "CLIPTextEncode",
    inputs: { text: prompt, clip: wf._clipRef },
  };
  wf["4"] = {
    class_type: "CLIPTextEncode",
    inputs: { text: negative, clip: wf._clipRef },
  };

  if (fromEmptyLatent) {
    wf["7"] = {
      class_type: "EmptyLatentImage",
      inputs: { width: cfg.width, height: cfg.height, batch_size: 1 },
    };
  } else {
    wf["5"] = { class_type: "LoadImage", inputs: { image: sourceImageName } };
    wf["6"] = {
      class_type: "ImageScale",
      inputs: {
        image: ["5", 0],
        upscale_method: "lanczos",
        width: cfg.width,
        height: cfg.height,
        crop: "center",
      },
    };
    wf["7"] = {
      class_type: "VAEEncode",
      inputs: { pixels: ["6", 0], vae: wf._vaeRef },
    };
  }

  wf["8"] = { class_type: "LoadImage", inputs: { image: poseMapName } };
  wf["8b"] = {
    class_type: "ImageScale",
    inputs: {
      image: ["8", 0],
      upscale_method: "nearest-exact",
      width: cfg.width,
      height: cfg.height,
      crop: "disabled",
    },
  };
  wf["9"] = {
    class_type: "ControlNetLoader",
    inputs: { control_net_name: "control_v11p_sd15_openpose_fp16.safetensors" },
  };
  wf["10"] = {
    class_type: "ControlNetApplyAdvanced",
    inputs: {
      positive: ["3", 0],
      negative: ["4", 0],
      control_net: ["9", 0],
      image: ["8b", 0],
      strength: openPoseStrength,
      start_percent: 0,
      end_percent: 1.0,
      vae: wf._vaeRef,
    },
  };
  wf["11"] = {
    class_type: "KSampler",
    inputs: {
      seed,
      steps: cfg.steps,
      cfg: cfg.cfg,
      sampler_name: cfg.sampler,
      scheduler: cfg.scheduler,
      denoise: fromEmptyLatent ? 1 : denoise,
      model: wf._modelRef,
      positive: ["10", 0],
      negative: ["10", 1],
      latent_image: ["7", 0],
    },
  };
  wf["12"] = {
    class_type: "VAEDecode",
    inputs: { samples: ["11", 0], vae: wf._vaeRef },
  };
  wf["13"] = {
    class_type: "SaveImage",
    inputs: { filename_prefix: prefix, images: ["12", 0] },
  };
  return wf;
}

/* -------------------------------------------------------------------------- */
/* Source selection — closest keyframe; optional chain if closer in yaw        */
/* -------------------------------------------------------------------------- */

function scoreKeyframe(shot, kf) {
  const targetYaw = yawOf(shot.angleKey);
  const wantSmile = expressionOf(shot) === "smile";
  const wantBust = Boolean(shot.bust);
  const wantPose = effectivePoseKey(shot);

  let score = angularDistance(targetYaw, kf.yaw);

  if (wantSmile && kf.expression === "smile") score -= 20;
  if (!wantSmile && kf.expression === "neutral") score -= 4;
  if (wantSmile && kf.expression !== "smile") score += 8;

  if (wantBust && kf.bust) score -= 25;
  if (wantBust && !kf.bust) score += 18;
  if (!wantBust && kf.bust) score += 30;

  if (wantPose === "stand" && (kf.poseKey || "stand") === "stand") score -= 3;
  if (wantPose === "bust" && kf.bust) score -= 10;
  if (kf.angleKey === shot.angleKey) score -= 15;

  return score;
}

function selectSource(shot, keyframeBank, lastAccepted = null) {
  let best = null;
  let bestScore = Infinity;

  for (const kf of keyframeBank) {
    if (!kf.uploadName) continue;
    const score = scoreKeyframe(shot, kf);
    if (score < bestScore) {
      bestScore = score;
      best = kf;
    }
  }

  if (!best) {
    throw new Error("No keyframe sources available — run master + keyframes first.");
  }

  // Optional chaining: last accepted wins only when closer in camera yaw
  if (CHAIN && lastAccepted?.uploadName) {
    const targetYaw = yawOf(shot.angleKey);
    const chainYaw = angularDistance(lastAccepted.yaw ?? 0, targetYaw);
    const kfYaw = angularDistance(best.yaw ?? 0, targetYaw);
    if (chainYaw + 5 < kfYaw) {
      return {
        source: lastAccepted,
        reason: `chain:${lastAccepted.id || lastAccepted.shotId || "prev"}`,
        score: chainYaw,
      };
    }
  }

  return { source: best, reason: `keyframe:${best.id}`, score: bestScore };
}

/**
 * Keyframe refresh: if this shot is a better anchor for a viewpoint slot, replace it.
 * Future shots inherit the improved identity (bank improves over time).
 */
function findRefreshTarget(shot, keyframeBank) {
  if (NO_KEYFRAME_REFRESH) return null;
  const dstPose = effectivePoseKey(shot);
  const expr = expressionOf(shot);

  // Never promote sit / wild limb poses into the stand viewpoint bank
  const isCanonicalStand = dstPose === "stand";
  const isCanonicalBust = Boolean(shot.bust) || dstPose === "bust";
  const isCanonicalSmile = expr === "smile" && isCanonicalStand;

  for (const kf of keyframeBank) {
    if (kf.angleKey !== shot.angleKey) continue;

    if (kf.bust) {
      if (isCanonicalBust) return kf;
      continue;
    }
    if (kf.expression === "smile") {
      if (isCanonicalSmile) return kf;
      continue;
    }
    // stand / profile / 45 / back anchors
    if (isCanonicalStand && expr === "neutral" && !shot.bust) return kf;
  }
  return null;
}

async function refreshKeyframe(kf, resultBuf, cfg, shotMeta) {
  await writeFile(kf.path, resultBuf);
  const up = await uploadImage(cfg.comfyUrl, `id_kf_${kf.id}.png`, resultBuf);
  kf.uploadName = up.name;
  kf.yaw = yawOf(shotMeta.angleKey);
  kf.angleKey = shotMeta.angleKey;
  kf.poseKey = effectivePoseKey(shotMeta);
  kf.expression = expressionOf(shotMeta);
  kf.bust = Boolean(shotMeta.bust);
  console.log(`  ↻ refreshed keyframe ${kf.id}`);
}

async function uploadPose(cfg, shot, tag) {
  const poseKey = effectivePoseKey(shot);
  const posePng = buildOpenPosePng(poseKey, shot.angleKey || "front", {
    lookOverShoulder: Boolean(shot.lookOverShoulder),
  });
  const posePath = join(POSES_DIR, `${tag}.png`);
  await writeFile(posePath, posePng);
  const up = await uploadImage(cfg.comfyUrl, `idpose_${tag}.png`, posePng);
  return { posePath, poseName: up.name, poseKey };
}

async function runEdit(cfg, ctx) {
  const {
    shot,
    source,
    denoise,
    seed,
    prefix,
    outPath,
    captionPath,
    loraName,
    backend,
    faceUploadName,
    fromEmptyLatent,
    useFaceId,
  } = ctx;

  const { poseName } = await uploadPose(cfg, shot, prefix);
  const prompt = characterPrompt(cfg, shot, { rebuild: fromEmptyLatent });
  const negative = shotNegative(cfg, shot);

  const buf = await queueAndWait(
    cfg.comfyUrl,
    img2imgOpenPoseWorkflow(cfg, {
      loraName,
      sourceImageName: source?.uploadName,
      poseMapName: poseName,
      prompt,
      negative,
      seed,
      denoise,
      openPoseStrength: OPENPOSE_STRENGTH,
      prefix: `id_${prefix}`,
      backend,
      faceImageName: faceUploadName,
      useFaceId,
      fromEmptyLatent,
    }),
    prefix,
  );

  await writeFile(outPath, buf);
  if (captionPath) await writeFile(captionPath, captionFor(cfg, shot), "utf8");
  const uploaded = await uploadImage(cfg.comfyUrl, `id_out_${prefix}.png`, buf);
  return {
    buf,
    uploadName: uploaded.name,
    yaw: yawOf(shot.angleKey),
    angleKey: shot.angleKey,
    poseKey: effectivePoseKey(shot),
    expression: expressionOf(shot),
    bust: Boolean(shot.bust),
    id: shot.id,
    shotId: shot.id,
  };
}

async function loadKeyframeBank(cfg) {
  const bank = [];
  for (const spec of KEYFRAME_SPECS) {
    const path = join(KEYFRAMES_DIR, `${spec.id}.png`);
    if (!existsSync(path)) {
      if (spec.id === "front" && existsSync(MASTER_PATH)) {
        await copyFile(MASTER_PATH, path);
      } else {
        continue;
      }
    }
    const up = await uploadImage(cfg.comfyUrl, `id_kf_${spec.id}.png`, await readFile(path));
    bank.push({
      id: spec.id,
      path,
      uploadName: up.name,
      yaw: yawOf(spec.angleKey),
      expression: spec.expression,
      bust: Boolean(spec.bust),
      angleKey: spec.angleKey,
      poseKey: spec.poseKey || "stand",
    });
  }
  return bank;
}

function keyframeShotFromSpec(spec) {
  return normalizeShot({
    id: spec.id,
    angleKey: spec.angleKey,
    poseKey: spec.poseKey,
    expression: spec.expression,
    bust: Boolean(spec.bust),
    pose:
      spec.expression === "smile"
        ? "standing straight, soft friendly closed-mouth smile, arms at sides"
        : spec.bust
          ? "facing camera, neutral friendly expression, shoulders visible"
          : "standing straight, arms relaxed at sides, feet slightly apart",
    captionExtra: spec.caption,
  });
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
  const cfg = await loadConfig();
  const backend = getIdentityBackend(IDENTITY_BACKEND);
  const loraName = LORA_NAME;

  await mkdir(IMAGES_DIR, { recursive: true });
  await mkdir(POSES_DIR, { recursive: true });
  await mkdir(KEYFRAMES_DIR, { recursive: true });

  console.log("============================================================");
  console.log(" Identity-first dataset generator");
  console.log(" Identity is preserved. Pose is edited.");
  console.log("============================================================");
  console.log(`Character:  ${cfg.name} / ${cfg.trigger}`);
  console.log(`Config:     ${CONFIG_PATH}`);
  console.log(`Output:     ${OUT_DIR}`);
  console.log(`Identity:   primary=img2img latent | secondary=FaceID (${backend.name})`);
  console.log(`LoRA:       ${loraName || "(none)"}`);
  console.log(`Denoise:    easy~0.55 medium~0.72 hard~0.82 extreme~0.88-0.95 (base ${BASE_DENOISE})`);
  console.log(`OpenPose:   ${OPENPOSE_STRENGTH} (pose only — identity from latent)`);
  console.log(`Source:     closest keyframe${CHAIN ? " + optional chain" : ""}`);
  console.log(`Keyframes:  refresh=${NO_KEYFRAME_REFRESH ? "off" : "on"}${FORCE_KEYFRAMES ? " (force regenerate)" : ""}`);
  console.log(`FaceID on:  master | controlled rebuilds${AUX_FACEID ? " | all shots (--aux-faceid)" : ""}`);

  await comfy(cfg.comfyUrl, "/system_stats");

  let faceUploadName = null;

  // ======================== PHASE 1: MASTER IDENTITY ========================
  if (!SHOTS_ONLY && !KEYFRAMES_ONLY) {
    if (backend.name === "faceid") {
      if (!existsSync(FACE_LOCK) || FORCE) {
        console.log("\n[1a] Face lock (FaceID reference for master / rebuilds)…");
        const faceBuf = await queueAndWait(
          cfg.comfyUrl,
          faceLockWorkflow(cfg, loraName),
          "face-lock",
        );
        await writeFile(FACE_LOCK, faceBuf);
        console.log(`  → ${FACE_LOCK}`);
      } else {
        console.log(`\n[1a] Reuse face lock: ${FACE_LOCK}`);
      }
      faceUploadName = (
        await uploadImage(cfg.comfyUrl, "id_face_lock_ref.png", await readFile(FACE_LOCK))
      ).name;
    }

    if (!existsSync(MASTER_PATH) || FORCE) {
      console.log("\n[1b] Master identity (ONLY EmptyLatent + denoise=1 + FaceID)…");
      const { poseName } = await uploadPose(
        cfg,
        { angleKey: "front", poseKey: "stand" },
        "master_front_stand",
      );
      const masterBuf = await queueAndWait(
        cfg.comfyUrl,
        masterIdentityWorkflow(cfg, {
          loraName,
          poseMapName: poseName,
          faceImageName: faceUploadName,
          backend,
        }),
        "master",
      );
      await writeFile(MASTER_PATH, masterBuf);
      console.log(`  → ${MASTER_PATH}`);
      if (cfg.openImages) openFile(MASTER_PATH);
    } else {
      console.log(`\n[1b] Reuse master: ${MASTER_PATH}`);
    }
  } else if (!existsSync(MASTER_PATH)) {
    throw new Error("Missing master_identity.png — run without --shots-only first.");
  }

  if (MASTER_ONLY) {
    console.log("\nDone (master only). Review master, then run --keyframes-only.");
    return;
  }

  if (!faceUploadName && existsSync(FACE_LOCK) && backend.name === "faceid") {
    faceUploadName = (
      await uploadImage(cfg.comfyUrl, "id_face_lock_ref.png", await readFile(FACE_LOCK))
    ).name;
  }

  /** @type {Array<object>} */
  let keyframeBank = [];

  // ======================== PHASE 2: CANONICAL KEYFRAMES ========================
  // img2img from master / nearest keyframe. Never invent identity from noise
  // unless controlled rebuild (profile / rear) — then FaceID carries identity.
  if (!SHOTS_ONLY) {
    console.log("\n[2] Canonical keyframes (img2img from master / nearest)…");

    const frontPath = join(KEYFRAMES_DIR, "front.png");
    if (!existsSync(frontPath) || FORCE_KEYFRAMES) {
      await copyFile(MASTER_PATH, frontPath);
      console.log("  front.png ← master (identity seed)");
    } else {
      console.log("  reuse front.png");
    }

    keyframeBank = await loadKeyframeBank(cfg);
    if (!keyframeBank.find((k) => k.id === "front")) {
      throw new Error("front keyframe missing");
    }

    for (const spec of KEYFRAME_SPECS) {
      if (spec.id === "front") continue;
      const outPath = join(KEYFRAMES_DIR, `${spec.id}.png`);

      if (existsSync(outPath) && !FORCE_KEYFRAMES) {
        console.log(`  reuse ${spec.id}.png`);
        continue;
      }

      const shot = keyframeShotFromSpec(spec);
      const { source, reason } = selectSource(shot, keyframeBank, null);
      const rebuild = needsEmptyLatentRebuild(shot, source);
      const denoise = rebuild ? 1 : denoiseForEdit(shot, source);
      const useFaceId = shouldUseFaceId(rebuild);

      console.log(
        `  ${spec.id} ← ${reason} (${rebuild ? "REBUILD EmptyLatent+FaceID" : "img2img"} denoise=${denoise.toFixed(2)} faceid=${useFaceId})`,
      );

      await runEdit(cfg, {
        shot,
        source,
        denoise,
        seed: cfg.seed + 100 + keyframeBank.length * 13,
        prefix: `kf_${spec.id}`,
        outPath,
        captionPath: null,
        loraName,
        backend,
        faceUploadName,
        fromEmptyLatent: rebuild,
        useFaceId,
      });

      console.log(`  → ${outPath}`);
      keyframeBank = await loadKeyframeBank(cfg);
    }

    keyframeBank = await loadKeyframeBank(cfg);
    console.log(`  Keyframe bank ready (${keyframeBank.length} frames).`);
  } else {
    console.log("\n[2] Loading keyframe bank…");
    keyframeBank = await loadKeyframeBank(cfg);
    if (!keyframeBank.length) throw new Error("No keyframes found.");
  }

  if (KEYFRAMES_ONLY) {
    console.log("\nDone (keyframes only). Review keyframes/, then run --shots-only.");
    return;
  }

  // ======================== PHASE 3: TRAINING SHOTS ========================
  const shots = (ONLY_IDS ? cfg.shots.filter((s) => ONLY_IDS.has(s.id)) : cfg.shots).map(
    normalizeShot,
  );
  console.log(`\n[3] Training shots (${shots.length}) from closest keyframe…`);

  const manifest = [];
  let lastAccepted = keyframeBank.find((k) => k.id === "front") || keyframeBank[0];

  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    const imgPath = join(IMAGES_DIR, `${cfg.trigger}_${shot.id}.png`);
    const txtPath = join(IMAGES_DIR, `${cfg.trigger}_${shot.id}.txt`);

    if (existsSync(imgPath) && !FORCE) {
      console.log(`  (${i + 1}/${shots.length}) ${shot.id} reuse`);
      // Still allow chaining from reused disk image
      const up = await uploadImage(cfg.comfyUrl, `id_out_${shot.id}.png`, await readFile(imgPath));
      lastAccepted = {
        id: shot.id,
        shotId: shot.id,
        uploadName: up.name,
        yaw: yawOf(shot.angleKey),
        angleKey: shot.angleKey,
        poseKey: effectivePoseKey(shot),
        expression: expressionOf(shot),
        bust: Boolean(shot.bust),
      };
      manifest.push({ id: shot.id, reused: true, source: "disk" });
      continue;
    }

    const { source, reason } = selectSource(shot, keyframeBank, lastAccepted);
    const rebuild = needsEmptyLatentRebuild(shot, source);
    const denoise = rebuild ? 1 : denoiseForEdit(shot, source);
    const useFaceId = shouldUseFaceId(rebuild);

    console.log(
      `  (${i + 1}/${shots.length}) ${shot.id} ← ${reason} (${rebuild ? "REBUILD" : "img2img"} denoise=${denoise.toFixed(2)} faceid=${useFaceId})`,
    );

    const result = await runEdit(cfg, {
      shot,
      source,
      denoise,
      seed: cfg.seed + 500 + i * 17,
      prefix: shot.id,
      outPath: imgPath,
      captionPath: txtPath,
      loraName,
      backend,
      faceUploadName,
      fromEmptyLatent: rebuild,
      useFaceId,
    });

    lastAccepted = result;

    // Keyframe refresh — bank improves when a better viewpoint anchor appears
    const refreshKf = findRefreshTarget(shot, keyframeBank);
    if (refreshKf) {
      await refreshKeyframe(refreshKf, result.buf, cfg, shot);
    }

    manifest.push({
      id: shot.id,
      source: reason,
      denoise: rebuild ? 1 : denoise,
      rebuild,
      faceId: useFaceId,
      sourceYaw: source.yaw,
      targetYaw: yawOf(shot.angleKey),
      refreshedKeyframe: refreshKf ? refreshKf.id : null,
    });
    console.log(`  → ${imgPath}`);
    if (cfg.openImages) openFile(imgPath);
  }

  const masterDs = join(IMAGES_DIR, `${cfg.trigger}_00_master_identity.png`);
  await copyFile(MASTER_PATH, masterDs);
  await writeFile(
    join(IMAGES_DIR, `${cfg.trigger}_00_master_identity.txt`),
    `${cfg.trigger}, master identity, front view, standing, ${cfg.appearance}, ${cfg.outfit}, ${cfg.style}`,
    "utf8",
  );

  await writeFile(
    join(OUT_DIR, "manifest.json"),
    JSON.stringify(
      {
        character: cfg.name,
        trigger: cfg.trigger,
        pipeline: "identity-first-persistent-state",
        philosophy: "Identity is preserved. Pose is edited.",
        identityBackend: backend.name,
        lora: loraName,
        baseDenoise: BASE_DENOISE,
        denoiseBands: { easy: 0.55, medium: 0.72, hard: 0.82, extreme: [0.88, 0.95] },
        chaining: CHAIN,
        keyframeRefresh: !NO_KEYFRAME_REFRESH,
        faceIdPolicy: "master | controlled rebuilds | optional --aux-faceid",
        keyframes: keyframeBank.map((k) => ({
          id: k.id,
          angleKey: k.angleKey,
          yaw: k.yaw,
          expression: k.expression,
          bust: !!k.bust,
        })),
        shots: manifest,
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(`\nDone. LoRA-ready dataset: ${IMAGES_DIR}`);
  console.log(`Master:    ${MASTER_PATH}`);
  console.log(`Keyframes: ${KEYFRAMES_DIR}`);
  console.log(`Manifest:  ${join(OUT_DIR, "manifest.json")}`);
}

main().catch((err) => {
  console.error("\nFailed:", err.message || err);
  process.exit(1);
});