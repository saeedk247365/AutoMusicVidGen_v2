/**
 * Adam-only nursery pipeline (toddler boy Adam — no Tom / tomchr / Sasha):
 *   1) Ensure character ref stills exist (optional / --chars-only)
 *   2) Ensure empty scene stills exist (home / lawn / kitchen / bedroom / dining)
 *   3) For each song: Qwen lyrics → ACE song → Qwen scene/actions → keyframes
 *
 * Keyframes: Adam studio plate (txt2img+LoRA) → ML background removal →
 * paste onto UNTOUCHED empty scene. Scene geometry is never inpainted/rewritten.
 *
 * Output:
 *   characters/            shared character defs + ref stills
 *   scenes/                shared empty room defs + stills
 *   batches/<YYYYMMDD>/
 *     <song_slug>/
 *       <song_slug>.mp3
 *       lyrics.txt
 *       scenes/            song-specific scene copies + actions.json
 *       keyframes/         Adam-in-scene beat stills
 *
 * Character defs live in characters/ (single JSON per character in characters/).
 * Cast is Adam only (characters/adam.json).
 *
 * Run:
 *   node scripts/02_0_generate-lyrics+song+scene+keyframes.js
 *
 * Optional:
 *   --count 10 --chars-only --scenes-only --force --skip-audio --qwen qwen3:14b
 *   --song batches/<date>/<slug> --keyframes-only   (regen stills; normalizes actions.json)
 *   --song … --keyframes-only --replan               (re-run Qwen beats from lyrics.txt)
 *   --song … --keyframes-only --force --reuse-cutouts (re-layout scale/placement only)
 */
import { mkdir, writeFile, readFile, copyFile, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { spawn, execFile } from "child_process";
import { promisify } from "util";
import {
  parseArgs,
  stripBom,
  comfy,
  sleep,
  queueAndWait,
  copyNewestOutput,
  checkpointStillWorkflow,
  loraStillWorkflow,
  loraImg2ImgWorkflow,
  uploadImage,
  COMFY_ROOT,
} from "../lib/comfy-client.js";
import sharp from "sharp";
import {
  compositeScene,
  STUDIO_BG_PROMPT,
  STUDIO_BG_NEGATIVE,
  removePlateBackground,
  resolveCharacterLayout,
} from "../lib/composite.js";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, "..");
const CHAR_PATH = join(ROOT, "characters", "adam.json");
const CHARACTERS_DIR = join(ROOT, "characters");
/** Only Adam appears in generated scenes (never Tom / tomchr / Sasha). */
const CAST_IDS = ["adam"];
const SCENES_DIR = join(ROOT, "scenes");
const ACE_ROOT =
  "C:\\Users\\Saeed Khan\\AppData\\Local\\ProdesecStudio\\ACE-Step-1.5";
const ACE_PYTHON = join(ACE_ROOT, ".venv", "Scripts", "python.exe");
const ACE_SCRIPT = join(ROOT, "pipelines", "ace-generate-song.py");
const OLLAMA_URL = "http://127.0.0.1:11434";

// ─── Song prompts (edit freely) ─────────────────────────────────────────────

const THEMES = [
  "dinosaurs",
  "farm animals",
  "construction trucks",
  "bedtime",
  "outer space",
  "pirates",
  "jungle",
  "ocean",
  "healthy food",
  "music",
  "colors",
  "counting",
  "friendship",
  "sharing",
  "kindness",
  "weather",
  "camping",
  "school",
  "garden",
  "magic",
  "transportation",
  "sports",
  "holidays",
  "circus",
  "washing hands",
  "brushing teeth",
  "rainy day",
  "snow day",
  "baking cookies",
  "kites",
  "balloons",
  "feelings",
  "shapes",
  "planets",
  "vegetables",
  "family",
  "seasons",
  "zoo trip",
  "teddy bear picnic",
  "sandcastles",
];

const STYLES = [
  "gentle acoustic",
  "modern preschool pop",
  "folk singalong",
  "light country",
  "soft orchestral",
  "happy ukulele",
  "playful jazz",
  "marching band",
  "calypso",
  "light bluegrass",
];

const EDUCATIONAL_FOCUS = [
  "counting",
  "colors",
  "emotions",
  "daily routines",
  "nature",
  "sharing",
  "listening",
  "body awareness",
  "opposites",
  "sequencing",
];

const MOVEMENT_PROMPTS = [
  "clap",
  "stomp",
  "tiptoe",
  "wave",
  "stretch",
  "spin",
  "march",
  "hop",
  "reach up high",
  "tap toes",
];

const CAPTION_TEMPLATE = `Create an original preschool song called "{{TITLE}}".

The song should sound like a professionally produced children's television theme.

Musical style:
{{STYLE}}

Requirements:
- warm
- playful
- memorable
- emotional
- positive
- uplifting
- easy to sing

Production:
- acoustic guitar
- piano
- ukulele
- hand claps
- bells
- soft percussion

Children's choir joins during the chorus.

The chorus should be the catchiest part.

The final chorus should feel bigger than every previous chorus.

Finish with a natural instrumental outro lasting around 10 seconds.

The vocals should finish before the music ends.

Do not cut off abruptly.

Target runtime:
about 150 seconds.`;

const QWEN_LYRICS_PROMPT = `You are one of the world's best preschool songwriters.

Your songs should feel like songs that could be sung in classrooms all over the world for the next 30 years.

Audience:
- ages 2-6
- teachers
- parents

Goals:
- easy to memorize
- joyful
- repetitive
- educational without sounding educational
- emotionally warm
- natural English
- sounds written by a human songwriter

DO NOT imitate existing nursery songs.

Today's song theme:
{{THEME}}

Only write about this theme.

Educational focus (weave in lightly, never lecture):
{{EDU_FOCUS}}

Primary movement for the chorus (must appear clearly):
{{MOVEMENT}}

Avoid repeating these tired tropes:
- bunny
- bird
- turtle
- puppy
- rainbow
- dream parade

Every chorus must contain:
- one memorable repeated hook
- the movement above (or a natural variation)
- one line teachers can easily teach

The chorus should be catchy enough that children remember it after hearing it once.

Song structure:

[Intro]
[Verse 1]
[Chorus]
[Verse 2]
[Chorus]
[Bridge]
[Final Chorus]
[Outro]

Each verse should introduce something NEW within the theme.

The bridge should slow slightly before the final chorus.

The outro should feel like saying goodbye naturally.

The lyrics should naturally finish BEFORE the music ends.

Keep lines short.

Never write more than 8 words on one line.

Never repeat the exact same song idea.

Do NOT reuse any of these titles already used this run:
{{USED_TITLES}}

OUTPUT EXACTLY

TITLE: ...

LYRICS:
...`;

