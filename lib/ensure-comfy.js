/**
 * Ensure project-local ComfyUI is reachable; start it if needed.
 */
import { spawn } from "child_process";
import { existsSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { platform } from "os";
import { sleep } from "./comfy-client.js";
import {
  comfyAuthHeaders,
  isSaladUrl,
  LOCAL_COMFY_URL,
  LOCAL_COMFY_PORT,
  getGpuBackend,
} from "./gpu-backend.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const COMFY_DIR = join(ROOT, "ComfyUI");
export const DEFAULT_COMFY_URL = LOCAL_COMFY_URL;

export function comfyPython() {
  return platform() === "win32"
    ? join(COMFY_DIR, "venv", "Scripts", "python.exe")
    : join(COMFY_DIR, "venv", "bin", "python");
}

export async function isComfyUp(url = DEFAULT_COMFY_URL) {
  try {
    const salad = isSaladUrl(url);
    const res = await fetch(`${url}/system_stats`, {
      headers: comfyAuthHeaders(url),
      signal: AbortSignal.timeout(salad ? 15000 : 3000),
    });
    if (res.ok) return true;
    // Salad ComfyUI-API recipes may expose /health instead of /system_stats
    if (salad) {
      const h = await fetch(`${url}/health`, {
        headers: comfyAuthHeaders(url),
        signal: AbortSignal.timeout(15000),
      });
      if (h.ok) return true;
      const r = await fetch(`${url}/ready`, {
        headers: comfyAuthHeaders(url),
        signal: AbortSignal.timeout(15000),
      });
      return r.ok;
    }
    return false;
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
    ["main.py", "--listen", "127.0.0.1", "--port", String(LOCAL_COMFY_PORT)],
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

  // Salad Cloud: never try to spawn local ComfyUI for a remote gateway URL
  if (isSaladUrl(url) || getGpuBackend() === "salad") {
    throw new Error(
      `Salad ComfyUI not reachable at ${url}. Check SALAD_COMFY_URL, Salad-Api-Key auth, and that the container group is running/ready.`,
    );
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
    `ComfyUI did not become ready at ${url} within ${Math.round(timeoutMs / 1000)}s. ` +
      `Check ComfyUI logs — if it crashes on import, the install may be incomplete.`,
  );
}
