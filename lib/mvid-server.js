/**
 * Express + EJS shell for interactive mvid review.
 */
import express from "express";
import { join, dirname, resolve, relative } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { openFile } from "./comfy-client.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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
  orchestrator.on("state", (state) => broadcast({ type: "state", ...state }));

  app.get("/", (_req, res) => {
    res.render("mvid", { initial: orchestrator.getState() });
  });

  app.get("/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write(`data: ${JSON.stringify({ type: "state", ...orchestrator.getState() })}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
  });

  app.get("/api/state", (_req, res) => {
    res.json(orchestrator.getState());
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
    return new Promise((resolve) => {
      const server = app.listen(port, "127.0.0.1", () => {
        const url = `http://127.0.0.1:${port}/`;
        console.log(`mvid GUI → ${url}`);
        try {
          openFile(url);
        } catch (err) {
          console.warn(`Could not open browser: ${err.message || err}`);
        }
        resolve({ server, url });
      });
    });
  }

  return { app, listen, broadcast };
}
