/**
 * Continuity grammar for kids-hit: objective, cause→effect chain,
 * bridge beats on room changes, cut motivation, action phases,
 * and screen-space continuity (placement / facing / exit↔enter).
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

export const ACTION_PHASES = new Set([
  "setup",
  "anticipate",
  "action",
  "react",
  "followthrough",
  "peak",
]);

export const BEAT_ROLES = new Set([
  "setup",
  "anticipate",
  "action",
  "react",
  "followthrough",
  "peak",
]);

export const CAMERA_MOTIONS = new Set([
  "none",
  "push_in",
  "track",
  "lower",
  "hold_wide",
  "pull_back",
]);

export const EXIT_DIRS = new Set([
  "left",
  "right",
  "center",
  "toward_cam",
  "away",
]);

const SLOT = new Set([
  "left",
  "mid_left",
  "center",
  "mid_right",
  "right",
]);

/** Left/right family for continuity (mid_* stays on same side). */
export function slotFamily(slot) {
  const s = normalizePlacementSlot(slot, "center");
  if (s === "left" || s === "mid_left") return "left";
  if (s === "right" || s === "mid_right") return "right";
  return "center";
}

/** Theme → single preschool objective (one goal for the whole song). */
export function objectiveForTheme(theme) {
  const t = String(theme || "").toLowerCase();
  if (/mom|sasha/.test(t) && /wash|hands/.test(t))
    return "wash hands with Mom then smile clean";
  if (/mom|sasha/.test(t) && /morning|stretch|wake/.test(t))
    return "do a morning stretch with Mom then start the day";
  if (/mom|sasha/.test(t) && /tidy|toys/.test(t))
    return "tidy toys with Mom until the room is clean";
  if (/mom|sasha/.test(t) && /bed|story|night/.test(t))
    return "hear a bedtime story with Mom then sleep";
  if (/mom|sasha/.test(t) && /porch|wave/.test(t))
    return "wave hello on the porch with Mom";
  if (/mom|sasha/.test(t) && /playroom|dance/.test(t))
    return "dance in the playroom with Mom";
  if (/rainy|march/.test(t)) return "march inside because it's raining outside";
  if (/wash|kitchen|hands/.test(t)) return "wash hands then get ready to eat";
  if (/bed|sleep|yawn|brush|teeth|lullaby/.test(t))
    return "get cozy and ready for bed";
  if (/tidy|toys|share/.test(t)) return "pick up toys and make the room tidy";
  if (/lawn|hop|shoes|outside|backyard/.test(t)) return "put on shoes and play outside";
  if (/dining|please|thank/.test(t)) return "sit at the table and say please thank you";
  if (/dance|freeze|living|playroom/.test(t)) return "dance in the living room then freeze";
  if (/stomp|clap at home/.test(t)) return "stomp and clap around the house";
  if (/morning|stretch|hello/.test(t)) return "wake up stretch and say hello";
  return "have a tiny home adventure";
}

/** True when the objective forbids outdoor destinations (lawn). */
export function objectiveIsIndoor(objective, theme = "") {
  const o = String(objective || objectiveForTheme(theme) || "").toLowerCase();
  const t = String(theme || "").toLowerCase();
  if (/outside|lawn|yard|shoes and play/.test(o) && !/inside|indoor|raining/.test(o)) {
    return false;
  }
  if (/inside|indoor|raining outside|wash hands|ready for bed|tidy|dining|living room|around the house|wake up/.test(o)) {
    return true;
  }
  if (/rainy|march|wash|bed|tidy|share|dining|dance|freeze|stomp|clap at home|morning/.test(t)) {
    return true;
  }
  return false;
}

export function normalizeCutMotivation(raw) {
  const s = String(raw || "")
    .toLowerCase()
    .trim();
  return CUT_MOTIVATIONS.has(s) ? s : "";
}

export function normalizeBeatRole(raw) {
  const s = String(raw || "")
    .toLowerCase()
    .trim();
  return BEAT_ROLES.has(s) ? s : "";
}

