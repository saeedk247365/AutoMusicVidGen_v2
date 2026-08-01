/**
 * Persist the single active mvid project across app restarts.
 * File: batches/.mvid-active.json
 */
import { existsSync } from "fs";
import { readFile, writeFile, mkdir, unlink } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ACTIVE_SESSION_PATH = join(ROOT, "batches", ".mvid-active.json");

function stripBom(raw) {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

export async function loadActiveProject() {
  try {
    if (!existsSync(ACTIVE_SESSION_PATH)) return null;
    const data = JSON.parse(stripBom(await readFile(ACTIVE_SESSION_PATH, "utf8")));
    const songRel = String(data.songRel || data.song || "").replace(/\\/g, "/").trim();
    if (!songRel) return null;
    const abs = join(ROOT, songRel);
    if (!existsSync(abs)) return { ...data, songRel, missing: true };
    return {
      songRel,
      stage: data.stage || "idle",
      statusMessage: data.statusMessage || "",
      outputResolution: data.outputResolution || "preview",
      kidsHit: data.kidsHit !== false,
      updatedAt: data.updatedAt || null,
      missing: false,
    };
  } catch {
    return null;
  }
}

/** Newest batch song folder (by mtime) when no .mvid-active.json exists. */
export async function findNewestBatchSong() {
  const { readdir, stat } = await import("fs/promises");
  const batchesRoot = join(ROOT, "batches");
  if (!existsSync(batchesRoot)) return null;
  const dates = (await readdir(batchesRoot, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && /^\d{8}$/.test(d.name))
    .map((d) => d.name)
    .sort()
    .reverse();
  let best = null;
  for (const date of dates) {
    const dayDir = join(batchesRoot, date);
    const slugs = (await readdir(dayDir, { withFileTypes: true }))
      .filter(
        (d) =>
          d.isDirectory() && !d.name.startsWith("_") && !d.name.startsWith("."),
      )
      .map((d) => d.name);
    for (const slug of slugs) {
      const dir = join(dayDir, slug);
      try {
        const st = await stat(dir);
        const rel = `batches/${date}/${slug}`;
        if (!best || st.mtimeMs > best.mtimeMs) {
          best = { songRel: rel, mtimeMs: st.mtimeMs };
        }
      } catch {
        /* skip */
      }
    }
  }
  return best;
}

export async function resolveStartupProject() {
  const active = await loadActiveProject();
  if (active && !active.missing) return active;
  const newest = await findNewestBatchSong();
  if (!newest) return null;
  return {
    songRel: newest.songRel,
    stage: "idle",
    statusMessage: "",
    outputResolution: "preview",
    kidsHit: true,
    updatedAt: null,
    missing: false,
    inferred: true,
  };
}

export async function saveActiveProject(state) {
  const songRel = String(state?.songRel || "")
    .replace(/\\/g, "/")
    .trim();
  if (!songRel) return null;
  await mkdir(dirname(ACTIVE_SESSION_PATH), { recursive: true });
  const doc = {
    songRel,
    stage: state.stage || "idle",
    statusMessage: state.statusMessage || "",
    outputResolution: state.outputResolution || "preview",
    kidsHit: state.kidsHit !== false,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(ACTIVE_SESSION_PATH, JSON.stringify(doc, null, 2), "utf8");
  return doc;
}

export async function clearActiveProject() {
  try {
    if (existsSync(ACTIVE_SESSION_PATH)) await unlink(ACTIVE_SESSION_PATH);
  } catch {
    /* ignore */
  }
}