/**
 * Qwen scene planner — frozen geometry only (identity-first).
 * Each beat: Adam studio plate → rembg cutout → paste on empty scene.
 * Placeholders: {{TITLE}} {{LYRICS}} {{THEME}} {{LOCATIONS}} {{POSES}} {{CAMERAS}} {{EXPRESSIONS}} {{FACINGS}}
 */
const QWEN_SCENES_PROMPT = `You plan preschool music-video BEATS as frozen still frames for a cartoon toddler.

Characters (use ONLY this name — never Tom, tomchr, dad, mom, Sasha, or any other person):
- Adam = toddler boy (the ONLY character in every beat)

Allowed locations (exact ids only):
{{LOCATIONS}}

Allowed camera values (exact — prefer full_body; never invent wide shots):
{{CAMERAS}}

Allowed pose ids (exact — ONLY these):
{{POSES}}

Allowed expression ids (exact):
{{EXPRESSIONS}}

Allowed facing ids (exact — body/head angle; never use lookAt):
{{FACINGS}}

Song title: {{TITLE}}
Theme: {{THEME}}

Lyrics:
{{LYRICS}}

Create 6 to 8 beats from intro to outro.

HARD RULES:
- Each beat is ONE frozen instant. No sequences ("runs then stops").
- No storytelling, no adverbs, no prompt_extra, no lookAt.
- Pose / expression / facing / camera must be from the allowed lists only.
- Exactly ONE character per beat: Adam only. placement must be {"Adam":"center"}.
- Never include Tom, tomchr, Sasha, dad, mom, or any second person.
- Preschool-safe. No scary content.

OUTPUT EXACTLY valid JSON (no markdown fences):
{
  "beats": [
    {
      "id": "01_intro",
      "location": "kitchen",
      "section": "Intro",
      "camera": "full_body",
      "placement": { "Adam": "center" },
      "characters": [
        {
          "name": "Adam",
          "pose": "clap",
          "expression": "happy",
          "facing": "front"
        }
      ]
    }
  ]
}`;

/** Canonical pose ids → deterministic geometry phrases for SD */
const CANONICAL_POSES = {
  stand:
    "standing upright, feet slightly apart, arms relaxed at sides, weight even",
  sit: "sitting, knees bent, hands resting on thighs, feet on floor",
  kneel:
    "kneeling on one knee, torso upright, arms open slightly at sides",
  walk:
    "mid-stride walk, left leg forward, right arm forward, right leg back, left arm back",
  wave: "standing, one arm raised waving, other arm at side",
  point: "standing, one arm extended pointing forward, other arm at side",
  hands_up: "standing, both arms raised above head, elbows soft",
  clap: "standing, both hands together in front of chest clapping",
};

const CANONICAL_CAMERAS = {
  full_body: "full body shot, head to feet visible, character large in frame, centered",
  medium_full: "medium full shot, head to knees, character large in frame",
  medium: "medium shot, waist-up, character fills most of frame",
  close: "close shot, chest-up, face clear",
  portrait: "portrait bust shot, shoulders and head, face clear",
};

const CANONICAL_EXPRESSIONS = {
  happy: "happy closed-mouth smile",
  neutral: "neutral calm face",
  curious: "curious soft open expression",
  gentle_smile: "gentle soft smile",
};

const CANONICAL_FACINGS = {
  front: "front view, body facing camera, head facing camera",
  three_quarter_left:
    "three-quarter view from left, body angled slightly left, head facing camera",
  three_quarter_right:
    "three-quarter view from right, body angled slightly right, head facing camera",
};

const CHAR_NAME_RE = /^adam$/i;

/** Other cast triggers to ban when generating a solo plate */
const CAST_SOLO_NEGATIVES = {
  adam: "Tom, tomchr, tomdad, Sasha, sashamom, adult, dad, mom, woman, father, mother, two people, multiple people, second person, couple, duo",
};

function titleCaseName(c) {
  const s = String(c || "").trim();
  if (!s) return "";
  return s[0].toUpperCase() + s.slice(1).toLowerCase();
}

function normalizePoseId(raw) {
  const s = String(raw || "")
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, "_");
  if (CANONICAL_POSES[s]) return s;
  if (/kneel/.test(s)) return "kneel";
  if (/clap/.test(s)) return "clap";
  if (/wave/.test(s)) return "wave";
  if (/point/.test(s)) return "point";
  if (/\bsit|sitting/.test(s)) return "sit";
  if (/hands_?up|arms_?up|arms raised|hands raised/.test(s)) return "hands_up";
  if (/run|walk|stride|jump|climb|slid|crawl|lean|mid.?stride/.test(s)) return "walk";
  if (/stand|still|sway|arms at sides/.test(s)) return "stand";
  return "stand";
}

function normalizeExpressionId(raw) {
  const s = String(raw || "")
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, "_");
  if (CANONICAL_EXPRESSIONS[s]) return s;
  if (/curious|wonder/.test(s)) return "curious";
  if (/gentle|soft smile|warm/.test(s)) return "gentle_smile";
  if (/happy|smile|joy|excited|wide eyes/.test(s)) return "happy";
  if (/neutral|calm|serious/.test(s)) return "neutral";
  return "happy";
}

function normalizeCameraId(raw) {
  const s = String(raw || "")
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, "_");
  if (CANONICAL_CAMERAS[s]) return s;
  if (/portrait|bust/.test(s)) return "portrait";
  if (/close|closeup|close_up/.test(s)) return "close";
  if (/medium_full|mediumfull|cowboy/.test(s)) return "medium_full";
  if (/medium|waist|medium_shot/.test(s)) return "medium";
  if (/wide|establishing/.test(s)) return "full_body"; // never wide — shrinks anatomy
  if (/full|fullbody|full_body|entire body/.test(s)) return "full_body";
  return "full_body";
}