export function normalizeCameraMotion(raw) {
  const s = String(raw || "")
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, "_");
  return CAMERA_MOTIONS.has(s) ? s : "";
}

export function normalizeActionPhase(raw) {
  const s = String(raw || "")
    .toLowerCase()
    .trim();
  // beatRole aliases map into actionPhase
  if (s === "setup") return "setup";
  if (s === "react") return "react";
  if (s === "peak") return "peak";
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

export function normalizePlacementSlot(raw, fallback = "center") {
  const s = String(raw || "")
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, "_");
  if (s === "near_left" || s === "close_left") return "mid_left";
  if (s === "near_right" || s === "close_right") return "mid_right";
  if (s === "together" || s === "close") return "center";
  return SLOT.has(s) ? s : fallback;
}

export function isBridgeLoc(loc) {
  return BRIDGE_LOCATIONS.has(String(loc || "").toLowerCase());
}

export function roomFamily(loc) {
  const L = String(loc || "").toLowerCase();
  if (L === "kitchen_sink") return "kitchen";
  if (isBridgeLoc(L)) return "bridge";
  return L;
}

export function oppositeDir(dir) {
  if (dir === "left") return "right";
  if (dir === "right") return "left";
  if (dir === "toward_cam") return "away";
  if (dir === "away") return "toward_cam";
  return "center";
}

function sideExit(dir, fallback = "right") {
  const d = normalizeExitDir(dir);
  return d === "left" || d === "right" ? d : fallback;
}

function defaultExitDir(index) {
  return index % 2 === 0 ? "right" : "left";
}

function facingForDir(dir, fallback = "front") {
  if (dir === "left") return "three_quarter_left";
  if (dir === "right") return "three_quarter_right";
  return fallback;
}

function slotOf(beat) {
  return normalizePlacementSlot(beat?.placement?.Adam ?? beat?.placement, "center");
}

function setSlot(beat, slot) {
  if (!beat.placement || typeof beat.placement !== "object") beat.placement = {};
  const hasMom = beat.characters?.some((c) => /^sasha$/i.test(c?.name));
  // Social near: stand next to each other (not far walls, not overlapping)
  if (hasMom && (beat.proximity === "near" || beat.proximity === "close" || beat.closeInteraction === true)) {
    beat.placement.Adam = "mid_left";
    beat.placement.Sasha = "mid_right";
    beat.proximity = "near";
    beat.closeInteraction = false;
    return;
  }
  const s = normalizePlacementSlot(slot, "center");
  beat.placement.Adam = s;
  if (hasMom) {
    const fam = slotFamily(s);
    beat.placement.Sasha =
      fam === "left" ? "right" : fam === "right" ? "left" : "right";
  }
}

function withLeadCharacter(beat, lead) {
  const others = (beat.characters || []).filter(
    (c) => !/^adam$/i.test(String(c?.name || "")),
  );
  const name = lead.name || "Adam";
  const rest = others.filter(
    (c) => String(c.name || "").toLowerCase() !== name.toLowerCase(),
  );
  beat.characters = [lead, ...rest];
}

/** Pick bridge still for A → B. */
export function bridgeLocationForTransition(fromLoc, toLoc, allowed = []) {
  const allow = new Set(allowed);
  const pick = (id) => (allow.size === 0 || allow.has(id) ? id : null);
  const a = roomFamily(fromLoc);
  const b = roomFamily(toLoc);
  if (a === b || a === "bridge" || b === "bridge") return null;
  if (a === "lawn" || b === "lawn") {
    return pick("doorway") || pick("hallway");
  }
  return pick("hallway") || pick("doorway");
}

