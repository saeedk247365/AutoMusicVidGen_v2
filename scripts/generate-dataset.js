import { mkdir, readFile, writeFile, copyFile, unlink } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { exec, execFile } from "child_process";
import { promisify } from "util";
import { platform } from "os";
import { randomUUID, randomInt } from "crypto";
import { buildOpenPosePng, ANGLE_YAW } from "../lib/openpose-maps.js";

const execFileAsync = promisify(execFile);

/**
 * Identity-first LoRA dataset generator.
 *
 * Core philosophy:
 *   Identity is persistent state. Pose is an edit.
 *   Identity is NEVER invented from text/noise as the primary source.
 *
 *   Identity is preserved. Pose is edited.
 *   NOT: Generate pose. Rediscover identity.
 *
 * Phase 1 ? Master Identity (generate ? review ? approve)
 *   A) --ref <image>            FaceID ref ? generate master_identity.png
 *   B) --set-master <image>     use an existing still as master (skips invent)
 *   C) --master-only            stop after master for visual review
 *   D) --approve-master         stamp master_approved.json after you like it
 *   Master invent seed is RANDOM each candidate (optional --seed to pin one).
 *   After approve, keyframes/shots use character JSON seed as usual.
 *   Keyframes/shots require an approved master (unless --skip-approval).
 *
 * Phase 2 ? Canonical Keyframes
 *   front / 45? / profile / rear / smile / bust from master (or nearest keyframe).
 *   img2img + OpenPose. Never invent identity from scratch (unless controlled rebuild).
 *
 * Phase 3 ? Training Shots
 *   Closest keyframe (yaw, pose, expression, bust) ? img2img + OpenPose.
 *   Identity from latent. OpenPose controls pose only.
 *
 * Adaptive denoise: easy ~0.55 | medium ~0.72 | hard ~0.82
 * Rebuilds (sit, crawl, rear, front→strict profile): EmptyLatent + denoise=1 + FaceID.
 * FaceID also on img2img when denoise >= 0.65 (not at ~0.55).
 * Keyframe refresh is OPT-IN (--keyframe-refresh). Default: master authority stays fixed.
 * Identity gate: InsightFace similarity vs master after each keyframe/shot (skip if no face).
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

const CONFIG_PATH = join(ROOT, flag("--character", "characters/tomchr.json"));
const OUT_DIR = join(ROOT, flag("--out", "dataset-new"));
const IMAGES_DIR = join(OUT_DIR, "images");
const POSES_DIR = join(OUT_DIR, "poses");
const KEYFRAMES_DIR = join(OUT_DIR, "keyframes");
const MASTER_PATH = join(OUT_DIR, "master_identity.png");
const MASTER_APPROVED_PATH = join(OUT_DIR, "master_approved.json");
const MASTER_SEED_PATH = join(OUT_DIR, "master_seed.json");
/** Optional fixed invent seed for a master candidate; omit = fresh random each run. */
const SEED_FLAG = flag("--seed", null);
const FACE_LOCK = join(OUT_DIR, "face_lock.png");

const MASTER_ONLY = has("--master-only");
const APPROVE_MASTER = has("--approve-master");
const SKIP_APPROVAL = has("--skip-approval");
const SET_MASTER = flag("--set-master", null);
const KEYFRAMES_ONLY = has("--keyframes-only");
const SHOTS_ONLY = has("--shots-only");
const FORCE = has("--force");
const FORCE_KEYFRAMES = has("--force-keyframes") || FORCE;
const CHAIN = has("--chain");
const AUX_FACEID = has("--aux-faceid");
/** Opt-in only — default bank is master → fixed keyframes → shots (no shot→bank pollution). */
const KEYFRAME_REFRESH = has("--keyframe-refresh");
/** Legacy alias: --no-keyframe-refresh is now the default (ignored). */
const SKIP_IDENTITY_GATE = has("--skip-identity-gate");
const IDENTITY_THRESHOLD = Number(flag("--identity-threshold", "0.40"));
const IDENTITY_RETRIES = Math.max(1, Number(flag("--identity-retries", "3")));
/** Legacy: invent face_lock from EmptyLatent+text. Causes identity drift ? avoid. */
const BOOTSTRAP_FROM_TEXT = has("--bootstrap-from-text");
const REF_FLAG = flag("--ref", null);
const COMFY_ROOT =
  flag("--comfy-root", null) || join(ROOT, "ComfyUI");
const COMFY_PYTHON = join(COMFY_ROOT, "venv", "Scripts", "python.exe");
const IDENTITY_SCRIPT = join(ROOT, "scripts", "identity-similarity.py");

/**
 * --master-only keeps inventing a new master until you --approve-master.
 * Once approved, master-only refuses to overwrite unless --force.
 */
function shouldForceNewMaster() {
  if (SET_MASTER || APPROVE_MASTER) return false;
  if (FORCE) return true;
  if (MASTER_ONLY && !isMasterApproved()) return true;
  return false;
}

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

/** Canonical viewpoint bank ? bootstrap via img2img from master; may refresh later. */
const KEYFRAME_SPECS_BASE = [
  { id: "front", angleKey: "front", poseKey: "stand", expression: "neutral", caption: "front stand neutral" },
  { id: "left45", angleKey: "threequarter_left", poseKey: "stand", expression: "neutral", caption: "three-quarter left" },
  { id: "right45", angleKey: "threequarter_right", poseKey: "stand", expression: "neutral", caption: "three-quarter right" },
  { id: "left_profile", angleKey: "side_left", poseKey: "stand", expression: "neutral", caption: "left profile" },
  { id: "right_profile", angleKey: "side_right", poseKey: "stand", expression: "neutral", caption: "right profile" },
  { id: "back", angleKey: "threequarter_back_left", poseKey: "stand", expression: "neutral", caption: "rear three-quarter" },
  { id: "smile", angleKey: "front", poseKey: "stand", expression: "happy", caption: "front stand soft smile" },
  { id: "neutral", angleKey: "front", poseKey: "bust", expression: "neutral", caption: "front bust neutral", bust: true },
];

