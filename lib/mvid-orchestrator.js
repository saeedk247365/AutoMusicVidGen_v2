/**
 * Interactive mvid orchestrator: stage runners + approval gates + SSE fan-out.
 */
import { spawn } from "child_process";
import { EventEmitter } from "events";
import { existsSync } from "fs";
import { readdir, readFile, writeFile, mkdir, unlink, stat } from "fs/promises";
import { writePreviewMp4 } from "./stitch-preview.js";
import { join, relative, resolve, basename, dirname } from "path";
import { fileURLToPath } from "url";
import { stripBom, resetComfyExecution } from "./comfy-client.js";
import { ensureComfyRunning, DEFAULT_COMFY_URL } from "./ensure-comfy.js";
import { resolveComfyUrlForStage, gpuStatus, comfyAuthHeaders, getGpuBackend, isSaladUrl } from "./gpu-backend.js";
import {
  PauseError,
  StopError,
  killProcessTree,
} from "./pipeline-control.js";
import {
  resolveOutputResolution,
  DEFAULT_OUTPUT_RESOLUTION,
  listOutputResolutions,
} from "./kids-hit.js";
import {
  loadActiveProject,
  saveActiveProject,
  clearActiveProject,
  resolveStartupProject,
} from "./mvid-active.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const STAGES = [
  "idle",
  "setup",
  "await_setup",
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
  "paused",
  "stopped",
  "done",
  "error",
];