/**
 * Fill continuity fields on each beat (cause/effect, dirs, cut, phase).
 * Always reconciles enterDir with previous exitDir when both exist.
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
    const sameRoom =
      prev && roomFamily(prev.location) === roomFamily(beat.location);

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

    // Cross-room / bridge: enter must match previous exit
    if (prev && !sameRoom) {
      const prevExit = sideExit(prev.exitDir, defaultExitDir(i - 1));
      prev.exitDir = prevExit;
      enterDir = oppositeDir(prevExit);
      if (!exitDir || exitDir === "center") exitDir = prevExit;
    } else if (prev && sameRoom) {
      // Same room: inherit screen side unless explicitly exiting
      const prevSlot = slotOf(prev);
      if (!enterDir || enterDir === "center") {
        enterDir =
          prevSlot === "left" || prevSlot === "right" ? prevSlot : "center";
      }
      // Keep exit mild unless explicit exit cut (walk-in-place stays planted)
      if (!exitDir) {
        if (beat.cutMotivation === "exit" || beat.bridge) {
          exitDir =
            enterDir === "left" || enterDir === "right"
              ? enterDir
              : defaultExitDir(i);
        } else {
          exitDir = "center";
        }
      }
    } else {
      if (!exitDir) {
        if (pose === "walk" || pose === "stomp") exitDir = defaultExitDir(i);
        else if (pose === "point") exitDir = "right";
        else exitDir = "center";
      }
      if (!enterDir) enterDir = "center";
    }

    // Hard reconcile: when prev exists and rooms differ, enter = opposite(prev.exit)
    if (prev && roomFamily(prev.location) !== roomFamily(beat.location)) {
      const prevExit = sideExit(prev.exitDir, defaultExitDir(i - 1));
      prev.exitDir = prevExit;
      enterDir = oppositeDir(prevExit);
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
          prevPhase === "setup" || prevPhase === "anticipate"
            ? "action"
            : prevPhase === "action"
              ? "react"
              : prevPhase === "react"
                ? "followthrough"
                : "action";
      } else if (
        /clap|stomp|jump|wave|hands_up/.test(pose) &&
        (arc === "fun" || arc === "celebration")
      ) {
        phase =
          i > 0 && list[i - 1].characters?.[0]?.pose === pose
            ? "action"
            : "anticipate";
      } else if (arc === "problem") phase = "setup";
      else if (arc === "celebration") phase = "peak";
      else phase = "action";
    }
    beat.actionPhase = phase;
    if (!beat.beatRole) beat.beatRole = phase;
  }

  return enforceScreenContinuity(list, { objective: obj, theme });
}

/**
 * Same-room placement inheritance, facing stability, exit→enter pairing.
 * Call after locations/poses are set (or from applyContinuityFields).
 */
