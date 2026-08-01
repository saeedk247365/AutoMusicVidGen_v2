/**
 * Generate 10 original nursery songs per run:
 *   1) Qwen (Ollama) writes title + lyrics (classroom-ready preschool songs)
 *   2) ACE-Step generates the song with a randomized production style
 *
 * Each song gets a unique theme + random style / edu focus / movement.
 * Edit THEMES, STYLES, QWEN_LYRICS_PROMPT, CAPTION_TEMPLATE at the top.
 *
 * Output:
 *   batches/nursery/<song_slug>.mp3
 *   batches/nursery/<song_slug>_lyrics.txt
 *   batches/nursery/manifest_<timestamp>.json
 *
 * Run:
 *   node scripts/01-generate-lyrics+songx10.js
 *
 * Optional:
 *   --count 10 --duration 180 --bpm 115 --steps 30 --qwen qwen3:14b
 */
import { mkdir, writeFile, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn, execFile } from "child_process";
import { promisify } from "util";
import { parseArgs, stripBom, comfy, sleep } from "../lib/comfy-client.js";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, "..");
const CHAR_PATH = join(ROOT, "characters", "tomchr.json");
const ACE_ROOT =
  "C:\\Users\\Saeed Khan\\AppData\\Local\\ProdesecStudio\\ACE-Step-1.5";
const ACE_PYTHON = join(ACE_ROOT, ".venv", "Scripts", "python.exe");
const ACE_SCRIPT = join(ROOT, "pipelines", "ace-generate-song.py");
const NURSERY_DIR = join(ROOT, "batches", "nursery");
const OLLAMA_URL = "http://127.0.0.1:11434";

// ─── Edit these ─────────────────────────────────────────────────────────────

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

/**
 * ACE caption — feeling first. Placeholders:
 * {{TITLE}} {{STYLE}}
 */
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

/**
 * Qwen lyrics prompt — edit freely.
 * Placeholders: {{THEME}} {{EDU_FOCUS}} {{MOVEMENT}} {{USED_TITLES}}
 */
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

const SETTINGS = {
  count: 10, // different nursery songs per run
  duration: 180, // seconds
  bpm: 115,
  seed: null, // null = random seed per song
  steps: 30,
  keyscale: null, // e.g. "C major"
  lm: "acestep-5Hz-lm-1.7B",
  backend: "pt",
  qwenModel: "qwen3:14b",
  qwenTemperature: 0.95,
};

// ─── Runner ─────────────────────────────────────────────────────────────────

function randomSeed() {
  return Math.floor(Math.random() * 2147483647);
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Shuffle and take up to n unique items (for a batch without theme clashes). */
function takeUnique(pool, n) {
  const copy = [...pool];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.min(n, copy.length));
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function slugify(title) {
  return String(title)
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "nursery-song";
}

function stripThink(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\/?think>/gi, "")
    .trim();
}

