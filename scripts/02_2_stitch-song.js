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
 * Timing (default / classic):
 *   Clips concatenated in order, then muxed with the full song.
 *   If silent video is shorter than audio, last frame is held (tpad).
 *   If video is longer, output is cut to audio (--shortest).
 *
 * Opt-in --loop-fill (kids-hit):
 *   Repeat/loop clips to cover the song instead of freezing the last frame.
 *   Uses scenes/actions.json startSec/endSec when present.
 *
 * Usage:
 *   node scripts/02_2_stitch-song.js --song batches/20260729/spin-and-listen
 *   node scripts/02_2_stitch-song.js --batch batches/20260729
 *   node scripts/02_2_stitch-song.js --song <path> --force
 *   node scripts/02_2_stitch-song.js --song <path> --loop-fill --force
 *
 * Requires ffmpeg + ffprobe on PATH.
 */
import { mkdir, readFile, writeFile, readdir, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname, basename, resolve } from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";
import { parseArgs, stripBom } from "../lib/comfy-client.js";
import { buildTimedSegmentPlan, buildLoopFillPlan } from "../lib/kids-hit.js";

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
  return p.replace(/\\/g, "/").replace(/'/g, "'\\''");
}

async function loadActions(songDir) {
  const p = join(songDir, "scenes", "actions.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(stripBom(await readFile(p, "utf8")));
  } catch {
    return null;
  }
}

function beatWindowForClip(clipPath, actions) {
  const stem = basename(clipPath, ".mp4");
  // Composite naming: NN_beatId
  const m = /^(\d+)_(.+)$/i.exec(stem);
  if (!m || !actions?.beats) return null;
  const beatId = m[2];
  const beat = actions.beats.find((b) => b.id === beatId);
  if (!beat) return null;
  if (
    Number.isFinite(Number(beat.startSec)) &&
    Number.isFinite(Number(beat.endSec))
  ) {
    return { startSec: Number(beat.startSec), endSec: Number(beat.endSec) };
  }
  return null;
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

  const audioDur = await ffprobeDuration(mp3);
  const loopFill = has("--loop-fill");
  let listBody;
  let loopCounts = null;
  let mode = "concat-tpad";

  if (loopFill) {
    mode = "loop-fill-timed";
    const actions = await loadActions(songDir);
    const clipMeta = [];
    for (const c of clips) {
      const durationSec = await ffprobeDuration(c);
      const win = beatWindowForClip(c, actions);
      clipMeta.push({
        path: c,
        durationSec,
        startSec: win?.startSec,
        endSec: win?.endSec,
      });
    }
    const plan = buildTimedSegmentPlan(clipMeta, audioDur);
    loopCounts = plan.loopCounts;
    console.log(
      `  timed segments: ${plan.segments.length} clips → ${plan.plannedSec.toFixed(1)}s target`,
    );

    const segmentFiles = [];
    for (let i = 0; i < plan.segments.length; i++) {
      const seg = plan.segments[i];
      const outSeg = join(workDir, `seg_${String(i).padStart(3, "0")}.mp4`);
      const t = Math.max(0.05, Number(seg.targetSec));
      const srcDur = await ffprobeDuration(seg.path);
      if (srcDur + 0.02 >= t) {
        await execFileAsync(
          "ffmpeg",
          [
            "-y",
            "-i",
            seg.path,
            "-t",
            t.toFixed(3),
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-an",
            outSeg,
          ],
          { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
        );
      } else {
        const loops = Math.max(1, Math.ceil(t / srcDur) + 1);
        await execFileAsync(
          "ffmpeg",
          [
            "-y",
            "-stream_loop",
            String(loops),
            "-i",
            seg.path,
            "-t",
            t.toFixed(3),
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-an",
            outSeg,
          ],
          { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
        );
      }
      segmentFiles.push(outSeg);
    }

    listBody = segmentFiles
      .map((c) => `file '${ffmpegEscapePath(resolve(c))}'`)
      .join("\n");
  } else {
    listBody = clips
      .map((c) => `file '${ffmpegEscapePath(resolve(c))}'`)
      .join("\n");
  }

  const listPath = join(workDir, "concat.txt");
  await writeFile(listPath, listBody, "utf8");

  const silentPath = join(workDir, "silent.mp4");
  console.log(`  concat…`);
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

  let videoDur = await ffprobeDuration(silentPath);
  console.log(`  video=${videoDur.toFixed(2)}s  audio=${audioDur.toFixed(2)}s`);

  const pad = Math.max(0, audioDur - videoDur);
  const paddedPath = join(workDir, "padded.mp4");
  let videoForMux = silentPath;

  if (loopFill) {
    // Trim excess or allow tiny pad only
    if (videoDur > audioDur + 0.05) {
      const trimmed = join(workDir, "trimmed.mp4");
      await execFileAsync(
        "ffmpeg",
        [
          "-y",
          "-i",
          silentPath,
          "-t",
          audioDur.toFixed(3),
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-an",
          trimmed,
        ],
        { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      );
      videoForMux = trimmed;
      videoDur = await ffprobeDuration(trimmed);
    } else if (pad > 0.15) {
      console.warn(
        `  warning: loop-fill still short by ${pad.toFixed(2)}s — tiny tpad for rounding only`,
      );
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
  } else if (pad > 0.05) {
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
      "libx264",
      "-b:v",
      "4M",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-shortest",
      outPath,
    ],
    { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );

  const finalPad = Math.max(0, audioDur - videoDur);
  const manifest = {
    songDir,
    createdAt: new Date().toISOString(),
    mode,
    clips: clips.map((c) => basename(c)),
    mp3: basename(mp3),
    videoDurationSec: videoDur,
    audioDurationSec: audioDur,
    padSec: loopFill ? Math.min(finalPad, 0.15) : finalPad,
    loopCounts,
    final: outPath,
  };
  await writeFile(
    join(songDir, "final_manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );

  for (const f of await readdir(workDir).catch(() => [])) {
    try {
      await unlink(join(workDir, f));
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
  if (has("--loop-fill")) console.log("  mode: loop-fill (no freeze pad)");
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
