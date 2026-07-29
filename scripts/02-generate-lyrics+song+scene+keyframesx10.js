/**
 * Family nursery pipeline (Tom dad + Sasha mom + Adam toddler boy):
 *   1) Ensure character keyframes exist (plain gray background)
 *   2) Ensure empty scene stills exist (home / lawn / kitchen / bedroom / dining)
 *   3) For each song: Qwen lyrics → ACE song → Qwen scene/actions → keyframes
 *
 * Output:
 *   characters/            shared character defs + ref stills
 *   scenes/                shared empty room defs + stills
 *   batches/<YYYYMMDD>/
 *     <song_slug>/
 *       <song_slug>.mp3
 *       lyrics.txt
 *       scenes/            song-specific scene copies + actions.json
 *       keyframes/         character action stills (plain bg)
 *
 * Character defs live in characters/ (single JSON per character in characters/).
 *
 * Run:
 *   node scripts/02-generate-lyrics+song+scene+keyframesx10.js
 *
 * Optional:
 *   --count 10 --chars-only --scenes-only --skip-audio --qwen qwen3:14b
 */
import { mkdir, writeFile, readFile, copyFile } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
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
} from "../lib/comfy-client.js";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, "..");
const CHAR_PATH = join(ROOT, "characters", "tomchr.json");
const CHARACTERS_DIR = join(ROOT, "characters");
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
 * Qwen scene/action planner for the family cast.
 * Placeholders: {{TITLE}} {{LYRICS}} {{THEME}} {{LOCATIONS}}
 */
const QWEN_SCENES_PROMPT = `You plan simple preschool music-video beats for a family cartoon:

Characters (use only these names):
- Tom = dad
- Sasha = mom
- Adam = toddler boy

Allowed locations (use only these ids):
{{LOCATIONS}}

Song title: {{TITLE}}
Theme: {{THEME}}

Lyrics:
{{LYRICS}}

Create 6 to 8 beats that follow the song from intro to outro.

Rules:
- Every beat uses 1 location from the allowed list.
- Every beat names 1 to 3 characters from Tom / Sasha / Adam.
- Actions must be preschool-safe, warm, clear, and easy to draw.
- Prefer family moments: helping, playing, hugging, cleaning, cooking, bedtime, outdoor play.
- Keep backgrounds PLAIN in character action descriptions (no busy rooms on the character plate).
- No scary, no adult themes, no text overlays.

OUTPUT EXACTLY valid JSON (no markdown fences):
{
  "beats": [
    {
      "id": "01_intro",
      "location": "kitchen",
      "section": "Intro",
      "characters": ["Tom", "Adam"],
      "action": "Tom kneels while Adam claps happily",
      "scene_note": "empty plain kitchen waiting for family",
      "keyframes": [
        {
          "character": "Tom",
          "pose": "kneeling, open arms, warm smile, front view",
          "prompt_extra": "kneeling to toddler height"
        },
        {
          "character": "Adam",
          "pose": "standing, tiny hands clapping, front view",
          "prompt_extra": "clapping happily"
        }
      ]
    }
  ]
}`;

const SETTINGS = {
  count: 10,
  duration: 180,
  bpm: 115,
  seed: null,
  steps: 30,
  keyscale: null,
  lm: "acestep-5Hz-lm-1.7B",
  backend: "pt",
  qwenModel: "qwen3:14b",
  qwenTemperature: 0.95,
  stillWidth: 768,
  stillHeight: 768,
  charWidth: 512,
  charHeight: 768,
  stillSteps: 28,
  stillCfg: 7,
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
  const ids = ["tom", "sasha", "adam"];
  const cast = {};
  for (const id of ids) {
    cast[id] = await loadJson(join(CHARACTERS_DIR, `${id}.json`));
  }
  const scenes = await loadJson(join(SCENES_DIR, "scenes.json"));
  return { cast, scenes };
}

function comfyCfg(characterRoot, overrides = {}) {
  return {
    checkpoint: characterRoot.checkpoint || "DreamShaper_8_pruned.safetensors",
    width: overrides.width ?? SETTINGS.stillWidth,
    height: overrides.height ?? SETTINGS.stillHeight,
    steps: overrides.steps ?? SETTINGS.stillSteps,
    cfg: overrides.cfg ?? SETTINGS.stillCfg,
  };
}

function buildCharPrompt(char, kf, actionExtra = "") {
  return [
    char.style,
    char.appearance,
    char.outfit,
    kf.angle,
    kf.pose,
    actionExtra,
    "single character only",
    "plain solid light gray background",
    "no furniture",
    "no room",
  ]
    .filter(Boolean)
    .join(", ");
}

function buildScenePrompt(scenePack, scene) {
  return [scenePack.style, scene.still, "empty environment", "no people"].join(
    ", ",
  );
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

function parseBeatsJson(raw, allowedLocations) {
  const text = stripThink(raw)
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("No JSON object in scene plan");
  const data = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(data.beats) || data.beats.length === 0) {
    throw new Error("Scene plan missing beats[]");
  }
  const allowed = new Set(allowedLocations);
  const beats = data.beats.map((b, i) => {
    const loc = String(b.location || "").toLowerCase().replace(/\s+/g, "_");
    if (!allowed.has(loc)) {
      throw new Error(`Beat ${i + 1} has invalid location: ${b.location}`);
    }
    const characters = (b.characters || [])
      .map((c) => String(c).trim())
      .filter((c) => /^(tom|sasha|adam)$/i.test(c))
      .map((c) => c[0].toUpperCase() + c.slice(1).toLowerCase());
    if (characters.length === 0) {
      throw new Error(`Beat ${i + 1} has no valid characters`);
    }
    const keyframes = Array.isArray(b.keyframes) ? b.keyframes : [];
    return {
      id: String(b.id || `${String(i + 1).padStart(2, "0")}_${loc}`),
      location: loc,
      section: b.section || "",
      characters,
      action: b.action || "",
      scene_note: b.scene_note || "",
      keyframes: keyframes.map((k) => ({
        character: String(k.character || "").trim(),
        pose: String(k.pose || "").trim(),
        prompt_extra: String(k.prompt_extra || "").trim(),
      })),
    };
  });
  return { beats };
}