function normalizeFacingId(raw) {
  const s = String(raw || "")
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, "_");
  if (CANONICAL_FACINGS[s]) return s;
  if (/three_?quarter_?left|left45|yaw-/.test(s)) return "three_quarter_left";
  if (/three_?quarter_?right|right45|yaw\+/.test(s)) return "three_quarter_right";
  return "front";
}

function normalizePlacementSlot(raw, fallback = "center") {
  const s = String(raw || "")
    .toLowerCase()
    .trim();
  if (s === "left" || s === "right" || s === "center") return s;
  if (/left|left_third/.test(s)) return "left";
  if (/right|right_third/.test(s)) return "right";
  return fallback;
}

const SETTINGS = {
  count: 1,
  duration: 180,
  bpm: 115,
  seed: null,
  steps: 30,
  keyscale: null,
  lm: "acestep-5Hz-lm-1.7B",
  backend: "pt",
  qwenModel: "qwen3:14b",
  qwenTemperature: 0.7,
  stillWidth: 768,
  stillHeight: 768,
  /** Character plate canvas (taller = full body feet-to-head) */
  charWidth: 512,
  charHeight: 768,
  stillSteps: 30,
  stillCfg: 7,
  /** Fallback scale; prefer resolveCharacterLayout() per location */
  keyframeCharScale: 0.52,
  keyframeLoraStrength: 0.95,
};

const STILL_NEGATIVE =
  "photo, photorealistic, 3d render, text, watermark, blurry, low quality, collage, split screen, extra limbs, distorted hands";

// ─── Helpers ────────────────────────────────────────────────────────────────

function randomSeed() {
  return Math.floor(Math.random() * 2147483647);
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function takeUnique(pool, n) {
  const copy = [...pool];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(n, copy.length));
}

function dateStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function timeStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function slugify(title) {
  return (
    String(title)
      .toLowerCase()
      .replace(/['']/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "nursery-song"
  );
}

function stripThink(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\/?think>/gi, "")
    .trim();
}

async function loadJson(path) {
  return JSON.parse(stripBom(await readFile(path, "utf8")));
}

async function loadFamilyCast() {
  const cast = {};
  for (const id of CAST_IDS) {
    const path = join(CHARACTERS_DIR, `${id}.json`);
    if (!existsSync(path)) {
      throw new Error(`Missing character def: ${path}`);
    }
    cast[id] = await loadJson(path);
  }
  const scenes = await loadJson(join(SCENES_DIR, "scenes.json"));
  return { cast, scenes };
}

function comfyCfg(characterRoot, overrides = {}) {
  return {
    checkpoint:
      overrides.checkpoint ||
      characterRoot.checkpoint ||
      "realcartoon3d_v15.safetensors",
    width: overrides.width ?? SETTINGS.stillWidth,
    height: overrides.height ?? SETTINGS.stillHeight,
    steps: overrides.steps ?? SETTINGS.stillSteps,
    cfg: overrides.cfg ?? SETTINGS.stillCfg,
    loraName: overrides.loraName ?? null,
    loraStrength: overrides.loraStrength ?? 0.9,
  };
}

function resolveLoraName(char) {
  const name = char.loraName || null;
  if (!name) return null;
  const abs = join(COMFY_ROOT, "models", "loras", name);
  if (!existsSync(abs)) {
    console.warn(`  LoRA missing for ${char.id}: ${name} (text-only fallback)`);
    return null;
  }
  return name;
}

