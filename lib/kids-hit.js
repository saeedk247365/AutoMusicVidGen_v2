/**
 * Opt-in kids-hit helpers. Classic 02_0 / 02_1 / 02_2 defaults stay unchanged
 * unless callers pass --kids-hit / --loop-fill.
 */

import {
  objectiveForTheme,
  applyContinuityFields,
  insertBridgeBeats,
  validateContinuity,
  continuityMotionExtras,
  BRIDGE_LOCATIONS,
} from "./kids-hit-continuity.js";

export {
  objectiveForTheme,
  validateContinuity,
  insertBridgeBeats,
  applyContinuityFields,
  BRIDGE_LOCATIONS,
} from "./kids-hit-continuity.js";

export const KIDS_HIT_DURATION_SEC = 75;
export const KIDS_HIT_BEAT_MIN = 14;
/** Allow room for doorway/hallway bridge beats. */
export const KIDS_HIT_BEAT_MAX = 18;
export const KIDS_HIT_WAN_LENGTH = 81; // ~5.06s @ 16fps; (n-1)%4===0
/** Kids-hit Wan frame size (square — matches keyframe stills). */
export const KIDS_HIT_WAN_WIDTH = 768;
export const KIDS_HIT_WAN_HEIGHT = 768;

export const HOME_THEMES = [
  "stomp and clap at home",
  "morning hello stretch",
  "tidy up toys",
  "kitchen helpers wash hands",
  "lawn play hop and wave",
  "bedtime stretch and yawn",
  "dining table please and thank you",
  "living room dance freeze",
  "shoes on go outside",
  "rainy day indoor march",
  "brush teeth bedtime",
  "share the toys",
];

/** Soft styles only — never marching band on a lullaby. */
export const KIDS_HIT_STYLES = [
  "gentle acoustic",
  "happy ukulele",
  "soft lullaby piano",
  "warm folk singalong",
  "soft preschool pop",
  "quiet bedtime ballad",
];

export const KIDS_HIT_CAPTION_TEMPLATE = `Create an original preschool song called "{{TITLE}}".

The song should sound like a catchy children's singalong for ages 2-6.

Musical style:
{{STYLE}}

Requirements:
- warm, playful, memorable, positive
- easy to sing along
- short chantable chorus
- tell a tiny preschool story: problem → discovery → fun → celebration
- match the musical style above exactly (if lullaby/bedtime, keep it soft and quiet — no marching band energy)

Production:
- ukulele or acoustic guitar or soft piano
- soft percussion (quiet for bedtime)
- light hand claps only if the song is upbeat

Keep the song SHORT.

Finish with a brief instrumental outro (about 5 seconds).

Vocals should finish before the music ends.

Do not cut off abruptly.

Target runtime:
about 75 seconds.`;

export const KIDS_HIT_LYRICS_PROMPT = `You are a preschool hit songwriter for ages 2-6.

Write a SHORT home singalong (about 75 seconds when sung) as ONE tiny adventure — not a random pose list.

Theme (ONLY this — must happen at home / yard / kitchen / bedroom):
{{THEME}}

Educational focus (light touch):
{{EDU_FOCUS}}

Primary chorus movement (must appear clearly in every chorus):
{{MOVEMENT}}

Mood: {{MOOD}}

ONE OBJECTIVE (required):
The whole song has ONE goal a toddler can say out loud (examples: march inside because rain; wash hands then eat; find teddy for bed; tidy toys).
Write it on the first line after TITLE as:
OBJECTIVE: ...

CHAIN REACTION (required):
Each line must cause the next. Example: rain → can't go out → see the door → march inside → stomp → sun peeks → smile.
Never write disconnected clap/wave/walk lines with no reason.

MINI STORY ARC:
1. PROBLEM (Intro) — the obstacle (rain, dirty hands, messy toys, sleepy)
2. DISCOVERY (Verse 1) — Adam finds the idea that solves it
3. FUN (Chorus + Verse 2) — do the fun action that serves the objective
4. CELEBRATION (Outro) — objective done / problem gone

HARD RULES:
- Setting must be depictable in: kitchen, kitchen_sink, lawn, bedroom, home, dining_room (doorways connect rooms in the video)
- Name places in order Adam travels (e.g. window → door → kitchen → table)
- Clear action verbs: clap, wash, splash, point, wave, walk, stomp, tiptoe, stretch, march
- If bedtime theme: stay bedroom; soft words; no stomping/lawn
- NO zoo, ocean, space, pirates, jungle trips
- Real preschool rhymes only; max 6 words per line
- BANNED filler: thin, real neat, no trap, so bold, like a rabbit, happy snap, oh what a delight
- ONE child (Adam). Prefer "I"/"my". Avoid "we are" / "let's all"

Structure:
[Intro]     ← PROBLEM
[Verse 1]   ← DISCOVERY
[Chorus]    ← FUN
[Verse 2]   ← more FUN (same objective)
[Chorus]    ← bigger FUN / peak
[Outro]     ← CELEBRATION

Do NOT reuse these titles:
{{USED_TITLES}}

OUTPUT EXACTLY

TITLE: ...
OBJECTIVE: ...

LYRICS:
...`;

/**
 * Placeholders include {{OBJECTIVE}} for continuity.
 */
