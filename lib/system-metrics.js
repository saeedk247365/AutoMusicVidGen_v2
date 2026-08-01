/**
 * Local + Salad resource usage for the mvid web UI.
 * Local: os (CPU/RAM) + nvidia-smi (GPU).
 * Salad: container instance API (CPU/RAM) + Comfy /system_stats (VRAM when up).
 */
import { cpus, freemem, totalmem } from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  saladComfyUrl,
  comfyAuthHeaders,
  isSaladUrl,
  getGpuBackend,
  saladConfigured,
} from "./gpu-backend.js";
import {
  saladMgmtConfigured,
  listContainerInstances,
  saladContainer,
} from "./salad-containers.js";

const execFileAsync = promisify(execFile);

/** @type {{ idle: number, total: number } | null} */
let _cpuSample = null;

function sampleCpuPercent() {
  const list = cpus();
  let idle = 0;
  let total = 0;
  for (const c of list) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  if (!_cpuSample || total <= _cpuSample.total) {
    _cpuSample = { idle, total };
    return null;
  }
  const idleDelta = idle - _cpuSample.idle;
  const totalDelta = total - _cpuSample.total;
  _cpuSample = { idle, total };
  if (totalDelta <= 0) return 0;
  return Math.round(100 * (1 - idleDelta / totalDelta));
}

async function nvidiaSmiGpus() {
  try {
    const { stdout } = await execFileAsync(
      "nvidia-smi",
      [
        "--query-gpu=name,utilization.gpu,utilization.memory,memory.used,memory.total",
        "--format=csv,noheader,nounits",
      ],
      { timeout: 4000, windowsHide: true },
    );
    const lines = String(stdout || "")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    return lines.map((line) => {
      const parts = line.split(",").map((s) => s.trim());
      const [name, util, memUtil, used, total] = parts;
      const usedMb = Number(used);
      const totalMb = Number(total);
      return {
        name: name || "GPU",
        utilPercent: Number.isFinite(Number(util)) ? Math.round(Number(util)) : null,
        memUtilPercent: Number.isFinite(Number(memUtil))
          ? Math.round(Number(memUtil))
          : null,
        vramUsedMb: Number.isFinite(usedMb) ? usedMb : null,
        vramTotalMb: Number.isFinite(totalMb) ? totalMb : null,
        vramPercent:
          Number.isFinite(usedMb) && Number.isFinite(totalMb) && totalMb > 0
            ? Math.round((100 * usedMb) / totalMb)
            : null,
      };
    });
  } catch {
    return [];
  }
}

export async function localSystemMetrics() {
  let cpuPercent = sampleCpuPercent();
  if (cpuPercent == null) {
    await new Promise((r) => setTimeout(r, 120));
    cpuPercent = sampleCpuPercent();
  }

  const total = totalmem();
  const free = freemem();
  const used = total - free;
  const ramPercent = total > 0 ? Math.round((100 * used) / total) : null;

  const gpus = await nvidiaSmiGpus();
  const primary = gpus[0] || null;

  return {
    ok: true,
    source: "local",
    cpuPercent,
    ramPercent,
    ramUsedMb: Math.round(used / (1024 * 1024)),
    ramTotalMb: Math.round(total / (1024 * 1024)),
    gpuPercent: primary?.utilPercent ?? null,
    gpuVramPercent: primary?.vramPercent ?? null,
    gpuName: primary?.name || null,
    gpus,
    at: new Date().toISOString(),
  };
}

/** Comfy /system_stats → host RAM + device VRAM (works on Salad gateway). */
async function comfyHostStats(comfyUrl) {
  if (!comfyUrl) return null;
  try {
    const res = await fetch(`${comfyUrl.replace(/\/$/, "")}/system_stats`, {
      headers: comfyAuthHeaders(comfyUrl),
      signal: AbortSignal.timeout(isSaladUrl(comfyUrl) ? 8000 : 2500),
    });
    if (!res.ok) {
      return {
        comfyUp: false,
        httpStatus: res.status,
        error: `HTTP ${res.status}`,
      };
    }
    const data = await res.json();
    const sys = data?.system || {};
    const ramTotal = Number(sys.ram_total || 0);
    const ramFree = Number(sys.ram_free || 0);
    let ramPercent = null;
    let ramUsedMb = null;
    let ramTotalMb = null;
    if (ramTotal > 0) {
      const used = Math.max(0, ramTotal - ramFree);
      ramPercent = Math.round((100 * used) / ramTotal);
      ramUsedMb = Math.round(used / (1024 * 1024));
      ramTotalMb = Math.round(ramTotal / (1024 * 1024));
    }

    const devices = data?.devices || data?.system?.devices || [];
    const d =
      (Array.isArray(devices) &&
        (devices.find((x) => /cuda|gpu/i.test(String(x.type || x.name || ""))) ||
          devices[0])) ||
      null;
    let name = null;
    let vramUsedMb = null;
    let vramTotalMb = null;
    let vramPercent = null;
    if (d) {
      const total = Number(d.vram_total ?? d.torch_vram_total ?? 0);
      const free = Number(d.vram_free ?? d.torch_vram_free ?? 0);
      if (total > 0) {
        const used = Math.max(0, total - free);
        name = d.name || "GPU";
        vramUsedMb = Math.round(used / (1024 * 1024));
        vramTotalMb = Math.round(total / (1024 * 1024));
        vramPercent = Math.round((100 * used) / total);
      }
    }

    return {
      comfyUp: true,
      httpStatus: 200,
      ramPercent,
      ramUsedMb,
      ramTotalMb,
      name,
      vramUsedMb,
      vramTotalMb,
      vramPercent,
    };
  } catch (err) {
    return {
      comfyUp: false,
      httpStatus: null,
      error: err?.message || String(err),
    };
  }
}

