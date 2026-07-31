/**
 * Interactive mvid: Express + EJS multi-tab review GUI.
 *
 *   npm run mvid
 *   npm run mvid -- --count 1
 *   npm run mvid -- --theme "rainy day indoor march"
 *   npm run mvid -- --song batches/<date>/<slug>
 *   npm run mvid -- --classic
 *   npm run mvid -- --auto-approve          # skip gates (watch-only)
 *   npm run mvid -- --port 3847
 *
 * Opens http://127.0.0.1:3847/ — Approve each stage, or enable Auto-approve all.
 */
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "../lib/comfy-client.js";
import { DEFAULT_COMFY_URL } from "../lib/ensure-comfy.js";
import { MvidOrchestrator } from "../lib/mvid-orchestrator.js";
import { createMvidServer } from "../lib/mvid-server.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const { flag, has } = parseArgs(argv);

const OWN = new Set([
  "--classic",
  "--song",
  "--comfy",
  "--port",
  "--auto-approve",
  "--help",
  "-h",
]);

function printHelp() {
  console.log(`mvid — interactive music video studio (Express + EJS)

  npm run mvid
  npm run mvid -- --count 1
  npm run mvid -- --theme "rainy day indoor march"
  npm run mvid -- --song batches/<date>/<slug>
  npm run mvid -- --classic
  npm run mvid -- --auto-approve
  npm run mvid -- --port 3847

Opens a browser UI with tabs for lyrics, song, storyline, scenes, scripts,
keyframes, clips, and final. Approve each stage (or enable Auto-approve all).

Kids-hit is the default. Pass --classic for the longer path.`);
}

function passthroughArgs() {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (OWN.has(a)) {
      if (a === "--song" || a === "--comfy" || a === "--port") i += 1;
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

  const kidsHit = !has("--classic");
  const comfyUrl = flag("--comfy", DEFAULT_COMFY_URL);
  const port = Number(flag("--port", "3847"));
  const songArg = flag("--song", null);
  const autoApprove = has("--auto-approve");

  console.log("════════════════════════════════════════════════════════");
  console.log(
    kidsHit
      ? "mvid — interactive kids-hit music video"
      : "mvid — interactive classic music video",
  );
  console.log("════════════════════════════════════════════════════════");

  const orchestrator = new MvidOrchestrator({
    kidsHit,
    comfyUrl,
    songArg,
    autoApprove,
    extraArgs: passthroughArgs(),
  });

  const { listen } = createMvidServer(orchestrator, { port });
  const { url } = await listen();

  // Run pipeline in background so the server stays up for approvals
  orchestrator.start().catch((err) => {
    console.error("\nPipeline failed:", err.message || err);
  });

  console.log(`GUI listening at ${url} (Ctrl+C to stop)`);
  console.log(`Project root: ${ROOT}`);
}

main().catch((err) => {
  console.error("\nFailed:", err.message || err);
  process.exit(1);
});