export const KIDS_HIT_SCENES_PROMPT = `You plan preschool music-video BEATS as a CONTINUOUS little adventure (not a pose slideshow).

Continuity contract:
- ONE objective for the whole song: {{OBJECTIVE}}
- Every beat is a consequence of the previous beat (cause → effect)
- When the room changes, Adam must GO there (exit / door) — never teleport
- Cuts need motivation: look, point, exit, object, match_action, energy
- Action phases: anticipate → action → followthrough across neighboring beats when possible
- Energy: problem (quiet) → discovery → fun → celebration (peak then soft)

Characters (ONLY):
- Adam = toddler boy (every beat)

Allowed locations (exact ids only):
{{LOCATIONS}}

Default location: {{DEFAULT_LOCATION}}
Mood: {{MOOD}}

Allowed cameras:
{{CAMERAS}}

Allowed poses:
{{POSES}}

Allowed expressions:
{{EXPRESSIONS}}

Allowed facings:
{{FACINGS}}

Song title: {{TITLE}}
Theme: {{THEME}}
Song duration seconds: {{DURATION_SEC}}

Lyrics:
{{LYRICS}}

Create EXACTLY between {{BEAT_MIN}} and {{BEAT_MAX}} beats covering 0 to {{DURATION_SEC}}.

HARD RULES:
- Each beat ONE frozen instant that advances the objective.
- Fields required on EVERY beat:
  storyBeat ("problem"|"discovery"|"fun"|"celebration"),
  cause, effect, lyricHint, startSec, endSec,
  cutMotivation, actionPhase, exitDir, enterDir,
  placement left|center|right, depth near|mid|far
- Intro=problem; Verse1=discovery; Chorus=fun; Verse2=fun; Outro=celebration
- Prefer 2–3 story rooms max. Use doorway/hallway only if needed (pipeline also inserts bridges).
- Bedtime: ALL bedroom.
- Pose matches lyric + story energy. tap→point NEVER tiptoe.
- Neighboring beats that share a pose should use anticipate then action/followthrough (match_action).
- Do not spam the same pose more than 2 times in a row.

OUTPUT EXACTLY valid JSON (no markdown fences):
{
  "durationSec": {{DURATION_SEC}},
  "kidsHit": true,
  "objective": "{{OBJECTIVE}}",
  "beats": [
    {
      "id": "01_intro",
      "location": "{{DEFAULT_LOCATION}}",
      "section": "Intro",
      "storyBeat": "problem",
      "cause": "song starts",
      "effect": "sees rain at the window",
      "lyricHint": "rain is falling",
      "cutMotivation": "look",
      "actionPhase": "anticipate",
      "exitDir": "center",
      "enterDir": "center",
      "startSec": 0,
      "endSec": 5,
      "camera": "medium_full",
      "depth": "mid",
      "placement": { "Adam": "left" },
      "characters": [
        {
          "name": "Adam",
          "pose": "stand",
          "expression": "curious",
          "facing": "front"
        }
      ]
    }
  ]
}`;