/** Extra toddler anatomy anchors ? sitting / crawl / walk / hands / expressions. */
const KEYFRAME_SPECS_TODDLER = [
  { id: "sit", angleKey: "front", poseKey: "sit", expression: "neutral", caption: "front sit toddler" },
  { id: "crawl", angleKey: "threequarter_right", poseKey: "crawl", expression: "neutral", caption: "crawl toddler" },
  { id: "walk", angleKey: "threequarter_right", poseKey: "walk", expression: "neutral", caption: "walk toddler" },
  { id: "hands_up", angleKey: "front", poseKey: "hands_up", expression: "happy", caption: "hands up toddler" },
  { id: "wave", angleKey: "front", poseKey: "wave", expression: "happy", caption: "wave toddler" },
  { id: "point", angleKey: "front", poseKey: "point", expression: "neutral", caption: "point toddler" },
  { id: "happy_face", angleKey: "front", poseKey: "bust", expression: "happy", caption: "happy close face", bust: true },
  { id: "sad_face", angleKey: "front", poseKey: "bust", expression: "sad", caption: "sad close face", bust: true },
  { id: "surprised_face", angleKey: "front", poseKey: "bust", expression: "surprised", caption: "surprised close face", bust: true },
];

function keyframeSpecsFor(cfg) {
  return isToddler(cfg)
    ? [...KEYFRAME_SPECS_BASE, ...KEYFRAME_SPECS_TODDLER]
    : KEYFRAME_SPECS_BASE;
}

async function loadConfig() {
  let raw = await readFile(CONFIG_PATH, "utf8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const cfg = JSON.parse(raw);
  cfg.comfyUrl = flag("--comfy", cfg.comfyUrl || "http://127.0.0.1:8888");
  cfg.width = cfg.width || 512;
  cfg.height = cfg.height || 768;
  cfg.steps = cfg.steps || 28;
  cfg.cfg = cfg.cfg ?? 7;
  cfg.sampler = cfg.sampler || "dpmpp_2m";
  cfg.scheduler = cfg.scheduler || "karras";
  return cfg;
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
    throw new Error(`ComfyUI ${path} ? ${res.status}: ${(await res.text()).slice(0, 1200)}`);
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

/** Strip builder-only keys ? ComfyUI 500s if _modelRef etc. are sent as nodes. */
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
  if (label) console.log(`  queued ${label} (${promptId.slice(0, 8)}?)`);

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
  if (key === "stand" && /reach|hands[_ ]?up/.test(text)) key = "hands_up";
  if (key === "stand" && /crawl/.test(text)) key = "crawl";
  if (key === "stand" && /point/.test(text)) key = "point";
  return key;
}

function expressionOf(shot) {
  if (shot.expression) return String(shot.expression).toLowerCase();
  const text = `${shot.pose || ""} ${shot.captionExtra || ""} ${shot.id || ""}`.toLowerCase();
  if (/surpris/.test(text)) return "surprised";
  if (/sad|cry|frown/.test(text)) return "sad";
  if (/smile|happy|joyful|grin|wave/.test(text)) return "happy";
  return "neutral";
}

function expressionPrompt(shot, cfg = {}) {
  switch (expressionOf(shot)) {
    case "happy":
    case "smile":
      return isBoy(cfg)
        ? "happy soft closed-mouth boyish smile"
        : "happy soft closed-mouth warm smile";
    case "sad":
      return "sad downturned mouth, big soft watery eyes, same exact face identity";
    case "surprised":
      return "surprised round open mouth, wide eyes, same exact face identity";
    default:
      return null;
  }
}

function isToddler(cfg) {
  const blob = `${cfg.role || ""} ${cfg.age || ""} ${cfg.trigger || ""} ${cfg.styleTag || ""} ${cfg.appearance || ""}`;
  return /toddler|baby|adamboy|bibibaby/i.test(blob);
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
    if (dstPose === "sit" || srcPose === "sit" || dstPose === "crawl" || srcPose === "crawl") score += 4;
    else if (["wave", "point", "hand_on_hip", "hands_up", "walk"].includes(dstPose)) score += 2;
    else if (dstPose === "bust" || srcPose === "bust") score += 1;
    else score += 1;
  }

  if (shot.bust && !source.bust) score += 1;
  if (!shot.bust && source.bust) score += 2;
  if (expressionOf(shot) !== (source.expression || "neutral")) score += 1;

  return score;
}

/**
 * Adaptive denoise (img2img only ? rebuilds use denoise=1):
 *   easy ~0.55 | medium ~0.72 | hard ~0.82 | extreme ~0.88?0.95
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

  // Limb / gesture edits: enough denoise to change pose, FaceID anchors identity at >=0.65
  if (dstPose === "walk") d = clamp(Math.max(d, 0.72), 0.72, 0.78);
  if (dstPose === "sit" || dstPose === "crawl") d = Math.max(d, 0.82);
  if (dstPose === "wave" || dstPose === "point" || dstPose === "hands_up") {
    d = clamp(Math.max(d, 0.7), 0.7, 0.75);
  }
  return clamp(d, 0.5, 0.95);
}

/**
 * Controlled rebuild — EmptyLatent + FaceID. Keep only hard identity/pose breaks:
 *   sit, crawl, strict rear, front ↔ strict profile.
 * Do NOT rebuild for front→45, 45→profile, walk, wave, hands_up (img2img + FaceID).
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
  if ((dstPose === "crawl" && srcPose !== "crawl") || (srcPose === "crawl" && dstPose !== "crawl")) {
    return true;
  }
  if (isRearView(dstAngle) && !isRearView(srcAngle)) return true;
  if (isRearView(srcAngle) && !isRearView(dstAngle)) return true;
  // front → strict profile (and reverse on large yaw jump)
  if (isStrictProfile(dstAngle) && !isStrictProfile(srcAngle) && yawDelta > 25) return true;
  if (isStrictProfile(srcAngle) && !isStrictProfile(dstAngle) && yawDelta > 25) return true;
  return false;
}

/**
 * FaceID policy:
 *   Primary = img2img latent at low denoise (~0.55).
 *   FaceID when rebuild, --aux-faceid, or denoise >= 0.65 (identity anchor).
 */
