/**
 * Interactive mvid orchestrator: stage runners + approval gates + SSE fan-out.
 */
import { spawn } from "child_process";
import { EventEmitter } from "events";
import { existsSync } from "fs";
import { readdir, readFile, writeFile, mkdir } from "fs/promises";
import { join, relative, resolve, basename, dirname } from "path";
import { fileURLToPath } from "url";
import { stripBom } from "./comfy-client.js";
import { ensureComfyRunning, DEFAULT_COMFY_URL } from "./ensure-comfy.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const STAGES = [
  "idle",
  "lyrics",
  "await_lyrics",
  "song",
  "await_song",
  "plan",
  "await_plan",
  "keyframes",
  "await_keyframes",
  "clips",
  "await_clips",
  "final",
  "await_final",
  "done",
  "error",
];

export class MvidOrchestrator extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.kidsHit = opts.kidsHit !== false;
    this.comfyUrl = opts.comfyUrl || DEFAULT_COMFY_URL;
    this.extraArgs = opts.extraArgs || [];
    this.songArg = opts.songArg || null;
    this.autoApprove = opts.autoApprove === true;
    this.songDir = null;
    this.songRel = null;
    this.stage = "idle";
    this.statusMessage = "Starting…";
    this.error = null;
    this.tabs = blankTabs();
    this._approval = null;
    this._rejectRequested = false;
    this._running = false;
    this._started = false;
  }

  getState() {
    return {
      stage: this.stage,
      statusMessage: this.statusMessage,
      autoApprove: this.autoApprove,
      kidsHit: this.kidsHit,
      songDir: this.songRel,
      error: this.error,
      waiting: this.stage.startsWith("await_"),
      tabs: this.tabs,
      stages: STAGES,
    };
  }

  setAutoApprove(enabled) {
    this.autoApprove = !!enabled;
    this.emit("state", this.getState());
    if (this.autoApprove && this._approval) {
      this._approval.resolve({ action: "approve" });
      this._approval = null;
    }
  }

  approve(stage, payload = {}) {
    const gate =
      stage === "storyline" || stage === "scenes" || stage === "scripts"
        ? "plan"
        : stage;
    if (this.stage !== `await_${gate}`) {
      return { ok: false, error: `Not waiting on ${gate} (stage=${this.stage})` };
    }
    if (!this._approval) return { ok: false, error: "Nothing to approve" };
    this._approval.resolve({ action: "approve", payload, stage: gate });
    this._approval = null;
    return { ok: true };
  }

  reject(stage) {
    const gate =
      stage === "storyline" || stage === "scenes" || stage === "scripts"
        ? "plan"
        : stage;
    if (this.stage !== `await_${gate}`) {
      return { ok: false, error: `Not waiting on ${gate} (stage=${this.stage})` };
    }
    if (!this._approval) return { ok: false, error: "Nothing to reject" };
    this._approval.resolve({ action: "reject", stage: gate });
    this._approval = null;
    return { ok: true };
  }

  async start() {
    if (this._started) return;
    this._started = true;
    this._running = true;
    try {
      await this._run();
    } catch (err) {
      this.error = err.message || String(err);
      this.setStage("error", this.error);
      this.emit("error", err);
    } finally {
      this._running = false;
    }
  }

  setStage(stage, message) {
    this.stage = stage;
    if (message) this.statusMessage = message;
    this.emit("state", this.getState());
    this.emit("sse", {
      type: "stage",
      stage,
      message: this.statusMessage,
      tabs: this.tabs,
      songDir: this.songRel,
      waiting: stage.startsWith("await_"),
      autoApprove: this.autoApprove,
    });
  }

  async waitForApproval(stage) {
    this.setStage(`await_${stage}`, `Waiting for approval: ${stage}`);
    if (this.autoApprove) {
      this.emit("sse", { type: "auto_approve", stage });
      return { action: "approve", payload: {} };
    }
    return new Promise((resolve) => {
      this._approval = { resolve };
    });
  }

  async _runNode(scriptRel, args, { watchPreview = false } = {}) {
    const script = join(ROOT, scriptRel);
    console.log(`\n▶ node ${scriptRel} ${args.join(" ")}`);
    this.emit("sse", { type: "log", message: `▶ ${scriptRel} ${args.join(" ")}` });
    return new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [script, ...args], {
        cwd: ROOT,
        stdio: "inherit",
        env: process.env,
      });
      let poll = null;
      let lastPreviewMtime = 0;
      if (watchPreview) {
        poll = setInterval(async () => {
          try {
            const previewPath = this.songDir
              ? join(this.songDir, "preview.mp4")
              : null;
            if (previewPath && existsSync(previewPath)) {
              const { stat } = await import("fs/promises");
              const st = await stat(previewPath);
              const m = Number(st.mtimeMs) || 0;
              if (m > lastPreviewMtime) {
                lastPreviewMtime = m;
                await this.refreshTabsFromDisk();
                this.setStage(
                  "clips",
                  `Animating… preview updated (${this.tabs?.preview?.clips || "?"} clips)`,
                );
              }
            }
          } catch {
            /* ignore poll errors */
          }
        }, 2500);
      }
      const clear = () => {
        if (poll) clearInterval(poll);
      };
      child.on("error", (err) => {
        clear();
        reject(err);
      });
      child.on("exit", (code) => {
        clear();
        if (code === 0) resolvePromise();
        else reject(new Error(`${scriptRel} exited with code ${code}`));
      });
    });
  }

  songPath(relOrAbs) {
    if (!relOrAbs) return null;
    if (relOrAbs.match(/^[A-Za-z]:[\\/]/) || relOrAbs.startsWith("/")) return relOrAbs;
    return join(ROOT, relOrAbs);
  }

  toRel(abs) {
    return relative(ROOT, abs).replace(/\\/g, "/");
  }

  async refreshTabsFromDisk() {
    const dir = this.songDir;
    if (!dir || !existsSync(dir)) return;
    const tabs = blankTabs();

    const lyricsPath = join(dir, "lyrics.txt");
    if (existsSync(lyricsPath)) {
      tabs.lyrics = { text: stripBom(await readFile(lyricsPath, "utf8")) };
    }

    const mp3s = (await readdir(dir).catch(() => [])).filter((f) =>
      f.toLowerCase().endsWith(".mp3"),
    );
    if (mp3s.length) {
      const preferred =
        mp3s.find((f) => f.toLowerCase() === `${basename(dir)}.mp3`.toLowerCase()) ||
        mp3s[0];
      tabs.song = { url: `/media/song/${encodeURIComponent(preferred)}`, name: preferred };
    }

    const actionsPath = join(dir, "scenes", "actions.json");
    if (existsSync(actionsPath)) {
      const plan = JSON.parse(stripBom(await readFile(actionsPath, "utf8")));
      tabs.storyline = {
        objective: plan.objective || "",
        theme: plan.theme || "",
        beats: (plan.beats || []).map((b) => ({
          id: b.id,
          section: b.section,
          storyBeat: b.storyBeat,
          location: b.location,
          cause: b.cause,
          effect: b.effect,
          lyricHint: b.lyricHint,
          startSec: b.startSec,
          endSec: b.endSec,
        })),
        raw: JSON.stringify(plan, null, 2),
      };
      tabs.scripts = {
        beats: (plan.beats || []).map((b) => ({
          id: b.id,
          lyricHint: b.lyricHint || "",
          cause: b.cause || "",
          effect: b.effect || "",
          cutMotivation: b.cutMotivation || "",
          actionPhase: b.actionPhase || "",
          characters: b.characters || [],
        })),
      };
      const usedLocs = [...new Set((plan.beats || []).map((b) => b.location).filter(Boolean))];
      tabs.scenes = {
        locations: await Promise.all(
          usedLocs.map(async (loc) => {
            const local = join(dir, "scenes", `${loc}.png`);
            const shared = join(ROOT, "scenes", `${loc}.png`);
            const exists = existsSync(local) || existsSync(shared);
            const beats = (plan.beats || []).filter((b) => b.location === loc).map((b) => b.id);
            return {
              id: loc,
              url: exists ? `/media/scenes/${encodeURIComponent(loc)}.png` : null,
              beats,
            };
          }),
        ),
      };
    }

    const kfDir = join(dir, "keyframes");
    if (existsSync(kfDir)) {
      const files = (await readdir(kfDir))
        .filter((f) => /\.png$/i.test(f))
        .sort();
      tabs.keyframes = {
        images: files.map((f) => ({
          name: f,
          url: `/media/keyframes/${encodeURIComponent(f)}`,
        })),
      };
    }

    const clipsDir = join(dir, "clips");
    if (existsSync(clipsDir)) {
      const files = (await readdir(clipsDir))
        .filter((f) => /\.mp4$/i.test(f) && f.toLowerCase() !== "final.mp4")
        .sort();
      tabs.clips = {
        videos: files.map((f) => ({
          name: f,
          url: `/media/clips/${encodeURIComponent(f)}`,
        })),
      };
    }

    const previewPath = join(dir, "preview.mp4");
    if (existsSync(previewPath)) {
      const { stat } = await import("fs/promises");
      const st = await stat(previewPath);
      tabs.preview = {
        url: `/media/preview.mp4`,
        name: "preview.mp4",
        clips: tabs.clips?.videos?.length || 0,
        mtime: Number(st.mtimeMs) || Date.now(),
      };
    }

    const finalPath = join(dir, "final.mp4");
    if (existsSync(finalPath)) {
      tabs.final = { url: `/media/final.mp4`, name: "final.mp4" };
    }

    this.tabs = tabs;
    this.emit("sse", { type: "tabs", tabs: this.tabs });
    this.emit("state", this.getState());
  }

  async applyLyricsPayload(payload) {
    if (!payload?.text || !this.songDir) return;
    const { stripPhysicalContactLanguage } = await import("./kids-hit.js");
    const cleaned = stripPhysicalContactLanguage(payload.text);
    await writeFile(join(this.songDir, "lyrics.txt"), cleaned, "utf8");
    await this.refreshTabsFromDisk();
  }

  async applyPlanPayload(payload) {
    if (!payload?.raw || !this.songDir) return;
    const plan = JSON.parse(payload.raw);
    await mkdir(join(this.songDir, "scenes"), { recursive: true });
    await writeFile(
      join(this.songDir, "scenes", "actions.json"),
      JSON.stringify(plan, null, 2),
      "utf8",
    );
    await this.refreshTabsFromDisk();
  }

  async findNewestSongFromManifest() {
    const batchesRoot = join(ROOT, "batches");
    if (!existsSync(batchesRoot)) return null;
    const dates = (await readdir(batchesRoot))
      .filter((n) => /^\d{8}$/.test(n))
      .sort();
    let best = null;
    for (const date of dates) {
      const dir = join(batchesRoot, date);
      const files = (await readdir(dir)).filter((f) => /^manifest_.+\.json$/i.test(f));
      for (const f of files) {
        if (!best || f > best.name) best = { path: join(dir, f), name: f };
      }
    }
    if (!best) return null;
    const manifest = JSON.parse(stripBom(await readFile(best.path, "utf8")));
    const songs = (manifest.songs || []).filter((s) => s.ok && s.songDir);
    if (!songs.length) return null;
    return resolve(songs[songs.length - 1].songDir);
  }

  async _run() {
    this.setStage("idle", "Ensuring ComfyUI…");
    await ensureComfyRunning(this.comfyUrl);

    const kidsFlags = this.kidsHit ? ["--kids-hit"] : [];
    const pass = [...this.extraArgs];

    // Existing song: jump to first missing stage or keyframes→clips→final
    if (this.songArg) {
      this.songDir = this.songPath(this.songArg);
      if (!existsSync(this.songDir)) throw new Error(`Song folder not found: ${this.songDir}`);
      this.songRel = this.toRel(this.songDir);
      await this.refreshTabsFromDisk();
      await this._continueFromExisting(kidsFlags);
      return;
    }

    // ── Lyrics ──
    for (;;) {
      this.setStage("lyrics", "Generating lyrics…");
      const args = [...kidsFlags];
      let sawCount = false;
      for (let i = 0; i < pass.length; i++) {
        if (pass[i] === "--count") {
          sawCount = true;
          args.push("--count", pass[i + 1]);
          i++;
          continue;
        }
        if (pass[i] === "--stop-after") {
          i++;
          continue;
        }
        args.push(pass[i]);
      }
      if (!sawCount) args.push("--count", "1");
      args.push("--stop-after", "lyrics");

      await this._runNode(
        "scripts/02_0_generate-lyrics+song+scene+keyframes.js",
        args,
      );
      this.songDir = await this.findNewestSongFromManifest();
      if (!this.songDir) throw new Error("Lyrics stage produced no song folder");
      this.songRel = this.toRel(this.songDir);
      await this.refreshTabsFromDisk();

      const decision = await this.waitForApproval("lyrics");
      if (decision.action === "reject") {
        this.setStage("lyrics", "Regenerating lyrics…");
        continue;
      }
      await this.applyLyricsPayload(decision.payload);
      break;
    }

    // ── Song ──
    for (;;) {
      this.setStage("song", "Generating song audio…");
      await this._runNode("scripts/02_0_generate-lyrics+song+scene+keyframes.js", [
        ...kidsFlags,
        "--song",
        this.songRel,
        "--resume-from",
        "song",
        "--stop-after",
        "song",
        // new seed on reject
        ...(this._rejectRequested ? ["--seed", String((Date.now() >>> 0) % 1e9)] : []),
      ]);
      this._rejectRequested = false;
      await this.refreshTabsFromDisk();
      const decision = await this.waitForApproval("song");
      if (decision.action === "reject") {
        this._rejectRequested = true;
        continue;
      }
      break;
    }

    // ── Plan (storyline / scenes / scripts) ──
    for (;;) {
      this.setStage("plan", "Generating storyline & scene plan…");
      await this._runNode("scripts/02_0_generate-lyrics+song+scene+keyframes.js", [
        ...kidsFlags,
        "--song",
        this.songRel,
        "--resume-from",
        "plan",
        "--stop-after",
        "plan",
      ]);
      await this.refreshTabsFromDisk();
      const decision = await this.waitForApproval("plan");
      if (decision.action === "reject") continue;
      if (decision.payload?.raw) await this.applyPlanPayload(decision.payload);
      break;
    }

    // Regenerate furnished scene plates (shared + song copy) before keyframes
    this.setStage("keyframes", "Refreshing furnished scene stills…");
    await this._runNode("scripts/02_0_generate-lyrics+song+scene+keyframes.js", [
      ...kidsFlags,
      "--scenes-only",
      "--force",
    ]);

    // ── Keyframes ──
    for (;;) {
      this.setStage("keyframes", "Generating keyframe stills…");
      await this._runNode("scripts/02_0_generate-lyrics+song+scene+keyframes.js", [
        ...kidsFlags,
        "--song",
        this.songRel,
        "--resume-from",
        "keyframes",
        "--force",
      ]);
      await this.refreshTabsFromDisk();
      const decision = await this.waitForApproval("keyframes");
      if (decision.action === "reject") continue;
      break;
    }

    await this._animateAndStitch(kidsFlags);
  }

  async _continueFromExisting(kidsFlags) {
    const hasKf =
      existsSync(join(this.songDir, "keyframes")) &&
      (await readdir(join(this.songDir, "keyframes"))).some((f) => /\.png$/i.test(f));
    const hasClips =
      existsSync(join(this.songDir, "clips")) &&
      (await readdir(join(this.songDir, "clips"))).some((f) => /\.mp4$/i.test(f));
    const hasFinal = existsSync(join(this.songDir, "final.mp4"));
    const hasPlan = existsSync(join(this.songDir, "scenes", "actions.json"));
    const hasMp3 = (await readdir(this.songDir)).some((f) => /\.mp3$/i.test(f));
    const hasLyrics = existsSync(join(this.songDir, "lyrics.txt"));

    if (!hasLyrics) throw new Error("Existing song folder has no lyrics.txt");

    if (!hasMp3) {
      for (;;) {
        this.setStage("song", "Generating song audio…");
        await this._runNode("scripts/02_0_generate-lyrics+song+scene+keyframes.js", [
          ...kidsFlags,
          "--song",
          this.songRel,
          "--resume-from",
          "song",
          "--stop-after",
          "song",
        ]);
        await this.refreshTabsFromDisk();
        const d = await this.waitForApproval("song");
        if (d.action === "reject") continue;
        break;
      }
    }

    if (!hasPlan) {
      for (;;) {
        this.setStage("plan", "Generating storyline & scene plan…");
        await this._runNode("scripts/02_0_generate-lyrics+song+scene+keyframes.js", [
          ...kidsFlags,
          "--song",
          this.songRel,
          "--resume-from",
          "plan",
          "--stop-after",
          "plan",
        ]);
        await this.refreshTabsFromDisk();
        const d = await this.waitForApproval("plan");
        if (d.action === "reject") continue;
        if (d.payload?.raw) await this.applyPlanPayload(d.payload);
        break;
      }
    }

    if (!hasKf) {
      for (;;) {
        this.setStage("keyframes", "Generating keyframe stills…");
        await this._runNode("scripts/02_0_generate-lyrics+song+scene+keyframes.js", [
          ...kidsFlags,
          "--song",
          this.songRel,
          "--resume-from",
          "keyframes",
          "--force",
        ]);
        await this.refreshTabsFromDisk();
        const d = await this.waitForApproval("keyframes");
        if (d.action === "reject") continue;
        break;
      }
    } else {
      await this.refreshTabsFromDisk();
      const d = await this.waitForApproval("keyframes");
      if (d.action === "reject") {
        for (;;) {
          this.setStage("keyframes", "Regenerating keyframes…");
          await this._runNode("scripts/02_0_generate-lyrics+song+scene+keyframes.js", [
            ...kidsFlags,
            "--song",
            this.songRel,
            "--resume-from",
            "keyframes",
            "--force",
          ]);
          await this.refreshTabsFromDisk();
          const d2 = await this.waitForApproval("keyframes");
          if (d2.action === "reject") continue;
          break;
        }
      }
    }

    if (!hasClips || !hasFinal) {
      await this._animateAndStitch(kidsFlags);
    } else {
      await this.refreshTabsFromDisk();
      this.setStage("done", "Complete — final.mp4 ready");
    }
  }

  async _animateAndStitch(kidsFlags) {
    for (;;) {
      this.setStage("clips", "Animating keyframes (Wan)…");
      const animArgs = ["--song", this.songRel, "--force"];
      if (this.kidsHit) animArgs.push("--kids-hit");
      await this._runNode("scripts/02_1_animate-keyframes.js", animArgs, {
        watchPreview: true,
      });
      await this.refreshTabsFromDisk();
      const decision = await this.waitForApproval("clips");
      if (decision.action === "reject") continue;
      break;
    }

    for (;;) {
      this.setStage("final", "Stitching final.mp4…");
      const stitchArgs = ["--song", this.songRel, "--force"];
      if (this.kidsHit) stitchArgs.push("--loop-fill");
      await this._runNode("scripts/02_2_stitch-song.js", stitchArgs);
      await this.refreshTabsFromDisk();
      const decision = await this.waitForApproval("final");
      if (decision.action === "reject") continue;
      break;
    }

    this.setStage("done", `Complete — ${this.songRel}/final.mp4`);
  }
}

function blankTabs() {
  return {
    lyrics: { text: "" },
    song: null,
    storyline: null,
    scenes: null,
    scripts: null,
    keyframes: null,
    clips: null,
    preview: null,
    final: null,
  };
}

export { ROOT as MVID_ROOT, DEFAULT_COMFY_URL };
