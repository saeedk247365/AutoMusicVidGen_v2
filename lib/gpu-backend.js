/**
 * Local vs Salad Cloud GPU backend resolution for ComfyUI calls.
 */
import "./load-env.js";

export const LOCAL_COMFY_URL = "http://127.0.0.1:8188";

const STATE = {
  backend: null, // "local" | "salad"
};

export function saladApiKey() {
  return (process.env.SALAD_API_KEY || "").trim();
}

export function saladComfyUrl() {
  return (process.env.SALAD_COMFY_URL || "").trim().replace(/\/$/, "");
}

export function getGpuBackend() {
  if (STATE.backend) return STATE.backend;
  const fromEnv = String(process.env.GPU_BACKEND || "local").toLowerCase();
  STATE.backend = fromEnv === "salad" ? "salad" : "local";
  return STATE.backend;
}

/**
 * Switch backend at runtime (mvid UI). Persists for process lifetime only.
 */
export function setGpuBackend(backend) {
  const b = String(backend || "").toLowerCase() === "salad" ? "salad" : "local";
  if (b === "salad") {
    if (!saladComfyUrl()) {
      return {
        ok: false,
        backend: getGpuBackend(),
        comfyUrl: resolveComfyUrl(),
        ready: false,
        error:
          "SALAD_COMFY_URL is empty. Paste your Salad Container Gateway URL into .env (portal → container group → Gateway).",
      };
    }
    if (!saladApiKey()) {
      return {
        ok: false,
        backend: getGpuBackend(),
        comfyUrl: resolveComfyUrl(),
        ready: false,
        error: "SALAD_API_KEY is missing in .env",
      };
    }
  }
  STATE.backend = b;
  process.env.GPU_BACKEND = b;
  return {
    ok: true,
    backend: b,
    comfyUrl: resolveComfyUrl(),
    ready: b === "local" || (!!saladComfyUrl() && !!saladApiKey()),
  };
}

export function resolveComfyUrl(override = null) {
  if (override) return String(override).replace(/\/$/, "");
  if (getGpuBackend() === "salad") {
    const url = saladComfyUrl();
    if (url) return url;
  }
  return LOCAL_COMFY_URL;
}

export function isSaladUrl(url) {
  const u = String(url || "").toLowerCase();
  return u.includes(".salad.cloud") || getGpuBackend() === "salad";
}

/** Headers for Comfy / Salad gateway requests. */
export function comfyAuthHeaders(url, extra = {}) {
  const headers = { ...extra };
  if (isSaladUrl(url)) {
    const key = saladApiKey();
    if (key) headers["Salad-Api-Key"] = key;
  }
  return headers;
}

export function gpuStatus() {
  const backend = getGpuBackend();
  const url = resolveComfyUrl();
  const hasKey = !!saladApiKey();
  const hasUrl = !!saladComfyUrl();
  return {
    backend,
    comfyUrl: url,
    saladConfigured: hasKey && hasUrl,
    saladHasKey: hasKey,
    saladHasUrl: hasUrl,
    ready: backend === "local" || (hasKey && hasUrl),
  };
}
