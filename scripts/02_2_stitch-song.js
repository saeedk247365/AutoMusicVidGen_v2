/**
 * 02_2 — Stitch Wan clips + song audio into a final music video.
 *
 * Expects (from 02_0 + 02_1):
 *   batches/<date>/<song_slug>/
 *     <song_slug>.mp3          (or any *.mp3)
 *     clips/*.mp4              (ordered by filename)
 *
 * Writes:
 *   batches/<date>/<song_slug>/final.mp4
 *   batches/<date>/<song_slug>/final_manifest.json
 *
 * Timing: clips are concatenated in order, then muxed with the full song.
 * If the silent video is shorter than the audio, the last frame is held
 * (tpad) so the song can finish. If video is longer, output is cut to audio
 * length (--shortest).
 *
 * Usage:
 *   node scripts/02_2_stitch-song.js --song batches/20260729/spin-and-listen
 *   node scripts/02_2_stitch-song.js --batch batches/20260729
 *   node scripts/02_2_stitch-song.js --song <path> --force
 *
 * Requires ffmpeg + ffprobe on PATH.
 * Do NOT run while LoRA training is occupying the GPU (CPU-only stitch is fine).
 */
import { mkdir, readFile, writeFile, readdir, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname, basename, resolve } from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";
import { parseArgs } from "../lib/comfy-client.js";

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { flag, has } = parseArgs();

function resolvePath(raw) {
  if (!raw) return null;
  if (raw.match(/^[A-Za-z]:[\\/]/) || raw.startsWith("/")) return raw;
  return join(ROOT, raw);
}

async function listSongDirs(batchOrSong) {
  const abs = resolvePath(batchOrSong);
  if (!abs || !existsSync(abs)) throw new Error(`Path not found: ${batchOrSong}`);
  if (existsSync(join(abs, "clips"))) return [abs];
  const kids = await readdir(abs);
  const songs = [];
  for (const name of kids) {
    const songDir = join(abs, name);
    if (existsSync(join(songDir, "clips"))) songs.push(songDir);
  }
  if (!songs.length) {
    throw new Error(`No song folders with clips/ under ${abs}`);
  }
  return songs.sort();
}

async function findSongMp3(songDir) {
  const files = await readdir(songDir);
  const mp3s = files.filter((f) => f.toLowerCase().endsWith(".mp3")).sort();
  if (!mp3s.length) {
    throw new Error(`No .mp3 in ${songDir}`);
  }
  // Prefer slug-named file if present
  const slug = basename(songDir);
  const preferred = mp3s.find((f) => f.toLowerCase() === `${slug}.mp3`.toLowerCase());
  return join(songDir, preferred || mp3s[0]);
}

async function listClips(songDir) {
  const clipsDir = join(songDir, "clips");
  const files = (await readdir(clipsDir))
    .filter((f) => f.toLowerCase().endsWith(".mp4"))
    .filter((f) => f.toLowerCase() !== "final.mp4")
    .sort();
  if (!files.length) {
    throw new Error(`No clips in ${clipsDir} — run 02_1 first`);
  }
  return files.map((f) => join(clipsDir, f));
}

async function ffprobeDuration(path) {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      path,
    ],
    { windowsHide: true },
  );
  const n = Number(String(stdout).trim());
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Could not read duration: ${path}`);
  }
  return n;
}

function ffmpegEscapePath(p) {
  // concat demuxer: escape single quotes for Windows paths
  return p.replace(/\\/g, "/").replace(/'/g, "'\\''");
}

async function stitchSong(songDir) {
  const outPath = join(songDir, "final.mp4");
  if (existsSync(outPath) && !has("--force")) {
    console.log(`  reuse ${outPath}`);
    return { outPath, reused: true };
  }

  const clips = await listClips(songDir);
  const mp3 = await findSongMp3(songDir);
  const workDir = join(songDir, "_stitch_tmp");
  await mkdir(workDir, { recursive: true });

  const listPath = join(workDir, "concat.txt");
  const listBody = clips
    .map((c) => `file '${ffmpegEscapePath(resolve(c))}'`)
    .join("\n");
  await writeFile(listPath, listBody, "utf8");

  const silentPath = join(workDir, "silent.mp4");
  console.log(`  concat ${clips.length} clips…`);
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-an",
      silentPath,
    ],
    { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );

  const videoDur = await ffprobeDuration(silentPath);
  const audioDur = await ffprobeDuration(mp3);
  console.log(`  video=${videoDur.toFixed(2)}s  audio=${audioDur.toFixed(2)}s`);

  const pad = Math.max(0, audioDur - videoDur);
  const paddedPath = join(workDir, "padded.mp4");
  let videoForMux = silentPath;

  if (pad > 0.05) {
    console.log(`  pad last frame +${pad.toFixed(2)}s to match song`);
    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-i",
        silentPath,
        "-vf",
        `tpad=stop_mode=clone:stop_duration=${pad.toFixed(3)}`,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-an",
        paddedPath,
      ],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    );
    videoForMux = paddedPath;
  }

  console.log(`  mux audio → ${outPath}`);
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-i",
      videoForMux,
      "-i",
      mp3,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-shortest",
      outPath,
    ],
    { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );

  const manifest = {
    songDir,
    createdAt: new Date().toISOString(),
    clips: clips.map((c) => basename(c)),
    mp3: basename(mp3),
    videoDurationSec: videoDur,
    audioDurationSec: audioDur,
    padSec: pad,
    final: outPath,
  };
  await writeFile(
    join(songDir, "final_manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );

  // Best-effort cleanup of temp files
  for (const f of [listPath, silentPath, paddedPath]) {
    try {
      if (existsSync(f)) await unlink(f);
    } catch {
      /* ignore */
    }
  }

  console.log(`  → ${outPath}`);
  return { outPath, reused: false, manifest };
}

async function main() {
  const songArg = flag("--song", null);
  const batchArg = flag("--batch", null);
  if (!songArg && !batchArg) {
    throw new Error(
      "Pass --song batches/<date>/<slug> or --batch batches/<date>",
    );
  }

  console.log("02_2 Stitch clips + song → final.mp4");
  const targets = await listSongDirs(songArg || batchArg);
  for (const songDir of targets) {
    console.log(`\nSong: ${songDir}`);
    await stitchSong(songDir);
  }
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("\nFailed:", err.message || err);
  process.exit(1);
});
