/**
 * Continuity grammar for kids-hit: objective, cause→effect chain,
 * bridge beats on room changes, cut motivation, action phases.
 * Classic pipeline does not import this unless --kids-hit.
 */

export const BRIDGE_LOCATIONS = new Set(["doorway", "hallway"]);

export const CUT_MOTIVATIONS = new Set([
  "look",
  "point",
  "exit",
  "object",
  "match_action",
  "energy",
]);

export const ACTION_PHASES = new Set(["anticipate", "action", "followthrough"]);

export const EXIT_DIRS = new Set([
  "left",
  "right",
  "center",
  "toward_cam",
  "away",
]);

/** Theme → single preschool objective (one goal for the whole song). */
export function objectiveForTheme(theme) {
  const t = String(theme || "").toLowerCase();
  if (/rainy|march/.test(t)) return "march inside because it's raining outside";
  if (/wash|kitchen|hands/.test(t)) return "wash hands then get ready to eat";
  if (/bed|sleep|yawn|brush|teeth|lullaby/.test(t))
    return "get cozy and ready for bed";
  if (/tidy|toys|share/.test(t)) return "pick up toys and make the room tidy";
  if (/lawn|hop|shoes|outside/.test(t)) return "put on shoes and play on the lawn";
  if (/dining|please|thank/.test(t)) return "sit at the table and say please thank you";
  if (/dance|freeze|living/.test(t)) return "dance in the living room then freeze";
  if (/stomp|clap at home/.test(t)) return "stomp and clap around the house";
  if (/morning|stretch|hello/.test(t)) return "wake up stretch and say hello";
  return "have a tiny home adventure";
}

export function normalizeCutMotivation(raw) {
  const s = String(raw || "")
    .toLowerCase()
    .trim();
  return CUT_MOTIVATIONS.has(s) ? s : "";
}

export function normalizeActionPhase(raw) {
  const s = String(raw || "")
    .toLowerCase()
    .trim();
  return ACTION_PHASES.has(s) ? s : "";
}

export function normalizeExitDir(raw) {
  const s = String(raw || "")
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, "_");
  if (s === "towards_cam" || s === "toward") return "toward_cam";
  return EXIT_DIRS.has(s) ? s : "";
}

function isBridgeLoc(loc) {
  return BRIDGE_LOCATIONS.has(String(loc || "").toLowerCase());
}

function roomFamily(loc) {
  const L = String(loc || "").toLowerCase();
  if (L === "kitchen_sink") return "kitchen";
  if (isBridgeLoc(L)) return "bridge";
  return L;
}

/** Pick bridge still for A → B. */
export function bridgeLocationForTransition(fromLoc, toLoc, allowed = []) {
  const allow = new Set(allowed);
  const pick = (id) => (allow.size === 0 || allow.has(id) ? id : null);
  const a = roomFamily(fromLoc);
  const b = roomFamily(toLoc);
  if (a === b || a === "bridge" || b === "bridge") return null;
  // Outdoor transitions prefer doorway
  if (a === "lawn" || b === "lawn") {
    return pick("doorway") || pick("hallway");
  }
  return pick("hallway") || pick("doorway");
}

function oppositeDir(dir) {
  if (dir === "left") return "right";
  if (dir === "right") return "left";
  if (dir === "toward_cam") return "away";
  if (dir === "away") return "toward_cam";
  return "center";
}

function defaultExitDir(index) {
  return index % 2 === 0 ? "right" : "left";
}

/**
 * Fill continuity fields on each beat (cause/effect, dirs, cut, phase).
 */