/** Strip empty-room bias from scene copy used only in docs/logs (not for SD scene rewrite). */
function sanitizeSceneStill(text) {
  return String(text || "")
    .replace(
      /\b(empty environment|completely empty|empty room|empty|no people|no characters|no faces|no animals(?: with faces)?|vacant|no person|without people)\b/gi,
      "",
    )
    .replace(/[,\s]+,/g, ",")
    .replace(/^,\s*|,\s*$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Shared identity stills (ref only). */
function buildCharPrompt(char, kf, actionExtra = "") {
  return [
    char.trigger,
    char.style || char.styleTag,
    char.appearance,
    char.outfit,
    kf.angle,
    kf.pose,
    actionExtra,
    "single character only",
    STUDIO_BG_PROMPT,
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * Studio plate for ML cutout — full-body Adam on flat gray (NOT chroma).
 * Pose/expression/facing from the beat; no room/furniture.
 */
function buildPlatePrompt(char, frame, beat) {
  const poseId = normalizePoseId(frame.pose);
  const exprId = normalizeExpressionId(frame.expression);
  let cameraId = normalizeCameraId(frame.camera || beat.camera);
  if (cameraId === "close" || cameraId === "portrait") cameraId = "medium_full";
  const facingId = normalizeFacingId(frame.facing);

  return [
    char.trigger,
    "masterpiece character plate",
    char.styleTag || char.style,
    "flat 2D anime cartoon illustration",
    "clean cel shading",
    char.appearance,
    char.outfit,
    "solid opaque body",
    "opaque clothing",
    "no transparency",
    CANONICAL_CAMERAS[cameraId],
    "full body head to feet visible",
    "small toddler proportions",
    "feet planted at bottom of frame",
    "centered",
    "soft even studio lighting matching soft daylight",
    "clean contact silhouette",
    CANONICAL_FACINGS[facingId],
    CANONICAL_POSES[poseId],
    CANONICAL_EXPRESSIONS[exprId],
    "exactly one toddler boy",
    "single character only",
    STUDIO_BG_PROMPT,
    "same exact outfit and identity",
  ]
    .filter(Boolean)
    .join(", ");
}

function plateNegative(char) {
  const solo = CAST_SOLO_NEGATIVES[String(char.id || "").toLowerCase()] || "";
  return [
    char.negative,
    STILL_NEGATIVE,
    solo,
    STUDIO_BG_NEGATIVE,
    "two people",
    "multiple people",
    "crowd",
    "adult",
    "dad",
    "mom",
    "Tom",
    "Sasha",
    "dog",
    "pet",
    "animal",
    "duplicate",
    "twin",
    "extra limbs",
    "extra arms",
    "extra fingers",
    "merged bodies",
    "transparent body",
    "see-through",
    "ghosting",
    "cropped feet",
    "cropped head",
    "cut off",
  ]
    .filter(Boolean)
    .join(", ");
}

/** Expand a normalized beat into one plate-spec per character. */
function framesFromBeat(beat) {
  const chars = Array.isArray(beat.characters) ? beat.characters : [];
  return chars.map((c, i) => {
    const name = typeof c === "string" ? titleCaseName(c) : titleCaseName(c.name);
    const pose = typeof c === "string" ? "stand" : normalizePoseId(c.pose);
    const expression =
      typeof c === "string" ? "happy" : normalizeExpressionId(c.expression);
    const facing =
      typeof c === "string"
        ? "front"
        : normalizeFacingId(c.facing || c.lookAt);
    const placement =
      beat.placement?.[name] ||
      (typeof c === "object" && c.placement) ||
      (chars.length === 1 ? "center" : i === 0 ? "left" : "right");
    return {
      name,
      character: name,
      pose,
      expression,
      facing,
      placement: normalizePlacementSlot(placement, "center"),
      camera: beat.camera,
    };
  });
}

function buildScenePrompt(scenePack, scene) {
  return [
    scenePack.style,
    scene.still,
    "empty environment",
    "completely empty room",
    "no people",
    "no characters",
    "no silhouettes",
    "no shadows of people",
    "no reflections of people",
    "no faces",
    "no animals",
    "no toys with faces",
  ].join(", ");
}

function parseTitleAndLyrics(raw) {
  const text = stripThink(raw);
  const titleMatch = /TITLE:\s*(.+)/i.exec(text);
  let title = titleMatch?.[1]?.trim() || "";
  title = title.replace(/^["']|["']$/g, "").trim();

  let lyrics = "";
  const lyricsMatch = /LYRICS:\s*([\s\S]*)/i.exec(text);
  if (lyricsMatch) lyrics = lyricsMatch[1].trim();
  else {
    const section = text.search(/\[Intro\]|\[Verse/i);
    if (section >= 0) lyrics = text.slice(section).trim();
  }
  lyrics = lyrics.replace(/\n(?:Note:|Notes:|Explanation:)[\s\S]*$/i, "").trim();

  if (!title) title = `Nursery Song ${Date.now()}`;
  if (!lyrics || !/\[(Intro|Verse|Chorus)/i.test(lyrics)) {
    throw new Error(`Could not parse lyrics:\n${text.slice(0, 400)}`);
  }
  return { title, lyrics };
}

function normalizeLocation(raw, allowedLocations, beatIndex) {
  const allowed = new Set(allowedLocations);
  let loc = String(raw || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_");

  const aliases = {
    bathroom: "bedroom",
    bath: "bedroom",
    restroom: "bedroom",
    toilet: "bedroom",
    living_room: "home",
    livingroom: "home",
    lounge: "home",
    living: "home",
    house: "home",
    yard: "lawn",
    garden: "lawn",
    park: "lawn",
    outdoors: "lawn",
    outside: "lawn",
    backyard: "lawn",
    dining: "dining_room",
    diningroom: "dining_room",
    table: "dining_room",
    cook: "kitchen",
    cooking: "kitchen",
    bed: "bedroom",
    sleep: "bedroom",
  };

  if (aliases[loc]) loc = aliases[loc];
  if (allowed.has(loc)) return loc;

  const fallback = allowedLocations[0] || "home";
  console.warn(
    `  Beat ${beatIndex + 1}: invalid location "${raw}" → using "${fallback}" (allowed: ${allowedLocations.join(", ")})`,
  );
  return fallback;
}

function parseBeatsJson(raw, allowedLocations) {
  const text = stripThink(raw)
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("No JSON object in scene plan");
  const data = JSON.parse(text.slice(start, end + 1));
  return normalizeBeatPlan(data, allowedLocations);
}

/**
 * Normalize Qwen / legacy actions.json into frozen-frame schema:
 * camera + location + placement + characters[{name,pose,expression,facing}]
 */
function normalizeBeatPlan(data, allowedLocations) {
  if (!Array.isArray(data?.beats) || data.beats.length === 0) {
    throw new Error("Scene plan missing beats[]");
  }
  const beats = data.beats.map((b, i) => {
    const loc = normalizeLocation(b.location, allowedLocations, i);
    const camera = normalizeCameraId(b.camera);

    // Prefer structured characters[]; migrate legacy string[] + keyframes[]
    let charObjs = [];
    const rawChars = Array.isArray(b.characters) ? b.characters : [];
    const legacyKfs = Array.isArray(b.keyframes) ? b.keyframes : [];

    if (rawChars.length > 0 && typeof rawChars[0] === "object" && rawChars[0]?.name) {
      charObjs = rawChars
        .map((c) => {
          const name = titleCaseName(c.name);
          if (!CHAR_NAME_RE.test(name)) return null;
          return {
            name,
            pose: normalizePoseId(c.pose),
            expression: normalizeExpressionId(c.expression),
            facing: normalizeFacingId(c.facing || c.lookAt),
          };
        })
        .filter(Boolean);
    } else if (legacyKfs.length > 0) {
      const seen = new Set();
      for (const k of legacyKfs) {
        const name = titleCaseName(k.character || k.name);
        if (!CHAR_NAME_RE.test(name) || seen.has(name)) continue;
        seen.add(name);
        const blob = [k.pose, k.prompt_extra, b.action].filter(Boolean).join(" ");
        charObjs.push({
          name,
          pose: normalizePoseId(k.pose || blob),
          expression: normalizeExpressionId(k.expression || blob),
          facing: normalizeFacingId(k.facing || k.lookAt),
        });
      }
    } else {
      charObjs = rawChars
        .map((c) => titleCaseName(c))
        .filter((c) => CHAR_NAME_RE.test(c))
        .map((name) => ({
          name,
          pose: normalizePoseId(b.action),
          expression: normalizeExpressionId(b.action),
          facing: "front",
        }));
    }

    // Adam-only cast: drop Tom/Sasha/etc. and force a single Adam beat if needed
    charObjs = charObjs.filter((c) => CHAR_NAME_RE.test(c.name));
    if (charObjs.length === 0) {
      charObjs = [
        {
          name: "Adam",
          pose: normalizePoseId(b.action),
          expression: normalizeExpressionId(b.action),
          facing: "front",
        },
      ];
    }
    charObjs = charObjs.slice(0, 1);
    charObjs[0].name = "Adam";

    const placement = { Adam: "center" };

    return {
      id: String(b.id || `${String(i + 1).padStart(2, "0")}_${loc}`),
      location: loc,
      section: b.section || "",
      camera,
      placement,
      characters: charObjs,
    };
  });
  return { beats };
}

async function ollamaChat(model, temperature, system, user, numPredict = 1800) {
  const label = `Ollama ${model}`;
  console.log(`  ${label}… (lyrics/beats can take 30–120s; waiting)`);
  const started = Date.now();
  const tick = setInterval(() => {
    const s = Math.round((Date.now() - started) / 1000);
    console.log(`  ${label} still running… ${s}s`);
  }, 15000);

  const controller = new AbortController();
  const kill = setTimeout(() => controller.abort(), 300000); // 5 min

  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        options: { temperature, top_p: 0.95, num_predict: numPredict },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Ollama ${res.status}: ${body.slice(0, 400)}`);
    }
    const data = await res.json();
    console.log(`  ${label} done in ${Math.round((Date.now() - started) / 1000)}s`);
    return data?.message?.content || data?.response || "";
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`${label} timed out after 5 minutes — is the model loaded?`);
    }
    throw err;
  } finally {
    clearInterval(tick);
    clearTimeout(kill);
  }
}

async function qwenGenerateLyrics(model, temperature, ctx) {
  const used =
    ctx.usedTitles.length > 0
      ? ctx.usedTitles.map((t) => `- ${t}`).join("\n")
      : "- (none yet)";
  const prompt = QWEN_LYRICS_PROMPT.replaceAll("{{THEME}}", ctx.theme)
    .replaceAll("{{EDU_FOCUS}}", ctx.eduFocus)
    .replaceAll("{{MOVEMENT}}", ctx.movement)
    .replaceAll("{{USED_TITLES}}", used);
  const content = await ollamaChat(
    model,
    temperature,
    "You are a world-class preschool songwriter. Follow the user format exactly. Output only TITLE and LYRICS.",
    prompt,
    1800,
  );
  return parseTitleAndLyrics(content);
}

async function qwenGenerateBeats(model, temperature, ctx) {
  const prompt = QWEN_SCENES_PROMPT.replaceAll("{{TITLE}}", ctx.title)
    .replaceAll("{{THEME}}", ctx.theme)
    .replaceAll("{{LYRICS}}", ctx.lyrics)
    .replaceAll("{{LOCATIONS}}", ctx.locations.map((l) => `- ${l}`).join("\n"))
    .replaceAll(
      "{{CAMERAS}}",
      Object.keys(CANONICAL_CAMERAS)
        .map((c) => `- ${c}`)
        .join("\n"),
    )
    .replaceAll(
      "{{POSES}}",
      Object.keys(CANONICAL_POSES)
        .map((p) => `- ${p}`)
        .join("\n"),
    )
    .replaceAll(
      "{{EXPRESSIONS}}",
      Object.keys(CANONICAL_EXPRESSIONS)
        .map((e) => `- ${e}`)
        .join("\n"),
    )
    .replaceAll(
      "{{FACINGS}}",
      Object.keys(CANONICAL_FACINGS)
        .map((f) => `- ${f}`)
        .join("\n"),
    );
  const content = await ollamaChat(
    model,
    temperature,
    "You plan frozen preschool cartoon storyboard stills. Output valid JSON only. Use only allowed pose/camera/expression/facing ids. No storytelling. No lookAt.",
    prompt,
    2200,
  );
  return parseBeatsJson(content, ctx.locations);
}

function runPython(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(ACE_PYTHON, args, {
      cwd: ACE_ROOT,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
    });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`ACE timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.on("data", (d) => process.stdout.write(d));
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      process.stderr.write(d);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ACE exited ${code}\n${stderr.slice(-2000)}`));
    });
  });
}

async function assertHealthyAudio(path) {
  const { stderr } = await execFileAsync(
    "ffmpeg",
    ["-i", path, "-af", "volumedetect", "-f", "null", "-"],
    { windowsHide: true },
  ).catch((e) => ({ stderr: e.stderr || String(e) }));
  const mean = /mean_volume:\s*([-\d.]+)/.exec(stderr)?.[1];
  const max = /max_volume:\s*([-\d.]+)/.exec(stderr)?.[1];
  if (mean == null || max == null) {
    console.log("Warning: could not measure audio levels");
    return;
  }
  if (Number(max) > -0.5 && Number(mean) > -3) {
    throw new Error(
      `ACE output looks clipped/corrupt (mean=${mean}dB max=${max}dB)`,
    );
  }
  console.log(`Audio levels: mean=${mean} dB  max=${max} dB`);
}

async function freeComfyVram(comfyUrl) {
  try {
    await comfy(comfyUrl, "/free", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
    });
    console.log("Freed ComfyUI VRAM");
    await sleep(1500);
  } catch (err) {
    console.log(`ComfyUI free skipped: ${err.message || err}`);
  }
}

async function generateStill(comfyUrl, cfg, prompt, negative, seed, prefix, dest, opts = {}) {
  if (existsSync(dest) && !opts.force) {
    console.log(`  skip exists: ${dest}`);
    return dest;
  }
  const denoise = opts.denoise ?? 1;
  const sceneImageName = opts.sceneImageName || null;
  let wf;
  if (sceneImageName) {
    wf = loraImg2ImgWorkflow(cfg, {
      imageName: sceneImageName,
      prompt,
      negative,
      seed,
      denoise,
      prefix,
    });
  } else if (cfg.loraName) {
    wf = loraStillWorkflow(cfg, prompt, negative, seed, prefix);
  } else {
    wf = checkpointStillWorkflow(cfg, prompt, negative, seed, prefix);
  }
  await queueAndWait(comfyUrl, wf, 900000, prefix);
  await copyNewestOutput("image", prefix, dest);
  console.log(`  saved: ${dest}`);
  return dest;
}

async function ensureCharacters(comfyUrl, cfgRoot, cast, outDir) {
  await mkdir(outDir, { recursive: true });
  for (const char of Object.values(cast)) {
    const charDir = join(outDir, char.id);
    await mkdir(charDir, { recursive: true });
    const loraName = resolveLoraName(char);
    const cfg = comfyCfg(cfgRoot, {
      width: SETTINGS.charWidth,
      height: SETTINGS.charHeight,
      checkpoint: char.checkpoint,
      loraName,
      loraStrength: char.loraStrength ?? 0.9,
    });
    console.log(`\n[characters] ${char.name}${loraName ? ` + LoRA ${loraName}` : " (no LoRA)"}`);
    for (let i = 0; i < char.keyframes.length; i++) {
      const kf = char.keyframes[i];
      const dest = join(charDir, `${char.id}_${kf.id}.png`);
      const prompt = buildCharPrompt(char, kf);
      const seed = (char.seed || 1000) + i;
      const prefix = `family_${char.id}_${kf.id}`;
      await generateStill(
        comfyUrl,
        cfg,
        prompt,
        `${char.negative}, ${STILL_NEGATIVE}`,
        seed,
        prefix,
        dest,
      );
    }
  }
}

async function ensureScenes(comfyUrl, cfgRoot, scenePack, outDir, { force = false } = {}) {
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "scenes.json"), JSON.stringify(scenePack, null, 2));
  const cfg = comfyCfg(cfgRoot, {
    width: SETTINGS.stillWidth,
    height: SETTINGS.stillHeight,
  });
  console.log(`\n[scenes] empty rooms${force ? " (force)" : ""}`);
  for (let i = 0; i < scenePack.scenes.length; i++) {
    const scene = scenePack.scenes[i];
    const dest = join(outDir, `${scene.id}.png`);
    if (force && existsSync(dest)) {
      try {
        await unlink(dest);
      } catch {
        /* ignore */
      }
    }
    const prompt = buildScenePrompt(scenePack, scene);
    const seed = 55000 + i;
    await generateStill(
      comfyUrl,
      cfg,
      prompt,
      `${scenePack.negative}, ${STILL_NEGATIVE}`,
      seed,
      `family_scene_${scene.id}`,
      dest,
      { force },
    );
  }
}

async function generateSongKeyframes(
  comfyUrl,
  cfgRoot,
  cast,
  scenePack,
  songDir,
  plan,
  sharedScenesDir,
  { force = false, reuseCutouts = false } = {},
) {
  const scenesDir = join(songDir, "scenes");
  const keyframesDir = join(songDir, "keyframes");
  const platesDir = join(keyframesDir, "plates");
  const cutoutsDir = join(keyframesDir, "cutouts");
  await mkdir(scenesDir, { recursive: true });
  await mkdir(keyframesDir, { recursive: true });
  await mkdir(platesDir, { recursive: true });
  await mkdir(cutoutsDir, { recursive: true });

  // Copy shared empty scene stills into this song folder (never rewritten later)
  for (const scene of scenePack.scenes) {
    const src = join(sharedScenesDir, `${scene.id}.png`);
    const dest = join(scenesDir, `${scene.id}.png`);
    if (existsSync(src) && (!existsSync(dest) || force)) await copyFile(src, dest);
  }

  const allowedLocations = (scenePack.scenes || []).map((s) => s.id);
  const planNorm = normalizeBeatPlan(plan, allowedLocations);
  await writeFile(
    join(scenesDir, "actions.json"),
    JSON.stringify(planNorm, null, 2),
  );

  let k = 0;
  for (const beat of planNorm.beats) {
    k += 1;
    const location = beat.location;
    const scenePath =
      (existsSync(join(scenesDir, `${location}.png`))
        ? join(scenesDir, `${location}.png`)
        : null) ||
      (existsSync(join(sharedScenesDir, `${location}.png`))
        ? join(sharedScenesDir, `${location}.png`)
        : null);

    if (!scenePath) {
      console.warn(`  Beat ${beat.id}: no scene PNG for "${location}" — skip`);
      continue;
    }

    const frames = framesFromBeat(beat).filter((f) =>
      cast[String(f.name || "").toLowerCase()],
    );
    if (frames.length === 0) {
      console.warn(`  Beat ${beat.id}: no cast characters — skip`);
      continue;
    }

    const frame = frames[0];
    const char = cast[String(frame.name || "").toLowerCase()];
    const pad = String(k).padStart(2, "0");
    const fname = `${pad}_${beat.id}.png`;
    const dest = join(keyframesDir, fname);
    const plateDest = join(platesDir, `${pad}_${beat.id}_${char.id}.png`);
    const cutoutDest = join(cutoutsDir, `${pad}_${beat.id}_${char.id}.png`);

    if (force) {
      const wipe = reuseCutouts ? [dest] : [dest, plateDest, cutoutDest];
      for (const p of wipe) {
        if (existsSync(p)) {
          try {
            await unlink(p);
          } catch {
            /* ignore */
          }
        }
      }
    }

    const layout = resolveCharacterLayout({
      location,
      camera: frame.camera || beat.camera,
      pose: frame.pose,
      slot: frame.placement || "center",
    });

    let cutoutBuf;
    if (reuseCutouts && existsSync(cutoutDest)) {
      console.log(
        `  [${pad}] ${beat.id} @ ${location} → reuse cutout → composite` +
          ` scale=${layout.scale.toFixed(2)}`,
      );
      cutoutBuf = await readFile(cutoutDest);
    } else {
      const loraName = resolveLoraName(char);
      const plateCfg = comfyCfg(cfgRoot, {
        width: SETTINGS.charWidth,
        height: SETTINGS.charHeight,
        checkpoint: char.checkpoint,
        loraName,
        loraStrength: SETTINGS.keyframeLoraStrength ?? char.loraStrength ?? 0.95,
      });

      const prompt = buildPlatePrompt(char, frame, beat);
      const neg = plateNegative(char);

      console.log(
        `  [${pad}] ${beat.id} @ ${location} cam=${beat.camera}` +
          ` → plate → rembg → composite` +
          `${loraName ? ` (+${loraName})` : ""}`,
      );
      console.log(
        `      pose=${frame.pose} face=${frame.facing} expr=${frame.expression} slot=${frame.placement || "center"}`,
      );

      await generateStill(
        comfyUrl,
        plateCfg,
        prompt,
        neg,
        randomSeed(),
        `family_plate_${char.id}_${beat.id}`,
        plateDest,
        { force },
      );

      console.log(`      rembg cutout…`);
      const plateBuf = await readFile(plateDest);
      cutoutBuf = await removePlateBackground(plateBuf);
      await writeFile(cutoutDest, cutoutBuf);
    }

    const canvasW = SETTINGS.stillWidth;
    const canvasH = SETTINGS.stillHeight;
    const sceneSized = join(scenesDir, `_${location}_${pad}_sized.png`);
    await sharp(scenePath)
      .resize(canvasW, canvasH, { fit: "cover" })
      .png()
      .toFile(sceneSized);

    console.log(
      `      layout scale=${layout.scale.toFixed(2)} pad=${layout.bottomPad.toFixed(2)} shadow=${layout.shadow}`,
    );

    const finalBuf = await compositeScene(
      sceneSized,
      [
        {
          buffer: cutoutBuf,
          slot: layout.slot,
          role: char.role || "toddler",
          scale: layout.scale,
          bottomPad: layout.bottomPad,
          shadow: layout.shadow,
          skipRemoveBg: true,
        },
      ],
      { width: canvasW, height: canvasH, removeBg: false },
    );
    await writeFile(dest, finalBuf);
    try {
      await unlink(sceneSized);
    } catch {
      /* ignore */
    }
    console.log(`  saved: ${dest}`);
  }
}

function uniqueSlug(base, used, batchDir) {
  let slug = base;
  let n = 2;
  while (used.has(slug) || existsSync(join(batchDir, slug))) {
    slug = `${base}-${n}`;
    n += 1;
  }
  used.add(slug);
  return slug;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const { flag, has } = parseArgs();
  const characterRoot = existsSync(CHAR_PATH)
    ? JSON.parse(stripBom(await readFile(CHAR_PATH, "utf8")))
    : {};
  const comfyUrl = characterRoot.comfyUrl || "http://127.0.0.1:8188";

  const count = Math.max(1, Number(flag("--count", String(SETTINGS.count))));
  const duration = Number(flag("--duration", String(SETTINGS.duration)));
  const bpm = Number(flag("--bpm", String(SETTINGS.bpm)));
  const steps = Number(flag("--steps", String(SETTINGS.steps)));
  const qwenModel = flag("--qwen", SETTINGS.qwenModel);
  const keyDefault =
    SETTINGS.keyscale == null || SETTINGS.keyscale === ""
      ? ""
      : String(SETTINGS.keyscale);
  const keyscale = has("--keyscale") ? flag("--keyscale", "") : keyDefault;
  const baseSeed = has("--seed")
    ? Number(flag("--seed", "0"))
    : SETTINGS.seed == null
      ? null
      : Number(SETTINGS.seed);
  const charsOnly = has("--chars-only");
  const scenesOnly = has("--scenes-only");
  const skipAudio = has("--skip-audio");
  const keyframesOnly = has("--keyframes-only");
  const force = has("--force");
  const songArg = flag("--song", null);

  const { cast, scenes: scenePack } = await loadFamilyCast();
  const sharedCharsDir = CHARACTERS_DIR;
  const sharedScenesDir = SCENES_DIR;

  // Regen keyframes for an existing song (keep mp3; normalize or replan actions.json)
  if (keyframesOnly) {
    if (!songArg) {
      throw new Error("--keyframes-only requires --song batches/<date>/<slug>");
    }
    const songDir = resolve(
      songArg.match(/^[A-Za-z]:[\\/]/) || songArg.startsWith("/")
        ? songArg
        : join(ROOT, songArg),
    );
    if (!existsSync(songDir)) throw new Error(`Song folder not found: ${songDir}`);
    const actionsPath = join(songDir, "scenes", "actions.json");
    const lyricsPath = join(songDir, "lyrics.txt");
    const locations = scenePack.scenes.map((s) => s.id);
    let plan;

    if (has("--replan")) {
      if (!existsSync(lyricsPath)) {
        throw new Error(`--replan needs ${lyricsPath}`);
      }
      const lyricsRaw = stripBom(await readFile(lyricsPath, "utf8"));
      const titleMatch = /^TITLE:\s*(.+)$/im.exec(lyricsRaw);
      const title =
        titleMatch?.[1]?.trim() ||
        songDir.split(/[/\\]/).pop()?.replace(/-/g, " ") ||
        "Song";
      const lyricsBody = lyricsRaw.replace(/^TITLE:.*$/im, "").trim() || lyricsRaw;
      console.log("Adam-only pipeline — keyframes-only + replan");
      console.log(`song: ${songDir}`);
      console.log("Replanning frozen beats with Qwen…");
      plan = await qwenGenerateBeats(qwenModel, SETTINGS.qwenTemperature, {
        title,
        theme: "family",
        lyrics: lyricsBody,
        locations,
      });
    } else {
      if (!existsSync(actionsPath)) {
        throw new Error(
          `Missing ${actionsPath} — run full 02_0 first, or use --replan`,
        );
      }
      plan = JSON.parse(stripBom(await readFile(actionsPath, "utf8")));
      console.log("Adam-only pipeline — keyframes-only");
      console.log(`song: ${songDir}`);
      console.log("Normalizing actions.json to frozen-frame schema…");
    }

    const reuseCutouts = has("--reuse-cutouts");
    await freeComfyVram(comfyUrl);
    // Refresh empty rooms unless we're only re-laying existing cutouts
    await ensureScenes(comfyUrl, characterRoot, scenePack, sharedScenesDir, {
      force: !reuseCutouts,
    });
    await generateSongKeyframes(
      comfyUrl,
      characterRoot,
      cast,
      scenePack,
      songDir,
      plan,
      sharedScenesDir,
      { force: true, reuseCutouts },
    );
    const rel = relative(ROOT, songDir).replace(/\\/g, "/");
    console.log("\n────────────────────────────────────────────────────────");
    console.log(" Next — animate keyframes (Wan 2.2):");
    console.log(`  node scripts/02_1_animate-keyframes.js --song ${rel}`);
    console.log("────────────────────────────────────────────────────────");
    return;
  }

  const batchDir = join(ROOT, "batches", dateStamp());
  await mkdir(batchDir, { recursive: true });
  await mkdir(sharedCharsDir, { recursive: true });
  await mkdir(sharedScenesDir, { recursive: true });

  console.log("Adam-only nursery pipeline");
  console.log(`batch: ${batchDir}`);

  try {
    const tags = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!tags.ok) throw new Error(`status ${tags.status}`);
  } catch (err) {
    if (!charsOnly && !scenesOnly) {
      throw new Error(`Ollama not reachable at ${OLLAMA_URL}: ${err.message || err}`);
    }
    console.log(`Ollama check skipped/failed: ${err.message || err}`);
  }

  if (!charsOnly && !scenesOnly) {
    if (!existsSync(ACE_PYTHON)) throw new Error(`ACE Python not found: ${ACE_PYTHON}`);
    if (!existsSync(ACE_SCRIPT)) throw new Error(`Missing ${ACE_SCRIPT}`);
  }

  await freeComfyVram(comfyUrl);
  await ensureCharacters(comfyUrl, characterRoot, cast, sharedCharsDir);
  await ensureScenes(comfyUrl, characterRoot, scenePack, sharedScenesDir, {
    force: force || scenesOnly,
  });

  if (charsOnly || scenesOnly) {
    console.log("\nDone (chars/scenes only).");
    return;
  }

  const runId = timeStamp();
  const manifest = {
    runId,
    batchDir,
    count,
    cast: Object.keys(cast),
    sceneIds: scenePack.scenes.map((s) => s.id),
    songs: [],
  };

  const usedTitles = [];
  const usedSlugs = new Set();
  const batchThemes = takeUnique(THEMES, count);
  while (batchThemes.length < count) batchThemes.push(pick(THEMES));
  const locations = scenePack.scenes.map((s) => s.id);

  for (let i = 1; i <= count; i++) {
    console.log(`\n══ Song ${i}/${count}`);
    const theme = batchThemes[i - 1];
    const style = pick(STYLES);
    const eduFocus = pick(EDUCATIONAL_FOCUS);
    const movement = pick(MOVEMENT_PROMPTS);
    const entry = { index: i, theme, style, eduFocus, movement, ok: false };

    let title;
    let lyrics;
    let slug;
    let songDir;
    try {
      console.log(
        `Qwen lyrics  theme=${theme}  style=${style}  edu=${eduFocus}  move=${movement}`,
      );
      console.log("  (pipeline: lyrics → ACE song → beat plan → keyframes)");
      ({ title, lyrics } = await qwenGenerateLyrics(qwenModel, SETTINGS.qwenTemperature, {
        theme,
        eduFocus,
        movement,
        usedTitles,
      }));
      usedTitles.push(title);
      slug = uniqueSlug(slugify(title), usedSlugs, batchDir);
      songDir = join(batchDir, slug);
      await mkdir(songDir, { recursive: true });
      await writeFile(
        join(songDir, "lyrics.txt"),
        `TITLE: ${title}\n\n${lyrics}`,
        "utf8",
      );
      entry.title = title;
      entry.slug = slug;
      entry.songDir = songDir;
      console.log(`Title: ${title}`);
    } catch (err) {
      entry.error = String(err.message || err).slice(0, 500);
      entry.stage = "lyrics";
      manifest.songs.push(entry);
      await writeFile(join(batchDir, `manifest_${runId}.json`), JSON.stringify(manifest, null, 2));
      console.error(`Lyrics failed: ${entry.error}`);
      continue;
    }

    // Song audio
    if (!skipAudio) {
      const dest = join(songDir, `${slug}.mp3`);
      const caption = CAPTION_TEMPLATE.replaceAll("{{TITLE}}", title).replaceAll(
        "{{STYLE}}",
        style,
      );
      const seed =
        baseSeed == null ? randomSeed() : (baseSeed + i - 1) >>> 0;
      entry.seed = seed;
      const pyArgs = [
        ACE_SCRIPT,
        "--out",
        dest,
        "--caption",
        caption,
        "--lyrics",
        join(songDir, "lyrics.txt"),
        "--duration",
        String(duration),
        "--bpm",
        String(bpm),
        "--seed",
        String(seed),
        "--steps",
        String(steps),
        "--lm",
        flag("--lm", SETTINGS.lm),
        "--backend",
        flag("--backend", SETTINGS.backend),
      ];
      if (keyscale) pyArgs.push("--keyscale", keyscale);
      if (has("--no-thinking")) pyArgs.push("--no-thinking");
      try {
        console.log(`ACE generating… seed=${seed}`);
        await freeComfyVram(comfyUrl);
        await runPython(pyArgs, 1800000);
        await assertHealthyAudio(dest);
        entry.file = `${slug}.mp3`;
      } catch (err) {
        entry.error = String(err.message || err).slice(0, 500);
        entry.stage = "song";
        manifest.songs.push(entry);
        await writeFile(
          join(batchDir, `manifest_${runId}.json`),
          JSON.stringify(manifest, null, 2),
        );
        console.error(`Song failed: ${entry.error}`);
        continue;
      }
    }

    // Scene plan + keyframes
    try {
      console.log("Qwen frozen beat plan…");
      const plan = await qwenGenerateBeats(qwenModel, SETTINGS.qwenTemperature, {
        title,
        theme,
        lyrics,
        locations,
      });
      entry.beats = plan.beats.length;
      console.log(`  ${plan.beats.length} beats — generating keyframe stills…`);
      await freeComfyVram(comfyUrl);
      await generateSongKeyframes(
        comfyUrl,
        characterRoot,
        cast,
        scenePack,
        songDir,
        plan,
        sharedScenesDir,
      );
      entry.ok = true;
      console.log(`Song package ready: ${songDir}`);
    } catch (err) {
      entry.error = String(err.message || err).slice(0, 500);
      entry.stage = "scenes";
      console.error(`Scenes/keyframes failed: ${entry.error}`);
    }

    manifest.songs.push(entry);
    await writeFile(
      join(batchDir, `manifest_${runId}.json`),
      JSON.stringify(manifest, null, 2),
      "utf8",
    );
  }

  const ok = manifest.songs.filter((s) => s.ok).length;
  console.log(`\nBatch done: ${ok}/${count} ok`);
  console.log(`Folder: ${batchDir}`);

  const ready = manifest.songs.filter((s) => s.ok && s.songDir);
  if (ready.length) {
    console.log("\n────────────────────────────────────────────────────────");
    console.log(" Next — animate keyframes (Wan 2.2):");
    for (const s of ready) {
      const rel = relative(ROOT, s.songDir).replace(/\\/g, "/");
      console.log(`  node scripts/02_1_animate-keyframes.js --song ${rel}`);
    }
    if (ready.length > 1) {
      const batchRel = relative(ROOT, batchDir).replace(/\\/g, "/");
      console.log(" Or animate the whole batch:");
      console.log(`  node scripts/02_1_animate-keyframes.js --batch ${batchRel}`);
    }
    console.log("────────────────────────────────────────────────────────");
  }

  if (ok === 0) process.exit(1);
}

main().catch((err) => {
  console.error("\nFailed:", err.message || err);
  process.exit(1);
});