export class MvidOrchestrator extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.kidsHit = opts.kidsHit !== false;
    this.comfyUrl = opts.comfyUrl || resolveComfyUrlForStage("prep") || DEFAULT_COMFY_URL;
    this.extraArgs = opts.extraArgs || [];
    this.songArg = opts.songArg || null;
    this.autoApprove = opts.autoApprove === true;
    this.outputResolution = resolveOutputResolution(
      opts.outputResolution || DEFAULT_OUTPUT_RESOLUTION,
    ).id;
    this.songDir = null;
    this.songRel = null;
    this.stage = "idle";
    this.statusMessage = "Starting…";
    this.error = null;
    this.tabs = blankTabs();
    this.setup = {
      castIds: ["adam", "sasha"],
      locationIds: [],
      title: "",
      objective: "",
      theme: "",
    };
    this._approval = null;
    this._rejectRequested = false;
    this._running = false;
    this._started = false;
    this._paused = false;
    this._stopped = false;
    this._pauseGate = null; // { promise, resolve }
    this._child = null;
    this._pausedFromStage = null;
    this.viewOnly = opts.viewOnly === true;
  }

  async rememberActiveProject() {
    if (!this.songRel) return;
    try {
      await saveActiveProject({
        songRel: this.songRel,
        stage: this.stage,
        statusMessage: this.statusMessage,
        outputResolution: this.outputResolution,
        kidsHit: this.kidsHit,
      });
    } catch {
      /* non-fatal */
    }
  }

  setComfyUrl(url) {
    if (url) this.comfyUrl = String(url).replace(/\/$/, "");
  }

  /** Sync orchestrator URLs after UI GPU route change. */
  syncGpuRoute() {
    this.comfyUrl = resolveComfyUrlForStage("prep");
    this.emit("state", this.getState());
    return {
      ok: true,
      backend: getGpuBackend(),
      comfyUrl: this.comfyUrl,
      clipsComfyUrl: resolveComfyUrlForStage("clips"),
    };
  }

  setupFlags() {
    const args = [];
    if (this.setup.castIds?.length) {
      args.push("--cast", this.setup.castIds.join(","));
    }
    if (this.setup.locationIds?.length) {
      args.push("--locations", this.setup.locationIds.join(","));
    }
    if (this.setup.title) args.push("--title", this.setup.title);
    if (this.setup.objective) args.push("--objective", this.setup.objective);
    if (this.setup.theme) args.push("--theme", this.setup.theme);
    return args;
  }

  applySetup(body = {}) {
    const castIds = Array.isArray(body.castIds)
      ? body.castIds.map(String).filter(Boolean)
      : String(body.cast || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
    if (!castIds.length) {
      return { ok: false, error: "Select at least one character" };
    }
    const locationIds = Array.isArray(body.locationIds)
      ? body.locationIds.map(String).filter(Boolean)
      : String(body.locations || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
    this.setup = {
      castIds,
      locationIds,
      title: String(body.title || "").trim(),
      objective: String(body.objective || "").trim(),
      theme: String(body.theme || "").trim(),
    };
    this.tabs.setup = { ...this.setup };
    this.emit("state", this.getState());
    return { ok: true, setup: this.setup };
  }

  getState() {
    return {
      stage: this.stage,
      statusMessage: this.statusMessage,
      autoApprove: this.autoApprove,
      kidsHit: this.kidsHit,
      outputResolution: this.outputResolution,
      outputResolutions: listOutputResolutions(),
      songDir: this.songRel,
      viewOnly: !!this.viewOnly,
      running: !!this._running,
      error: this.error,
      waiting: this.stage.startsWith("await_"),
      paused: this._paused,
      stopped: this._stopped,
      tabs: this.tabs,
      stages: STAGES,
      setup: this.setup,
      gpu: gpuStatus(),
      comfyUrl: this.comfyUrl,
      pausedFromStage: this._pausedFromStage,
    };
  }

  setOutputResolution(id) {
    const preset = resolveOutputResolution(id);
    this.outputResolution = preset.id;
    this.emit("state", this.getState());
    return { ok: true, outputResolution: preset.id, preset };
  }

  resolutionFlags() {
    return ["--output-resolution", this.outputResolution];
  }

  /**
   * Open an existing batch song for viewing (and optional continue).
   * Does not start generation — refreshes tabs from disk.
   */
  async openSong(relOrPath) {
    const raw = String(relOrPath || "").trim().replace(/\\/g, "/");
    if (!raw) return { ok: false, error: "song path required" };
    const dir = this.songPath(raw);
    if (!existsSync(dir)) {
      return { ok: false, error: `Song folder not found: ${raw}` };
    }
    this.songDir = dir;
    this.songRel = this.toRel(dir);
    this.songArg = this.songRel;
    await this.refreshTabsFromDisk();
    await this.rememberActiveProject();
    if (
      this.stage === "idle" ||
      this.stage === "done" ||
      this.stage === "error" ||
      this.stage === "stopped" ||
      String(this.stage).startsWith("await_")
    ) {
      this.statusMessage = `Viewing ${this.songRel}`;
    }
    this.emit("state", this.getState());
    this.emit("sse", {
      type: "log",
      message: `Opened ${this.songRel}`,
    });
    return { ok: true, songDir: this.songRel, tabs: this.tabs };
  }

  /**
   * Restore last active project for viewing (no generation).
   */
  async restoreActiveProject() {
    const active = await resolveStartupProject();
    if (!active?.songRel) {
      return { ok: false, error: "No active project saved" };
    }
    if (active.missing) {
      await clearActiveProject();
      return { ok: false, error: `Saved project missing: ${active.songRel}` };
    }
    if (active.outputResolution) {
      this.outputResolution = resolveOutputResolution(active.outputResolution).id;
    }
    this.viewOnly = true;
    const opened = await this.openSong(active.songRel);
    if (!opened.ok) return opened;
    const note = active.inferred
      ? `Opened latest batch ${this.songRel} (no prior session file)`
      : `Restored ${this.songRel} — edit / remake, or Continue pipeline`;
    this.setStage("idle", note);
    await this.rememberActiveProject();
    return { ok: true, ...active, songDir: this.songRel, tabs: this.tabs };
  }

  /**
   * Resume pipeline on the currently open song (continue from first missing stage).
   */
  async continuePipeline() {
    // Pause → change GPU → Continue should resume the in-flight pipeline with new route.
    if (this._paused && this._running) {
      const resumed = this.resume();
      return {
        ok: resumed.ok,
        resumed: true,
        songDir: this.songRel,
        backend: resumed.backend,
        error: resumed.error,
      };
    }
    if (this._running) {
      return { ok: false, error: "Pipeline already running" };
    }
    if (!this.songRel) {
      return { ok: false, error: "No project open" };
    }
    this.viewOnly = false;
    this.songArg = this.songRel;
    this._started = false;
    this._stopped = false;
    this.error = null;
    this.syncGpuRoute();
    this.emit("sse", {
      type: "log",
      message: `Continuing pipeline for ${this.songRel} · GPU ${getGpuBackend()}`,
    });
    this.start().catch((err) => {
      console.error("Continue pipeline failed:", err.message || err);
    });
    return { ok: true, songDir: this.songRel };
  }

  /**
   * Clear active project and start a fresh setup → lyrics pipeline.
   */
  async startNewProject() {
    if (this._running) {
      return { ok: false, error: "Stop or wait for the current pipeline first" };
    }
    await clearActiveProject();
    this.viewOnly = false;
    this.songArg = null;
    this.songDir = null;
    this.songRel = null;
    this.tabs = blankTabs();
    this._started = false;
    this._stopped = false;
    this.error = null;
    this.emit("state", this.getState());
    this.emit("sse", { type: "log", message: "Starting new project…" });
    this.start().catch((err) => {
      console.error("New project failed:", err.message || err);
    });
    return { ok: true };
  }

  setAutoApprove(enabled) {
    this.autoApprove = !!enabled;
    this.emit("state", this.getState());
    if (this.autoApprove && this._approval && !this._paused) {
      this._approval.resolve({ action: "approve" });
      this._approval = null;
    }
  }

  async interruptComfy() {
    const urls = new Set(
      [
        this.comfyUrl,
        resolveComfyUrlForStage("prep"),
        resolveComfyUrlForStage("clips"),
      ]
        .filter(Boolean)
        .map((u) => String(u).replace(/\/$/, "")),
    );
    await Promise.all(
      [...urls].map(async (url) => {
        try {
          await fetch(`${url}/interrupt`, {
            method: "POST",
            headers: {
              ...comfyAuthHeaders(url),
              "Content-Type": "application/json",
            },
            body: "{}",
            signal: AbortSignal.timeout(5000),
          });
        } catch {
          /* ignore */
        }
      }),
    );
  }

  _killActiveChild() {
    if (this._child?.pid) {
      killProcessTree(this._child.pid);
      this._child = null;
    }
  }

  /**
   * Pause generation: kill active worker, interrupt Comfy, hold until resume.
   * Works during any generating stage (local or Salad).
   */
  async pause() {
    if (this._stopped) return { ok: false, error: "Pipeline already stopped" };
    if (this._paused) return { ok: true, paused: true };
    this._paused = true;
    this._pausedFromStage = this.stage?.replace(/^await_/, "") || this.stage;
    if (!this._pauseGate) {
      let resolve;
      const promise = new Promise((r) => {
        resolve = r;
      });
      this._pauseGate = { promise, resolve };
    }
    await this.interruptComfy();
    this._killActiveChild();
    this.setStage("paused", `Paused (was: ${this._pausedFromStage})`);
    this.emit("sse", { type: "log", message: "⏸ Pipeline paused" });
    return { ok: true, paused: true, from: this._pausedFromStage };
  }

  resume() {
    if (this._stopped) return { ok: false, error: "Pipeline stopped — restart mvid" };
    if (!this._paused) return { ok: true, paused: false };
    this._paused = false;
    const from = this._pausedFromStage;
    this._pausedFromStage = null;
    const route = this.syncGpuRoute();
    if (this._pauseGate) {
      this._pauseGate.resolve();
      this._pauseGate = null;
    }
    this.setStage(from || "idle", `Resumed from ${from || "idle"} · GPU ${route.backend}`);
    this.emit("sse", {
      type: "log",
      message:
        `▶ Pipeline resumed · GPU ${route.backend}` +
        (route.clipsComfyUrl && route.clipsComfyUrl !== route.comfyUrl
          ? ` · clips → ${route.clipsComfyUrl}`
          : ` · ${route.comfyUrl}`),
    });
    return {
      ok: true,
      paused: false,
      from,
      backend: route.backend,
      comfyUrl: route.comfyUrl,
      clipsComfyUrl: route.clipsComfyUrl,
    };
  }

  /**
   * Hard stop: kill workers, interrupt Comfy, end pipeline (no auto-resume).
   */
  async stop(reason = "Stopped by user") {
    this._stopped = true;
    this._paused = false;
    if (this._pauseGate) {
      this._pauseGate.resolve();
      this._pauseGate = null;
    }
    if (this._approval) {
      this._approval.resolve({ action: "reject", stage: "stop" });
      this._approval = null;
    }
    await this.interruptComfy();
    this._killActiveChild();
    this.error = reason;
    this.setStage("stopped", reason);
    this.emit("sse", { type: "log", message: `⏹ ${reason}` });
    return { ok: true, stopped: true };
  }

  async _waitIfPaused() {
    if (this._stopped) throw new StopError();
    while (this._paused) {
      this.setStage("paused", `Paused (was: ${this._pausedFromStage || this.stage})`);
      if (!this._pauseGate) {
        let resolve;
        const promise = new Promise((r) => {
          resolve = r;
        });
        this._pauseGate = { promise, resolve };
      }
      await this._pauseGate.promise;
      if (this._stopped) throw new StopError();
    }
  }

  async _runStageWork(label, fn) {
    for (;;) {
      if (this._stopped) throw new StopError();
      await this._waitIfPaused();
      try {
        return await fn();
      } catch (err) {
        if (err instanceof StopError || this._stopped) throw new StopError();
        if (err instanceof PauseError || this._paused) {
          await this._waitIfPaused();
          continue;
        }
        throw err;
      }
    }
  }

  approve(stage, payload = {}) {
    if (this._paused) return { ok: false, error: "Paused — resume first" };
    if (this._stopped) return { ok: false, error: "Stopped" };
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
    if (this._paused) return { ok: false, error: "Paused — resume first" };
    if (this._stopped) return { ok: false, error: "Stopped" };
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
    this._stopped = false;
    try {
      await this._run();
    } catch (err) {
      if (err instanceof StopError || this._stopped) {
        this.setStage("stopped", this.statusMessage || "Stopped");
      } else {
        this.error = err.message || String(err);
        this.setStage("error", this.error);
        this.emit("error", err);
      }
    } finally {
      this._running = false;
      this._child = null;
    }
  }

  setStage(stage, message) {
    this.stage = stage;
    if (message) this.statusMessage = message;
    void this.rememberActiveProject();
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
    await this._waitIfPaused();
    this.setStage(`await_${stage}`, `Waiting for approval: ${stage}`);
    if (this.autoApprove && !this._paused) {
      this.emit("sse", { type: "auto_approve", stage });
      return { action: "approve", payload: {} };
    }
    return new Promise((resolve) => {
      this._approval = { resolve };
    });
  }

  async _runNode(scriptRel, args, opts = {}) {
    for (;;) {
      await this._waitIfPaused();
      if (this._stopped) throw new StopError();
      try {
        return await this._spawnNode(scriptRel, args, opts);
      } catch (err) {
        if (err instanceof StopError || this._stopped) throw new StopError();
        if (err instanceof PauseError || this._paused) {
          this.emit("sse", {
            type: "log",
            message: `⏸ Paused during ${scriptRel} — will retry this stage on resume`,
          });
          await this._waitIfPaused();
          continue;
        }
        throw err;
      }
    }
  }

  async _spawnNode(scriptRel, args, opts = {}) {
    if (this._stopped) throw new StopError();

    // Re-resolve GPU route on every spawn so Pause → change GPU → Resume picks up split/salad/local.
    let comfyUrl = opts.comfyUrl || null;
    let backend = opts.backend || null;
    const stage = opts.stage || null;
    if (stage) {
      comfyUrl = resolveComfyUrlForStage(stage);
      backend = isSaladUrl(comfyUrl) ? "salad" : "local";
    }

    const url = (comfyUrl || this.comfyUrl || "").replace(/\/$/, "");
    if (stage === "clips" || stage === "wan") {
      this.comfyUrl = resolveComfyUrlForStage("prep");
      this.emit("sse", {
        type: "log",
        message:
          getGpuBackend() === "split"
            ? `Split route: Wan clips → ${url}`
            : `Clips GPU → ${url} [${backend}]`,
      });
      if (isSaladUrl(url)) {
        await ensureComfyRunning(url);
        this.emit("sse", {
          type: "log",
          message: "Salad: reset Comfy queue/VRAM before Wan…",
        });
        await resetComfyExecution(url, { label: "pre-Wan" });
      }
    }

    const script = join(ROOT, scriptRel);
    const withComfy =
      args.includes("--comfy") || !url ? args : ["--comfy", url, ...args];
    const childBackend =
      backend ||
      (isSaladUrl(url) ? "salad" : getGpuBackend() === "split" ? "local" : getGpuBackend());
    console.log(`\n▶ node ${scriptRel} ${withComfy.join(" ")}`);
    this.emit("sse", {
      type: "log",
      message: `▶ ${scriptRel} [${childBackend}] ${withComfy.join(" ")}`,
    });
    return new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [script, ...withComfy], {
        cwd: ROOT,
        stdio: "inherit",
        env: {
          ...process.env,
          GPU_BACKEND: childBackend === "salad" ? "salad" : "local",
        },
        windowsHide: true,
      });
      this._child = child;
      let poll = null;
      let lastPreviewMtime = 0;
      let lastClipCount = -1;
      if (opts.watchPreview) {
        poll = setInterval(async () => {
          try {
            if (!this.songDir) return;
            const previewPath = join(this.songDir, "preview.mp4");
            const clipsDir = join(this.songDir, "clips");
            let clipCount = 0;
            if (existsSync(clipsDir)) {
              clipCount = (await readdir(clipsDir)).filter((f) =>
                /\.mp4$/i.test(f),
              ).length;
            }
            let previewMtime = 0;
            if (existsSync(previewPath)) {
              const { stat } = await import("fs/promises");
              previewMtime = Number((await stat(previewPath)).mtimeMs) || 0;
            }
            const changed =
              previewMtime > lastPreviewMtime || clipCount !== lastClipCount;
            if (!changed) return;
            lastPreviewMtime = Math.max(lastPreviewMtime, previewMtime);
            lastClipCount = clipCount;
            await this.refreshTabsFromDisk();
            this.setStage(
              this.stage?.startsWith("await_") ? this.stage : "clips",
              `Animating… ${clipCount} clip(s)` +
                (previewMtime ? " · preview updated" : ""),
            );
            this.emit("sse", {
              type: "tabs",
              tabs: this.tabs,
            });
          } catch {
            /* ignore poll errors */
          }
        }, 2000);
      }
      const clear = () => {
        if (poll) clearInterval(poll);
        poll = null;
        if (this._child === child) this._child = null;
      };
      child.on("error", (err) => {
        clear();
        reject(err);
      });
      child.on("exit", (code, signal) => {
        clear();
        if (this._stopped) {
          reject(new StopError());
          return;
        }
        if (this._paused) {
          reject(new PauseError());
          return;
        }
        if (code === 0) resolvePromise({ code, signal });
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
      const usedLocs = [
        ...new Set((plan.beats || []).map((b) => b.location).filter(Boolean)),
      ];
      tabs.scripts = {
        beats: (plan.beats || []).map((b, i) => ({
          index: i + 1,
          id: b.id,
          section: b.section || "",
          location: b.location || "",
          storyBeat: b.storyBeat || "",
          lyricHint: b.lyricHint || "",
          cause: b.cause || "",
          effect: b.effect || "",
          interaction: b.interaction || "",
          cutMotivation: b.cutMotivation || "",
          actionPhase: b.actionPhase || "",
          camera: b.camera || "",
          depth: b.depth || "",
          startSec: b.startSec,
          endSec: b.endSec,
          proximity: b.proximity || "",
          characters: (b.characters || []).map((c) => ({
            name: c.name || "",
            pose: c.pose || "stand",
            expression: c.expression || "happy",
            facing: c.facing || "front",
          })),
          keyframeStem: `${String(i + 1).padStart(2, "0")}_${b.id}`,
        })),
        locations: usedLocs,
      };
      tabs.scenes = {
        locations: await Promise.all(
          usedLocs.map(async (loc) => {
            const local = join(dir, "scenes", `${loc}.png`);
            const shared = join(ROOT, "scenes", `${loc}.png`);
            const exists = existsSync(local) || existsSync(shared);
            const beats = (plan.beats || [])
              .filter((b) => b.location === loc)
              .map((b) => b.id);
            return {
              id: loc,
              url: exists
                ? `/media/scenes/${encodeURIComponent(loc)}.png`
                : null,
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
        images: await Promise.all(
          files.map(async (f) => {
            const stem = f.replace(/\.[^.]+$/, "");
            const m = /^(\d+)_(.+)$/.exec(stem);
            let mtime = Date.now();
            try {
              mtime = Number((await stat(join(kfDir, f))).mtimeMs) || mtime;
            } catch {
              /* keep fallback */
            }
            return {
              name: f,
              stem,
              index: m ? Number(m[1]) : null,
              beatId: m ? m[2] : stem,
              url: `/media/keyframes/${encodeURIComponent(f)}`,
              mtime,
            };
          }),
        ),
      };
    }

    const clipsDir = join(dir, "clips");
    if (existsSync(clipsDir)) {
      const files = (await readdir(clipsDir))
        .filter((f) => /\.mp4$/i.test(f) && f.toLowerCase() !== "final.mp4")
        .sort();
      tabs.clips = {
        videos: await Promise.all(
          files.map(async (f) => {
            const stem = f.replace(/\.[^.]+$/, "");
            let mtime = Date.now();
            try {
              mtime = Number((await stat(join(clipsDir, f))).mtimeMs) || mtime;
            } catch {
              /* keep fallback */
            }
            return {
              name: f,
              stem,
              url: `/media/clips/${encodeURIComponent(f)}`,
              mtime,
            };
          }),
        ),
      };
    }

    const previewPath = join(dir, "preview.mp4");
    if (existsSync(previewPath)) {
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

  async persistSession() {
    if (!this.songDir) return;
    const path = join(this.songDir, "mvid-session.json");
    await writeFile(
      path,
      JSON.stringify(
        {
          ...this.setup,
          comfyUrl: this.comfyUrl,
          outputResolution: this.outputResolution,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );
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

  /**
   * Merge UI script edits into scenes/actions.json (by beat id).
   * @param {Array<object>} edits
   */
  async applyScriptsBeats(edits) {
    if (!this.songDir) return { ok: false, error: "No song open" };
    if (!Array.isArray(edits) || !edits.length) {
      return { ok: false, error: "No beat edits" };
    }
    const actionsPath = join(this.songDir, "scenes", "actions.json");
    if (!existsSync(actionsPath)) {
      return { ok: false, error: "actions.json missing — approve plan first" };
    }
    const plan = JSON.parse(stripBom(await readFile(actionsPath, "utf8")));
    const byId = new Map(edits.map((e) => [String(e.id), e]));
    plan.beats = (plan.beats || []).map((b) => {
      const e = byId.get(String(b.id));
      if (!e) return b;
      const next = { ...b };
      for (const key of [
        "lyricHint",
        "cause",
        "effect",
        "interaction",
        "cutMotivation",
        "actionPhase",
        "storyBeat",
        "location",
        "camera",
        "depth",
        "section",
        "proximity",
      ]) {
        if (e[key] != null) next[key] = e[key];
      }
      if (Array.isArray(e.characters) && e.characters.length) {
        next.characters = e.characters.map((c, i) => ({
          ...(b.characters?.[i] || {}),
          name: c.name || b.characters?.[i]?.name || "Adam",
          pose: c.pose || "stand",
          expression: c.expression || "happy",
          facing: c.facing || "front",
        }));
      }
      return next;
    });
    await writeFile(actionsPath, JSON.stringify(plan, null, 2), "utf8");
    // Keep storyline raw textarea in sync
    if (this.tabs?.storyline) {
      this.tabs.storyline.raw = JSON.stringify(plan, null, 2);
    }
    await this.refreshTabsFromDisk();
    this.emit("sse", {
      type: "log",
      message: `Saved script edits for ${edits.length} beat(s)`,
    });
    this.emit("state", this.getState());
    return { ok: true, beats: plan.beats.length };
  }

  /**
   * Remake one (or more) keyframe stills from current actions.json.
   * Optionally re-animate matching Wan clips.
   */
  async remakeKeyframe({
    beatId = null,
    only = null,
    animate = false,
    reuseCutouts = true,
    saveBeats = null,
  } = {}) {
    if (!this.songDir || !this.songRel) {
      return { ok: false, error: "No song open" };
    }
    if (this._child) {
      return { ok: false, error: "Pipeline busy — wait for current job to finish" };
    }
    if (saveBeats?.length) {
      const saved = await this.applyScriptsBeats(saveBeats);
      if (!saved.ok) return saved;
    }
    const onlyList = []
      .concat(only || [])
      .concat(beatId ? [beatId] : [])
      .map((s) => String(s).trim())
      .filter(Boolean);
    if (!onlyList.length) {
      return { ok: false, error: "beatId / only required" };
    }

    const kidsFlags = [
      ...(this.kidsHit ? ["--kids-hit"] : []),
      ...this.resolutionFlags(),
    ];
    const label = onlyList.join(",");
    const prevStage = this.stage;
    const prevMsg = this.statusMessage;
    this.setStage(
      this.stage?.startsWith("await_") ? this.stage : "keyframes",
      `Remaking keyframe(s): ${label}…`,
    );
    this.emit("sse", {
      type: "log",
      message: `Remake keyframe(s) ${label}${reuseCutouts ? " (reuse cutouts)" : ""}`,
    });

    const args = [
      "--song",
      this.songRel,
      "--keyframes-only",
      "--force",
      "--only",
      label,
      ...kidsFlags,
    ];
    if (reuseCutouts) args.push("--reuse-cutouts");
    try {
      await this._runNode(
        "scripts/02_0_generate-lyrics+song+scene+keyframes.js",
        args,
      );
      await this.refreshTabsFromDisk();

      if (animate) {
        const animArgs = [
          "--song",
          this.songRel,
          "--force",
          "--only",
          label,
          ...kidsFlags,
        ];
        this.emit("sse", {
          type: "log",
          message: `Remake Wan clip(s) ${label}`,
        });
        await this._runNode("scripts/02_1_animate-keyframes.js", animArgs, {
          watchPreview: true,
          stage: "clips",
        });
        this.comfyUrl = resolveComfyUrlForStage("prep");
        await this.refreshTabsFromDisk();
      }

      const remade = onlyList.map((id) => {
        const img = (this.tabs?.keyframes?.images || []).find(
          (x) =>
            x.beatId === id ||
            x.stem === id ||
            x.stem?.endsWith(`_${id}`) ||
            x.name?.includes(id),
        );
        const clip = (this.tabs?.clips?.videos || []).find(
          (x) =>
            x.stem === img?.stem ||
            x.name?.includes(id) ||
            x.stem?.endsWith(`_${id}`),
        );
        return {
          beatId: id,
          stem: img?.stem || null,
          keyframe: img?.name || null,
          keyframeMtime: img?.mtime || null,
          clip: clip?.name || null,
          clipMtime: clip?.mtime || null,
        };
      });
      const at = Date.now();
      this.emit("state", this.getState());
      this.emit("sse", {
        type: "log",
        message: `Remake done: ${label}${animate ? " (+clip)" : ""} · still updated`,
      });
      this.emit("sse", {
        type: "remake_done",
        only: onlyList,
        animate: !!animate,
        remade,
        at,
      });
      if (this.viewOnly || prevStage === "idle" || prevStage === "done") {
        this.setStage(
          "idle",
          `Remade ${label}${animate ? " + clip" : ""} — check Keyframes tab`,
        );
      } else if (prevStage?.startsWith("await_")) {
        this.setStage(prevStage, prevMsg || `Waiting for approval`);
      }
      return { ok: true, only: onlyList, animate: !!animate, remade, at };
    } catch (err) {
      if (this.viewOnly || prevStage === "idle" || prevStage === "done") {
        this.setStage("idle", prevMsg || `Remake failed — fix and retry, or Continue`);
      } else if (prevStage?.startsWith("await_")) {
        this.setStage(prevStage, prevMsg || `Waiting for approval`);
      }
      throw err;
    }
  }

  /**
   * Delete one or more Wan clip mp4s (by filename, stem, or beat id).
   * Rebuilds progressive preview from remaining clips when possible.
   */
  async deleteClips({ names = null, stems = null, beatId = null } = {}) {
    if (!this.songDir || !this.songRel) {
      return { ok: false, error: "No song open" };
    }
    if (this._child) {
      return { ok: false, error: "Pipeline busy — wait for current job to finish" };
    }
    const clipsDir = join(this.songDir, "clips");
    if (!existsSync(clipsDir)) {
      return { ok: false, error: "No clips folder" };
    }
    const wanted = new Set(
      []
        .concat(names || [])
        .concat(stems || [])
        .concat(beatId ? [beatId] : [])
        .map((s) => String(s || "").trim())
        .filter(Boolean)
        .map((s) => s.replace(/\.mp4$/i, "")),
    );
    if (!wanted.size) {
      return { ok: false, error: "names / stems / beatId required" };
    }

    const files = (await readdir(clipsDir)).filter(
      (f) => /\.mp4$/i.test(f) && f.toLowerCase() !== "final.mp4",
    );
    const deleted = [];
    for (const f of files) {
      const stem = f.replace(/\.mp4$/i, "");
      const beatFromStem = /^(\d+)_(.+)$/.exec(stem)?.[2] || stem;
      const hit = [...wanted].some(
        (w) =>
          f === w ||
          f === `${w}.mp4` ||
          stem === w ||
          beatFromStem === w ||
          stem.endsWith(`_${w}`),
      );
      if (!hit) continue;
      await unlink(join(clipsDir, f));
      deleted.push(f);
    }
    if (!deleted.length) {
      return { ok: false, error: `No matching clips for: ${[...wanted].join(", ")}` };
    }

    // Drop stale progressive preview; rebuild if any clips remain
    const previewPath = join(this.songDir, "preview.mp4");
    if (existsSync(previewPath)) {
      try {
        await unlink(previewPath);
      } catch {
        /* ignore */
      }
    }
    let preview = null;
    try {
      preview = await writePreviewMp4(this.songDir);
    } catch (err) {
      this.emit("sse", {
        type: "log",
        message: `Preview rebuild skipped: ${err?.message || err}`,
      });
    }

    await this.refreshTabsFromDisk();
    this.emit("sse", {
      type: "log",
      message: `Deleted clip(s): ${deleted.join(", ")}`,
    });
    this.emit("sse", {
      type: "clips_deleted",
      deleted,
      preview: preview?.path || null,
    });
    return {
      ok: true,
      deleted,
      remaining: this.tabs?.clips?.videos?.length || 0,
      preview: !!this.tabs?.preview?.url,
    };
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
    this.comfyUrl = resolveComfyUrlForStage("prep");
    this.setStage(
      "idle",
      `Ensuring ComfyUI (${this.comfyUrl}) [${getGpuBackend()}]…`,
    );
    await ensureComfyRunning(this.comfyUrl);

    const kidsFlags = [
      ...(this.kidsHit ? ["--kids-hit"] : []),
      ...this.resolutionFlags(),
    ];
    const pass = [...this.extraArgs];

    // Existing song: jump to first missing stage or keyframes→clips→final
    if (this.songArg) {
      this.songDir = this.songPath(this.songArg);
      if (!existsSync(this.songDir)) throw new Error(`Song folder not found: ${this.songDir}`);
      this.songRel = this.toRel(this.songDir);
      await this.rememberActiveProject();
      await this.refreshTabsFromDisk();
      await this._continueFromExisting(kidsFlags);
      return;
    }

    // ── Setup (cast + scenes + optional title/objective) ──
    {
      this.tabs.setup = { ...this.setup };
      this.emit("state", this.getState());
      const decision = await this.waitForApproval("setup");
      if (decision.action === "reject") {
        // stay on setup with same defaults
      }
      if (decision.payload && Object.keys(decision.payload).length) {
        const applied = this.applySetup(decision.payload);
        if (!applied.ok) throw new Error(applied.error);
      }
      if (!this.setup.castIds?.length) {
        throw new Error("Setup requires at least one cast member");
      }
      this.setStage("setup", `Cast: ${this.setup.castIds.join(", ")}`);
    }

    // ── Lyrics ──
    for (;;) {
      this.setStage("lyrics", "Generating lyrics…");
      const args = [...kidsFlags, ...this.setupFlags()];
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
        // avoid duplicate theme/cast flags from CLI when setup owns them
        if (
          pass[i] === "--theme" ||
          pass[i] === "--cast" ||
          pass[i] === "--locations" ||
          pass[i] === "--title" ||
          pass[i] === "--objective"
        ) {
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
      await this.rememberActiveProject();
      await this.persistSession();
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
      // Stills already on disk — don't re-gate; go make/finish clips.
      await this.refreshTabsFromDisk();
      this.emit("sse", {
        type: "log",
        message: hasClips
          ? "Keyframes present — continuing to stitch/final…"
          : "Keyframes present — continuing to Wan clips…",
      });
    }

    if (!hasClips || !hasFinal) {
      await this._animateAndStitch(kidsFlags);
    } else {
      await this.refreshTabsFromDisk();
      this.setStage("done", "Complete — final.mp4 ready");
    }
  }

  async _animateAndStitch(kidsFlags) {
    // Continue/resume must NOT --force: reuse clips already on disk (e.g. local clip #1).
    // Only pass --force after the user rejects the clips gate (full remake).
    let forceClips = false;
    for (;;) {
      this.setStage(
        "clips",
        `Animating keyframes (Wan) on ${getGpuBackend()}…`,
      );
      // kidsFlags already includes --kids-hit / --output-resolution when set
      // stage:"clips" re-resolves Salad/local URL on every spawn (incl. after Pause→GPU change→Resume)
      const animArgs = ["--song", this.songRel, ...kidsFlags];
      if (forceClips) animArgs.splice(2, 0, "--force");
      await this._runNode("scripts/02_1_animate-keyframes.js", animArgs, {
        watchPreview: true,
        stage: "clips",
      });
      // Rest of pipeline (stitch) prefers local Comfy URL in state
      this.comfyUrl = resolveComfyUrlForStage("prep");
      await this.refreshTabsFromDisk();
      const decision = await this.waitForApproval("clips");
      if (decision.action === "reject") {
        forceClips = true;
        continue;
      }
      break;
    }

    for (;;) {
      this.setStage("final", "Stitching final.mp4…");
      const stitchArgs = ["--song", this.songRel, "--force"];
      if (this.kidsHit) stitchArgs.push("--loop-fill");
      await this._runNode("scripts/02_2_stitch-song.js", stitchArgs, {
        stage: "prep",
        backend: "local",
      });
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
    setup: null,
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