export function enforceScreenContinuity(beats, { objective = "", theme = "" } = {}) {
  const list = Array.isArray(beats) ? beats.map((b) => ({ ...b })) : [];
  const indoor = objectiveIsIndoor(objective, theme);

  for (let i = 0; i < list.length; i++) {
    const beat = list[i];
    const prev = i > 0 ? list[i - 1] : null;
    const char = beat.characters?.[0]
      ? { ...beat.characters[0] }
      : { name: "Adam", pose: "stand", expression: "curious", facing: "front" };

    // Ban outdoor when objective is indoor
    if (indoor && String(beat.location || "").toLowerCase() === "lawn") {
      beat.location = prev?.location && prev.location !== "lawn" ? prev.location : "home";
      beat.bridge = false;
    }

    const sameRoom =
      prev && roomFamily(prev.location) === roomFamily(beat.location);
    const prevSlot = prev ? slotOf(prev) : "center";
    let slot = slotOf(beat);

    if (!prev) {
      // Open on left or center — not random right
      if (slot === "right") slot = "left";
      setSlot(beat, slot);
      char.facing = char.facing || "front";
      withLeadCharacter(beat, char);
      continue;
    }

    if (sameRoom) {
      // Still START = where previous shot ENDED. Walk-in-place does NOT change slot;
      // only explicit exit / bridge shots travel across the frame.
      const traveling =
        beat.cutMotivation === "exit" || beat.bridge === true;
      const arrival =
        normalizePlacementSlot(
          prev.endPlacement?.Adam ?? prev.endPlacement,
          "",
        ) ||
        (prev.cutMotivation === "exit" || prev.bridge
          ? normalizeExitDir(prev.exitDir)
          : "") ||
        prevSlot;
      const startSlot = SLOT.has(arrival) ? arrival : prevSlot;

      // Preserve social-near dual-cast mid-frame; don't yank to far walls
      if (beat.proximity === "near" || beat.proximity === "close" || beat.closeInteraction === true) {
        beat.proximity = "near";
        beat.closeInteraction = false;
        setSlot(beat, "mid_left");
        char.facing = prev.characters?.[0]?.facing || "front";
        withLeadCharacter(beat, char);
        continue;
      }

      slot = startSlot;
      beat.enterDir =
        slotFamily(startSlot) === "center" ? "center" : slotFamily(startSlot);

      if (!traveling) {
        beat.exitDir = "center";
        // endPlacement stamped later; keep start stable
      } else {
        if (!normalizeExitDir(beat.exitDir) || beat.exitDir === "center") {
          beat.exitDir =
            startSlot === "left" || startSlot === "right"
              ? startSlot === "left"
                ? "right"
                : "left"
              : defaultExitDir(i);
        }
      }
      if (traveling && (beat.exitDir === "left" || beat.exitDir === "right")) {
        char.facing = facingForDir(beat.exitDir, char.facing || "front");
      } else {
        char.facing = prev.characters?.[0]?.facing || "front";
      }
    } else {
      // Cross-room: enter opposite of prev exit; place on enter side
      // Bridge shots stay on the exit side (threshold continuity), then the
      // following story room enters from the opposite side.
      const prevExit = sideExit(
        prev.exitDir,
        prevSlot === "left" || prevSlot === "right" ? prevSlot : defaultExitDir(i - 1),
      );
      prev.exitDir = prevExit;
      // Ensure prev ends on exit side (do not move prev START)
      if (prevExit === "left" || prevExit === "right") {
        prev.endPlacement = { Adam: prevExit };
        if (prev.characters?.[0]) {
          withLeadCharacter(prev, {
            ...prev.characters[0],
            facing: facingForDir(prevExit, prev.characters[0].facing),
          });
        }
      }

      if (beat.bridge) {
        slot = prevExit === "left" || prevExit === "right" ? prevExit : "center";
        beat.enterDir = slot;
        beat.exitDir = slot;
        char.facing = facingForDir(slot, "front");
      } else {
        beat.enterDir = oppositeDir(prevExit);
        slot =
          beat.enterDir === "left" || beat.enterDir === "right"
            ? beat.enterDir
            : "center";
        // Arrive planted — only leave again when cutMotivation becomes exit later
        beat.exitDir = "center";
        char.facing = facingForDir(beat.enterDir, "front");
      }
    }

    // Sink / celebration: depth/facing only — never snap L/R → center (teleport)
    if (String(beat.location || "").toLowerCase() === "kitchen_sink") {
      beat.depth = "far";
    }
    if (
      String(beat.storyBeat || "").toLowerCase() === "celebration" &&
      sameRoom &&
      (char.pose === "hands_up" || char.pose === "wave")
    ) {
      char.facing = "front";
      beat.depth = beat.depth || "near";
    }

    setSlot(beat, slot);
    withLeadCharacter(beat, char);
  }

  // Second pass: exit→enter pairing. Bridges keep exit side; story rooms enter opposite.
  // Do not write endPlacement here — stampEndPlacements owns that after.
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1];
    const beat = list[i];
    if (roomFamily(prev.location) === roomFamily(beat.location)) continue;
    const prevExit = sideExit(prev.exitDir, "right");
    prev.exitDir = prevExit;
    if (beat.bridge) {
      beat.enterDir = prevExit;
      beat.exitDir = prevExit;
      setSlot(beat, prevExit === "left" || prevExit === "right" ? prevExit : "center");
      if (beat.characters?.[0]) {
        withLeadCharacter(beat, {
          ...beat.characters[0],
          facing: facingForDir(slotOf(beat), beat.characters[0].facing),
        });
      }
      continue;
    }
    const fromBridge = !!prev.bridge;
    const enter = fromBridge
      ? oppositeDir(sideExit(prev.exitDir, prevExit))
      : oppositeDir(prevExit);
    beat.enterDir = enter;
    if (enter === "left" || enter === "right") {
      setSlot(beat, enter);
      if (beat.characters?.[0]) {
        withLeadCharacter(beat, {
          ...beat.characters[0],
          facing: facingForDir(enter, beat.characters[0].facing),
        });
      }
    }
  }

  return list;
}