function shouldUseFaceId(rebuild, denoise = 0) {
  return Boolean(rebuild || AUX_FACEID || denoise >= 0.65);
}

/** Stronger FaceID weight on rebuilds / harder aux edits; lighter near the 0.65 threshold. */
function faceIdWeightFor(fromEmptyLatent, denoise) {
  if (fromEmptyLatent) return 0.85;
  if (denoise >= 0.82) return 0.75;
  if (denoise >= 0.72) return 0.65;
  if (denoise >= 0.65) return 0.5;
  return 0.35;
}

function resolveReferencePath(cfg) {
  const candidates = [];
  if (REF_FLAG) candidates.push({ raw: REF_FLAG, required: true, label: "--ref" });
  if (cfg.referenceImage) {
    candidates.push({ raw: cfg.referenceImage, required: true, label: "referenceImage" });
  }
  candidates.push({ raw: join(OUT_DIR, "reference.png"), required: false, label: "out/reference.png" });
  candidates.push({
    raw: join(dirname(CONFIG_PATH), "reference.png"),
    required: false,
    label: "character-dir/reference.png",
  });

  for (const { raw, required, label } of candidates) {
    if (!raw) continue;
    const abs =
      raw.match(/^[A-Za-z]:[\\/]/) || raw.startsWith("/") || raw.startsWith("\\\\")
        ? raw
        : join(ROOT, raw);
    if (existsSync(abs)) return abs;
    if (required) {
      throw new Error(
        `Identity reference (${label}) not found: ${abs}\n` +
          `Pass a real image path, e.g. --ref "E:\\photos\\adam_ref.png"\n` +
          `Or generate without a ref: npm run generate:adam:master`,
      );
    }
  }
  return null;
}

async function ensureFaceLockFromRealImage(srcPath, label) {
  await mkdir(OUT_DIR, { recursive: true });
  if (!existsSync(srcPath)) {
    throw new Error(`Identity reference not found: ${srcPath}`);
  }
  await copyFile(srcPath, FACE_LOCK);
  console.log(`  face_lock ? ${label}: ${srcPath}`);
  return FACE_LOCK;
}

function isMasterApproved() {
  return existsSync(MASTER_APPROVED_PATH) && existsSync(MASTER_PATH);
}

async function clearMasterApproval(reason) {
  if (!existsSync(MASTER_APPROVED_PATH)) return;
  await unlink(MASTER_APPROVED_PATH);
  console.log(`  cleared master approval (${reason})`);
}

/**
 * Master invent seed: always random per candidate unless --seed is set.
 * After approval, keyframes/shots keep using character JSON cfg.seed (unchanged).
 */
function resolveMasterInventSeed() {
  if (SEED_FLAG != null && SEED_FLAG !== "") {
    const n = Number(SEED_FLAG);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`Invalid --seed: ${SEED_FLAG}`);
    }
    return n >>> 0;
  }
  return randomInt(0, 2 ** 32);
}

async function writeMasterSeedRecord(seed, { source = "invent" } = {}) {
  const rec = {
    seed,
    source,
    at: new Date().toISOString(),
    masterPath: MASTER_PATH,
  };
  await writeFile(MASTER_SEED_PATH, JSON.stringify(rec, null, 2), "utf8");
  return rec;
}

