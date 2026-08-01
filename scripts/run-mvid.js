/**
 * Interactive mvid: Express + EJS multi-tab review GUI.
 *
 *   npm run mvid
 *   npm run mvid -- --count 1
 *   npm run mvid -- --theme "rainy day indoor march"
 *   npm run mvid -- --song batches/<date>/<slug>
 *   npm run mvid -- --new                 # ignore saved project; start fresh
 *   npm run mvid -- --continue            # restore + resume pipeline
 *   npm run mvid -- --classic
 *   npm run mvid -- --auto-approve
 *   npm run mvid -- --port 3847
 *
 * On restart (default): restores the last open project for viewing.
 * Only one project is active at a time (batches/.mvid-active.json).
 */
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "../lib/comfy-client.js";
import { DEFAULT_COMFY_URL } from "../lib/ensure-comfy.js";
import { resolveComfyUrl, setGpuBackend, gpuStatus } from "../lib/gpu-backend.js";
import { MvidOrchestrator } from "../lib/mvid-orchestrator.js";
import { createMvidServer } from "../lib/mvid-server.js";
import { resolveStartupProject } from "../lib/mvid-active.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const { flag, has } = parseArgs(argv);

const OWN = new Set([
  "--classic",
  "--song",
  "--comfy",
  "--port",
  "--auto-approve",
  "--salad",
  "--gpu",
  "--output-resolution",
  "--new",
  "--continue",
  "--resume",
  "--help",
  "-h",
]);

function printHelp() {
  console.log(`mvid — interactive music video studio (Express + EJS)

  npm run mvid
  npm run mvid -- --song batches/<date>/<slug>
  npm run mvid -- --new                 # start a brand-new project
  npm run mvid -- --continue            # restore last project + resume pipeline
  npm run mvid -- --gpu split
  npm run mvid -- --salad
  npm run mvid -- --output-resolution youtube
  npm run mvid -- --port 3847

Default restart restores the last open project (view-only).
Active project is saved to batches/.mvid-active.json.`);
}

function passthroughArgs() {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (OWN.has(a)) {
      if (
        a === "--song" ||
        a === "--comfy" ||
        a === "--port" ||
        a === "--gpu" ||
        a === "--output-resolution"
      ) {
        i += 1;
      }
      continue;
    }
    out.push(a);
  }
  return out;
}

async function main() {
  if (has("--help") || has("-h")) {
    printHelp();
    return;
  }

  if (has("--salad") || flag("--gpu", "") === "salad") {
    const r = setGpuBackend("salad");
    if (!r.ok) {
      console.warn(`Salad GPU not ready: ${r.error}`);
    }
  } else if (flag("--gpu", "")) {
    const r = setGpuBackend(flag("--gpu"));
    if (!r.ok) {
      console.warn(`GPU backend '${flag("--gpu")}' not ready: ${r.error}`);
    }
  }

  const kidsHit = !has("--classic");
  const g = gpuStatus();
  const comfyUrl = flag("--comfy", null) || g.comfyUrl || DEFAULT_COMFY_URL;
  const port = Number(flag("--port", "3847"));
  const songArg = flag("--song", null);
  const autoApprove = has("--auto-approve");
  const outputResolution = flag("--output-resolution", "preview");
  const forceNew = has("--new");
  const forceContinue = has("--continue") || has("--resume");

  console.log("════════════════════════════════════════════════════════");
  console.log(
    kidsHit
      ? "mvid — interactive kids-hit music video"
      : "mvid — interactive classic music video",
  );
  if (g.backend === "split") {
    console.log(`GPU: split · prep ${g.prepComfyUrl} · clips ${g.clipsComfyUrl}`);
  } else {
    console.log(`GPU: ${g.backend} → ${comfyUrl}`);
  }
  console.log(`Output: ${outputResolution}`);
  console.log("════════════════════════════════════════════════════════");

  const orchestrator = new MvidOrchestrator({
    kidsHit,
    comfyUrl,
    songArg: forceNew ? null : songArg,
    autoApprove,
    outputResolution,
    extraArgs: passthroughArgs(),
    viewOnly: !songArg && !forceNew && !forceContinue,
  });

  const { listen } = createMvidServer(orchestrator, { port });
  const { url } = await listen();

  if (forceNew) {
    console.log("Starting new project (--new)");
    orchestrator.start().catch((err) => {
      console.error("\nPipeline failed:", err.message || err);
    });
  } else if (songArg) {
    console.log(`Continuing song: ${songArg}`);
    orchestrator.start().catch((err) => {
      console.error("\nPipeline failed:", err.message || err);
    });
  } else if (forceContinue) {
    const restored = await orchestrator.restoreActiveProject();
    if (!restored.ok) {
      console.warn(`No project to continue: ${restored.error}`);
      orchestrator.start().catch((err) => {
        console.error("\nPipeline failed:", err.message || err);
      });
    } else {
      console.log(`Restored + continuing: ${restored.songDir}`);
      await orchestrator.continuePipeline();
    }
  } else {
    // Default: restore last project for viewing (do not start a blank pipeline)
    const restored = await orchestrator.restoreActiveProject();
    if (restored.ok) {
      console.log(
        restored.inferred
          ? `Opened latest batch: ${restored.songDir}`
          : `Restored active project: ${restored.songDir}`,
      );
    } else {
      console.log("No prior project — starting setup");
      orchestrator.start().catch((err) => {
        console.error("\nPipeline failed:", err.message || err);
      });
    }
  }

  const hint = await resolveStartupProject();
  if (hint?.songRel && !forceNew) {
    console.log(`Active project file: batches/.mvid-active.json`);
  }

  console.log(`GUI listening at ${url} (Ctrl+C to stop)`);
  console.log(`Project root: ${ROOT}`);
}

main().catch((err) => {
  console.error("\nFailed:", err.message || err);
  process.exit(1);
});