function makeBridgeBeat(prev, next, bridgeLoc) {
  const exitDir = sideExit(prev.exitDir, "right");
  return {
    id: "bridge",
    location: bridgeLoc,
    section: prev.section || next.section || "Verse 1",
    storyBeat:
      prev.storyBeat === "celebration" ? "fun" : prev.storyBeat || "discovery",
    lyricHint: "through the door",
    cause: prev.effect || prev.lyricHint || "heads to the door",
    effect: `opens toward ${next.location}`,
    exitDir,
    enterDir: exitDir,
    cutMotivation: "exit",
    actionPhase: "action",
    bridge: true,
    camera: "medium_full",
    depth: "mid",
    placement: { Adam: exitDir },
    characters: [
      {
        name: "Adam",
        pose: "walk",
        expression: "curious",
        facing: facingForDir(exitDir, "front"),
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
        prev.exitDir = sideExit(prev.exitDir, defaultExitDir(out.length));
        prev.cutMotivation = "exit";
        if (prev.characters?.[0] && !/walk|point|wave/.test(prev.characters[0].pose)) {
          withLeadCharacter(prev, {
            ...prev.characters[0],
            pose: "walk",
            expression: "curious",
          });
        }
        out.push(makeBridgeBeat(prev, beat, bridgeLoc));
        beat.enterDir = oppositeDir(prev.exitDir);
        beat.cutMotivation = "energy";
        beat.cause = `comes through ${bridgeLoc}`;
      }
    }
    out.push(beat);
  }
  return out;
}

/**
 * Progressive room path: problem→p0, discovery→p1, fun→stay/progress, celebration→last indoor.
 * Never snaps fun back to p[0] (that caused home←hallway←home loops).
 */