function readMasterSeedRecord() {
  if (!existsSync(MASTER_SEED_PATH)) return null;
  try {
    let raw = readFileSync(MASTER_SEED_PATH, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeMasterApproval({ source = "manual", note = "" } = {}) {
  if (!existsSync(MASTER_PATH)) {
    throw new Error(`Cannot approve ? missing master: ${MASTER_PATH}`);
  }
  const seedRec = readMasterSeedRecord();
  const stamp = {
    approvedAt: new Date().toISOString(),
    masterPath: MASTER_PATH,
    character: CONFIG_PATH,
    source,
    masterSeed: seedRec?.seed ?? null,
    note: note || undefined,
  };
  await writeFile(MASTER_APPROVED_PATH, JSON.stringify(stamp, null, 2), "utf8");
  console.log(`  ? master APPROVED ? ${MASTER_APPROVED_PATH}`);
  if (stamp.masterSeed != null) {
    console.log(`  locked invent seed=${stamp.masterSeed} (keyframes/shots still use character seed)`);
  }
  return stamp;
}

function resolveLocalPath(raw) {
  if (!raw) return null;
  if (raw.match(/^[A-Za-z]:[\\/]/) || raw.startsWith("/") || raw.startsWith("\\\\")) {
    return raw;
  }
  return join(ROOT, raw);
}

function printMasterReviewHelp(cfg) {
  const charArg = flag("--character", "characters/tomchr.json");
  const outArg = flag("--out", "dataset-new");
  console.log("");
  console.log("????????????????????????????????????????????????????????");
  console.log(" MASTER REVIEW REQUIRED");
  console.log(` Open: ${MASTER_PATH}`);
  console.log("");
  console.log(" 1) Approve only:");
  console.log(
    `    node scripts/generate-dataset.js --character ${charArg} --out ${outArg} --approve-master --master-only`,
  );
  console.log("");
  console.log(" 2) Approve and continue to keyframes + shots:");
  console.log(
    `    node scripts/generate-dataset.js --character ${charArg} --out ${outArg} --approve-master`,
  );
  console.log("");
  console.log(" 3) Dislike it? Regenerate master:");
  console.log(
    `    node scripts/generate-dataset.js --character ${charArg} --out ${outArg} --master-only --force --ref <ref.png>`,
  );
  console.log("    or install your own still:");
  console.log(
    `    node scripts/generate-dataset.js --character ${charArg} --out ${outArg} --set-master <still.png> --master-only`,
  );
  console.log("????????????????????????????????????????????????????????");
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

/** Shared render style ? centralized here; character JSON should use styleTag only. */
const STYLE_LOCK =
  "flat 2D anime cartoon illustration, clean cel shading, simple bold lineart, soft even studio lighting, consistent cartoon style";

/** Chroma-key green — captioned so LoRA can drop it at inference; never train scenic rooms. */
const BG_CHROMA =
  "plain solid chroma key green background, pure bright green #00FF00 backdrop, empty chroma studio, no furniture, no scenery, no room";

const BG_CHROMA_CAPTION = "plain solid chroma key green background";

const BG_CHROMA_NEGATIVE =
  "gray background, white background, beige background, room interior, furniture, kitchen, bedroom, lawn, scenery, gradient background, textured wall, circle backdrop";

/** @deprecated alias — kept so older call sites still resolve */
const BG_GRAY = BG_CHROMA;

/** Short clothing tokens — SD attention prefers brevity over long rule essays. */
const OUTFIT_LOCK =
  "mint green crew neck t-shirt, navy toddler pants, white sneakers, same outfit every image";

const OUTFIT_NEGATIVE =
  "shorts, bare legs, bare feet, jeans, logo, stripes, different clothes, clothing change, colored sneakers";

const STYLE_NEGATIVE =
  "photo, photorealistic, realistic skin texture, detailed pores, hyperrealistic, cinematic lighting, dramatic lighting, volumetric lighting, 3d render, octane, unreal engine";

const ANATOMY_NEGATIVE =
  "twisted neck, broken neck, impossible neck, head spun around, looking over shoulder, head facing camera while body turned away, extra legs, ghost legs, double legs, fused legs, overlapping legs, extra feet, three legs, malformed legs, extra limbs, duplicate limbs";

const TODDLER_LOCK =
  "toddler proportions, slightly large head relative to body, short legs, small hands, small feet, consistent head-to-body ratio, not overweight";

const TODDLER_NEGATIVE =
  "adult proportions, long legs, tall child, teen body, small head large body, fat, obese, overweight, chubby, pudgy, bloated belly, double chin";

const BOY_LOCK =
  "male toddler boy only, masculine little boy, boy haircut, boy face";

const BOY_NEGATIVE =
  "girl, female, woman, feminine, androgynous, female toddler, female child, long hair, pigtails, hair bow, dress, skirt, pink outfit, makeup, lipstick, heavy eyelashes";

function isBoy(cfg) {
  const blob = `${cfg.trigger || ""} ${cfg.age || ""} ${cfg.role || ""} ${cfg.appearance || ""} ${cfg.styleTag || ""}`;
  return /\bboy\b|male|adamboy|tomchr/i.test(blob);
}

/** Solid chroma-green identity plates only — scenes belong in animation compositing, not LoRA training. */
function backgroundForShot(shot) {
  if (shot.background) return shot.background;
  return BG_CHROMA;
}

function outfitPositive(cfg) {
  // Prefer short global lock; character outfit only if it is already short
  const o = (cfg.outfit || "").trim();
  if (o && o.length <= 120) return o;
  return OUTFIT_LOCK;
}

function styleParts(cfg, { rebuild = false } = {}) {
  const parts = [STYLE_LOCK];
  if (cfg.styleTag) parts.push(cfg.styleTag);
  else if (cfg.style && !/flat 2D anime cartoon illustration/i.test(cfg.style)) {
    parts.push(cfg.style);
  }
  if (isToddler(cfg)) parts.push(TODDLER_LOCK);
  if (isBoy(cfg)) parts.push(BOY_LOCK);
  if (rebuild) {
    parts.push(
      "strict flat cel-shaded cartoon only, same illustration style as the master identity, not realistic",
    );
  }
  return parts;
}

function anatomyPromptLock(shot, cfg) {
  const angle = shot.angleKey || "front";
  const parts = [
    "anatomically natural neck, head aligned with torso, no twisted neck",
    "exactly two legs, clear leg separation, no ghost limbs, no extra feet",
  ];
  if (isToddler(cfg)) {
    parts.push(
      "preserve toddler head-to-body ratio, short legs, small hands and feet, slim not fat",
    );
  }
  if (isBoy(cfg)) {
    parts.push("keep masculine toddler boy identity, never female");
  }
  if (isStrictProfile(angle)) {
    parts.push(
      "true side profile, head and body face the same direction, only one eye visible, only one ear visible",
      "profile reference sheet accuracy, facial silhouette preserved, same nose shape, same hair silhouette, same ear placement",
    );
  } else if (isRearView(angle) && !shot.lookOverShoulder) {
    parts.push(
      "facing away, back of head toward camera, do not turn head toward camera, no over-the-shoulder glance",
    );
  } else if (angle !== "front") {
    parts.push(
      "head facing same direction as body, gaze forward in body direction, not looking at camera",
    );
  }
  return parts.join(", ");
}

function characterPrompt(cfg, shot, { rebuild = false } = {}) {
  const expr = expressionPrompt(shot, cfg);
  const bg = backgroundForShot(shot);
  const style = styleParts(cfg, { rebuild }).join(", ");
  const outfit = outfitPositive(cfg);

  if (shot.bust) {
    return [
      cfg.trigger,
      cfg.appearance,
      outfit,
      shot.angle,
      shot.pose,
      expr,
      "close-up bust portrait, head and shoulders only, single character, same exact identity",
      anatomyPromptLock(shot, cfg),
      "clothing colors distinct from pure chroma key green backdrop",
      bg,
      style,
    ]
      .filter(Boolean)
      .join(", ");
  }
  return [
    cfg.trigger,
    cfg.appearance,
    outfit,
    shot.angle,
    shot.pose,
    expr,
    anatomyPromptLock(shot, cfg),
    "same exact character identity, consistent face body proportions hairstyle clothing age",
    "single solitary character only, full body centered, no other faces",
    outfit,
    "clothing colors distinct from pure chroma key green backdrop",
    bg,
    style,
  ]
    .filter(Boolean)
    .join(", ");
}

function shotNegative(cfg, shot) {
  return [
    cfg.negative,
    OUTFIT_NEGATIVE,
    STYLE_NEGATIVE,
    ANATOMY_NEGATIVE,
    BG_CHROMA_NEGATIVE,
    isToddler(cfg) ? TODDLER_NEGATIVE : null,
    isBoy(cfg) ? BOY_NEGATIVE : null,
    shot.extraNegative,
  ]
    .filter(Boolean)
    .join(", ");
}

function captionFor(cfg, shot) {
  return `${cfg.trigger}, ${shot.captionExtra || shot.caption || ""}, ${cfg.appearance}, ${outfitPositive(cfg)}, ${BG_CHROMA_CAPTION}`
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

/** Close-up face plate for FaceID. Must contain a detectable face (head fully in frame). */
function faceLockWorkflow(cfg, loraName, seed = cfg.seed) {
  const wf = withCheckpointAndOptionalLora(cfg, loraName);
  const prompt = [
    cfg.trigger,
    cfg.appearance,
    "extreme close-up face portrait only",
    "head fully visible and centered, face filling most of the frame",
    "eyes nose mouth clearly visible, looking at camera",
    "crop at shoulders, NO full body, NO torso below chest, NO legs, NO feet, NO hands in pockets",
    ...styleParts(cfg),
    BG_GRAY,
  ].join(", ");
  const negative = [
    cfg.negative,
    "full body, standing full figure, legs, feet, shoes, pants visible, hands in pockets, head out of frame, head cropped, no face, faceless, decapitated",
    STYLE_NEGATIVE,
  ]
    .filter(Boolean)
    .join(", ");
  wf["3"] = {
    class_type: "CLIPTextEncode",
    inputs: { text: prompt, clip: wf._clipRef },
  };
  wf["4"] = {
    class_type: "CLIPTextEncode",
    inputs: { text: negative, clip: wf._clipRef },
  };
  wf["5"] = {
    class_type: "EmptyLatentImage",
    // Square bust is easier for InsightFace than tall full-body canvas
    inputs: { width: Math.min(cfg.width || 512, 512), height: Math.min(cfg.width || 512, 512), batch_size: 1 },
  };
  wf["6"] = {
    class_type: "KSampler",
    inputs: {
      seed,
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

/** PHASE 1 ? master from real FaceID ref (+ OpenPose). Not identity-from-text alone. */
function masterIdentityWorkflow(cfg, { loraName, poseMapName, faceImageName, backend, seed }) {
  if (seed == null) {
    throw new Error("masterIdentityWorkflow requires an explicit invent seed (random per candidate)");
  }
  const wf = withCheckpointAndOptionalLora(cfg, loraName);
  const prompt = [
    cfg.trigger,
    cfg.appearance,
    cfg.outfit,
    "front view, body facing camera, looking at camera",
    "standing straight, arms relaxed at sides, feet slightly apart",
    "full body including head and feet, head fully visible, face clearly visible",
    "canonical master identity reference, perfect character consistency",
    "single solitary character only, full body centered",
    OUTFIT_LOCK,
    "hands empty at sides, no hands in pockets",
    BG_GRAY,
    ...styleParts(cfg),
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
      seed,
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
/* Source selection ? closest keyframe; optional chain if closer in yaw        */
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
    throw new Error("No keyframe sources available ? run master + keyframes first.");
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
  if (!KEYFRAME_REFRESH) return null;
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
  console.log(`  ? refreshed keyframe ${kf.id}`);
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

/**
 * InsightFace cosine similarity vs master / face_lock.
 * Returns { skipped, pass, similarity, reason }.
 */
async function checkIdentitySimilarity(candidatePath) {
  if (SKIP_IDENTITY_GATE) {
    return { skipped: true, pass: true, similarity: null, reason: "skip_flag" };
  }
  const ref = existsSync(FACE_LOCK)
    ? FACE_LOCK
    : existsSync(MASTER_PATH)
      ? MASTER_PATH
      : null;
  if (!ref) {
    return { skipped: true, pass: true, similarity: null, reason: "no_ref" };
  }
  if (!existsSync(COMFY_PYTHON) || !existsSync(IDENTITY_SCRIPT)) {
    console.log("  identity_gate=skipped (Comfy python or helper missing)");
    return { skipped: true, pass: true, similarity: null, reason: "helper_missing" };
  }
  try {
    const { stdout } = await execFileAsync(
      COMFY_PYTHON,
      [IDENTITY_SCRIPT, ref, candidatePath],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    );
    const line = String(stdout || "")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .pop();
    const data = JSON.parse(line || "{}");
    if (!data.ok) {
      if (data.reason === "no_face") {
        return {
          skipped: true,
          pass: true,
          similarity: null,
          reason: "skipped_no_face",
        };
      }
      return {
        skipped: true,
        pass: true,
        similarity: null,
        reason: data.reason || "gate_error",
      };
    }
    const sim = Number(data.similarity);
    const pass = sim >= IDENTITY_THRESHOLD;
    return { skipped: false, pass, similarity: sim, reason: pass ? "ok" : "below_threshold" };
  } catch (err) {
    console.log(`  identity_gate=skipped (error: ${err.message || err})`);
    return { skipped: true, pass: true, similarity: null, reason: "exec_error" };
  }
}

/** True if InsightFace can detect a face on path (same image vs itself). */
async function insightFaceDetects(path) {
  if (!existsSync(path) || !existsSync(COMFY_PYTHON) || !existsSync(IDENTITY_SCRIPT)) {
    return false;
  }
  try {
    const { stdout } = await execFileAsync(
      COMFY_PYTHON,
      [IDENTITY_SCRIPT, path, path],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    );
    const line = String(stdout || "")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .pop();
    const data = JSON.parse(line || "{}");
    return Boolean(data.ok);
  } catch {
    return false;
  }
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

  const attempts = SKIP_IDENTITY_GATE ? 1 : IDENTITY_RETRIES;
  let best = null;
  let bestSim = -Infinity;
  let lastGate = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const attemptSeed = (seed + attempt * 9973) >>> 0;
    const buf = await queueAndWait(
      cfg.comfyUrl,
      img2imgOpenPoseWorkflow(cfg, {
        loraName,
        sourceImageName: source?.uploadName,
        poseMapName: poseName,
        prompt,
        negative,
        seed: attemptSeed,
        denoise,
        openPoseStrength: OPENPOSE_STRENGTH,
        prefix: `id_${prefix}`,
        backend,
        faceImageName: faceUploadName,
        useFaceId,
        fromEmptyLatent,
      }),
      attempt === 0 ? prefix : `${prefix}_r${attempt}`,
    );

    const tmpPath = join(OUT_DIR, `_gate_${prefix.replace(/[^\w.-]+/g, "_")}.png`);
    await writeFile(tmpPath, buf);
    const gate = await checkIdentitySimilarity(tmpPath);
    lastGate = gate;

    if (gate.skipped) {
      best = { buf, seed: attemptSeed, gate };
      break;
    }

    const sim = gate.similarity ?? -1;
    if (sim > bestSim) {
      bestSim = sim;
      best = { buf, seed: attemptSeed, gate };
    }

    if (gate.pass) {
      console.log(
        `  identity_gate=pass sim=${sim.toFixed(3)} (threshold ${IDENTITY_THRESHOLD})`,
      );
      break;
    }

    console.log(
      `  identity_gate=reject sim=${sim.toFixed(3)} < ${IDENTITY_THRESHOLD} (retry ${attempt + 1}/${attempts})`,
    );
  }

  if (!best) throw new Error(`Identity gate produced no candidate for ${prefix}`);
  if (!best.gate.skipped && !best.gate.pass) {
    console.log(
      `  identity_gate=warn keeping best sim=${(best.gate.similarity ?? bestSim).toFixed?.(3) ?? bestSim} after ${attempts} tries`,
    );
  } else if (best.gate.skipped && best.gate.reason === "skipped_no_face") {
    console.log("  identity_gate=skipped_no_face");
  }

  await writeFile(outPath, best.buf);
  try {
    await unlink(join(OUT_DIR, `_gate_${prefix.replace(/[^\w.-]+/g, "_")}.png`));
  } catch {
    /* ignore */
  }
  if (captionPath) await writeFile(captionPath, captionFor(cfg, shot), "utf8");
  const uploaded = await uploadImage(cfg.comfyUrl, `id_out_${prefix}.png`, best.buf);
  return {
    buf: best.buf,
    uploadName: uploaded.name,
    yaw: yawOf(shot.angleKey),
    angleKey: shot.angleKey,
    poseKey: effectivePoseKey(shot),
    expression: expressionOf(shot),
    bust: Boolean(shot.bust),
    id: shot.id,
    shotId: shot.id,
    identityGate: best.gate || lastGate,
    seedUsed: best.seed,
  };
}

async function loadKeyframeBank(cfg) {
  const bank = [];
  for (const spec of keyframeSpecsFor(cfg)) {
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
  const expr = String(spec.expression || "neutral").toLowerCase();
  let pose = "standing straight, arms relaxed at sides, feet slightly apart";
  if (spec.poseKey === "sit") pose = "sitting, knees bent, hands on thighs, feet on floor";
  else if (spec.poseKey === "crawl") pose = "crawling on all fours, hands and knees on floor";
  else if (spec.poseKey === "walk") pose = "walking mid-stride, arms swinging naturally";
  else if (spec.poseKey === "hands_up") pose = "standing, both arms raised high above head";
  else if (spec.poseKey === "wave") pose = "standing, one arm raised waving hello";
  else if (spec.poseKey === "point") pose = "standing, one arm extended pointing forward";
  else if (spec.bust) pose = "facing camera, shoulders visible";
  else if (expr === "happy" || expr === "smile") {
    pose = "standing straight, soft friendly closed-mouth smile, arms at sides";
  }
  if (expr === "sad" && spec.bust) pose = "sad expression, downturned mouth, shoulders visible";
  if (expr === "surprised" && spec.bust) pose = "surprised expression, wide eyes, shoulders visible";
  if (expr === "happy" && spec.bust) pose = "happy smile, rosy cheeks, shoulders visible";

  return normalizeShot({
    id: spec.id,
    angleKey: spec.angleKey,
    poseKey: spec.poseKey,
    expression: spec.expression,
    bust: Boolean(spec.bust),
    pose,
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
  console.log(`OpenPose:   ${OPENPOSE_STRENGTH} (pose only ? identity from latent)`);
  console.log(`Source:     closest keyframe${CHAIN ? " + optional chain" : ""}`);
  console.log(`Keyframes:  refresh=${KEYFRAME_REFRESH ? "on (--keyframe-refresh)" : "off (default)"}`);
  console.log(
    `FaceID on:  master | rebuilds | denoise>=0.65${AUX_FACEID ? " | all (--aux-faceid)" : ""}`,
  );
  console.log(
    `Identity gate: ${SKIP_IDENTITY_GATE ? "off" : `on (threshold ${IDENTITY_THRESHOLD}, retries ${IDENTITY_RETRIES})`}`,
  );
  console.log(
    `Bootstrap:  ${BOOTSTRAP_FROM_TEXT ? "TEXT/NOISE (legacy ? drift risk)" : "real --ref or approved master"}`,
  );

  await comfy(cfg.comfyUrl, "/system_stats");

  let faceUploadName = null;
  let masterJustCreated = false;

  // ======================== PHASE 1: MASTER IDENTITY ========================
  // Generate ? review ? --approve-master. Keyframes require approval stamp.
  if (!SHOTS_ONLY && !KEYFRAMES_ONLY) {
    // Optional: install a hand-picked still as the master (skip invent).
    if (SET_MASTER) {
      const src = resolveLocalPath(SET_MASTER);
      if (!existsSync(src)) throw new Error(`--set-master not found: ${src}`);
      await mkdir(OUT_DIR, { recursive: true });
      await copyFile(src, MASTER_PATH);
      await ensureFaceLockFromRealImage(src, "--set-master");
      await clearMasterApproval("new master installed via --set-master");
      masterJustCreated = true;
      console.log(`\n[1] Master installed from file ? ${MASTER_PATH}`);
      if (cfg.openImages !== false) openFile(MASTER_PATH);
    }

    const forceNewMaster = shouldForceNewMaster();
    const masterSeed = resolveMasterInventSeed();
    if (MASTER_ONLY && isMasterApproved() && !FORCE && !SET_MASTER) {
      console.log(`\n[1] Master already APPROVED: ${MASTER_PATH}`);
      console.log("  Re-run with --force to replace it (clears approval).");
      printMasterReviewHelp(cfg);
      return;
    }
    const hasMaster = existsSync(MASTER_PATH) && !forceNewMaster;
    const refPath = resolveReferencePath(cfg);

    if (backend.name === "faceid") {
      if (hasMaster && !SET_MASTER) {
        const faceSrc =
          existsSync(FACE_LOCK) && !FORCE ? FACE_LOCK : MASTER_PATH;
        await ensureFaceLockFromRealImage(
          faceSrc,
          faceSrc === MASTER_PATH ? "master" : "existing face_lock",
        );
        console.log(`\n[1a] FaceID source ? master / face_lock`);
      } else if (refPath) {
        console.log("\n[1a] FaceID source ? real reference image");
        await ensureFaceLockFromRealImage(refPath, "--ref / referenceImage");
        const refCopy = join(OUT_DIR, "reference.png");
        if (refPath !== refCopy) await copyFile(refPath, refCopy);
      } else if (existsSync(FACE_LOCK) && !forceNewMaster) {
        console.log(`\n[1a] Reuse face_lock: ${FACE_LOCK}`);
      } else if (BOOTSTRAP_FROM_TEXT || forceNewMaster) {
        // Text bootstrap: do NOT invent a separate face_lock for FaceID.
        // Cartoon/noise face plates often have no detectable face → InsightFace crashes.
        // Invent the master from text+OpenPose first, then copy master → face_lock.
        console.log(
          "\n[1a] Text bootstrap: skip FaceID face_lock (will invent master from text, then copy to face_lock)",
        );
        faceUploadName = null;
      } else if (!existsSync(MASTER_PATH) || FORCE) {
        throw new Error(
          [
            "No real identity source for FaceID.",
            "Provide one of:",
            "  1) --ref path/to/reference.png",
            "  2) --set-master path/to/approved_still.png",
            "  3) set \"referenceImage\" in the character JSON",
            "  4) --bootstrap-from-text   (invents master from text; no FaceID)",
          ].join("\n"),
        );
      }

      if (refPath || (hasMaster && !forceNewMaster) || (existsSync(FACE_LOCK) && !forceNewMaster && !BOOTSTRAP_FROM_TEXT)) {
        if (existsSync(FACE_LOCK)) {
          faceUploadName = (
            await uploadImage(cfg.comfyUrl, "id_face_lock_ref.png", await readFile(FACE_LOCK))
          ).name;
        }
      }
    }

    if ((!existsSync(MASTER_PATH) || forceNewMaster) && !SET_MASTER) {
      const textBootstrap = BOOTSTRAP_FROM_TEXT || (forceNewMaster && !refPath);
      if (backend.name === "faceid" && !faceUploadName && !textBootstrap) {
        throw new Error("FaceID required for master generation but no face reference was uploaded.");
      }
      if (textBootstrap) {
        console.log(
          "\n[1b] Generating master from text + OpenPose (no FaceID — review required)…",
        );
      } else {
        console.log(
          "\n[1b] Generating master identity (FaceID + OpenPose — review required)…",
        );
      }
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
          faceImageName: textBootstrap ? null : faceUploadName,
          backend: textBootstrap ? { name: "none" } : backend,
          seed: masterSeed,
        }),
        "master",
      );
      await writeFile(MASTER_PATH, masterBuf);
      // Use master itself as face_lock for later continuity (may still be cartoon for InsightFace)
      await copyFile(MASTER_PATH, FACE_LOCK);
      await writeMasterSeedRecord(masterSeed, {
        source: SEED_FLAG != null ? "cli --seed" : "random",
      });
      await clearMasterApproval("new master generated");
      masterJustCreated = true;
      console.log(`  → ${MASTER_PATH}`);
      console.log(`  face_lock ← master`);
      console.log(
        SEED_FLAG != null
          ? `  invent seed=${masterSeed} (--seed override)`
          : `  invent seed=${masterSeed} (random candidate — approve to lock identity)`,
      );
      console.log(`  after approve: keyframes/shots use character seed=${cfg.seed}`);
      if (cfg.openImages !== false) openFile(MASTER_PATH);
    } else if (!SET_MASTER) {
      console.log(`\n[1b] Existing master: ${MASTER_PATH}`);
      console.log(
        isMasterApproved()
          ? "  status: APPROVED"
          : "  status: pending review (not approved yet)",
      );
    }
  } else if (!existsSync(MASTER_PATH)) {
    throw new Error(
      "Missing master_identity.png ? generate with --master-only first, then --approve-master.",
    );
  }

  // Explicit approve stamp (after you visually like the master).
  if (APPROVE_MASTER) {
    if (!existsSync(MASTER_PATH)) {
      throw new Error(`Cannot --approve-master; missing ${MASTER_PATH}`);
    }
    await writeMasterApproval({
      source: SET_MASTER ? "set-master" : masterJustCreated ? "generated" : "existing",
    });
    await ensureFaceLockFromRealImage(MASTER_PATH, "approved master");
  }

  if (MASTER_ONLY) {
    printMasterReviewHelp(cfg);
    console.log(
      masterJustCreated || !isMasterApproved()
        ? "\nDone (master only). Approve when ready, then continue."
        : "\nDone (master only). Master already approved.",
    );
    return;
  }

  // Gate: do not build keyframes/shots on an unreviewed master.
  if (!SKIP_APPROVAL && !isMasterApproved()) {
    printMasterReviewHelp(cfg);
    throw new Error(
      "Master is not approved yet. Review the image, then re-run with --approve-master (or pass --skip-approval).",
    );
  }

  if (!faceUploadName && existsSync(FACE_LOCK) && backend.name === "faceid") {
    faceUploadName = (
      await uploadImage(cfg.comfyUrl, "id_face_lock_ref.png", await readFile(FACE_LOCK))
    ).name;
  } else if (!faceUploadName && existsSync(MASTER_PATH) && backend.name === "faceid") {
    await ensureFaceLockFromRealImage(MASTER_PATH, "approved master");
    faceUploadName = (
      await uploadImage(cfg.comfyUrl, "id_face_lock_ref.png", await readFile(FACE_LOCK))
    ).name;
  }

  // Cartoon masters often have no InsightFace-detectable face — FaceID would crash Comfy.
  if (faceUploadName) {
    const probe = existsSync(FACE_LOCK) ? FACE_LOCK : MASTER_PATH;
    if (!(await insightFaceDetects(probe))) {
      console.log(
        "  FaceID disabled: InsightFace found no face on face_lock (common for cartoons). Using img2img latent only.",
      );
      faceUploadName = null;
    }
  }

  /** @type {Array<object>} */
  let keyframeBank = [];

  // ======================== PHASE 2: CANONICAL KEYFRAMES ========================
  // img2img from master / nearest keyframe. Never invent identity from noise
  // unless controlled rebuild (profile / rear) ? then FaceID carries identity.
  if (!SHOTS_ONLY) {
    console.log("\n[2] Canonical keyframes (img2img from master / nearest)?");

    const frontPath = join(KEYFRAMES_DIR, "front.png");
    if (!existsSync(frontPath) || FORCE_KEYFRAMES) {
      await copyFile(MASTER_PATH, frontPath);
      console.log("  front.png ? master (identity seed)");
    } else {
      console.log("  reuse front.png");
    }

    keyframeBank = await loadKeyframeBank(cfg);
    if (!keyframeBank.find((k) => k.id === "front")) {
      throw new Error("front keyframe missing");
    }

    for (const spec of keyframeSpecsFor(cfg)) {
      if (spec.id === "front") continue;
      const outPath = join(KEYFRAMES_DIR, `${spec.id}.png`);

      if (existsSync(outPath) && !FORCE_KEYFRAMES) {
        console.log(`  reuse ${spec.id}.png`);
        continue;
      }

      const shot = keyframeShotFromSpec(spec);
      const { source, reason } = selectSource(shot, keyframeBank, null);
      let rebuild = needsEmptyLatentRebuild(shot, source);
      let denoise = rebuild ? 1 : denoiseForEdit(shot, source);
      // Without FaceID, EmptyLatent invents identity — fall back to strong img2img instead.
      if (rebuild && !faceUploadName) {
        rebuild = false;
        denoise = Math.max(denoiseForEdit(shot, source), 0.85);
      }
      const useFaceId = shouldUseFaceId(rebuild, denoise) && Boolean(faceUploadName);

      console.log(
        `  ${spec.id} ? ${reason} (${rebuild ? "REBUILD EmptyLatent+FaceID" : "img2img"} denoise=${denoise.toFixed(2)} faceid=${useFaceId})`,
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

      console.log(`  ? ${outPath}`);
      keyframeBank = await loadKeyframeBank(cfg);
    }

    keyframeBank = await loadKeyframeBank(cfg);
    console.log(`  Keyframe bank ready (${keyframeBank.length} frames).`);
  } else {
    console.log("\n[2] Loading keyframe bank?");
    keyframeBank = await loadKeyframeBank(cfg);
    if (!keyframeBank.length) throw new Error("No keyframes found.");
  }

  if (KEYFRAMES_ONLY) {
    console.log("\nDone (keyframes only). Review keyframes/, then run --shots-only.");
    return;
  }

  // ======================== PHASE 3: TRAINING SHOTS ========================
  if (!Array.isArray(cfg.shots) || !cfg.shots.length) {
    throw new Error(
      `No shots defined in ${CONFIG_PATH}. Add a "shots" array (see characters/adam.json), or stop after keyframes with --keyframes-only.`,
    );
  }
  const shots = (ONLY_IDS ? cfg.shots.filter((s) => ONLY_IDS.has(s.id)) : cfg.shots).map(
    normalizeShot,
  );
  console.log(`\n[3] Training shots (${shots.length}) from closest keyframe?`);

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
    let rebuild = needsEmptyLatentRebuild(shot, source);
    let denoise = rebuild ? 1 : denoiseForEdit(shot, source);
    if (rebuild && !faceUploadName) {
      rebuild = false;
      denoise = Math.max(denoiseForEdit(shot, source), 0.85);
    }
    const useFaceId = shouldUseFaceId(rebuild, denoise) && Boolean(faceUploadName);

    console.log(
      `  (${i + 1}/${shots.length}) ${shot.id} ? ${reason} (${rebuild ? "REBUILD" : "img2img"} denoise=${denoise.toFixed(2)} faceid=${useFaceId})`,
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

    // Keyframe refresh only when --keyframe-refresh (opt-in; avoids bank pollution)
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
      identityGate: result.identityGate || null,
      seedUsed: result.seedUsed ?? null,
    });
    console.log(`  ? ${imgPath}`);
    if (cfg.openImages) openFile(imgPath);
  }

  const masterDs = join(IMAGES_DIR, `${cfg.trigger}_00_master_identity.png`);
  await copyFile(MASTER_PATH, masterDs);
  await writeFile(
    join(IMAGES_DIR, `${cfg.trigger}_00_master_identity.txt`),
    `${cfg.trigger}, master identity, front view, standing, ${cfg.appearance}, ${outfitPositive(cfg)}`,
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
        denoiseBands: { easy: 0.55, medium: 0.72, hard: 0.82, walk: [0.72, 0.78] },
        chaining: CHAIN,
        keyframeRefresh: KEYFRAME_REFRESH,
        faceIdPolicy: "master | rebuilds | denoise>=0.65 | optional --aux-faceid",
        identityGate: {
          enabled: !SKIP_IDENTITY_GATE,
          threshold: IDENTITY_THRESHOLD,
          retries: IDENTITY_RETRIES,
        },
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