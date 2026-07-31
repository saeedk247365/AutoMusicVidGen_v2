/**
 * Ensure project-local ComfyUI is reachable; start it if needed.
 */
import { spawn } from "child_process";
import { existsSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { platform } from "os";
import { sleep } from "./comfy-client.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const COMFY_DIR = join(ROOT, "ComfyUI");
export const DEFAULT_COMFY_URL = "http://127.0.0.1:8188";

export function comfyPython() {
  return platform() === "win32"
    ? join(COMFY_DIR, "venv", "Scripts", "python.exe")
    : join(COMFY_DIR, "venv", "bin", "python");
}

export async function isComfyUp(url = DEFAULT_COMFY_URL) {
  try {
    const res = await fetch(`${url}/system_stats`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Start ComfyUI in the background (detached). Returns the ChildProcess.
 */
export function startComfyBackground() {
  const py = comfyPython();
  if (!existsSync(join(COMFY_DIR, "main.py"))) {
    throw new Error(`ComfyUI not found at ${COMFY_DIR}`);
  }
  if (!existsSync(py)) {
    throw new Error(`ComfyUI venv python not found at ${py}`);
  }

  const logDir = join(ROOT, "ComfyUI", "user");
  const outLog = join(logDir, "mvid-comfy-stdout.log");
  const errLog = join(logDir, "mvid-comfy-stderr.log");

  // Touch logs so paths exist for spawn stdio if needed
  try {
    writeFileSync(outLog, "", { flag: "a" });
    writeFileSync(errLog, "", { flag: "a" });
  } catch {
    /* ignore */
  }

  console.log(`Starting ComfyUI from ${COMFY_DIR}`);
  const child = spawn(
    py,
    ["main.py", "--listen", "127.0.0.1", "--port", "8188"],
    {
      cwd: COMFY_DIR,
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    },
  );
  child.unref();
  return child;
}

/**
 * If ComfyUI is down, start it and wait until /system_stats responds.
 * @returns {{ started: boolean }}
 */
export async function ensureComfyRunning(
  url = DEFAULT_COMFY_URL,
  { timeoutMs = 180000, pollMs = 2000 } = {},
) {
  if (await isComfyUp(url)) {
    console.log(`ComfyUI already running at ${url}`);
    return { started: false };
  }

  console.log(`ComfyUI not reachable at ${url} — starting…`);
  startComfyBackground();

  const startedAt = Date.now();
  let lastLog = 0;
  while (Date.now() - startedAt < timeoutMs) {
    await sleep(pollMs);
    if (await isComfyUp(url)) {
      console.log(`ComfyUI ready at ${url}`);
      return { started: true };
    }
    const secs = Math.round((Date.now() - startedAt) / 1000);
    if (secs - lastLog >= 10) {
      console.log(`  waiting for ComfyUI… (${secs}s)`);
      lastLog = secs;
    }
  }

  throw new Error(
    `ComfyUI did not become ready at ${url} within ${Math.round(timeoutMs / 1000)}s`,
  );
}
