/**
 * Dry-run continuity validation (no Comfy / Wan / ACE).
 * Usage:
 *   node scripts/validate-continuity.js
 *   node scripts/validate-continuity.js --plan batches/_templates/continuity-golden-rainy-march.json
 *   node scripts/validate-continuity.js --song batches/20260730/rainy-day-march-2
 */
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { parseArgs, stripBom } from "../lib/comfy-client.js";
import {
  repairKidsHitBeats,
  validateContinuity,
  objectiveForTheme,
  kidsHitLocationPalette,
} from "../lib/kids-hit.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { flag } = parseArgs();

async function loadPlan() {
  const planArg = flag("--plan", null);
  const songArg = flag("--song", null);
  if (planArg) {
    const p = planArg.match(/^[A-Za-z]:/) ? planArg : join(ROOT, planArg);
    return JSON.parse(stripBom(await readFile(p, "utf8")));
  }
  if (songArg) {
    const song = songArg.match(/^[A-Za-z]:/) ? songArg : join(ROOT, songArg);
    const p = join(song, "scenes", "actions.json");
    if (!existsSync(p)) throw new Error(`Missing ${p}`);
    return JSON.parse(stripBom(await readFile(p, "utf8")));
  }
  const golden = join(
    ROOT,
    "batches/_templates/continuity-golden-rainy-march.json",
  );
  return JSON.parse(stripBom(await readFile(golden, "utf8")));
}

const plan = await loadPlan();
const theme = plan.theme || "rainy day indoor march";
const allowed = kidsHitLocationPalette(theme, [
  "home",
  "kitchen",
  "kitchen_sink",
  "bedroom",
  "lawn",
  "dining_room",
  "doorway",
  "hallway",
]);

const repaired = repairKidsHitBeats(plan.beats || [], {
  theme,
  allowedLocations: allowed,
  durationSec: plan.durationSec || 75,
});
const out = {
  ...plan,
  objective: plan.objective || objectiveForTheme(theme),
  theme,
  kidsHit: true,
  beats: repaired,
};
const issues = validateContinuity(out);

console.log(`objective: ${out.objective}`);
console.log(`beats: ${out.beats.length}`);
console.log(
  `arcs: ${[...new Set(out.beats.map((b) => b.storyBeat))].join(" → ")}`,
);
console.log(
  `rooms: ${out.beats.map((b) => (b.bridge ? `${b.location}*` : b.location)).join(" → ")}`,
);
console.table(
  out.beats.map((b) => ({
    id: b.id,
    arc: b.storyBeat,
    loc: b.location,
    bridge: !!b.bridge,
    cause: String(b.cause || "").slice(0, 28),
    effect: String(b.effect || "").slice(0, 28),
    cut: b.cutMotivation,
    phase: b.actionPhase,
    pose: b.characters?.[0]?.pose,
  })),
);

if (issues.length) {
  console.error("FAIL continuity:", issues.join(", "));
  process.exit(1);
}
console.log("PASS continuity");