function parseTitleAndLyrics(raw) {
  const text = stripThink(raw);
  const titleMatch = /TITLE:\s*(.+)/i.exec(text);
  let title = titleMatch?.[1]?.trim() || "";
  title = title.replace(/^["']|["']$/g, "").trim();

  let lyrics = "";
  const lyricsMatch = /LYRICS:\s*([\s\S]*)/i.exec(text);
  if (lyricsMatch) {
    lyrics = lyricsMatch[1].trim();
  } else {
    const section = text.search(/\[Intro\]|\[Verse/i);
    if (section >= 0) lyrics = text.slice(section).trim();
  }

  // Drop trailing junk after outro if model adds notes
  lyrics = lyrics.replace(/\n(?:Note:|Notes:|Explanation:)[\s\S]*$/i, "").trim();

  if (!title) {
    const hook = /In our (.+?)[\.!\n]/i.exec(lyrics) || /called ["'](.+?)["']/i.exec(text);
    title = hook?.[1]?.trim() || `Nursery Song ${Date.now()}`;
  }
  if (!lyrics || !/\[(Intro|Verse|Chorus)/i.test(lyrics)) {
    throw new Error(`Could not parse lyrics from Qwen output:\n${text.slice(0, 400)}`);
  }
  return { title, lyrics };
}

async function qwenGenerateLyrics(model, temperature, { theme, eduFocus, movement, usedTitles }) {
  const used =
    usedTitles.length > 0 ? usedTitles.map((t) => `- ${t}`).join("\n") : "- (none yet)";
  const prompt = QWEN_LYRICS_PROMPT
    .replaceAll("{{THEME}}", theme)
    .replaceAll("{{EDU_FOCUS}}", eduFocus)
    .replaceAll("{{MOVEMENT}}", movement)
    .replaceAll("{{USED_TITLES}}", used);

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      messages: [
        {
          role: "system",
          content:
            "You are a world-class preschool songwriter. Follow the user format exactly. Output only TITLE and LYRICS.",
        },
        { role: "user", content: prompt },
      ],
      options: {
        temperature,
        top_p: 0.95,
        num_predict: 1800,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ollama ${res.status}: ${body.slice(0, 400)}`);
  }
  const data = await res.json();
  const content = data?.message?.content || data?.response || "";
  return parseTitleAndLyrics(content);
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
  const meanN = Number(mean);
  const maxN = Number(max);
  if (maxN > -0.5 && meanN > -3) {
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
    await sleep(2000);
  } catch (err) {
    console.log(`ComfyUI free skipped: ${err.message || err}`);
  }
}

function uniqueSlug(base, used) {
  let slug = base;
  let n = 2;
  while (used.has(slug) || existsSync(join(NURSERY_DIR, `${slug}.mp3`))) {
    slug = `${base}-${n}`;
    n += 1;
  }
  used.add(slug);
  return slug;
}

async function main() {
  const { flag, has } = parseArgs();
  const character = existsSync(CHAR_PATH)
    ? JSON.parse(stripBom(await readFile(CHAR_PATH, "utf8")))
    : {};
  const comfyUrl = character.comfyUrl || "http://127.0.0.1:8888";

  if (!existsSync(ACE_PYTHON)) {
    throw new Error(`ACE Python not found: ${ACE_PYTHON}`);
  }
  if (!existsSync(ACE_SCRIPT)) {
    throw new Error(`Missing ${ACE_SCRIPT}`);
  }

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

  await mkdir(NURSERY_DIR, { recursive: true });

  const runId = stamp();
  const manifest = {
    runId,
    count,
    duration,
    bpm,
    steps,
    keyscale: keyscale || null,
    qwenModel,
    songs: [],
  };

  console.log("Nursery lyrics (Qwen) + ACE-Step song batch");
  console.log(
    `count=${count}  duration=${duration}s  bpm=${bpm}  steps=${steps}  qwen=${qwenModel}`,
  );
  console.log(`output: ${NURSERY_DIR}`);

  // Smoke-check Ollama
  try {
    const tags = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!tags.ok) throw new Error(`status ${tags.status}`);
  } catch (err) {
    throw new Error(`Ollama not reachable at ${OLLAMA_URL}: ${err.message || err}`);
  }

  await freeComfyVram(comfyUrl);

  const usedTitles = [];
  const usedSlugs = new Set();
  // Unique themes for this batch; if count > pool, recycle randomly after
  const batchThemes = takeUnique(THEMES, count);
  while (batchThemes.length < count) batchThemes.push(pick(THEMES));

  for (let i = 1; i <= count; i++) {
    console.log(`\n══ Song ${i}/${count}`);

    const theme = batchThemes[i - 1];
    const style = pick(STYLES);
    const eduFocus = pick(EDUCATIONAL_FOCUS);
    const movement = pick(MOVEMENT_PROMPTS);

    let title;
    let lyrics;
    let slug;
    try {
      console.log(
        `Qwen (${qwenModel})  theme=${theme}  style=${style}  edu=${eduFocus}  move=${movement}`,
      );
      ({ title, lyrics } = await qwenGenerateLyrics(
        qwenModel,
        SETTINGS.qwenTemperature,
        { theme, eduFocus, movement, usedTitles },
      ));
      usedTitles.push(title);
      slug = uniqueSlug(slugify(title), usedSlugs);
      console.log(`Title: ${title}`);
      console.log(`Slug:  ${slug}`);
    } catch (err) {
      const msg = err.message || String(err);
      console.error(`Lyrics failed: ${msg}`);
      manifest.songs.push({
        index: i,
        ok: false,
        stage: "lyrics",
        theme,
        style,
        eduFocus,
        movement,
        error: msg.slice(0, 500),
      });
      await writeFile(
        join(NURSERY_DIR, `manifest_${runId}.json`),
        JSON.stringify(manifest, null, 2),
        "utf8",
      );
      continue;
    }

    const lyricsPath = join(NURSERY_DIR, `${slug}_lyrics.txt`);
    const dest = join(NURSERY_DIR, `${slug}.mp3`);
    const caption = CAPTION_TEMPLATE
      .replaceAll("{{TITLE}}", title)
      .replaceAll("{{STYLE}}", style);
    await writeFile(lyricsPath, lyrics, "utf8");

    const seed =
      baseSeed == null ? randomSeed() : (baseSeed + i - 1) >>> 0;

    const pyArgs = [
      ACE_SCRIPT,
      "--out",
      dest,
      "--caption",
      caption,
      "--lyrics",
      lyricsPath,
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
      console.log(`ACE generating… seed=${seed}  style=${style}`);
      await runPython(pyArgs, 1800000);
      await assertHealthyAudio(dest);
      manifest.songs.push({
        index: i,
        ok: true,
        title,
        slug,
        theme,
        style,
        eduFocus,
        movement,
        seed,
        file: `${slug}.mp3`,
        lyricsFile: `${slug}_lyrics.txt`,
      });
      console.log(`Saved: ${dest}`);
    } catch (err) {
      const msg = err.message || String(err);
      console.error(`Song failed: ${msg}`);
      manifest.songs.push({
        index: i,
        ok: false,
        stage: "song",
        title,
        slug,
        theme,
        style,
        eduFocus,
        movement,
        seed,
        error: msg.slice(0, 500),
      });
    }

    await writeFile(
      join(NURSERY_DIR, `manifest_${runId}.json`),
      JSON.stringify(manifest, null, 2),
      "utf8",
    );
  }

  const ok = manifest.songs.filter((s) => s.ok).length;
  console.log(`\nBatch done: ${ok}/${count} ok`);
  console.log(`Folder: ${NURSERY_DIR}`);
  if (ok === 0) process.exit(1);
}

main().catch((err) => {
  console.error("\nFailed:", err.message || err);
  process.exit(1);
});
