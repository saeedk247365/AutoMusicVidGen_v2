/**
 * Start the project-local ComfyUI server in the foreground
 * (leave running while you use the pipeline manually).
 *
 * For the full auto chain, prefer: npm run mvid
 */
import { spawn } from "child_process";
import {
  COMFY_DIR,
  comfyPython,
  isComfyUp,
  DEFAULT_COMFY_URL,
} from "../lib/ensure-comfy.js";
import { LOCAL_COMFY_PORT } from "../lib/gpu-backend.js";
import { existsSync } from "fs";
import { join } from "path";

const py = comfyPython();

if (!existsSync(join(COMFY_DIR, "main.py"))) {
  console.error(`ComfyUI not found at ${COMFY_DIR}`);
  process.exit(1);
}
if (!existsSync(py)) {
  console.error(`ComfyUI venv python not found at ${py}`);
  process.exit(1);
}

if (await isComfyUp(DEFAULT_COMFY_URL)) {
  console.log(`ComfyUI already running at ${DEFAULT_COMFY_URL}`);
  process.exit(0);
}

console.log(`Starting ComfyUI from ${COMFY_DIR}`);
console.log(`→ ${DEFAULT_COMFY_URL}`);

const child = spawn(
  py,
  ["main.py", "--listen", "127.0.0.1", "--port", String(LOCAL_COMFY_PORT)],
  { cwd: COMFY_DIR, stdio: "inherit" },
);

child.on("exit", (code) => process.exit(code ?? 1));
