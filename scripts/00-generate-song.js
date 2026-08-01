/**
 * Basic ACE-Step 1.5 song generator — batch mode.
 *
 * Edit CAPTION / LYRICS / SETTINGS below, then run:
 *   node scripts/00-generate-song.js
 *
 * Generates COUNT songs (default 10), each with a different seed.
 * Output:
 *   batches/<name>_<timestamp>/
 *
 * Optional CLI overrides:
 *   --name my_song --count 10 --duration 90 --bpm 100 --seed 2026 --steps 8
 *   --keyscale "C major" --no-thinking
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

// ─── Edit these ─────────────────────────────────────────────────────────────

const CAPTION = `Create an original nursery song called "Little Dream Parade. Write an approximately 150-second song. After the final chorus, include an 8–12 second instrumental outro. End naturally with the vocals finishing before the music fades."

Style:
- Warm, joyful, and magical.
- Ages 2–6.
- Gentle, memorable melody.
- Easy-to-sing lyrics.
- Soft acoustic instruments with light piano, ukulele, bells, and claps.
- Children's choir supporting the chorus.
- Male or female lead with a warm, friendly voice.
- Moderate tempo (110–120 BPM).
- Every verse introduces a new friendly character.
- Encourage imagination, kindness, movement, and curiosity.
- Avoid loud rock or club sounds.
- Make the chorus unforgettable after hearing it once.
- Original composition only.`;

const LYRICS = `[Intro]

Come along,
Come along,
Let's begin our day.

[Verse 1]

Little bunny, hop with me,
One, two, three, so happily.

Little bird, fly up high,
Wave hello across the sky.

[Chorus]

March along,
Sing along,
Every friend belongs.

Clap your hands,
Tap your toes,
Watch our happy garden grow.

March along,
Smile along,
Every heart is strong.

Together we can laugh and play,
In our little dream parade.

[Verse 2]

Little turtle, nice and slow,
Watch the pretty flowers grow.

Little puppy, wag your tail,
Let's explore the happy trail.

[Chorus]

March along,
Sing along,
Every friend belongs.

Clap your hands,
Tap your toes,
Watch our happy garden grow.

March along,
Smile along,
Every heart is strong.

Together we can laugh and play,
In our little dream parade.

[Bridge]

Reach up high,
Touch the sky.

Twirl around,
Without a sound.

Big smiles,
Little feet.

Every day is kind and sweet.

[Final Chorus]

March along,
Sing along,
Every friend belongs.

Hold a hand,
Share a smile,
Let's imagine for a while.

March along,
Sing along,
Shining bright all day long.

Together we can laugh and play,
In our little dream parade.

[Outro]

See you soon,
See you soon,

Have a happy day.


`;

const SETTINGS = {
  name: "little_dream_parade",
  count: 10, // songs per batch
  duration: 180, // seconds
  bpm: 115,
  // Base seed; each take uses baseSeed + i. Omit / null for fully random each take.
  seed: Math.floor(Math.random() * 2147483647),
  steps: 30,
  keyscale: null, // e.g. "C major" — omit to let ACE default
  lm: "acestep-5Hz-lm-1.7B",
  backend: "pt", // pt | vllm | mlx
};

// ─── Runner (usually leave alone) ───────────────────────────────────────────

function randomSeed() {
  return Math.floor(Math.random() * 2147483647);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
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

  const name = flag("--name", SETTINGS.name);
  const count = Math.max(1, Number(flag("--count", String(SETTINGS.count))));
  const duration = Number(flag("--duration", String(SETTINGS.duration)));
  const bpm = Number(flag("--bpm", String(SETTINGS.bpm)));
  const steps = Number(flag("--steps", String(SETTINGS.steps)));
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

  const batchDir = join(ROOT, "batches", `${name}_${stamp()}`);
  await mkdir(batchDir, { recursive: true });

  const lyricsPath = join(batchDir, `${name}_lyrics.txt`);
  await writeFile(lyricsPath, LYRICS, "utf8");

  const manifest = {
    name,
    count,
    duration,
    bpm,
    steps,
    keyscale: keyscale || null,
    caption: CAPTION,
    lyricsPath,
    takes: [],
  };

  console.log("ACE-Step 1.5 — batch song generation");
  console.log(
    `name=${name}  count=${count}  duration=${duration}s  bpm=${bpm}  steps=${steps}  key=${keyscale || "(default)"}`,
  );
  console.log(`batch folder: ${batchDir}`);

  await freeComfyVram(comfyUrl);

  for (let i = 1; i <= count; i++) {
    const seed =
      baseSeed == null ? randomSeed() : (baseSeed + i - 1) >>> 0;
    const pad = String(i).padStart(2, "0");
    const takeName = `${pad}_seed${seed}`;
    const dest = join(batchDir, `${takeName}.mp3`);

    console.log(`\n── Take ${i}/${count}  seed=${seed}  → ${takeName}.mp3`);

    const pyArgs = [
      ACE_SCRIPT,
      "--out",
      dest,
      "--caption",
      CAPTION,
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
      await runPython(pyArgs, 1800000);
      await assertHealthyAudio(dest);
      manifest.takes.push({ index: i, seed, file: `${takeName}.mp3`, ok: true });
      console.log(`Saved: ${dest}`);
    } catch (err) {
      const msg = err.message || String(err);
      console.error(`Take ${i} failed: ${msg}`);
      manifest.takes.push({
        index: i,
        seed,
        file: `${takeName}.mp3`,
        ok: false,
        error: msg.slice(0, 500),
      });
    }

    await writeFile(
      join(batchDir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf8",
    );
  }

  const ok = manifest.takes.filter((t) => t.ok).length;
  console.log(`\nBatch done: ${ok}/${count} ok`);
  console.log(`Folder: ${batchDir}`);
  if (ok === 0) process.exit(1);
}

main().catch((err) => {
  console.error("\nFailed:", err.message || err);
  process.exit(1);
});
