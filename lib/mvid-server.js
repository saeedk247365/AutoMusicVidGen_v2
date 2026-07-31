/**
 * Express + EJS shell for interactive mvid review.
 */
import express from "express";
import { join, dirname, resolve, relative } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { readdir, readFile, writeFile, mkdir } from "fs/promises";
import { openFile } from "./comfy-client.js";
import {
  gpuStatus,
  setGpuBackend,
  resolveComfyUrl,
} from "./gpu-backend.js";
import { isComfyUp } from "./ensure-comfy.js";
import {
  saladContainerStatus,
  startContainerGroup,
  stopContainerGroup,
  listContainerGroups,
  saladMgmtConfigured,
} from "./salad-containers.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHARACTERS_DIR = join(ROOT, "characters");
const SCENES_DIR = join(ROOT, "scenes");

function slugId(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

export function createMvidServer(orchestrator, { port = 3847 } = {}) {
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", join(ROOT, "views"));
  app.use(express.json({ limit: "4mb" }));
  app.use("/static", express.static(join(ROOT, "public")));

  const sseClients = new Set();

  function broadcast(event) {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(data);
      } catch {
        sseClients.delete(res);
      }
    }
  }

  orchestrator.on("sse", broadcast);
  orchestrator.on("state", (state) =>
    broadcast({ type: "state", ...state, gpu: gpuStatus() }),
  );

  app.get("/", (_req, res) => {
    res.render("mvid", {
      initial: { ...orchestrator.getState(), gpu: gpuStatus() },
    });
  });

  app.get("/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write(
      `data: ${JSON.stringify({
        type: "state",
        ...orchestrator.getState(),
        gpu: gpuStatus(),
      })}\n\n`,
    );
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
  });

  app.get("/api/state", (_req, res) => {
    res.json({ ...orchestrator.getState(), gpu: gpuStatus() });
  });

  app.get("/api/gpu", async (_req, res) => {
    const status = gpuStatus();
    const up = await isComfyUp(status.comfyUrl);
    res.json({ ...status, comfyUp: up });
  });

  app.post("/api/gpu", async (req, res) => {
    const backend = req.body?.backend;
    const result = setGpuBackend(backend);
    if (result.ok) {
      orchestrator.setComfyUrl?.(result.comfyUrl);
      broadcast({ type: "gpu", ...gpuStatus() });
    }
    const up = result.ok ? await isComfyUp(result.comfyUrl) : false;
    res.status(result.ok ? 200 : 400).json({ ...result, comfyUp: up });
  });

  app.get("/api/characters", async (_req, res) => {
    try {
      const files = (await readdir(CHARACTERS_DIR)).filter((f) =>
        f.endsWith(".json"),
      );
      const list = [];
      for (const f of files) {
        try {
          const raw = JSON.parse(await readFile(join(CHARACTERS_DIR, f), "utf8"));
          list.push({
            id: raw.id || f.replace(/\.json$/i, ""),
            name: raw.name || raw.id,
            role: raw.role || "",
            appearance: raw.appearance || "",
            outfit: raw.outfit || "",
            hasLora: !!raw.loraName,
          });
        } catch {
          /* skip */
        }
      }
      res.json({ ok: true, characters: list });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post("/api/characters", async (req, res) => {
    try {
      const body = req.body || {};
      const id = slugId(body.id || body.name);
      if (!id) return res.status(400).json({ ok: false, error: "id/name required" });
      const path = join(CHARACTERS_DIR, `${id}.json`);
      if (existsSync(path) && !body.overwrite) {
        return res.status(409).json({ ok: false, error: `Character ${id} exists` });
      }
      const doc = {
        id,
        name: body.name || id,
        role: body.role || "toddler",
        trigger: body.trigger || id,
        age: body.age || "",
        comfyUrl: resolveComfyUrl(),
        checkpoint: body.checkpoint || "realcartoon3d_v15.safetensors",
        loraName: body.loraName || null,
        loraStrength: body.loraStrength ?? 0.9,
        seed: body.seed ?? (Date.now() % 1e9),
        width: 512,
        height: 768,
        steps: 28,
        cfg: 7,
        sampler: "dpmpp_2m",
        scheduler: "karras",
        styleTag: body.styleTag || "flat 2D anime cartoon preschool",
        appearance: body.appearance || "",
        outfit: body.outfit || "",
        negative:
          body.negative ||
          "photo, photorealistic, text, watermark, extra limbs, twin",
        keyframes: body.keyframes || [
          {
            id: "front_stand",
            angle: "front view, body facing camera",
            pose: "standing relaxed, arms at sides",
          },
        ],
      };
      await mkdir(CHARACTERS_DIR, { recursive: true });
      await writeFile(path, JSON.stringify(doc, null, 2));
      res.json({ ok: true, character: doc });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.get("/api/scenes", async (_req, res) => {
    try {
      const pack = JSON.parse(
        await readFile(join(SCENES_DIR, "scenes.json"), "utf8"),
      );
      const scenes = (pack.scenes || []).map((s) => ({
        id: s.id,
        name: s.name || s.id,
        still: s.still || "",
        thumbUrl: existsSync(join(SCENES_DIR, `${s.id}.png`))
          ? `/media/scenes/${s.id}.png`
          : null,
      }));
      res.json({ ok: true, style: pack.style, scenes });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post("/api/setup", (req, res) => {
    const result = orchestrator.applySetup?.(req.body || {});
    if (!result?.ok) {
      return res
        .status(400)
        .json(result || { ok: false, error: "Setup not supported" });
    }
    if (orchestrator.stage === "await_setup") {
      orchestrator.approve("setup", req.body || {});
    }
    res.json({ ok: true, setup: orchestrator.setup, ...orchestrator.getState() });
  });

  app.post("/api/approve", (req, res) => {
    const stage = req.body?.stage;
    const payload = req.body?.payload || {};
    const result = orchestrator.approve(stage, payload);
    res.status(result.ok ? 200 : 400).json(result);
  });

  app.post("/api/reject", (req, res) => {
    const stage = req.body?.stage;
    const result = orchestrator.reject(stage);
    res.status(result.ok ? 200 : 400).json(result);
  });

  app.post("/api/auto-approve", (req, res) => {
    orchestrator.setAutoApprove(!!req.body?.enabled);
    res.json({ ok: true, autoApprove: orchestrator.autoApprove });
  });

  app.post("/api/pause", async (_req, res) => {
    const result = await orchestrator.pause();
    res.status(result.ok ? 200 : 400).json(result);
  });

  app.post("/api/resume", (_req, res) => {
    const result = orchestrator.resume();
    res.status(result.ok ? 200 : 400).json(result);
  });

  app.post("/api/stop", async (req, res) => {
    const result = await orchestrator.stop(
      req.body?.reason || "Stopped by user",
    );
    res.json(result);
  });

  app.get("/api/salad/status", async (_req, res) => {
    try {
      const status = await saladContainerStatus();
      res.json(status);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.get("/api/salad/containers", async (_req, res) => {
    try {
      if (!saladMgmtConfigured()) {
        return res.status(400).json({
          ok: false,
          error: "Set SALAD_ORG in .env to list containers",
        });
      }
      const data = await listContainerGroups();
      res.json({ ok: true, data });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post("/api/salad/start", async (req, res) => {
    try {
      const name = req.body?.name;
      const result = await startContainerGroup(name || undefined);
      const status = await saladContainerStatus();
      res.json({ ok: true, started: result, status });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post("/api/salad/stop", async (req, res) => {
    try {
      const name = req.body?.name;
      const result = await stopContainerGroup(name || undefined);
      const status = await saladContainerStatus();
      res.json({ ok: true, stopped: result, status });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message || String(err) });
    }
  });

  function safeSongFile(...parts) {
    const songDir = orchestrator.songDir;
    if (!songDir) return null;
    const full = resolve(songDir, ...parts);
    const rel = relative(songDir, full);
    if (!rel || rel.startsWith("..") || rel.split(/[/\\]/).includes("..")) return null;
    if (!existsSync(full)) return null;
    return full;
  }

  app.get("/media/song/:name", (req, res) => {
    const file = safeSongFile(req.params.name);
    if (!file) return res.status(404).end();
    res.sendFile(file);
  });

  app.get("/media/keyframes/:name", (req, res) => {
    const file = safeSongFile("keyframes", req.params.name);
    if (!file) return res.status(404).end();
    res.sendFile(file);
  });

  app.get("/media/clips/:name", (req, res) => {
    const file = safeSongFile("clips", req.params.name);
    if (!file) return res.status(404).end();
    res.sendFile(file);
  });

  app.get("/media/preview.mp4", (_req, res) => {
    const file = safeSongFile("preview.mp4");
    if (!file) return res.status(404).end();
    res.sendFile(file);
  });

  app.get("/media/final.mp4", (_req, res) => {
    const file = safeSongFile("final.mp4");
    if (!file) return res.status(404).end();
    res.sendFile(file);
  });

  app.get("/media/scenes/:name", (req, res) => {
    const name = req.params.name;
    let file = safeSongFile("scenes", name);
    if (!file) {
      const shared = join(ROOT, "scenes", name);
      if (existsSync(shared)) file = shared;
    }
    if (!file) return res.status(404).end();
    res.sendFile(file);
  });

  function listen() {
    return new Promise((resolveListen) => {
      const server = app.listen(port, "127.0.0.1", () => {
        const url = `http://127.0.0.1:${port}/`;
        console.log(`mvid GUI → ${url}`);
        try {
          openFile(url);
        } catch (err) {
          console.warn(`Could not open browser: ${err.message || err}`);
        }
        resolveListen({ server, url });
      });
    });
  }

  return { app, listen, broadcast };
}