export function journeyLocation(arc, palette, defLoc, index, total) {
  const p = (palette || []).filter((id) => !isBridgeLoc(id));
  const rooms = p.length ? p : [defLoc || "home"];
  const a = String(arc || "").toLowerCase();
  if (rooms.length === 1) return rooms[0];
  if (a === "problem") return rooms[0];
  if (a === "discovery") return rooms[Math.min(1, rooms.length - 1)];
  // Fun stays in discovery room (don't race to last room / sink)
  if (a === "fun") return rooms[Math.min(1, rooms.length - 1)];
  if (a === "celebration") return rooms[rooms.length - 1];
  const t = total > 1 ? index / (total - 1) : 0;
  return rooms[Math.min(rooms.length - 1, Math.floor(t * (rooms.length - 1)))];
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
  const theme = String(plan.theme || "").trim();
  if (!objective) issues.push("missing_objective");

  const indoor = objectiveIsIndoor(objective, theme);
  const arcs = new Set(beats.map((b) => b.storyBeat).filter(Boolean));
  for (const need of ["problem", "discovery", "fun", "celebration"]) {
    if (!arcs.has(need)) issues.push(`missing_arc:${need}`);
  }

  const visited = [];
  for (let i = 0; i < beats.length; i++) {
    const b = beats[i];
    const loc = String(b.location || "").toLowerCase();
    if (indoor && loc === "lawn") {
      issues.push(`outdoor_vs_objective:${b.id || i}`);
    }
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

    // exit ↔ enter pairing across room changes
    if (fa !== fb) {
      const ex = sideExit(a.exitDir, "");
      const en = normalizeExitDir(b.enterDir);
      if (ex && en) {
        if (b.bridge) {
          // Bridge continues on the exit side
          if (en !== ex) {
            issues.push(`exit_enter_mismatch:${a.id || i - 1}->${b.id || i}`);
          }
        } else if (en !== oppositeDir(ex)) {
          issues.push(`exit_enter_mismatch:${a.id || i - 1}->${b.id || i}`);
        }
      }
    }

    // Screen continuity: same-room inherit; bridges continue on exit side.
    // Story room after a room/bridge change may enter opposite — not a jump.
    if (b.bridge || (fa === fb && fa !== "bridge")) {
      const sa = slotOf(a);
      const sb = slotOf(b);
      const aEnd =
        normalizePlacementSlot(a.endPlacement?.Adam ?? a.endPlacement, sa) ||
        sa;
      // Same side family (left≈mid_left) is continuous; only flag true teleports
      if (slotFamily(sb) !== slotFamily(aEnd) && sb !== aEnd) {
        issues.push(
          `placement_jump:${a.id || i - 1}->${b.id || i}(${aEnd}->${sb})`,
        );
      }
    }

    // Same-room facing flip spam
    if (fa === fb && fa !== "bridge") {
      const traveling =
        b.characters?.[0]?.pose === "walk" ||
        b.cutMotivation === "exit" ||
        b.bridge ||
        a.cutMotivation === "exit" ||
        a.characters?.[0]?.pose === "walk" ||
        a.bridge;
      const faFacing = a.characters?.[0]?.facing;
      const fbFacing = b.characters?.[0]?.facing;
      if (
        faFacing &&
        fbFacing &&
        faFacing !== fbFacing &&
        faFacing !== "front" &&
        fbFacing !== "front" &&
        !traveling
      ) {
        issues.push(`facing_flip:${a.id || i - 1}->${b.id || i}`);
      }
    }

    // Repeated lyric hints (same line on consecutive story beats)
    if (
      !a.bridge &&
      !b.bridge &&
      a.lyricHint &&
      b.lyricHint &&
      String(a.lyricHint).toLowerCase() === String(b.lyricHint).toLowerCase()
    ) {
      issues.push(`repeated_lyric_hint:${a.id || i - 1}->${b.id || i}`);
    }

    // Room backtrack (A→B→A), counting only story rooms (bridges ignored)
    if (fa && fb && fa !== "bridge" && fb !== "bridge") {
      if (!visited.length || visited[visited.length - 1] !== fb) visited.push(fb);
      if (visited.length >= 3) {
        const earlier = visited.slice(0, -1);
        if (earlier.includes(fb) && visited[visited.length - 2] !== fb) {
          issues.push(`room_backtrack:...->${fb}@${b.id || i}`);
        }
      }
    }
  }

  const funOnly = beats.every((b) => b.storyBeat === "fun");
  if (funOnly) issues.push("flat_energy");

  return [...new Set(issues)];
}

