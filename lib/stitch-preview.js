/**
 * Progressive preview stitch: concat finished clips + song audio trimmed to video length.
 * Used while Wan animate runs so the web UI can preview with sound as clips arrive.
 */
import { mkdir, readFile, writeFile, readdir, unlink, rm } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname, basename, resolve } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { stripBom } from "./comfy-client.js";

const execFileAsync = promisify(execFile);

function ffmpegEscapePath(p) {
  return p.replace(/\\/g, "/").replace(/'/g, "'\\''");
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

async function findSongMp3(songDir) {
  const files = await readdir(songDir);
  const mp3s = files.filter((f) => f.toLowerCase().endsWith(".mp3")).sort();
  if (!mp3s.length) throw new Error(`No .mp3 in ${songDir}`);
  const slug = basename(songDir);
  const preferred = mp3s.find(
    (f) => f.toLowerCase() === `${slug}.mp3`.toLowerCase(),
  );
  return join(songDir, preferred || mp3s[0]);
}

async function listFinishedClips(songDir) {
  const clipsDir = join(songDir, "clips");
  if (!existsSync(clipsDir)) return [];
  const files = (await readdir(clipsDir))
    .filter((f) => f.toLowerCase().endsWith(".mp4"))
    .filter((f) => !/^(final|preview)\.mp4$/i.test(f))
    .sort();
  return files.map((f) => join(clipsDir, f));
}

/**
 * Rebuild songDir/preview.mp4 from whatever clips exist so far.
 * Audio is trimmed to the current video length (first N seconds of the song).
 * @returns {{ path: string, clips: number, durationSec: number } | null}
 */
export async function writePreviewMp4(songDir) {
  const clips = await listFinishedClips(songDir);
  if (!clips.length) return null;

  const mp3 = await findSongMp3(songDir);
  const outPath = join(songDir, "preview.mp4");
  const workDir = join(songDir, "_preview_tmp");
  await mkdir(workDir, { recursive: true });

  try {
    const listPath = join(workDir, "concat.txt");
    const listBody = clips
      .map((c) => `file '${ffmpegEscapePath(resolve(c))}'`)
      .join("\n");
    await writeFile(listPath, listBody, "utf8");

    const silentPath = join(workDir, "silent.mp4");
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
    await execFileAsync(
      "ffmpeg",
      [
        "-y",
        "-i",
        silentPath,
        "-i",
        mp3,
        "-t",
        videoDur.toFixed(3),
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

    return { path: outPath, clips: clips.length, durationSec: videoDur };
  } finally {
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
