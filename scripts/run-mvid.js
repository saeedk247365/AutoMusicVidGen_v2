/**
 * Full music-video chain (no manual steps):
 *   ensure ComfyUI → lyrics+song+keyframes → Wan animate → stitch final.mp4
 *
 * Default: kids-hit (~75s, loop-fill stitch).
 * Classic (~180s, freeze-pad): pass --classic
 *
 * Usage:
 *   npm run mvid
 *   npm run mvid -- --count 1
 *   npm run mvid -- --theme "rainy day indoor march"
 *   npm run mvid -- --song batches/<date>/<slug>   # skip lyrics; animate+stitch only
 *   npm run mvid -- --classic
 */
import { spawn } from "child_process";
import { readdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { ensureComfyRunning, DEFAULT_COMFY_URL } from "../lib/ensure-comfy.js";
import { parseArgs, stripBom } from "../lib/comfy-client.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const { flag, has } = parseArgs(argv);

const classic = has("--classic");
const kidsHit = !classic;
const songArg = flag("--song", null);
const comfyUrl = flag("--comfy", DEFAULT_COMFY_URL);

/** Flags consumed by this orchestrator (not forwarded to 02_0). */
const OWN = new Set(["--classic", "--song", "--comfy", "--help", "-h"]);

function printHelp() {
  console.log(`mvid — full music video chain (auto)

  npm run mvid
  npm run mvid -- --count 1
  npm run mvid -- --theme "rainy day indoor march"
  npm run mvid -- --song batches/<date>/<slug>
  npm run mvid -- --classic

Starts ComfyUI if needed, then:
  02_0 (lyrics + song + keyframes) → 02_1 (Wan) → 02_2 (stitch final.mp4)

Kids-hit is the default. Pass --classic for the longer path.
Extra flags (except --classic/--song/--comfy) are forwarded to 02_0.`);
}

function passthroughArgs() {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (OWN.has(a)) {
      if (a === "--song" || a === "--comfy") i += 1;
      continue;
    }
    out.push(a);
  }
  return out;
}

function runNode(scriptRel, args) {
  const script = join(ROOT, scriptRel);
  console.log(`\n▶ node ${scriptRel} ${args.join(" ")}`);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: ROOT,
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${scriptRel} exited with code ${code}`));
    });
  });
}

function todayBatchDir() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return join(ROOT, "batches", `${y}${m}${day}`);
}

async function findNewestManifestPath() {
  const batchesRoot = join(ROOT, "batches");
  if (!existsSync(batchesRoot)) return null;
  const dates = (await readdir(batchesRoot))
    .filter((n) => /^\d{8}$/.test(n))
    .sort();
  let best = null;
  for (const date of dates) {
    const dir = join(batchesRoot, date);
    const files = (await readdir(dir)).filter((f) =>
      /^manifest_.+\.json$/i.test(f),
    );
    for (const f of files) {
      const path = join(dir, f);
      if (!best || f > best.name) best = { path, name: f };
    }
  }
  return best?.path || null;
}

async function loadNewestManifest() {
  const path = await findNewestManifestPath();
  if (!path) return null;
  return JSON.parse(stripBom(await readFile(path, "utf8")));
}

async function songDirsFromManifest(manifest) {
  const songs = (manifest?.songs || []).filter((s) => s.ok && s.songDir);
  return songs.map((s) => resolve(s.songDir));
}

function songRel(abs) {
  return relative(ROOT, abs).replace(/\\/g, "/");
}

async function main() {
  if (has("--help") || has("-h")) {
    printHelp();
    return;
  }

  console.log("════════════════════════════════════════════════════════");
  console.log(
    kidsHit
      ? "mvid — full kids-hit music video (auto)"
      : "mvid — full classic music video (auto)",
  );
  console.log("════════════════════════════════════════════════════════");

  await ensureComfyRunning(comfyUrl);

  let targets = [];

  if (songArg) {
    const abs = resolve(
      songArg.match(/^[A-Za-z]:[\\/]/) || songArg.startsWith("/")
        ? songArg
        : join(ROOT, songArg),
    );
    if (!existsSync(abs)) throw new Error(`Song folder not found: ${abs}`);
    targets = [abs];
    console.log(`Using existing song: ${songRel(abs)}`);
  } else {
    const lyricsArgs = [
      ...(kidsHit ? ["--kids-hit"] : []),
      ...passthroughArgs(),
    ];
    // Default one song if caller didn't pass --count
    if (!lyricsArgs.includes("--count")) {
      lyricsArgs.push("--count", "1");
    }

    await runNode(
      "scripts/02_0_generate-lyrics+song+scene+keyframes.js",
      lyricsArgs,
    );

    const manifest = await loadNewestManifest();
    targets = await songDirsFromManifest(manifest);

    if (!targets.length) {
      // Fallback: any song folder under today's batch with keyframes/
      const batchDir = todayBatchDir();
      if (existsSync(batchDir)) {
        const names = await readdir(batchDir);
        for (const name of names) {
          const dir = join(batchDir, name);
          if (existsSync(join(dir, "keyframes"))) targets.push(dir);
        }
        targets.sort();
      }
    }

    if (!targets.length) {
      throw new Error(
        "02_0 finished but no song folders were found to animate. Check batches/.",
      );
    }
  }

  for (const songDir of targets) {
    const rel = songRel(songDir);
    const animArgs = ["--song", rel, "--force"];
    if (kidsHit) animArgs.push("--kids-hit");
    await runNode("scripts/02_1_animate-keyframes.js", animArgs);

    const stitchArgs = ["--song", rel, "--force"];
    if (kidsHit) stitchArgs.push("--loop-fill");
    await runNode("scripts/02_2_stitch-song.js", stitchArgs);

    const finalPath = join(songDir, "final.mp4");
    console.log(`\n✓ final: ${existsSync(finalPath) ? songRel(finalPath) : "(missing)"}`);
  }

  console.log("\n════════════════════════════════════════════════════════");
  console.log("mvid complete");
  for (const songDir of targets) {
    console.log(`  ${songRel(join(songDir, "final.mp4"))}`);
  }
  console.log("════════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("\nFailed:", err.message || err);
  process.exit(1);
});