/** Motion extras for Wan from continuity fields. */
export function continuityMotionExtras(beat, prevBeat) {
  const parts = [];
  const phase =
    normalizeActionPhase(beat?.actionPhase) ||
    normalizeBeatRole(beat?.beatRole);
  const cut = normalizeCutMotivation(beat?.cutMotivation);
  const slot = slotOf(beat);
  const exitDir = normalizeExitDir(beat?.exitDir);
  const enterDir = normalizeExitDir(beat?.enterDir);
  const cam = normalizeCameraMotion(beat?.cameraMotion);

  const hasPrev = !!prevBeat;
  if (phase === "setup") {
    parts.push(
      hasPrev
        ? "quiet hold in the ongoing scene, soft idle, do not restart the story"
        : "quiet setup noticing moment, soft idle, story about to begin",
    );
  } else if (phase === "anticipate") {
    parts.push(
      hasPrev
        ? "continue the wind-up already underway, leans in, not a fresh start"
        : "anticipation wind-up starting the action, leans in, not finished yet",
    );
  } else if (phase === "followthrough") {
    parts.push(
      "follow-through settle after the move, soft finish, hold the feeling",
    );
  } else if (phase === "react") {
    parts.push(
      "quick reaction to what just happened, face and body respond, short readable beat",
    );
  } else if (phase === "peak") {
    parts.push("peak payoff motion, biggest clear energy of the arc so far");
  } else if (phase === "action") {
    parts.push(
      hasPrev
        ? "mid-action continuation of the same scene, clear readable motion, do not reset"
        : "mid-action clear readable motion driving the story",
    );
  }

  if (cam === "push_in") {
    parts.push("soft camera push-in toward the face like joining the moment");
  } else if (cam === "track") {
    parts.push("camera gently tracks with the character");
  } else if (cam === "lower") {
    parts.push("camera lowers to toddler eye level");
  } else if (cam === "hold_wide") {
    parts.push("camera holds a wider readable frame");
  } else if (cam === "pull_back") {
    parts.push("camera softly pulls back to show the whole moment");
  }

  if (cut === "match_action" && prevBeat) {
    const prevPose = prevBeat.characters?.[0]?.pose || "stand";
    const prevSlot = slotOf(prevBeat);
    parts.push(
      `continuing the same ${prevPose} motion from the previous shot, stay near ${prevSlot} of frame, do not reset pose or teleport`,
    );
  }

  if (cut === "exit" || beat?.bridge) {
    const dir =
      exitDir === "left" || exitDir === "right" ? exitDir : slot;
    parts.push(
      `moving toward the ${dir} of frame, end near ${dir}`,
    );
  } else if (beat?.characters?.[0]?.pose === "stomp") {
    parts.push(
      `stomp in place in the ${slot} of frame, energetic feet, do not travel across the room`,
    );
  } else if (beat?.characters?.[0]?.pose === "walk") {
    parts.push(
      `march steps in the ${slot} of the frame with wind-up and settle, small bounce, do not cross the room`,
    );
  } else if (
    beat?.proximity === "near" ||
    beat?.proximity === "close" ||
    /kneel|open arms|wave|stretch|dance|together/i.test(String(beat?.interaction || ""))
  ) {
    parts.push(
      "stay mid-frame near the other character with a clear gap between bodies, face each other, react, do not touch, do not hug, do not stand on opposite walls",
    );
  } else {
    parts.push(
      `stay planted in the ${slot} of the frame with alive idle business, small local motion only, do not cross the room`,
    );
  }

  const endSlot = normalizePlacementSlot(
    beat?.endPlacement?.Adam ?? beat?.endPlacement,
    slot,
  );
  if (endSlot) {
    parts.push(
      `finish the shot with the character still in the ${endSlot} of the frame (matches the next still)`,
    );
  }

  if (beat?.bridge) {
    parts.push("crossing a doorway threshold, short bridge shot");
  }

  // Only true room/bridge entrances — same-room enterDir often means facing/slot,
  // and "entering from left" makes every cut feel like a fresh arrival.
  const sameRoom =
    !!prevBeat &&
    roomFamily(prevBeat.location) === roomFamily(beat?.location);
  const trueEntrance =
    !!beat?.bridge ||
    !prevBeat ||
    (!!prevBeat && !sameRoom);
  if (trueEntrance && !sameRoom) {
    if (enterDir === "left") {
      parts.push("entering from the left side of frame");
    } else if (enterDir === "right") {
      parts.push("entering from the right side of frame");
    }
  }

  if (prevBeat && sameRoom) {
    const prevSlot = slotOf(prevBeat);
    const prevPose = prevBeat.characters?.[0]?.pose || "stand";
    const pose = beat?.characters?.[0]?.pose || "stand";
    parts.push(
      `CONTINUITY CUT: next shot of the same scene after "${String(prevBeat.effect || prevBeat.lyricHint || prevPose).slice(0, 48)}", cast already present, no new arrivals, do not replay earlier beats`,
    );
    if (prevSlot === slot) {
      parts.push(
        `begin where the last shot ended (${slot} of frame), continuous screen direction`,
      );
    } else {
      parts.push(
        `screen move from ${prevSlot} toward ${slot}, still the same continuous action`,
      );
    }
    if (String(prevPose) !== String(pose)) {
      parts.push(
        `transition from ${prevPose} into ${pose}, do not reset to a neutral idle then start over`,
      );
    }
  }

  return parts;
}