async function ollamaChat(model, temperature, system, user, numPredict = 1800) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
  return data?.message?.content || data?.response || "";
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
    .replaceAll("{{LOCATIONS}}", ctx.locations.map((l) => `- ${l}`).join("\n"));
  const content = await ollamaChat(
    model,
    temperature,
    "You plan preschool cartoon storyboards. Output valid JSON only.",
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

async function generateStill(comfyUrl, cfg, prompt, negative, seed, prefix, dest) {
  if (existsSync(dest)) {
    console.log(`  skip exists: ${dest}`);
    return dest;
  }
  const wf = checkpointStillWorkflow(cfg, prompt, negative, seed, prefix);
  await queueAndWait(comfyUrl, wf, 900000, prefix);
  await copyNewestOutput(dest, "image", prefix);
  console.log(`  saved: ${dest}`);
  return dest;
}

async function ensureCharacters(comfyUrl, cfgRoot, cast, outDir) {
  await mkdir(outDir, { recursive: true });
  for (const char of Object.values(cast)) {
    const charDir = join(outDir, char.id);
    await mkdir(charDir, { recursive: true });
    // Single source of truth is characters/<id>.json — do not duplicate into the asset folder.
    const cfg = comfyCfg(cfgRoot, {
      width: SETTINGS.charWidth,
      height: SETTINGS.charHeight,
    });
    console.log(`\n[characters] ${char.name}`);
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

async function ensureScenes(comfyUrl, cfgRoot, scenePack, outDir) {
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "scenes.json"), JSON.stringify(scenePack, null, 2));
  const cfg = comfyCfg(cfgRoot, {
    width: SETTINGS.stillWidth,
    height: SETTINGS.stillHeight,
  });
  console.log("\n[scenes] empty rooms (plain)");
  for (let i = 0; i < scenePack.scenes.length; i++) {
    const scene = scenePack.scenes[i];
    const dest = join(outDir, `${scene.id}.png`);
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
) {
  const scenesDir = join(songDir, "scenes");
  const keyframesDir = join(songDir, "keyframes");
  await mkdir(scenesDir, { recursive: true });
  await mkdir(keyframesDir, { recursive: true });

  // Copy shared empty scene stills into this song folder
  for (const scene of scenePack.scenes) {
    const src = join(sharedScenesDir, `${scene.id}.png`);
    const dest = join(scenesDir, `${scene.id}.png`);
    if (existsSync(src) && !existsSync(dest)) await copyFile(src, dest);
  }
  await writeFile(join(scenesDir, "actions.json"), JSON.stringify(plan, null, 2));

  const cfg = comfyCfg(cfgRoot, {
    width: SETTINGS.charWidth,
    height: SETTINGS.charHeight,
  });

  let k = 0;
  for (const beat of plan.beats) {
    const frames =
      beat.keyframes.length > 0
        ? beat.keyframes
        : beat.characters.map((name) => ({
            character: name,
            pose: beat.action,
            prompt_extra: beat.action,
          }));

    for (const frame of frames) {
      const key = String(frame.character || "").toLowerCase();
      const char = cast[key];
      if (!char) continue;
      k += 1;
      const fname = `${String(k).padStart(2, "0")}_${beat.id}_${char.id}.png`;
      const dest = join(keyframesDir, fname);
      const prompt = buildCharPrompt(
        char,
        {
          angle: "front view, looking at camera",
          pose: frame.pose || beat.action,
        },
        frame.prompt_extra || beat.action,
      );
      await generateStill(
        comfyUrl,
        cfg,
        prompt,
        `${char.negative}, ${STILL_NEGATIVE}`,
        randomSeed(),
        `family_song_${char.id}_${beat.id}_${k}`,
        dest,
      );
    }
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

  const { cast, scenes: scenePack } = await loadFamilyCast();
  const batchDir = join(ROOT, "batches", dateStamp());
  const sharedCharsDir = CHARACTERS_DIR;
  const sharedScenesDir = SCENES_DIR;
  await mkdir(batchDir, { recursive: true });
  await mkdir(sharedCharsDir, { recursive: true });
  await mkdir(sharedScenesDir, { recursive: true });

  console.log("Family nursery pipeline — Tom / Sasha / Adam");
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
  await ensureScenes(comfyUrl, characterRoot, scenePack, sharedScenesDir);

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
      await writeFile(join(songDir, "lyrics.txt"), lyrics, "utf8");
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
      console.log("Qwen scene/action plan…");
      const plan = await qwenGenerateBeats(qwenModel, SETTINGS.qwenTemperature, {
        title,
        theme,
        lyrics,
        locations,
      });
      entry.beats = plan.beats.length;
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
  if (ok === 0) process.exit(1);
}

main().catch((err) => {
  console.error("\nFailed:", err.message || err);
  process.exit(1);
});
