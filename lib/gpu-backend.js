/**
 * Local vs Salad Cloud GPU backend resolution for ComfyUI calls.
 *
 * Routes:
 *   local  — all Comfy stages on local
 *   salad  — all Comfy stages on Salad
 *   split  — prep/stills on local; Wan clips on Salad when configured
 *
 * One Comfy listen port everywhere (local PC + Salad container + Salad gateway):
 *   COMFY_PORT === 8888
 */
import "./load-env.js";

/** Shared ComfyUI port — local listen, Salad listen, Salad Container Gateway. */
export const COMFY_PORT = 8888;
export const LOCAL_COMFY_PORT = COMFY_PORT;
export const SALAD_COMFY_PORT = COMFY_PORT;
export const LOCAL_COMFY_URL = `http://127.0.0.1:${COMFY_PORT}`;

const STATE = {
  /** @type {"local"|"salad"|"split"|null} */
  backend: null,
};

export function saladApiKey() {
  return (process.env.SALAD_API_KEY || "").trim();
}

export function saladComfyUrl() {
  return (process.env.SALAD_COMFY_URL || "").trim().replace(/\/$/, "");
}

function normalizeBackend(raw) {
  const b = String(raw || "local").toLowerCase().trim();
  if (b === "salad" || b === "split") return b;
  return "local";
}

export function getGpuBackend() {
  if (STATE.backend) return STATE.backend;
  STATE.backend = normalizeBackend(process.env.GPU_BACKEND);
  return STATE.backend;
}

/** True when Salad credentials exist (needed for salad + split clips). */
export function saladConfigured() {
  return !!(saladComfyUrl() && saladApiKey());
}

/**
 * Switch backend at runtime (mvid UI). Persists for process lifetime only.
 * @param {"local"|"salad"|"split"} backend
 */
export function setGpuBackend(backend) {
  const b = normalizeBackend(backend);
  if (b === "salad" || b === "split") {
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
    clipsComfyUrl: resolveComfyUrlForStage("clips"),
    ready: b === "local" || saladConfigured(),
    split: b === "split",
  };
}

/**
 * Default Comfy URL for the current route (split → local for prep).
 */
export function resolveComfyUrl(override = null) {
  if (override) return String(override).replace(/\/$/, "");
  return resolveComfyUrlForStage("prep");
}

/**
 * Stage-aware Comfy URL.
 * @param {"prep"|"stills"|"clips"|"wan"|"stitch"|"default"} stage
 */
export function resolveComfyUrlForStage(stage = "default") {
  const route = getGpuBackend();
  const st = String(stage || "default").toLowerCase();
  const wantSalad =
    route === "salad" ||
    (route === "split" && (st === "clips" || st === "wan"));

  if (wantSalad) {
    const url = saladComfyUrl();
    if (url) return url;
  }
  return LOCAL_COMFY_URL;
}

export function isSaladUrl(url) {
  const u = String(url || "").toLowerCase();
  return u.includes(".salad.cloud");
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
  const hasKey = !!saladApiKey();
  const hasUrl = !!saladComfyUrl();
  return {
    backend,
    comfyUrl: resolveComfyUrl(),
    clipsComfyUrl: resolveComfyUrlForStage("clips"),
    prepComfyUrl: resolveComfyUrlForStage("prep"),
    saladConfigured: hasKey && hasUrl,
    saladHasKey: hasKey,
    saladHasUrl: hasUrl,
    split: backend === "split",
    ready: backend === "local" || (hasKey && hasUrl),
  };
}
