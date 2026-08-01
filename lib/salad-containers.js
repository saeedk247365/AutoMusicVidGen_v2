/**
 * Salad Cloud container-group management (start/stop/status).
 * Needs SALAD_API_KEY + SALAD_ORG (+ optional SALAD_PROJECT, SALAD_CONTAINER).
 */
import "./load-env.js";
import { saladApiKey, saladComfyUrl } from "./gpu-backend.js";

const API = "https://api.salad.com/api/public";

export function saladOrg() {
  return (process.env.SALAD_ORG || "").trim();
}
export function saladProject() {
  return (process.env.SALAD_PROJECT || "default").trim();
}
export function saladContainer() {
  return (process.env.SALAD_CONTAINER || "").trim();
}

function authHeaders() {
  const key = saladApiKey();
  if (!key) throw new Error("SALAD_API_KEY missing in .env");
  return {
    "Salad-Api-Key": key,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function saladFetch(path, { method = "GET", body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: authHeaders(),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  if (!res.ok) {
    const msg =
      data?.title || data?.detail || data?.message || text.slice(0, 300) || res.status;
    const err = new Error(`Salad API ${method} ${path} → ${res.status}: ${msg}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return { status: res.status, data };
}

export function saladMgmtConfigured() {
  return !!(saladApiKey() && saladOrg());
}

export async function listContainerGroups() {
  const org = saladOrg();
  const project = saladProject();
  if (!org) throw new Error("SALAD_ORG missing in .env (portal org slug)");
  const { data } = await saladFetch(
    `/organizations/${encodeURIComponent(org)}/projects/${encodeURIComponent(project)}/containers`,
  );
  return data;
}

export async function getContainerGroup(name = saladContainer()) {
  const org = saladOrg();
  const project = saladProject();
  if (!org) throw new Error("SALAD_ORG missing in .env");
  if (!name) throw new Error("SALAD_CONTAINER missing in .env (container group name)");
  const { data } = await saladFetch(
    `/organizations/${encodeURIComponent(org)}/projects/${encodeURIComponent(project)}/containers/${encodeURIComponent(name)}`,
  );
  return data;
}

export async function startContainerGroup(name = saladContainer()) {
  const org = saladOrg();
  const project = saladProject();
  if (!org) throw new Error("SALAD_ORG missing in .env");
  if (!name) throw new Error("SALAD_CONTAINER missing in .env");
  const { status, data } = await saladFetch(
    `/organizations/${encodeURIComponent(org)}/projects/${encodeURIComponent(project)}/containers/${encodeURIComponent(name)}/start`,
    { method: "POST" },
  );
  return { status, data, name };
}

export async function stopContainerGroup(name = saladContainer()) {
  const org = saladOrg();
  const project = saladProject();
  if (!org) throw new Error("SALAD_ORG missing in .env");
  if (!name) throw new Error("SALAD_CONTAINER missing in .env");
  const { status, data } = await saladFetch(
    `/organizations/${encodeURIComponent(org)}/projects/${encodeURIComponent(project)}/containers/${encodeURIComponent(name)}/stop`,
    { method: "POST" },
  );
  return { status, data, name };
}

export async function listContainerInstances(name = saladContainer()) {
  const org = saladOrg();
  const project = saladProject();
  if (!org || !name) return null;
  try {
    const { data } = await saladFetch(
      `/organizations/${encodeURIComponent(org)}/projects/${encodeURIComponent(project)}/containers/${encodeURIComponent(name)}/instances`,
    );
    return data;
  } catch {
    return null;
  }
}

/** Compact status for UI / billing awareness. */
export async function saladContainerStatus() {
  const base = {
    configured: saladMgmtConfigured(),
    hasKey: !!saladApiKey(),
    org: saladOrg() || null,
    project: saladProject(),
    container: saladContainer() || null,
    gatewayUrl: saladComfyUrl() || null,
  };
  if (!base.configured) {
    return {
      ...base,
      ok: false,
      error:
        "Set SALAD_ORG (and SALAD_CONTAINER) in .env to manage start/stop from the UI.",
    };
  }
  try {
    if (!base.container) {
      const list = await listContainerGroups();
      const items = list?.items || list || [];
      return {
        ...base,
        ok: true,
        listed: true,
        groups: (Array.isArray(items) ? items : []).map(summarizeGroup),
      };
    }
    const group = await getContainerGroup(base.container);
    const instances = await listContainerInstances(base.container);
    return {
      ...base,
      ok: true,
      group: summarizeGroup(group),
      instances: summarizeInstances(instances),
    };
  } catch (err) {
    return { ...base, ok: false, error: err.message || String(err) };
  }
}

function summarizeGroup(g) {
  if (!g || typeof g !== "object") return g;
  return {
    name: g.name || g.id,
    displayName: g.display_name || g.displayName,
    currentState: g.current_state || g.currentState || g.state,
    replicas: g.replicas,
    running: countRunning(g),
    networking: g.networking
      ? {
          auth: g.networking.auth,
          dns:
            g.networking.dns ||
            g.networking.fqdn ||
            g.networking?.dns_name ||
            null,
        }
      : null,
    createTime: g.create_time || g.createTime,
    updateTime: g.update_time || g.updateTime,
  };
}

function countRunning(g) {
  const cs = g?.current_state || g?.currentState || {};
  if (typeof cs === "string") return null;
  return (
    cs.instance_status_counts?.running_status ??
    cs.instanceStatusCounts?.runningStatus ??
    cs.running ??
    null
  );
}

function summarizeInstances(data) {
  const items = data?.items || data?.instances || data || [];
  if (!Array.isArray(items)) return { raw: data };
  return {
    count: items.length,
    items: items.map((i) => ({
      id: i.id || i.machine_id,
      state: i.state || i.current_state,
      ready: i.ready ?? i.is_ready,
      cpuPercent: i.cpu_percent ?? i.cpuPercent ?? null,
      ramPercent: i.memory_usage_percent ?? i.memoryUsagePercent ?? null,
      ramUsedMb: i.memory_usage_mb ?? i.memoryUsageMb ?? null,
    })),
  };
}