export function applyContinuityFields(beats, { objective = "", theme = "" } = {}) {
  const list = Array.isArray(beats) ? beats.map((b) => ({ ...b })) : [];
  const obj = objective || objectiveForTheme(theme);

  for (let i = 0; i < list.length; i++) {
    const beat = list[i];
    const prev = i > 0 ? list[i - 1] : null;
    const hint = String(beat.lyricHint || beat.effect || "").trim();
    const pose = beat.characters?.[0]?.pose || "stand";
    const arc = String(beat.storyBeat || "").toLowerCase();

    beat.objective = obj;

    if (!beat.cause) {
      beat.cause = prev
        ? String(prev.effect || prev.lyricHint || prev.characters?.[0]?.pose || "previous action")
        : "song starts";
    }
    if (!beat.effect) {
      beat.effect = hint || `${pose} in ${beat.location || "room"}`;
    }

    let exitDir = normalizeExitDir(beat.exitDir);
    let enterDir = normalizeExitDir(beat.enterDir);
    if (!exitDir) {
      if (pose === "walk" || pose === "stomp") exitDir = defaultExitDir(i);
      else if (pose === "point") exitDir = "right";
      else exitDir = "center";
    }
    if (!enterDir) {
      enterDir = prev?.exitDir ? oppositeDir(prev.exitDir) : "center";
      if (enterDir === "center" && pose === "walk") enterDir = defaultExitDir(i);
    }
    beat.exitDir = exitDir;
    beat.enterDir = enterDir;

    let cut = normalizeCutMotivation(beat.cutMotivation);
    if (!cut) {
      if (beat.bridge) cut = "exit";
      else if (prev && roomFamily(prev.location) !== roomFamily(beat.location))
        cut = "exit";
      else if (pose === "point") cut = "point";
      else if (prev && prev.characters?.[0]?.pose === pose) cut = "match_action";
      else if (arc === "problem" || arc === "discovery") cut = "look";
      else cut = "energy";
    }
    beat.cutMotivation = cut;

    let phase = normalizeActionPhase(beat.actionPhase);
    if (!phase) {
      if (beat.bridge) phase = "action";
      else if (cut === "match_action" && prev) {
        const prevPhase = normalizeActionPhase(prev.actionPhase) || "action";
        phase =
          prevPhase === "anticipate"
            ? "action"
            : prevPhase === "action"
              ? "followthrough"
              : "action";
      } else if (
        /clap|stomp|jump|wave|hands_up/.test(pose) &&
        (arc === "fun" || arc === "celebration")
      ) {
        // Start pairs: anticipate then action on next same-pose if possible
        phase = i > 0 && list[i - 1].characters?.[0]?.pose === pose ? "action" : "anticipate";
      } else if (arc === "problem") phase = "anticipate";
      else if (arc === "celebration") phase = "followthrough";
      else phase = "action";
    }
    beat.actionPhase = phase;

    // Placement follows enter direction for continuity
    if (beat.enterDir === "left" || beat.enterDir === "right") {
      beat.placement = { Adam: beat.enterDir };
      if (beat.depth === "near") beat.depth = "mid";
    }
  }

  return list;
}

function makeBridgeBeat(prev, next, bridgeLoc) {
  const exitDir = normalizeExitDir(prev.exitDir) || "right";
  return {
    id: "bridge",
    location: bridgeLoc,
    section: prev.section || next.section || "Verse 1",
    storyBeat: prev.storyBeat === "celebration" ? "fun" : prev.storyBeat || "discovery",
    lyricHint: "through the door",
    cause: prev.effect || prev.lyricHint || "heads to the door",
    effect: `opens toward ${next.location}`,
    exitDir,
    enterDir: oppositeDir(exitDir),
    cutMotivation: "exit",
    actionPhase: "action",
    bridge: true,
    camera: "medium_full",
    depth: "mid",
    placement: { Adam: exitDir === "left" ? "left" : "right" },
    characters: [
      {
        name: "Adam",
        pose: "walk",
        expression: "curious",
        facing: "front",
      },
    ],
    objective: prev.objective || next.objective || "",
  };
}

/**
 * Insert doorway/hallway beats whenever room family changes.
 * Caps growth by preferring one bridge per transition.
 */
