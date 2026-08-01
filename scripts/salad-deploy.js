/**
 * Create / start Salad container group for AMVG ComfyUI image.
 *
 *   node scripts/salad-deploy.js
 *   node scripts/salad-deploy.js --org my-org --name amvg-comfyui
 */
import "../lib/load-env.js";
import { parseArgs } from "../lib/comfy-client.js";
import {
  saladApiKey,
  saladComfyUrl,
  SALAD_COMFY_PORT,
} from "../lib/gpu-backend.js";
import {
  saladOrg,
  saladProject,
  saladContainer,
  getContainerGroup,
  startContainerGroup,
  listContainerGroups,
  saladContainerStatus,
} from "../lib/salad-containers.js";
import { writeFile, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.salad.com/api/public";

const DEFAULT_IMAGE =
  process.env.SALAD_IMAGE ||
  "ghcr.io/saeedk247365/amvg-comfyui:kids-hit-wan22";

function headers() {
  const key = saladApiKey();
  if (!key) throw new Error("SALAD_API_KEY missing in .env");
  return {
    "Salad-Api-Key": key,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(data).slice(0, 600)}`);
  }
  return data;
}

async function listGpuClasses(org) {
  try {
    return await api(
      "GET",
      `/organizations/${encodeURIComponent(org)}/gpu-classes`,
    );
  } catch {
    return null;
  }
}

function pickGpuIds(gpuData) {
  const items = gpuData?.items || gpuData || [];
  if (!Array.isArray(items) || !items.length) {
    // Common Salad RTX 4090 / 3090 / 4080 class IDs from public docs (may drift)
    return [
      "ed563892-aacd-40f5-80b7-90c9be6c759b",
      "a5db5c50-cbcb-4596-ae80-6a0c8090d80f",
      "9998fe42-04a5-4807-b3a5-849943f16c38",
    ];
  }
  const prefer = items.filter((g) =>
    /4090|4080|3090|3080|a6000|l40|5090/i.test(
      `${g.name || ""} ${g.title || ""} ${g.display_name || ""}`,
    ),
  );
  const pool = prefer.length ? prefer : items;
  return pool.slice(0, 5).map((g) => g.id || g.gpu_class_id).filter(Boolean);
}

async function createGroup(org, project, name, image, gpuIds) {
  const body = {
    name,
    display_name: "AMVG ComfyUI kids-hit",
    container: {
      image,
      resources: {
        cpu: 4,
        memory: 30720,
        gpu_classes: gpuIds,
        storage_amount: 107374182400,
      },
      priority: "high",
    },
    autostart_policy: true,
    restart_policy: "always",
    replicas: 1,
    networking: {
      protocol: "http",
      auth: true,
      port: SALAD_COMFY_PORT,
    },
    startup_probe: {
      http: {
        path: "/system_stats",
        port: SALAD_COMFY_PORT,
        scheme: "http",
      },
      initial_delay_seconds: 60,
      period_seconds: 15,
      timeout_seconds: 10,
      failure_threshold: 40,
    },
    readiness_probe: {
      http: {
        path: "/system_stats",
        port: SALAD_COMFY_PORT,
        scheme: "http",
      },
      initial_delay_seconds: 30,
      period_seconds: 10,
      timeout_seconds: 5,
      failure_threshold: 3,
    },
  };

  const ghUser = (process.env.GHCR_USER || "saeedk247365").trim();
  const ghToken = (process.env.GHCR_TOKEN || "").trim();
  if (ghToken) {
    body.container.registry_authentication = {
      basic: { username: ghUser, password: ghToken },
    };
  }

  return api(
    "POST",
    `/organizations/${encodeURIComponent(org)}/projects/${encodeURIComponent(project)}/containers`,
    body,
  );
}

async function patchEnvFile(updates) {
  const envPath = join(ROOT, ".env");
  let text = existsSync(envPath) ? await readFile(envPath, "utf8") : "";
  for (const [k, v] of Object.entries(updates)) {
    const re = new RegExp(`^${k}=.*$`, "m");
    if (re.test(text)) text = text.replace(re, `${k}=${v}`);
    else text += `\n${k}=${v}`;
  }
  await writeFile(envPath, text.trimEnd() + "\n", "utf8");
}

async function main() {
  const { flag, has } = parseArgs();
  const org = flag("--org", saladOrg() || process.env.SALAD_ORG || "");
  const project = flag("--project", saladProject());
  const name = flag("--name", saladContainer() || "amvg-comfyui");
  const image = flag("--image", DEFAULT_IMAGE);

  if (!org) {
    console.error(
      "Set SALAD_ORG in .env (portal.salad.com → org slug in the URL) or pass --org",
    );
    process.exit(2);
  }
  if (!saladApiKey()) {
    console.error("SALAD_API_KEY missing");
    process.exit(2);
  }

  console.log(`Org=${org} project=${project} name=${name}`);
  console.log(`Image=${image}`);

  // Ensure public GHCR pull works on Salad — image should be public or use registry auth
  let existing = null;
  try {
    existing = await getContainerGroup(name);
    console.log("Container group already exists:", existing?.current_state || existing?.name);
  } catch {
    console.log("Creating container group…");
    const gpus = pickGpuIds(await listGpuClasses(org));
    console.log("GPU classes:", gpus);
    existing = await createGroup(org, project, name, image, gpus);
    console.log("Created:", existing?.name || existing);
  }

  try {
    await startContainerGroup(name);
    console.log("Start requested");
  } catch (err) {
    console.warn("Start:", err.message || err);
  }

  const status = await saladContainerStatus();
  console.log(JSON.stringify(status, null, 2));

  const dns =
    status?.group?.networking?.dns ||
    existing?.networking?.dns ||
    existing?.networking?.fqdn ||
    null;
  const gateway = dns
    ? String(dns).startsWith("http")
      ? String(dns).replace(/\/$/, "")
      : `https://${dns}`
    : saladComfyUrl() || "";

  await patchEnvFile({
    SALAD_ORG: org,
    SALAD_PROJECT: project,
    SALAD_CONTAINER: name,
    SALAD_COMFY_URL: gateway || "",
    GPU_BACKEND: gateway ? "salad" : "local",
  });
  console.log("\nUpdated .env");
  if (gateway) {
    console.log(`SALAD_COMFY_URL=${gateway}`);
    console.log("Wait until Status shows running/ready, then: npm run mvid -- --salad");
  } else {
    console.log(
      "Copy the Gateway URL from Salad portal into SALAD_COMFY_URL when the group is ready.",
    );
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