function pickInstanceMetrics(instancesPayload) {
  const items =
    instancesPayload?.items ||
    instancesPayload?.instances ||
    (Array.isArray(instancesPayload) ? instancesPayload : []);
  if (!Array.isArray(items) || !items.length) return null;

  const running =
    items.find((i) => {
      const st = String(i.state || i.current_state || "").toLowerCase();
      return st === "running" || i.ready === true;
    }) || items[0];

  const cpu =
    running.cpu_percent ??
    running.cpuPercent ??
    null;
  const ram =
    running.memory_usage_percent ??
    running.memoryUsagePercent ??
    null;
  const ramMb =
    running.memory_usage_mb ??
    running.memoryUsageMb ??
    null;

  return {
    instanceId: running.id || running.machine_id || null,
    state: running.state || running.current_state || null,
    ready: running.ready ?? null,
    cpuPercent:
      cpu == null || !Number.isFinite(Number(cpu))
        ? null
        : Math.round(Number(cpu)),
    ramPercent:
      ram == null || !Number.isFinite(Number(ram))
        ? null
        : Math.round(Number(ram)),
    ramUsedMb:
      ramMb == null || !Number.isFinite(Number(ramMb))
        ? null
        : Math.round(Number(ramMb)),
  };
}

export async function saladSystemMetrics() {
  const backend = getGpuBackend();
  const gateway = saladComfyUrl();
  const base = {
    ok: false,
    source: "salad",
    available: false,
    configured: saladConfigured(),
    mgmtConfigured: saladMgmtConfigured(),
    backend,
    gatewayUrl: gateway || null,
    cpuPercent: null,
    ramPercent: null,
    ramUsedMb: null,
    gpuPercent: null,
    gpuVramPercent: null,
    gpuName: null,
    instance: null,
    note: null,
    at: new Date().toISOString(),
  };

  if (!saladConfigured() && !saladMgmtConfigured()) {
    return { ...base, note: "Salad not configured in .env" };
  }

  let instance = null;
  if (saladMgmtConfigured() && saladContainer()) {
    try {
      const raw = await listContainerInstances();
      instance = pickInstanceMetrics(raw);
    } catch (err) {
      base.note = err.message || String(err);
    }
  }

  const host = gateway ? await comfyHostStats(gateway) : null;

  const cpuPercent = instance?.cpuPercent ?? null;
  const ramPercent = instance?.ramPercent ?? host?.ramPercent ?? null;
  const ramUsedMb = instance?.ramUsedMb ?? host?.ramUsedMb ?? null;
  const gpuVramPercent = host?.vramPercent ?? null;
  const comfyUp = !!host?.comfyUp;

  const available = !!(
    cpuPercent != null ||
    ramPercent != null ||
    gpuVramPercent != null
  );

  let note = null;
  if (available) {
    if (cpuPercent == null && !saladMgmtConfigured()) {
      note = "CPU% needs SALAD_ORG in .env (instance API)";
    }
  } else if (gateway && host && !host.comfyUp) {
    note =
      host.httpStatus === 503
        ? "Gateway 503 — replica up but Comfy not ready (check logs / pull latest image, port 8888)"
        : host.error || `Comfy unreachable (${host.httpStatus || "error"})`;
  } else if (gateway && !host) {
    note = "Gateway set but Comfy not reachable";
  } else {
    note =
      base.note ||
      (!saladContainer()
        ? "Set SALAD_CONTAINER for instance CPU metrics"
        : "No Salad metrics yet");
  }

  return {
    ...base,
    ok: available || !!gateway,
    available,
    cpuPercent,
    ramPercent,
    ramUsedMb,
    ramTotalMb: host?.ramTotalMb ?? null,
    // Instance API has CPU%; GPU util % is not exposed — show VRAM from Comfy
    gpuPercent: null,
    gpuVramPercent,
    gpuName: host?.name || null,
    gpuVramUsedMb: host?.vramUsedMb ?? null,
    gpuVramTotalMb: host?.vramTotalMb ?? null,
    comfyUp,
    httpStatus: host?.httpStatus ?? null,
    instance,
    note,
  };
}

/** Combined payload for GET /api/metrics */
export async function collectSystemMetrics() {
  const [local, salad] = await Promise.all([
    localSystemMetrics(),
    saladSystemMetrics(),
  ]);
  return { ok: true, local, salad, at: new Date().toISOString() };
}