export function insertBridgeBeats(beats, allowedLocations = []) {
  const src = Array.isArray(beats) ? beats : [];
  if (src.length < 2) return src.map((b) => ({ ...b }));

  const out = [];
  for (let i = 0; i < src.length; i++) {
    const beat = { ...src[i] };
    if (i === 0) {
      out.push(beat);
      continue;
    }
    const prev = out[out.length - 1];
    const from = roomFamily(prev.location);
    const to = roomFamily(beat.location);
    if (
      from &&
      to &&
      from !== to &&
      from !== "bridge" &&
      to !== "bridge" &&
      !prev.bridge
    ) {
      const bridgeLoc = bridgeLocationForTransition(
        prev.location,
        beat.location,
        allowedLocations,
      );
      if (bridgeLoc) {
        // Ensure prev looks like an exit
        prev.exitDir = prev.exitDir || defaultExitDir(out.length);
        prev.cutMotivation = prev.cutMotivation === "look" ? "exit" : prev.cutMotivation || "exit";
        if (prev.characters?.[0] && !/walk|point|wave/.test(prev.characters[0].pose)) {
          prev.characters = [
            { ...prev.characters[0], pose: "walk", expression: "curious" },
          ];
        }
        out.push(makeBridgeBeat(prev, beat, bridgeLoc));
        beat.enterDir = oppositeDir(prev.exitDir);
        beat.cutMotivation = "exit";
        beat.cause = `comes through ${bridgeLoc}`;
      }
    }
    out.push(beat);
  }
  return out;
}

/**
 * Validate continuity; returns list of issue strings (empty = ok).
 */
export function validateContinuity(plan) {
  const issues = [];
  const beats = plan?.beats || [];
  if (!beats.length) {
    issues.push("no_beats");
    return issues;
  }

  const objective = String(plan.objective || beats[0]?.objective || "").trim();
  if (!objective) issues.push("missing_objective");

  const arcs = new Set(beats.map((b) => b.storyBeat).filter(Boolean));
  for (const need of ["problem", "discovery", "fun", "celebration"]) {
    if (!arcs.has(need)) issues.push(`missing_arc:${need}`);
  }

  for (let i = 1; i < beats.length; i++) {
    const a = beats[i - 1];
    const b = beats[i];
    const fa = roomFamily(a.location);
    const fb = roomFamily(b.location);
    if (
      fa &&
      fb &&
      fa !== fb &&
      fa !== "bridge" &&
      fb !== "bridge" &&
      !a.bridge &&
      !b.bridge
    ) {
      issues.push(`teleport:${a.location}->${b.location}@${b.id || i}`);
    }
    if (!b.cause && !b.effect) issues.push(`no_chain:${b.id || i}`);
  }

  const funOnly = beats.every((b) => b.storyBeat === "fun");
  if (funOnly) issues.push("flat_energy");

  return [...new Set(issues)];
}

/** Motion extras for Wan from continuity fields. */
export function continuityMotionExtras(beat, prevBeat) {
  const parts = [];
  const phase = normalizeActionPhase(beat?.actionPhase);
  const cut = normalizeCutMotivation(beat?.cutMotivation);
  if (phase === "anticipate") {
    parts.push("anticipation pose starting the action, small wind-up, not finished yet");
  } else if (phase === "followthrough") {
    parts.push("follow-through of the action, settling after the move, soft finish");
  } else if (phase === "action") {
    parts.push("mid-action clear readable motion");
  }
  if (cut === "match_action" && prevBeat) {
    const prevPose = prevBeat.characters?.[0]?.pose || "stand";
    parts.push(
      `continuing the same ${prevPose} motion from the previous shot, do not reset pose`,
    );
  }
  if (cut === "exit") {
    parts.push("moving toward the exit of frame, walking out");
  }
  if (beat?.bridge) {
    parts.push("crossing a doorway threshold, short bridge shot");
  }
  if (beat?.enterDir === "left") parts.push("entering from the left side of frame");
  if (beat?.enterDir === "right") parts.push("entering from the right side of frame");
  return parts;
}