const BAD_LYRIC_RE =
  /\b(so thin|real neat|stand complete|happy snap|little lists|steady grade|oh what a delight|right up to the glow|no trap|so bold|towel,? plain|like a rabbit|i'?m so bold)\b/i;

const CALM_THEME_RE =
  /bed|sleep|yawn|night|brush teeth|lullaby|dream|pajamas|goodnight/i;

/** Intro should name a small problem / stuck feeling. */
const PROBLEM_LYRIC_RE =
  /\b(rain|gray|grey|dirty|mess|messy|tired|sleepy|yawn|can'?t|cannot|oh no|stuck|sad|cold|dark|wait|still|bored|frown|drip|mud|spill|late|loud|quiet too|won'?t|no sun|no go)\b/i;

/** Outro should resolve / celebrate. */
const CELEBRATION_LYRIC_RE =
  /\b(clean|bright|done|ready|smile|yay|sun|cozy|goodnight|thank|happy|all done|finished|tidy|warm|hug|bedtime|shine|cheer|clap)\b/i;

const ENERGETIC_POSES = new Set([
  "stomp",
  "clap",
  "wave",
  "hands_up",
  "walk",
]);

const ENERGETIC_MOTION = {
  stand: "standing with light bounce on the beat, ready to move",
  sit: "sitting, soft posture shift, gentle head bob",
  kneel: "kneeling, slight torso sway",
  walk: "small steps across the frame on the beat, knees lifting, arms swinging, body shifts left or right",
  tiptoe: "tiptoeing in place softly, heels raised, careful quiet steps",
  wave: "big enthusiastic wave, arm swinging high side to side repeatedly",
  point: "pointing clearly at the sink or faucet, arm extended, small rhythmic pulse",
  hands_up: "arms raised high, bouncing on the beat, joyful preschool dance",
  clap: "rhythmic clapping on the beat, both hands meeting in front of chest clearly 3 to 4 times, energetic wash-hands clap",
  stomp: "stomping feet alternately on the beat, knees lifting, whole-body bounce",
};

const CALM_MOTION = {
  stand: "standing calmly, tiny breath sway, soft preschool stillness",
  sit: "sitting on the floor, soft sleepy posture, gentle breathing",
  kneel: "kneeling quietly, slight torso sway",
  walk: "slow quiet steps in place",
  tiptoe: "tiptoeing softly in place, heels up, quiet careful motion",
  wave: "small gentle wave goodnight",
  point: "soft pointing gesture, tiny motion",
  hands_up: "arms stretching upward slowly then relaxing, sleepy stretch yawn motion",
  clap: "soft quiet claps once or twice",
  stomp: "very soft foot taps, no stomping energy",
};

const STORY_MOTION = {
  problem:
    "soft uncertain energy, looking around, small hesitant motion, preschool problem moment",
  discovery:
    "curious brightening energy, noticing something, stepping into the idea",
  fun: "clear joyful rhythmic motion on the beat, playful preschool dance energy",
  celebration:
    "big happy finish energy, proud smile motion, celebratory bounce, problem solved",
};

const WASH_HINT_MOTION =
  "pretend washing hands under a sink, rubbing palms, splashy preschool gesture, keep identity fixed";

export function kidsHitMood(theme) {
  return CALM_THEME_RE.test(String(theme || "")) ? "calm" : "energetic";
}

export function kidsHitDefaultLocation(theme, allowed = []) {
  const t = String(theme || "").toLowerCase();
  const allow = new Set(allowed);
  const pick = (id) => (allow.size === 0 || allow.has(id) ? id : allowed[0] || "home");
  if (CALM_THEME_RE.test(t)) return pick("bedroom");
  if (/kitchen|wash|cook|hands/.test(t)) return pick("kitchen");
  if (/lawn|outside|shoes|hop|yard/.test(t)) return pick("lawn");
  if (/dining|table|please|thank/.test(t)) return pick("dining_room");
  if (/living|dance|freeze|share|toy|tidy/.test(t)) return pick("home");
  return pick("home");
}

/** Related rooms for a theme — enables scene changes without random teleports. */
export function kidsHitLocationPalette(theme, allowed = []) {
  const t = String(theme || "").toLowerCase();
  const allow = new Set(allowed);
  const keep = (...ids) => {
    const out = ids.filter((id) => allow.size === 0 || allow.has(id));
    return out.length ? out : [kidsHitDefaultLocation(theme, allowed)];
  };
  if (CALM_THEME_RE.test(t)) return keep("bedroom");
  if (/kitchen|wash|cook|hands/.test(t))
    return keep("kitchen", "kitchen_sink", "dining_room", "home", "doorway", "hallway");
  if (/lawn|outside|shoes|hop|yard/.test(t))
    return keep("lawn", "home", "doorway", "hallway");
  if (/dining|table|please|thank/.test(t))
    return keep("dining_room", "kitchen", "kitchen_sink", "home", "doorway", "hallway");
  if (/living|dance|freeze|share|toy|tidy/.test(t))
    return keep("home", "kitchen", "bedroom", "doorway", "hallway");
  if (/stomp|clap at home|morning|rainy|march/.test(t))
    return keep("home", "kitchen", "kitchen_sink", "bedroom", "lawn", "doorway", "hallway");
  return keep("home", "kitchen", "lawn", "doorway", "hallway");
}

export function kidsHitMovementForTheme(theme, fallback = "clap") {
  const t = String(theme || "").toLowerCase();
  if (CALM_THEME_RE.test(t)) return "tiptoe";
  if (/stomp/.test(t)) return "stomp";
  if (/clap/.test(t) && !/wash|kitchen|hands/.test(t)) return "clap";
  if (/wave|hello/.test(t)) return "wave";
  if (/hop|lawn|outside|shoes/.test(t)) return "hop";
  if (/stretch|morning/.test(t)) return "stretch";
  if (/march|rainy/.test(t)) return "march";
  if (/tidy|wash|kitchen|hands/.test(t)) return "wash";
  if (/dining|table|please|thank|share/.test(t)) return "clap";
  if (/dance|freeze|living/.test(t)) return "clap";
  const safe = ["clap", "wave", "stomp", "hop", "stretch", "wash", "march"];
  if (safe.includes(String(fallback || "").toLowerCase())) return fallback;
  return "clap";
}

export function kidsHitStyleForMood(mood, pool = KIDS_HIT_STYLES) {
  if (mood === "calm") {
    const soft = pool.filter((s) => /lullaby|quiet|soft|gentle|acoustic|ukulele|folk/i.test(s));
    return soft[Math.floor(Math.random() * soft.length)] || "soft lullaby piano";
  }
  const up = pool.filter((s) => !/lullaby|quiet|bedtime/i.test(s));
  return up[Math.floor(Math.random() * up.length)] || pool[0];
}

export function lyricsHaveProblems(lyrics) {
  const text = String(lyrics || "");
  const issues = [];
  if (BAD_LYRIC_RE.test(text)) {
    issues.push("banned_filler_rhyme");
  }
  if (/\b(we are all|we'?re all|mom|dad|brother|sister|family of|parents|let'?s all)\b/i.test(text)) {
    issues.push("extra_cast_or_adults");
  }
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^\[/.test(l) && !/^TITLE:/i.test(l));
  for (const line of lines) {
    const words = line.replace(/[^a-zA-Z\s']/g, "").split(/\s+/).filter(Boolean);
    if (words.length > 7) issues.push(`line_too_long:${line.slice(0, 40)}`);
  }
  if (/\b(snap!?|so fun!?|complete!?|don'?t be a (gap|grump|pain|cheat|nap|dis))\b/i.test(text)) {
    issues.push("weak_filler_end");
  }
  // Outro must have at least one non-empty lyric line after the header
  const outroBody = /\[Outro\]\s*([\s\S]*?)(?=\n\[|$)/i.exec(text)?.[1] || "";
  if (!outroBody.trim()) issues.push("empty_outro");
  const introBody = /\[Intro\]\s*([\s\S]*?)(?=\n\[|$)/i.exec(text)?.[1] || "";
  if (!introBody.trim()) issues.push("empty_intro");
  // Prefer multi-room lyrics for visual variety (skip for pure bedtime)
  if (!CALM_THEME_RE.test(text)) {
    const placeHits = [
      /kitchen|sink|wash/i.test(text),
      /table|dining|eat|supper/i.test(text),
      /living|sofa|toys|home/i.test(text),
      /lawn|outside|yard|shoes/i.test(text),
      /bedroom|bed|sleep/i.test(text),
      /rain|gray|march|stomp/i.test(text),
    ].filter(Boolean).length;
    if (placeHits < 2) issues.push("single_room_lyrics");
  }
  // Mini-story check: intro should sound like a problem; outro like a resolve
  if (introBody.trim() && !PROBLEM_LYRIC_RE.test(introBody)) {
    issues.push("intro_missing_problem");
  }
  if (outroBody.trim() && !CELEBRATION_LYRIC_RE.test(outroBody)) {
    issues.push("outro_missing_celebration");
  }
  return [...new Set(issues)];
}

export function normalizeKidsLyricsText(text) {
  return String(text || "")
    .replace(/\u2019/g, "'")
    .replace(/\u2018/g, "'")
    .replace(/\u201C|\u201D/g, '"')
    .replace(/\u2026/g, "...")
    .replace(/\r\n/g, "\n");
}

/** Soft-fix: trim lyric lines to maxWords (keeps section headers). */
export function shortenKidsLyricLines(lyrics, maxWords = 6) {
  return String(lyrics || "")
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trimEnd();
      if (!trimmed || /^\[/.test(trimmed) || /^TITLE:/i.test(trimmed) || /^LYRICS:/i.test(trimmed)) {
        return trimmed;
      }
      const parts = trimmed.match(/^(\s*)(.*)$/);
      const lead = parts?.[1] || "";
      const body = parts?.[2] || trimmed;
      const tokens = body.split(/\s+/).filter(Boolean);
      if (tokens.length <= maxWords) return lead + body;
      return lead + tokens.slice(0, maxWords).join(" ");
    })
    .join("\n");
}

/** Infer a HOME_THEMES-like theme string from lyrics when meta is missing. */
export function inferKidsHitThemeFromLyrics(lyrics) {
  const t = String(lyrics || "").toLowerCase();
  if (CALM_THEME_RE.test(t) || /tiptoe|yawn|pajamas|goodnight/.test(t))
    return "bedtime stretch and yawn";
  if (/wash|soap|hands|sink|bubble|scrub|clean/.test(t))
    return "kitchen helpers wash hands";
  if (/lawn|outside|yard|shoes|hop/.test(t)) return "lawn play hop and wave";
  if (/please|thank|dining|table|supper/.test(t))
    return "dining table please and thank you";
  if (/freeze|dance|living|clap/.test(t)) return "living room dance freeze";
  if (/tidy|toys|share/.test(t)) return "tidy up toys";
  if (/stomp/.test(t)) return "stomp and clap at home";
  return "morning hello stretch";
}

export function isEnergeticPose(poseId) {
  return ENERGETIC_POSES.has(String(poseId || "").toLowerCase());
}

export function energeticMotionForPose(poseId) {
  const id = String(poseId || "stand")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return ENERGETIC_MOTION[id] || ENERGETIC_MOTION.stand;
}

export function calmMotionForPose(poseId) {
  const id = String(poseId || "stand")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return CALM_MOTION[id] || CALM_MOTION.stand;
}

export function kidsHitMotionPrompt({
  poseIds,
  location,
  camera,
  mood = "energetic",
  lyricHint = "",
  storyBeat = "",
  actionPhase = "",
  cutMotivation = "",
  bridge = false,
  enterDir = "",
  prevBeat = null,
} = {}) {
  const poses = (poseIds || ["stand"]).map((p) => String(p || "stand"));
  const arc = normalizeStoryBeat(storyBeat);
  const forceCalm = mood === "calm" || arc === "problem";
  const forceCelebrate = arc === "celebration" || arc === "fun";
  const energetic =
    !forceCalm &&
    (forceCelebrate || poses.some((p) => isEnergeticPose(p)));
  const parts = poses.map((p) =>
    energetic ? energeticMotionForPose(p) : calmMotionForPose(p),
  );
  const hint = String(lyricHint || "").toLowerCase();
  const wash =
    !forceCalm &&
    /wash|soap|scrub|splash|rinse|bubble|suds|hands|sink|tap/.test(hint)
      ? WASH_HINT_MOTION
      : null;
  const continuity = continuityMotionExtras(
    { actionPhase, cutMotivation, bridge, enterDir, characters: [{ pose: poses[0] }] },
    prevBeat,
  );
  return [
    "cartoon preschool music video still",
    STORY_MOTION[arc] || null,
    parts.join("; "),
    ...continuity,
    wash,
    hint ? `acting out: ${String(lyricHint).slice(0, 60)}` : null,
    location ? `in ${String(location).replace(/_/g, " ")}` : null,
    camera ? String(camera).replace(/_/g, " ") : null,
    energetic
      ? "clear rhythmic motion on the beat, keep identity and outfit fixed"
      : "gentle natural motion, keep pose geometry, soft camera push-in, quiet preschool energy",
    "flat 2D anime cartoon style",
    energetic
      ? "no morphing, no extra limbs, readable preschool dance"
      : "no sudden pose changes, no morphing, no extra limbs, no stomping",
  ]
    .filter(Boolean)
    .join(", ");
}

export function normalizeStoryBeat(raw) {
  const s = String(raw || "")
    .toLowerCase()
    .trim();
  if (s === "problem" || s === "discovery" || s === "fun" || s === "celebration")
    return s;
  return "";
}

/** Map section + position → story arc phase. */
export function storyBeatFromSection(section, index = 0, total = 1) {
  const sec = String(section || "").toLowerCase();
  if (/intro/.test(sec)) return "problem";
  if (/verse\s*1|verse_1|verse1/.test(sec)) return "discovery";
  if (/chorus/.test(sec)) return "fun";
  if (/verse\s*2|verse_2|verse2/.test(sec)) return "fun";
  if (/outro/.test(sec)) return "celebration";
  const t = index / Math.max(1, total - 1);
  if (t < 0.2) return "problem";
  if (t < 0.4) return "discovery";
  if (t < 0.85) return "fun";
  return "celebration";
}

function expressionForStory(storyBeat, hint, mood) {
  const arc = normalizeStoryBeat(storyBeat);
  const h = String(hint || "").toLowerCase();
  if (arc === "problem") return /sad|tired|yawn/.test(h) ? "neutral" : "curious";
  if (arc === "discovery") return "curious";
  if (arc === "celebration" || arc === "fun") return "happy";
  return expressionFromHint(hint, mood);
}

function poseForStory(hint, { mood, section, theme, storyBeat } = {}) {
  const arc = normalizeStoryBeat(storyBeat) || storyBeatFromSection(section);
  let pose = poseFromLyricHint(hint, { mood, section, theme });
  // Arc soft overrides when lyric doesn't force a strong action
  const forced =
    /\b(clap|stomp|wave|tiptoe|march|wash|splash|point|stretch|yawn|walk|go)\b/i.test(
      String(hint || ""),
    );
  if (!forced) {
    if (arc === "problem") pose = mood === "calm" ? "sit" : "stand";
    else if (arc === "discovery") pose = "point";
    else if (arc === "fun") {
      if (/stomp|march/.test(String(theme || ""))) pose = /stomp/.test(theme) ? "stomp" : "walk";
      else pose = "clap";
    } else if (arc === "celebration") pose = "hands_up";
  }
  if (arc === "problem" && (pose === "stomp" || pose === "hands_up")) pose = "stand";
  if (arc === "celebration" && pose === "stand") pose = "wave";
  return pose;
}

export function pickWanLength(windowSec, fps = 16, preferred = KIDS_HIT_WAN_LENGTH) {
  const maxFrames = Math.max(17, Math.floor(Number(windowSec || 5) * fps) | 0);
  let n = preferred;
  if (n > maxFrames) {
    n = Math.max(1, Math.floor((maxFrames - 1) / 4) * 4 + 1);
  }
  if ((n - 1) % 4 !== 0) {
    n = Math.max(1, Math.round((n - 1) / 4) * 4 + 1);
  }
  const capped =
    maxFrames % 4 === 1
      ? maxFrames
      : Math.floor((maxFrames - 1) / 4) * 4 + 1;
  return Math.min(n, capped);
}

export function assignBeatTimings(beats, durationSec) {
  const dur = Math.max(1, Number(durationSec) || KIDS_HIT_DURATION_SEC);
  const list = Array.isArray(beats) ? beats.map((b) => ({ ...b })) : [];
  if (!list.length) return list;

  const hasAll = list.every(
    (b) =>
      Number.isFinite(Number(b.startSec)) &&
      Number.isFinite(Number(b.endSec)) &&
      Number(b.endSec) > Number(b.startSec),
  );

  if (!hasAll) {
    const slot = dur / list.length;
    for (let i = 0; i < list.length; i++) {
      list[i].startSec = Math.round(i * slot * 1000) / 1000;
      list[i].endSec =
        i === list.length - 1
          ? dur
          : Math.round((i + 1) * slot * 1000) / 1000;
    }
    return list;
  }

  list.sort((a, b) => Number(a.startSec) - Number(b.startSec));
  list[0].startSec = 0;
  for (let i = 0; i < list.length; i++) {
    list[i].startSec = Number(list[i].startSec);
    list[i].endSec = Number(list[i].endSec);
    if (i > 0 && list[i].startSec < list[i - 1].endSec) {
      list[i].startSec = list[i - 1].endSec;
    }
    if (list[i].endSec <= list[i].startSec) {
      list[i].endSec = list[i].startSec + dur / list.length;
    }
  }
  list[list.length - 1].endSec = dur;
  return list;
}

/**
 * Clamp beat count into [min,max] by merging consecutive similar beats, then retime.
 */
export function clampBeatCount(beats, durationSec, min = KIDS_HIT_BEAT_MIN, max = KIDS_HIT_BEAT_MAX) {
  let list = Array.isArray(beats) ? beats.map((b) => ({ ...b })) : [];
  if (!list.length) return list;

  // Merge consecutive identical pose+location while over max
  while (list.length > max) {
    let best = -1;
    let bestScore = -1;
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i];
      const b = list[i + 1];
      const poseA = a.characters?.[0]?.pose || a.pose;
      const poseB = b.characters?.[0]?.pose || b.pose;
      let score = 0;
      if (a.location === b.location) score += 2;
      if (poseA === poseB) score += 3;
      if (String(a.section) === String(b.section)) score += 1;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) best = list.length - 2;
    const keep = list[best];
    const drop = list[best + 1];
    keep.endSec = drop.endSec ?? keep.endSec;
    keep.lyricHint = keep.lyricHint || drop.lyricHint;
    list.splice(best + 1, 1);
  }

  if (list.length < min) {
    // Leave as-is; assignBeatTimings will stretch
  }

  // Renumber ids, then ALWAYS retime equally (merged windows otherwise stay huge)
  list = list.map((b, i) => {
    const { startSec, endSec, ...rest } = b;
    return {
      ...rest,
      id: `${String(i + 1).padStart(2, "0")}_${String(b.section || b.location || "beat")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "") || "beat"}`,
    };
  });

  return assignBeatTimings(list, durationSec);
}

export function locationFromLyricHint(hint, allowed = []) {
  const s = String(hint || "").toLowerCase();
  const allow = new Set(allowed);
  const pick = (id) => (allow.size === 0 || allow.has(id) ? id : null);
  if (/sink|tap|faucet|soap|suds|splash|rinse|scrub/.test(s))
    return pick("kitchen_sink") || pick("kitchen");
  if (/kitchen|wash|cook|fridge|hands/.test(s)) return pick("kitchen");
  if (/outside|yard|lawn|grass|shoes on/.test(s)) {
    // "can't go outside" / "no play outside" is an indoor problem — not a lawn teleport
    if (
      /\b(no|not|can'?t|cannot|don'?t)\b[\s\S]{0,16}\b(outside|out)\b/i.test(s) ||
      /no play outside|stay inside|march inside/i.test(s)
    ) {
      return pick("home");
    }
    return pick("lawn");
  }
  if (/bed|sleep|yawn|night|pajamas|tooth|tiptoe|goodnight|dream|tucked/.test(s))
    return pick("bedroom");
  if (/dinner|dining|please|thank|eat|table|supper|ready to eat/.test(s))
    return pick("dining_room");
  if (/sofa|living|dance|freeze|toys|tidy/.test(s)) return pick("home");
  return null;
}

/** Map lyric/section → pose. Never maps "tap" to tiptoe. */
export function poseFromLyricHint(hint, { mood = "energetic", section = "", theme = "" } = {}) {
  const h = String(hint || "").toLowerCase();
  const sec = String(section || "").toLowerCase();
  const th = String(theme || "").toLowerCase();

  // Word-boundary tiptoe only — "tap" must NEVER become tiptoe
  if (/\btiptoe\b|tip-toe|tip toe/.test(h)) return "tiptoe";
  if (/yawn|stretch|arms up|arms to the ceiling|reach up/.test(h)) return "hands_up";
  if (/freeze|still|ready to eat|smile and sing/.test(h)) return "stand";
  if (/sleep|tucked|goodnight|dream|\bbed\b/.test(h) && mood === "calm") return "sit";
  if (/tap|faucet|point|look at|turn the/.test(h)) return "point";
  if (/towel|wipe|dry|\bwave\b|hello/.test(h)) return "wave";
  if (/walk|march|\bgo\b|dance|chase|twirl|leap|jump|spin|bounce|shoes/.test(h))
    return mood === "calm" ? "tiptoe" : "walk";
  if (/\bstomp\b/.test(h) && mood !== "calm") return "stomp";
  if (/clap|wash|soap|scrub|splash|rinse|bubble|suds|clean|dirt|hands/.test(h))
    return "clap";
  if (/chorus/.test(sec) && mood !== "calm") {
    if (/stomp|march/.test(th) || /\bmarch\b/.test(h)) return /stomp/.test(th) ? "stomp" : "walk";
    return "clap";
  }
  if (mood === "calm") return /\btiptoe\b/.test(h) ? "tiptoe" : "stand";
  return "stand";
}

function expressionFromHint(hint, mood) {
  const h = String(hint || "").toLowerCase();
  if (/splash|clap|stomp|yay|happy|smile/.test(h)) return "happy";
  if (/curious|look|point|tap/.test(h)) return "curious";
  if (mood === "calm" || /sleep|yawn|gentle|quiet/.test(h)) return "gentle_smile";
  return "happy";
}

function sectionLocation(section, palette, defLoc, index, total, storyBeat) {
  const sec = String(section || "").toLowerCase();
  const arc = normalizeStoryBeat(storyBeat) || storyBeatFromSection(section, index, total);
  const p = palette.length ? palette : [defLoc];
  if (p.length === 1) return p[0];
  // Story journey through rooms
  if (arc === "problem") return p[0];
  if (arc === "discovery") return p[Math.min(1, p.length - 1)];
  if (arc === "fun") return p[0];
  if (arc === "celebration") return p[p.length - 1];
  if (/outro/.test(sec)) return p[p.length - 1];
  if (/intro/.test(sec)) return p[0];
  if (/chorus/.test(sec)) return p[0];
  if (/verse/.test(sec)) return p[Math.min(1, p.length - 1)];
  return p[index % p.length];
}

export function repairKidsHitBeats(beats, { theme, allowedLocations, durationSec } = {}) {
  const mood = kidsHitMood(theme);
  const palette = kidsHitLocationPalette(theme, allowedLocations);
  const defLoc = palette[0] || kidsHitDefaultLocation(theme, allowedLocations);
  const paletteSet = new Set(palette);
  let list = Array.isArray(beats) ? beats.map((b) => ({ ...b })) : [];

  const facings = ["front", "three_quarter_left", "front", "three_quarter_right"];
  const poseAlts = {
    problem: mood === "calm" ? ["sit", "stand", "tiptoe"] : ["stand", "point", "wave"],
    discovery: ["point", "walk", "clap", "wave"],
    fun:
      mood === "calm"
        ? ["tiptoe", "wave", "hands_up"]
        : ["clap", "walk", "stomp", "hands_up", "wave"],
    celebration: ["hands_up", "wave", "clap", "stand"],
  };

  for (let i = 0; i < list.length; i++) {
    const beat = list[i];
    const hint = String(beat.lyricHint || "");
    const arc =
      normalizeStoryBeat(beat.storyBeat) ||
      storyBeatFromSection(beat.section, i, list.length);
    beat.storyBeat = arc;

    const hintLoc = locationFromLyricHint(hint, palette);
    let loc = String(beat.location || "").toLowerCase();
    if (!paletteSet.has(loc)) loc = "";
    if (hintLoc) loc = hintLoc;
    if (!loc) {
      loc = sectionLocation(beat.section, palette, defLoc, i, list.length, arc);
    }
    if (mood === "calm") loc = palette.includes("bedroom") ? "bedroom" : defLoc;
    // Wash actions prefer sink plate
    if (/wash|soap|splash|rinse|scrub|suds|sink/.test(hint.toLowerCase())) {
      if (paletteSet.has("kitchen_sink")) loc = "kitchen_sink";
      else if (paletteSet.has("kitchen")) loc = "kitchen";
    }
    beat.location = loc;

    const chars = Array.isArray(beat.characters) ? beat.characters : [];
    if (!chars[0]) {
      chars[0] = { name: "Adam", pose: "stand", expression: "curious", facing: "front" };
    }
    let pose = poseForStory(hint, {
      mood,
      section: beat.section,
      theme,
      storyBeat: arc,
    });
    if (pose === "tiptoe" && mood !== "calm" && !/\btiptoe\b|tip-toe|tip toe/i.test(hint)) {
      pose = "stand";
    }
    if (mood === "calm" && (pose === "stomp" || pose === "clap")) pose = "tiptoe";
    chars[0].name = "Adam";
    chars[0].pose = pose;
    chars[0].expression = expressionForStory(arc, hint, mood);
    chars[0].facing = facings[i % facings.length];
    beat.characters = chars;

    // Story journey placement — never left+near (tiny corner kid)
    let slot = "center";
    let depth = "mid";
    if (arc === "problem") {
      slot = i % 2 === 0 ? "left" : "center";
      depth = "mid";
    } else if (arc === "discovery") {
      slot = pose === "walk" ? (i % 2 === 0 ? "left" : "right") : "center";
      depth = loc === "kitchen_sink" ? "far" : "mid";
    } else if (arc === "fun") {
      slot = pose === "walk" ? (i % 2 === 0 ? "left" : "right") : "center";
      depth = "mid";
    } else {
      // celebration
      slot = "center";
      depth = "near";
    }
    if (loc === "kitchen_sink") {
      slot = "center";
      depth = "far";
    }
    // Edge slots must stay mid/far so toddler fills frame
    if ((slot === "left" || slot === "right") && depth === "near") depth = "mid";
    beat.placement = { Adam: slot };
    beat.depth = depth;

    // Camera follows emotional energy
    if (arc === "problem" || arc === "discovery") {
      beat.camera = i % 2 === 0 ? "medium_full" : "medium";
    } else {
      beat.camera = i % 2 === 0 ? "full_body" : "medium_full";
    }
  }

  // Force multi-location when palette allows
  if (palette.length > 1 && mood !== "calm") {
    const uniq = new Set(list.map((b) => b.location));
    if (uniq.size < 2) {
      for (let i = 0; i < list.length; i++) {
        list[i].location = sectionLocation(
          list[i].section,
          palette,
          defLoc,
          i,
          list.length,
          list[i].storyBeat,
        );
      }
    }
  }

  // Ensure all four story phases appear when we have enough beats
  if (list.length >= 8) {
    const have = new Set(list.map((b) => b.storyBeat));
    if (!have.has("problem") && list[0]) list[0].storyBeat = "problem";
    if (!have.has("discovery") && list[2]) list[2].storyBeat = "discovery";
    if (!have.has("fun")) {
      const mid = Math.floor(list.length / 2);
      if (list[mid]) list[mid].storyBeat = "fun";
    }
    if (!have.has("celebration") && list[list.length - 1]) {
      list[list.length - 1].storyBeat = "celebration";
      list[list.length - 1].characters[0].pose = "hands_up";
      list[list.length - 1].characters[0].expression = "happy";
      list[list.length - 1].placement = { Adam: "center" };
      list[list.length - 1].depth = "near";
    }
  }

  // Break pose spam within same arc
  for (let i = 2; i < list.length; i++) {
    const a = list[i - 2].characters?.[0]?.pose;
    const b = list[i - 1].characters?.[0]?.pose;
    const c = list[i].characters?.[0]?.pose;
    if (a && a === b && b === c) {
      const alts = poseAlts[list[i].storyBeat] || poseAlts.fun;
      const next = alts[(i + 1) % alts.length];
      list[i].characters[0].pose = next === c ? alts[(i + 2) % alts.length] : next;
    }
  }

  // Continuity: bridge teleports, then fill cause/effect/dirs/phases
  const objective = objectiveForTheme(theme);
  const allowedForBridge = [
    ...palette,
    ...[...BRIDGE_LOCATIONS].filter(
      (id) => !allowedLocations?.length || allowedLocations.includes(id),
    ),
  ];
  list = insertBridgeBeats(list, allowedForBridge);
  list = applyContinuityFields(list, { objective, theme });

  list = clampBeatCount(
    list,
    durationSec || KIDS_HIT_DURATION_SEC,
    KIDS_HIT_BEAT_MIN,
    KIDS_HIT_BEAT_MAX,
  );

  // Re-stamp storyBeat + continuity after clamp renumbers
  for (let i = 0; i < list.length; i++) {
    if (!normalizeStoryBeat(list[i].storyBeat)) {
      list[i].storyBeat = storyBeatFromSection(list[i].section, i, list.length);
    }
  }
  list = applyContinuityFields(list, { objective, theme });
  return list;
}

/** Full kids-hit plan repair + continuity validation helper. */
export function finalizeKidsHitPlan(plan, { theme, allowedLocations, durationSec } = {}) {
  const objective = plan.objective || objectiveForTheme(theme || plan.theme || "");
  const beats = repairKidsHitBeats(plan.beats || [], {
    theme: theme || plan.theme,
    allowedLocations,
    durationSec: durationSec || plan.durationSec || KIDS_HIT_DURATION_SEC,
  });
  const out = {
    ...plan,
    kidsHit: true,
    objective,
    theme: theme || plan.theme,
    durationSec: durationSec || plan.durationSec || KIDS_HIT_DURATION_SEC,
    beats,
  };
  out.continuityIssues = validateContinuity(out);
  return out;
}

/**
 * Timed stitch plan: one segment per clip, targetSec = beat window.
 * Stitch must ffmpeg-trim/loop each segment to exactly targetSec (no double-play drift).
 */
export function buildTimedSegmentPlan(clips, audioDur) {
  const target = Math.max(0.1, Number(audioDur) || 0);
  const segments = [];
  const loopCounts = {};

  if (!clips?.length || target <= 0) {
    return { segments, loopCounts, plannedSec: 0 };
  }

  const timed = clips.every(
    (c) =>
      Number.isFinite(Number(c.startSec)) &&
      Number.isFinite(Number(c.endSec)) &&
      Number(c.endSec) > Number(c.startSec),
  );

  if (timed) {
    let planned = 0;
    for (const c of clips) {
      const window = Math.max(0.05, Number(c.endSec) - Number(c.startSec));
      segments.push({ path: c.path, targetSec: window });
      loopCounts[c.path] = 1;
      planned += window;
    }
    // If windows sum short of audio, extend last segment
    if (planned + 0.05 < target && segments.length) {
      const deficit = target - planned;
      segments[segments.length - 1].targetSec += deficit;
      planned = target;
    }
    return { segments, loopCounts, plannedSec: planned };
  }

  // Equal share fallback
  const share = target / clips.length;
  let planned = 0;
  for (const c of clips) {
    segments.push({ path: c.path, targetSec: share });
    loopCounts[c.path] = 1;
    planned += share;
  }
  return { segments, loopCounts, plannedSec: planned };
}

/** @deprecated use buildTimedSegmentPlan for kids-hit; kept for untimed loop-fill */
export function buildLoopFillPlan(clips, audioDur) {
  const timed = buildTimedSegmentPlan(clips, audioDur);
  if (timed.segments.length && clips.every((c) => c.startSec != null)) {
    return {
      entries: timed.segments.map((s) => s.path),
      loopCounts: timed.loopCounts,
      plannedSec: timed.plannedSec,
      segments: timed.segments,
    };
  }

  const target = Math.max(0.1, Number(audioDur) || 0);
  const loopCounts = {};
  const entries = [];
  let planned = 0;
  let i = 0;
  let guard = 0;
  while (planned + 0.05 < target && guard < 2000 && clips?.length) {
    const c = clips[i % clips.length];
    entries.push(c.path);
    const d = Math.max(0.05, Number(c.durationSec) || 3);
    planned += d;
    loopCounts[c.path] = (loopCounts[c.path] || 0) + 1;
    i += 1;
    guard += 1;
  }
  return { entries, loopCounts, plannedSec: planned, segments: null };
}

export function fillKidsHitPrompt(template, vars) {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{{${k}}}`, String(v ?? ""));
  }
  return out;
}
