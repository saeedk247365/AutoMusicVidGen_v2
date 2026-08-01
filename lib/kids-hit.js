/**
 * Opt-in kids-hit helpers. Classic 02_0 / 02_1 / 02_2 defaults stay unchanged
 * unless callers pass --kids-hit / --loop-fill.
 */

import {
  objectiveForTheme,
  objectiveIsIndoor,
  applyContinuityFields,
  insertBridgeBeats,
  validateContinuity,
  continuityMotionExtras,
  enforceScreenContinuity,
  journeyLocation,
  roomFamily,
  isBridgeLoc,
  bridgeLocationForTransition,
  normalizeActionPhase,
  normalizeBeatRole,
  normalizeCameraMotion,
  BRIDGE_LOCATIONS,
} from "./kids-hit-continuity.js";

export {
  objectiveForTheme,
  objectiveIsIndoor,
  validateContinuity,
  insertBridgeBeats,
  applyContinuityFields,
  enforceScreenContinuity,
  journeyLocation,
  normalizeActionPhase,
  normalizeBeatRole,
  normalizeCameraMotion,
  BRIDGE_LOCATIONS,
} from "./kids-hit-continuity.js";

export const KIDS_HIT_DURATION_SEC = 75;
export const KIDS_HIT_BEAT_MIN = 14;
/** Soft max so living-story can keep react/anticipate micro-beats. */
export const KIDS_HIT_BEAT_MAX = 20;
export const KIDS_HIT_WAN_LENGTH = 81; // ~5.06s @ 16fps; (n-1)%4===0

/**
 * Final output resolution presets (stills + Wan + stitch must match).
 * Default stays at current preview size; switch to `youtube` for production.
 */
export const OUTPUT_RESOLUTION_PRESETS = {
  preview: {
    id: "preview",
    label: "Preview 768×768",
    stillWidth: 768,
    stillHeight: 768,
    charWidth: 512,
    charHeight: 768,
    wanWidth: 768,
    wanHeight: 768,
  },
  youtube: {
    id: "youtube",
    // Wan / VAE need multiples of 16 — true 1080 is not (1080 % 16 === 8).
    label: "YouTube 1920×1088",
    stillWidth: 1920,
    stillHeight: 1088,
    charWidth: 720,
    charHeight: 1088,
    wanWidth: 1920,
    wanHeight: 1088,
  },
};

export const DEFAULT_OUTPUT_RESOLUTION = "preview";

export function listOutputResolutions() {
  return Object.values(OUTPUT_RESOLUTION_PRESETS).map((p) => ({
    id: p.id,
    label: p.label,
    stillWidth: p.stillWidth,
    stillHeight: p.stillHeight,
    wanWidth: p.wanWidth,
    wanHeight: p.wanHeight,
  }));
}

export function resolveOutputResolution(idOrPreset) {
  if (idOrPreset && typeof idOrPreset === "object") {
    const p = idOrPreset;
    if (p.stillWidth && p.wanWidth) return { ...OUTPUT_RESOLUTION_PRESETS.preview, ...p };
  }
  const key = String(idOrPreset || DEFAULT_OUTPUT_RESOLUTION)
    .toLowerCase()
    .trim();
  return (
    OUTPUT_RESOLUTION_PRESETS[key] ||
    OUTPUT_RESOLUTION_PRESETS[DEFAULT_OUTPUT_RESOLUTION]
  );
}

/** Kids-hit Wan frame size (square — matches keyframe stills). Alias of preview preset. */
export const KIDS_HIT_WAN_WIDTH =
  OUTPUT_RESOLUTION_PRESETS.preview.wanWidth;
export const KIDS_HIT_WAN_HEIGHT =
  OUTPUT_RESOLUTION_PRESETS.preview.wanHeight;

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
  "mom and adam wash hands",
  "morning stretch with mom",
  "tidy toys with mom",
  "bedtime story with mom",
  "porch wave with mom",
  "playroom dance with mom",
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

Write a SHORT home singalong (about 75 seconds when sung) as ONE tiny lived adventure — characters DOING things to each other and the world, never a pose checklist.

Theme (ONLY this — must happen at home / yard / kitchen / bedroom):
{{THEME}}

Educational focus (light touch):
{{EDU_FOCUS}}

Primary chorus movement (must appear clearly in every chorus):
{{MOVEMENT}}

Mood: {{MOOD}}

ONE OBJECTIVE (required):
The whole song has ONE goal a toddler can say out loud (examples: march inside because rain; wash hands then eat; find teddy for bed; tidy toys; morning stretch with Mom).
Write it on the first line after TITLE as:
OBJECTIVE: ...

LIVED CHAIN (required — each line is a CAUSE of the next):
Write what characters NOTICE and DO, not frozen poses.
Good: stuck in sheets → Mom kneels nearby → I look up → Mom waves open arms → I stretch → we dance side by side → ready
Bad: stand → wave → stand → smile → stand
NEVER write hugs, kisses, embraces, holding, wrapping arms, hand-holding, high-fives, cheek-to-cheek, or "pull close" — kids-safe near-space play only (look, wave, kneel nearby, clap, point, stretch, dance beside).

MINI STORY ARC (escalate energy):
1. PROBLEM (Intro) — stuck / can't / oh no (soft, small)
2. DISCOVERY (Verse 1) — notice helper or idea; look → try
3. FUN (Chorus) — bigger motion; peak on second chorus
4. MORE FUN (Verse 2) — same objective, one new twist
5. CELEBRATION (Outro) — smile / wave / done (warm resolve) — NO hug

HARD RULES:
- Setting must be depictable in: kitchen, kitchen_sink, lawn, bedroom, home, dining_room, playroom, backyard, bathtub, porch, living_rug (doorways connect rooms)
- Name places in travel order (bed → door → rug)
- Verbs of LIVING: notice, look, kneel nearby, wave open arms (no touch), run, stretch, point, clap, march, dance beside — not "stand" as a lyric
- BANNED physical contact words: hug, kiss, embrace, hold tight, wrap arms, snuggle, cuddle, squeeze, high-five, hand-hold, cheek, pull close, pull me close
- Complete every lyric line (never cut mid-sentence)
- Bedtime: bedroom only; soft words; no stomping/lawn
- NO zoo, ocean, space, pirates, jungle trips
- Max 6 words per finished line
- BANNED filler: thin, real neat, no trap, so bold, like a rabbit, happy snap, oh what a delight
- Cast: toddler hero (Adam). Mom (Sasha) may help when theme/lyrics need her. Prefer "I"/"my"; short Mom cues ("Mom kneels", "Mom waves") — never "Mom hugs"

Structure:
[Intro]     ← PROBLEM (stuck)
[Verse 1]   ← DISCOVERY (notice → try)
[Chorus]    ← FUN (build)
[Verse 2]   ← twist on same objective
[Chorus]    ← bigger FUN / peak
[Outro]     ← CELEBRATION (resolve)

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
export const KIDS_HIT_SCENES_PROMPT = `You plan preschool music-video BEATS as a LIVED adventure — characters interacting through a chain, never a pose slideshow of standing in places.

North star: kids watch characters DO things TO each other. Every beat answers "what happens because of that?"

Continuity + living-story contract:
- ONE objective for the whole song: {{OBJECTIVE}}
- Cause → effect on EVERY beat (previous effect = this cause)
- Room changes need GOING there (exit / door / bridge) — never teleport
- Cuts need motivation: look, point, exit, object, match_action, energy
- Action phases across neighbors: setup → anticipate → action → react → followthrough → peak
- Each big move has wind-up AND settle (never run→hard cut with no react)
- Energy escalates: problem (soft) → discovery → fun → peak fun → celebration
- Visual rhythm: alternate short reaction / longer action / short joke / longer anticipation — not same length every shot
- Idle "business": characters never freeze — toddler bounces/rocks/looks; helper shifts weight/nods/tiny hands
- Emotion PROGRESSES (not flat smile): problem soft → discovery surprise/curious → fun happy → peak excited → celebration warm
- Reaction shots: when helper points/kneels/waves open arms, next beat shows toddler NOTICE → feel → respond
- Camera JOINS the story: lower when kneel, track when run/walk, push_in on find/laugh, close on reaction, pull_back / hold_wide on celebration
- Interaction field: short verb chain (e.g. "Mom kneels nearby → Adam looks up → Mom waves → Adam stretches")
- NO physical contact: never hug, kiss, embrace, hold, wrap arms, high-five, cheek-to-cheek, pull close — near-space social play only

Characters (cast-agnostic roles):
- Lead toddler (Adam) REQUIRED on every beat — drives the journey
- Helper Mom (Sasha) OPTIONAL (~1/3–1/2 of beats when lyrics/theme say Mom/help). Mom poses: stand, kneel, wave, point, hands_up, walk — never stomp/tiptoe/clap-dance
- Prefer INTERACTION over solo: notice → kneel nearby → look up → wave open arms → stretch → dance beside beats standing then waving alone
- Characters may stand NEAR each other mid-frame but bodies must NOT touch

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
- Each beat ONE frozen instant that advances the objective through ACTION or REACTION.
- BAN pose spam: no stand→wave→stand→smile loops. Prefer notice/kneel/stretch/clap/dance-beside chains.
- NEVER schedule hugs, kisses, embraces, or any body contact.
- Fields required on EVERY beat:
  storyBeat ("problem"|"discovery"|"fun"|"celebration"),
  cause, effect, interaction, lyricHint, startSec, endSec,
  cutMotivation, actionPhase, beatRole, cameraMotion, emotionIntensity (1-5),
  exitDir, enterDir,
  placement left|center|right per character, depth near|mid|far
- Intro=problem; Verse1=discovery; Chorus=fun (second chorus = peak energy); Verse2=fun twist; Outro=celebration
- Prefer 2–3 story rooms. Doorway/hallway only for travel (pipeline also inserts bridges).
- Bedtime: ALL bedroom.
- Pose matches lyric + escalating energy. tap→point NEVER tiptoe.
- Neighbor same pose → anticipate then action/followthrough (match_action).
- Same pose ≤2 times in a row.
- BOTH Adam+Sasha: Adam left/center, Sasha right — never same slot.
- SCREEN CONTINUITY (toddler is continuity lead):
  - Same room: keep Adam placement; NEVER left↔right teleport for variety
  - enterDir of beat N = opposite of exitDir of N-1 on room change
  - Facing front (or same) in-room; angle only when walking out
  - Indoor/raining objective: NEVER lawn destination
  - No room revisit without doorway reason; progressive journey only

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
      "effect": "stuck and looks for Mom",
      "interaction": "Adam stuck → looks around",
      "lyricHint": "stuck in bed",
      "cutMotivation": "look",
      "actionPhase": "setup",
      "beatRole": "setup",
      "cameraMotion": "hold_wide",
      "emotionIntensity": 1,
      "exitDir": "center",
      "enterDir": "center",
      "startSec": 0,
      "endSec": 4,
      "camera": "medium_full",
      "depth": "mid",
      "placement": { "Adam": "left" },
      "characters": [
        {
          "name": "Adam",
          "pose": "sit",
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
  /\b(clean|bright|done|ready|smile|yay|sun|cozy|goodnight|thank|happy|all done|finished|tidy|warm|wave|bedtime|shine|cheer|clap)\b/i;

const ENERGETIC_POSES = new Set([
  "stomp",
  "clap",
  "wave",
  "hands_up",
  "walk",
]);

const ENERGETIC_MOTION = {
  stand:
    "alive idle: weight shifting, soft bounce, looking around, tiny hand fidgets, never a frozen statue",
  sit: "sitting with soft rock, posture shifts, head bob, curious glances",
  kneel: "kneeling with torso sway, open inviting energy, tiny nod",
  walk:
    "anticipation then clear steps in place on the beat, knees lifting, arms swinging, then soft settle — not a teleport cut",
  tiptoe: "tiptoeing in place softly, heels raised, careful quiet steps, tiny wobble",
  wave: "wind-up then big enthusiastic wave, arm swinging high, follow-through settle",
  point: "looks then points clearly, arm extended with small pulse, holds for reaction",
  hands_up: "leans into stretch, arms rise high, bounce on the beat, joyful preschool peak",
  clap: "gets excited then rhythmic clapping 3 to 4 times, whole-body bounce, laugh settle",
  stomp: "leans forward then stomps alternately on the beat, knees lifting, whole-body bounce",
};

const CALM_MOTION = {
  stand: "standing with soft breath sway, tiny blinks and head turns, alive calm idle",
  sit: "sitting on the floor, soft sleepy rock, gentle breathing, looking around softly",
  kneel: "kneeling quietly, warm torso sway, soft nod",
  walk: "slow quiet steps in place with soft settle",
  tiptoe: "tiptoeing softly in place, heels up, quiet careful motion",
  wave: "small gentle wave goodnight with soft follow-through",
  point: "soft look then pointing gesture, tiny motion",
  hands_up: "slow stretch upward then relaxing yawn settle",
  clap: "soft quiet claps once or twice with a smile settle",
  stomp: "very soft foot taps, no stomping energy",
};

const TODDLER_IDLE =
  "toddler idle business: bounce rock clap-ready hands, wobble look-around, never frozen";
const HELPER_IDLE =
  "helper idle business: shift weight, soft nod, tiny hand motion, breathing sway, never frozen";

const PHASE_MOTION = {
  setup: "quiet setup moment, noticing, soft start of the beat",
  anticipate: "anticipation wind-up, leans in, about to move, not finished yet",
  action: "clear mid-action readable motion driving the story",
  react: "quick reaction beat — face and body respond to what just happened",
  followthrough: "follow-through settle after the move, soft finish, hold the feeling",
  peak: "peak energy payoff, biggest readable motion of the arc so far",
};

const CAMERA_MOTION_TEXT = {
  none: null,
  push_in: "camera softly pushes in toward the face like joining the moment",
  track: "camera gently tracks with the character motion",
  lower: "camera lowers toward toddler eye level",
  hold_wide: "camera holds a wider readable frame for the group moment",
  pull_back: "camera softly pulls back to show both characters together",
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
  if (/mom|sasha|help/.test(t) && /wash|hands|kitchen/.test(t))
    return keep("kitchen", "kitchen_sink", "home", "doorway", "hallway");
  if (/mom|sasha/.test(t) && /bed|story|night/.test(t))
    return keep("bedroom", "doorway", "hallway");
  if (/mom|sasha/.test(t) && /porch|wave/.test(t))
    return keep("porch", "home", "doorway", "hallway");
  if (/mom|sasha/.test(t) && /playroom|dance|tidy/.test(t))
    return keep("playroom", "living_rug", "home", "doorway", "hallway");
  if (/mom|sasha/.test(t) && /morning|stretch|wake/.test(t))
    return keep("bedroom", "living_rug", "home", "doorway", "hallway");
  if (/mom|sasha|help/.test(t))
    return keep("home", "living_rug", "kitchen", "playroom", "bedroom", "doorway", "hallway");
  if (/kitchen|wash|cook|hands/.test(t))
    return keep("kitchen", "kitchen_sink", "dining_room", "home", "doorway", "hallway");
  if (/lawn|outside|shoes|hop|yard|backyard/.test(t))
    return keep("lawn", "backyard", "porch", "home", "doorway", "hallway");
  if (/dining|table|please|thank/.test(t))
    return keep("dining_room", "kitchen", "kitchen_sink", "home", "doorway", "hallway");
  if (/living|dance|freeze|share|toy|tidy|playroom|rug/.test(t))
    return keep("home", "living_rug", "playroom", "kitchen", "bedroom", "doorway", "hallway");
  if (/bath|tub|splash|bubble/.test(t))
    return keep("bathtub", "bedroom", "hallway", "doorway");
  if (/rainy|march/.test(t))
    return keep("home", "kitchen", "hallway", "doorway");
  if (/stomp|clap at home|morning/.test(t))
    return keep("home", "living_rug", "kitchen", "bedroom", "doorway", "hallway");
  return keep("home", "kitchen", "playroom", "doorway", "hallway");
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
  if (/\b(we are all|we'?re all|dad|brother|sister|family of|parents|let'?s all)\b/i.test(text)) {
    issues.push("extra_cast_or_adults");
  }
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^\[/.test(l) && !/^TITLE:/i.test(l) && !/^OBJECTIVE:/i.test(l) && !/^LYRICS:/i.test(l));
  for (const line of lines) {
    const words = line.replace(/[^a-zA-Z\s']/g, "").split(/\s+/).filter(Boolean);
    if (words.length > 7) issues.push(`line_too_long:${line.slice(0, 40)}`);
    // Hard fail incomplete chops (the old shortenKidsLyricLines bug)
    if (
      /,\s*(can't|cannot|my|your|her|his|the|a|an|so|to|for|and|i|we|she|he)$/i.test(line) ||
      /\b(i'?m|we'?re|she|he|mom|opens?|says?)\s*$/i.test(line) ||
      /"[^"]*$/.test(line) ||
      / —\s*$/.test(line) ||
      /\b(too|so)\s*$/i.test(line)
    ) {
      issues.push(`truncated_line:${line.slice(0, 40)}`);
    }
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
      /living|sofa|toys|home|rug/i.test(text),
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
  return stripPhysicalContactLanguage(
    String(text || "")
      .replace(/\u2019/g, "'")
      .replace(/\u2018/g, "'")
      .replace(/\u201C|\u201D/g, '"')
      .replace(/\u2026/g, "...")
      .replace(/\r\n/g, "\n"),
  );
}

/**
 * Normalize lyrics WITHOUT mid-line chopping.
 * Long lines stay intact so QA can reject and regenerate complete short lines.
 */
export function shortenKidsLyricLines(lyrics, maxWords = 6) {
  void maxWords;
  return normalizeKidsLyricsText(lyrics);
}

/** Repair known incomplete lyric endings into complete short preschool lines. */
export function repairTruncatedLyricLines(lyrics) {
  const fixes = [
    [/i'?m stuck in my bed,?\s*can'?t\s*$/i, "Stuck in bed now"],
    [/my blanket'?s? too tight,?\s*i'?m stuck\s*$/i, "Blanket too tight"],
    [/mom kneels by me,?\s*her voice\s*$/i, "Mom kneels by me"],
    [/i look up,?\s*she opens her\s*$/i, "Mom opens her arms"],
    [/i stretch my arms,?\s*i stretch\s*$/i, "I stretch my arms"],
    [/i reach for mom,?\s*i do\s*$/i, "I reach for Mom"],
    [/i run to the rug,?\s*i\s*$/i, "I run to the rug"],
    [/mom laughs,?\s*i stretch,?\s*we both\s*$/i, "Mom laughs we stretch"],
    [/i hug mom tight,?\s*i do\s*$/i, "I smile at Mom"],
    [/we hug and we giggle,?\s*we'?re\s*$/i, "We giggle and wave"],
    [/we hug tight and high\.?/i, "We dance side by side"],
    [/we hug tight and sound\.?/i, "We clap and smile"],
    [/mom pulls me close\.?/i, "Mom waves open arms"],
    [/morning hug done\.?/i, "Morning stretch done"],
    [/\bhug\b/gi, "wave"],
    [/\bkiss(?:es|ed|ing)?\b/gi, "smile"],
    [/\bembrace(?:d|s)?\b/gi, "wave"],
    [/\bsnuggle(?:d|s)?\b/gi, "smile"],
    [/\bcuddle(?:d|s)?\b/gi, "smile"],
    [/with a morning stretch,?\s*i feel\s*$/i, "Morning stretch feels good"],
    [/mom says,?\s*"?time to stretch,?\s*my\s*"?\s*$/i, "Mom says stretch now"],
    [/bend and wiggle\s*[—-]?\s*feel so\s*$/i, "Bend and wiggle now"],
  ];
  return String(lyrics || "")
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trimEnd();
      if (!trimmed || /^\[/.test(trimmed) || /^TITLE:/i.test(trimmed) || /^OBJECTIVE:/i.test(trimmed)) {
        return trimmed;
      }
      for (const [re, fixed] of fixes) {
        if (re.test(trimmed.trim())) return fixed;
      }
      // Generic: trailing dangling word after comma → drop dangling clause
      const m = trimmed.match(/^(.*),\s*(can't|cannot|my|your|her|his|the|a|an|so|to|for|and|i|we|she|he)\s*$/i);
      if (m && m[1].split(/\s+/).filter(Boolean).length >= 2) {
        return m[1].trim();
      }
      return trimmed;
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

function poseMotionForContinuity(poseId, { energetic, phase, hasPrev }) {
  const full = energetic
    ? energeticMotionForPose(poseId)
    : calmMotionForPose(poseId);
  if (!hasPrev) return full;
  // Later shots: avoid "looks then points" / full wind-up that restarts the beat.
  if (phase === "setup" || phase === "followthrough") {
    return `already holding ${poseId}, tiny alive continuation only, do not restart the gesture from the beginning`;
  }
  if (phase === "anticipate" || phase === "react") {
    return `continue mid-${poseId}: ${full}, already in the moment, no scene reset`;
  }
  return `continue the action: ${full}, do not replay the start of the scene`;
}

export function kidsHitMotionPrompt({
  poseIds,
  location,
  camera,
  mood = "energetic",
  lyricHint = "",
  storyBeat = "",
  actionPhase = "",
  beatRole = "",
  cameraMotion = "",
  interaction = "",
  emotionIntensity = 0,
  cutMotivation = "",
  bridge = false,
  enterDir = "",
  exitDir = "",
  placement = null,
  endPlacement = null,
  prevBeat = null,
  hasHelper = false,
  proximity = "",
  closeInteraction = false,
  cause = "",
  effect = "",
} = {}) {
  const poses = (poseIds || ["stand"]).map((p) => String(p || "stand"));
  const arc = normalizeStoryBeat(storyBeat);
  const phase =
    normalizeActionPhase(actionPhase) ||
    normalizeBeatRole(beatRole) ||
    "";
  const forceCalm = mood === "calm" || arc === "problem";
  const forceCelebrate = arc === "celebration" || arc === "fun";
  const energetic =
    !forceCalm &&
    (forceCelebrate ||
      phase === "peak" ||
      Number(emotionIntensity) >= 4 ||
      poses.some((p) => isEnergeticPose(p)));
  const hasPrev = !!prevBeat;
  const parts = poses.map((p) =>
    poseMotionForContinuity(p, { energetic, phase, hasPrev }),
  );
  const hint = String(lyricHint || "").toLowerCase();
  const wash =
    !forceCalm &&
    /wash|soap|scrub|splash|rinse|bubble|suds|hands|sink|tap/.test(hint)
      ? WASH_HINT_MOTION
      : null;
  const slot =
    typeof placement === "string"
      ? placement
      : placement?.Adam || placement?.adam || "center";
  const endSlot =
    typeof endPlacement === "string"
      ? endPlacement
      : endPlacement?.Adam || endPlacement?.adam || null;
  const helperPresent =
    hasHelper || !!(placement?.Sasha || placement?.sasha);
  const prox = String(proximity || (closeInteraction ? "close" : "")).toLowerCase();
  const contact =
    closeInteraction || prox === "close" || prox === "contact";
  const continuity = continuityMotionExtras(
    {
      actionPhase: phase,
      beatRole: beatRole || phase,
      cameraMotion,
      cutMotivation,
      bridge,
      enterDir,
      exitDir,
      location,
      placement: { Adam: slot },
      endPlacement: endSlot ? { Adam: endSlot } : { Adam: slot },
      characters: [{ pose: poses[0] }],
      proximity: prox || undefined,
      closeInteraction: contact,
      interaction,
    },
    prevBeat,
  );
  const camText =
    CAMERA_MOTION_TEXT[normalizeCameraMotion(cameraMotion)] || null;
  const prevEffect = String(prevBeat?.effect || prevBeat?.lyricHint || "").trim();
  const nowEffect = String(effect || interaction || lyricHint || "").trim();
  const storyBridge =
    hasPrev && (prevEffect || cause || nowEffect)
      ? [
          "same ongoing preschool scene, next lyric cut only",
          prevEffect
            ? `because ${prevEffect.slice(0, 70)}, now ${nowEffect.slice(0, 70) || "this lyric"}`
            : cause
              ? `because ${String(cause).slice(0, 70)}, now ${nowEffect.slice(0, 70) || "this lyric"}`
              : null,
          helperPresent
            ? "helper already in frame if shown in the still — do not make anyone newly arrive"
            : "only characters already in the still — no new person enters",
        ]
          .filter(Boolean)
          .join("; ")
      : null;
  return [
    "cartoon preschool music video still",
    STORY_MOTION[arc] || null,
    PHASE_MOTION[phase] || null,
    parts.join("; "),
    TODDLER_IDLE,
    helperPresent ? HELPER_IDLE : null,
    storyBridge,
    ...continuity,
    camText,
    wash,
    interaction
      ? `interaction chain: ${String(interaction).slice(0, 80)}`
      : null,
    hint ? `acting out: ${String(lyricHint).slice(0, 60)}` : null,
    contact
      ? "characters stay mid-frame NEAR each other with a clear gap, face each other, react, NO touching, NO hugging, NO wrapping arms"
      : helperPresent
        ? "helper stays near toddler mid-frame, react to each other, do not stand on opposite walls, NO physical contact"
        : null,
    location ? `in ${String(location).replace(/_/g, " ")}` : null,
    camera ? String(camera).replace(/_/g, " ") : null,
    energetic
      ? "clear lived motion with anticipation and follow-through, keep identity and outfit fixed"
      : "gentle lived motion with idle business, keep pose geometry, quiet preschool energy",
    "OUTFIT LOCK: toddler wears mint green t-shirt and navy pants only; mom wears solid coral pink blouse and cream long pants only; same outfits entire shot",
    "NO hat, NO beanie, NO cap, NO bag, NO purse, NO glasses, NO outfit change, NO clothing morph",
    helperPresent
      ? "toddler and helper near each other reacting, helper taller adult mom, keep each identity fixed, NO morphing together, NO touching, exact cast count only"
      : null,
    "flat 2D anime cartoon style",
    "NO kiss, NO hug, NO embrace, NO extra people, NO second child",
    "gentle preschool motion, keep exact cast count and outfits fixed",
    energetic
      ? "no morphing, no extra limbs, readable preschool interaction, no teleport across the room"
      : "no sudden pose changes, no morphing, no extra limbs, no stomping, no teleport",
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

function expressionForStory(storyBeat, hint, mood, intensity = 0) {
  const arc = normalizeStoryBeat(storyBeat);
  const h = String(hint || "").toLowerCase();
  const n = Number(intensity) || 0;
  if (/surprised|wow|oh|stuck|can't|cannot/.test(h) || (arc === "discovery" && n >= 3))
    return "surprised";
  if (/excited|yay|cheer|peak|dance/.test(h) || n >= 5) return "excited";
  if (arc === "problem") {
    if (/sad|tired|yawn|stuck/.test(h)) return "neutral";
    return n <= 1 ? "neutral" : "curious";
  }
  if (arc === "discovery") return n >= 3 ? "surprised" : "curious";
  if (arc === "celebration") return n >= 4 ? "excited" : "happy";
  if (arc === "fun") return n >= 4 ? "excited" : "happy";
  return expressionFromHint(hint, mood);
}

function poseForStory(hint, { mood, section, theme, storyBeat } = {}) {
  const arc = normalizeStoryBeat(storyBeat) || storyBeatFromSection(section);
  let pose = poseFromLyricHint(hint, { mood, section, theme });
  // Arc soft overrides when lyric doesn't force a strong action
  const forced =
    /\b(clap|stomp|wave|tiptoe|march|wash|splash|point|stretch|yawn|walk|go|hug|run|kneel|look)\b/i.test(
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

/** Soft mom-safe poses — never stomping toddler dance. */
function momPoseForStory(hint, arc, mood) {
  const h = String(hint || "").toLowerCase();
  const a = String(arc || "").toLowerCase();
  if (/kneel|welcome|open arms|wave/.test(h) || a === "celebration") return "kneel";
  if (/wave|hello|bye/.test(h)) return "wave";
  if (/point|look|door|sink/.test(h)) return "point";
  if (/walk|march|come|go/.test(h)) return "walk";
  if (/arms|yay|cheer|done/.test(h)) return "hands_up";
  if (a === "discovery") return "kneel";
  if (mood === "calm") return "kneel";
  return "stand";
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

  // Visual rhythm: short react / longer action / peak payoff — not flat chops
  const weightOf = (b, i) => {
    if (b.bridge) return 0.55;
    const role =
      normalizeBeatRole(b.beatRole) ||
      normalizeActionPhase(b.actionPhase) ||
      "";
    const arc = String(b.storyBeat || "").toLowerCase();
    const pose = b.characters?.[0]?.pose || "";
    let w = 1;
    if (role === "setup") w = 0.7;
    else if (role === "anticipate") w = 0.9;
    else if (role === "react") w = 0.65;
    else if (role === "action") w = 1.2;
    else if (role === "followthrough") w = 1.0;
    else if (role === "peak") w = 1.4;
    else if (arc === "problem") w = 0.85;
    else if (arc === "discovery") w = 1.0;
    else if (arc === "fun") w = /walk|stomp|clap|hands_up/.test(pose) ? 1.25 : 1.1;
    else if (arc === "celebration") w = 1.15;

    // Alternate rhythm vs previous beat when both would be long
    if (i > 0) {
      const prevRole =
        normalizeBeatRole(list[i - 1].beatRole) ||
        normalizeActionPhase(list[i - 1].actionPhase);
      if (
        (prevRole === "action" || prevRole === "peak") &&
        (role === "action" || role === "peak" || !role)
      ) {
        w *= 0.85;
      }
      if (prevRole === "react" && role === "react") w *= 1.15;
    }
    return Math.max(0.45, w);
  };

  const weights = list.map((b, i) => weightOf(b, i));
  const sumW = weights.reduce((a, b) => a + b, 0) || list.length;
  let t = 0;
  for (let i = 0; i < list.length; i++) {
    const span = (weights[i] / sumW) * dur;
    list[i].startSec = Math.round(t * 1000) / 1000;
    t += span;
    list[i].endSec =
      i === list.length - 1 ? dur : Math.round(t * 1000) / 1000;
  }
  list[0].startSec = 0;
  list[list.length - 1].endSec = dur;
  return list;
}

/**
 * Clamp beat count into [min,max] by merging consecutive similar beats, then retime.
 */
export function clampBeatCount(beats, durationSec, min = KIDS_HIT_BEAT_MIN, max = KIDS_HIT_BEAT_MAX) {
  let list = Array.isArray(beats) ? beats.map((b) => ({ ...b })) : [];
  if (!list.length) return list;

  // Merge consecutive similar beats while over max — never drop bridges or cross rooms
  while (list.length > max) {
    let best = -1;
    let bestScore = -1;
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i];
      const b = list[i + 1];
      if (a.bridge || b.bridge) continue;
      if (roomFamily(a.location) !== roomFamily(b.location)) continue;
      const poseA = a.characters?.[0]?.pose || a.pose;
      const poseB = b.characters?.[0]?.pose || b.pose;
      let score = 0;
      if (a.location === b.location) score += 2;
      if (poseA === poseB) score += 3;
      if (String(a.section) === String(b.section)) score += 1;
      // Prefer merging non-exit beats
      if (a.cutMotivation === "exit" || b.cutMotivation === "exit") score -= 2;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) {
      // Fallback: merge last two non-bridge same-family if possible
      for (let i = list.length - 2; i >= 0; i--) {
        if (list[i].bridge || list[i + 1].bridge) continue;
        if (roomFamily(list[i].location) !== roomFamily(list[i + 1].location)) continue;
        best = i;
        break;
      }
    }
    if (best < 0) break; // cannot merge further without breaking continuity
    const keep = list[best];
    const drop = list[best + 1];
    keep.endSec = drop.endSec ?? keep.endSec;
    keep.lyricHint = keep.lyricHint || drop.lyricHint;
    // Preserve exit side of the later beat for screen continuity
    if (drop.exitDir && drop.exitDir !== "center") keep.exitDir = drop.exitDir;
    if (drop.placement?.Adam) keep.placement = drop.placement;
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
  if (/couch|sofa|living|toys|tidy|share|rug|dance/.test(s))
    return pick("living_rug") || pick("home") || pick("playroom");
  if (/playroom|blocks|toys on the floor/.test(s)) return pick("playroom") || pick("home");
  if (/sandbox|backyard|slide/.test(s)) return pick("backyard") || pick("lawn");
  if (/bath|tub|bubble bath/.test(s)) return pick("bathtub") || pick("bedroom");
  if (/porch|doorstep|front door wave/.test(s)) return pick("porch") || pick("home");
  if (/table|dining|please|thank|eat|supper/.test(s))
    return pick("dining_room") || pick("kitchen") || pick("home");
  if (/outside|yard|lawn|grass|shoes on/.test(s)) {
    // "can't go outside" / "no play outside" is an indoor problem — not a lawn teleport
    if (
      /\b(no|not|can'?t|cannot|don'?t)\b[\s\S]{0,16}\b(outside|out)\b/i.test(s) ||
      /no play outside|stay inside|march inside|raining/i.test(s)
    ) {
      return pick("home");
    }
    return pick("backyard") || pick("lawn");
  }
  if (/bed|sleep|yawn|night|pajamas|tooth|tiptoe|goodnight|dream|tucked/.test(s))
    return pick("bedroom");
  if (/dinner|dining|please|thank|eat|table|supper|ready to eat/.test(s))
    return pick("dining_room");
  if (/door|hallway|through the door/.test(s))
    return pick("doorway") || pick("hallway") || pick("home");
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
  if (/surpris|wow|oh no|stuck|can't/.test(h)) return "surprised";
  if (/excit|yay|cheer|dance/.test(h)) return "excited";
  if (/splash|clap|stomp|happy|smile/.test(h)) return "happy";
  if (/curious|look|point|tap|notice/.test(h)) return "curious";
  if (mood === "calm" || /sleep|yawn|gentle|quiet/.test(h)) return "gentle_smile";
  return "happy";
}

function sectionLocation(section, palette, defLoc, index, total, storyBeat) {
  const arc = normalizeStoryBeat(storyBeat) || storyBeatFromSection(section, index, total);
  const storyRooms = (palette || []).filter((id) => !isBridgeLoc(id));
  return journeyLocation(arc, storyRooms, defLoc, index, total);
}

/**
 * After a bridge, do not return to a prior story room — advance to the next palette room.
 * The final palette room may be re-entered (celebration settle).
 */
function fixJourneyMonotonic(beats, storyRooms, defLoc) {
  const rooms = storyRooms?.length ? storyRooms : [defLoc || "home"];
  const lastRoom = rooms[rooms.length - 1];
  let lastStory = null;
  const closed = new Set();
  for (let i = 0; i < beats.length; i++) {
    const beat = beats[i];
    const loc = String(beat.location || "").toLowerCase();
    if (isBridgeLoc(loc) || beat.bridge) {
      // Leaving a non-final story room via bridge closes it for return
      if (lastStory && lastStory !== lastRoom) closed.add(lastStory);
      continue;
    }
    let next = loc;
    if (!rooms.includes(next)) next = lastStory || rooms[0];
    if (closed.has(next)) {
      const minIdx = Math.min(
        rooms.length - 1,
        Math.max(0, rooms.indexOf(lastStory) + 1),
      );
      next = rooms[minIdx] || lastRoom;
    }
    // Never rewind index along the palette
    if (lastStory && rooms.indexOf(next) < rooms.indexOf(lastStory)) {
      next = lastStory;
    }
    beat.location = next;
    lastStory = next;
  }
  return beats;
}

export function repairKidsHitBeats(
  beats,
  { theme, allowedLocations, durationSec, lyricsText } = {},
) {
  const mood = kidsHitMood(theme);
  const objective = objectiveForTheme(theme);
  const indoor = objectiveIsIndoor(objective, theme);
  let palette = kidsHitLocationPalette(theme, allowedLocations);
  // Strip outdoor destinations when objective is indoor
  if (indoor) {
    palette = palette.filter((id) => String(id).toLowerCase() !== "lawn");
  }
  const defLoc = palette[0] || kidsHitDefaultLocation(theme, allowedLocations);
  const paletteSet = new Set(palette);
  let list = Array.isArray(beats) ? beats.map((b) => ({ ...b })) : [];
  if (lyricsText) {
    list = spreadLyricHints(list, lyricsText);
  } else {
    list = dedupeLyricHints(list);
  }

  const poseAlts = {
    problem: mood === "calm" ? ["sit", "stand", "tiptoe"] : ["stand", "point", "wave"],
    discovery: ["point", "walk", "clap", "wave"],
    fun:
      mood === "calm"
        ? ["tiptoe", "wave", "hands_up"]
        : ["clap", "walk", "stomp", "hands_up", "wave"],
    celebration: ["hands_up", "wave", "clap", "stand"],
  };

  // Track progressive room so we never rewind without a bridge later
  let journeyCursor = 0;
  const storyRooms = palette.filter((id) => !isBridgeLoc(id));

  for (let i = 0; i < list.length; i++) {
    const beat = list[i];
    const hint = String(beat.lyricHint || "");
    const arc =
      normalizeStoryBeat(beat.storyBeat) ||
      storyBeatFromSection(beat.section, i, list.length);
    beat.storyBeat = arc;

    const hintLoc = locationFromLyricHint(hint, palette);
    let loc = String(beat.location || "").toLowerCase();
    if (indoor && loc === "lawn") loc = "";
    if (!paletteSet.has(loc)) loc = "";
    if (hintLoc && !(indoor && hintLoc === "lawn")) loc = hintLoc;
    // Story beats must not sit on doorway/hallway unless marked bridge
    if (isBridgeLoc(loc) && !beat.bridge) loc = "";
    if (!loc) {
      loc = sectionLocation(beat.section, palette, defLoc, i, list.length, arc);
    }
    if (isBridgeLoc(loc) && !beat.bridge) {
      loc = storyRooms[Math.min(journeyCursor, storyRooms.length - 1)] || defLoc;
    }
    if (mood === "calm") loc = palette.includes("bedroom") ? "bedroom" : defLoc;
    if (/wash|soap|splash|rinse|scrub|suds|sink/.test(hint.toLowerCase())) {
      if (paletteSet.has("kitchen_sink")) loc = "kitchen_sink";
      else if (paletteSet.has("kitchen")) loc = "kitchen";
    }

    // Enforce non-rewinding journey for non-bridge story rooms
    if (!isBridgeLoc(loc) && storyRooms.length > 1) {
      const idx = storyRooms.indexOf(loc);
      if (idx >= 0) {
        if (idx < journeyCursor) {
          // Backtrack — snap forward to current journey room
          loc = storyRooms[Math.min(journeyCursor, storyRooms.length - 1)];
        } else {
          journeyCursor = Math.max(journeyCursor, idx);
        }
      }
    }
    beat.location = loc;

    const chars = Array.isArray(beat.characters) ? beat.characters : [];
    // Keep Adam as lead; optionally keep/inject Sasha
    let adam =
      chars.find((c) => /^adam$/i.test(c?.name)) ||
      chars.find((c) => !/^sasha$/i.test(c?.name)) ||
      null;
    let sasha = chars.find((c) => /^sasha$/i.test(c?.name)) || null;
    if (!adam) {
      adam = { name: "Adam", pose: "stand", expression: "curious", facing: "front" };
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
    adam.name = "Adam";
    adam.pose = pose;
    adam.expression = expressionForStory(arc, hint, mood);
    adam.facing = "front";

    const wantMom =
      /mom|sasha|help|together|story with/i.test(String(theme || "")) ||
      /\bmom\b|sasha|help me|with mom/i.test(hint);
    const momBeat =
      wantMom &&
      (arc === "discovery" ||
        arc === "celebration" ||
        (arc === "fun" && i % 3 === 1) ||
        !!sasha);
    if (momBeat) {
      const momPose = momPoseForStory(hint, arc, mood);
      sasha = {
        name: "Sasha",
        pose: momPose,
        expression:
          arc === "problem" ? "curious" : arc === "celebration" ? "happy" : "gentle_smile",
        facing: "front",
      };
    } else {
      sasha = null;
    }

    beat.characters = sasha ? [adam, sasha] : [adam];

    // Initial placement: Adam continuity lead; Mom close when present (not far walls)
    let slot = i === 0 ? "mid_left" : "mid_left";
    let depth = "mid";
    if (arc === "celebration") depth = "near";
    if (loc === "kitchen_sink") depth = "far";
    beat.placement = { Adam: slot };
    if (sasha) {
      beat.placement.Sasha = "mid_right";
      beat.proximity = "near";
    }
    beat.depth = depth;

    // Camera: stabilize within arc (avoid medium↔full every beat)
    if (arc === "problem" || arc === "discovery") {
      beat.camera = "medium_full";
    } else if (arc === "celebration") {
      beat.camera = "full_body";
    } else {
      beat.camera = "medium_full";
    }
  }

  // Monotonic journey: after leaving a story room via bridge, never return to it
  list = fixJourneyMonotonic(list, storyRooms, defLoc);

  // Force multi-location when palette allows (progressive, not rewind)
  if (storyRooms.length > 1 && mood !== "calm") {
    const uniq = new Set(
      list.filter((b) => !isBridgeLoc(b.location)).map((b) => b.location),
    );
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
      const lastPlacement = { Adam: "center" };
      if (list[list.length - 1].characters.some((c) => /^sasha$/i.test(c.name))) {
        lastPlacement.Sasha = "right";
      } else if (/mom|sasha|help|stretch|morning/i.test(String(theme || ""))) {
        list[list.length - 1].characters.push({
          name: "Sasha",
          pose: "kneel",
          expression: "happy",
          facing: "front",
        });
        lastPlacement.Sasha = "right";
      }
      list[list.length - 1].placement = lastPlacement;
      list[list.length - 1].depth = "near";
      // Celebration stays in last indoor story room — never lawn when indoor
      const lastIndoor =
        storyRooms[storyRooms.length - 1] || defLoc;
      list[list.length - 1].location = lastIndoor;
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

  const allowedForBridge = [
    ...palette,
    ...[...BRIDGE_LOCATIONS].filter(
      (id) => !allowedLocations?.length || allowedLocations.includes(id),
    ),
  ];

  // Order: clamp BEFORE bridges so clamp cannot delete bridges, then bridge, then screen continuity
  list = clampBeatCount(
    list,
    durationSec || KIDS_HIT_DURATION_SEC,
    KIDS_HIT_BEAT_MIN,
    KIDS_HIT_BEAT_MAX,
  );

  for (let i = 0; i < list.length; i++) {
    if (!normalizeStoryBeat(list[i].storyBeat)) {
      list[i].storyBeat = storyBeatFromSection(list[i].section, i, list.length);
    }
    if (indoor && String(list[i].location).toLowerCase() === "lawn") {
      list[i].location = defLoc;
    }
  }

  list = insertBridgeBeats(list, allowedForBridge);
  // If bridges pushed us over max, clamp again but protect bridges
  if (list.length > KIDS_HIT_BEAT_MAX) {
    list = clampBeatCount(
      list,
      durationSec || KIDS_HIT_DURATION_SEC,
      KIDS_HIT_BEAT_MIN,
      KIDS_HIT_BEAT_MAX,
    );
    // Re-insert any bridges lost by aggressive clamp
    list = insertBridgeBeats(list, allowedForBridge);
  }

  list = sanitizeBridgeBeats(list, allowedForBridge);
  list = applyContinuityFields(list, { objective, theme });
  // Final screen-space pass (idempotent with applyContinuityFields)
  list = enforceScreenContinuity(list, { objective, theme });
  list = scrubStaleGeographyText(list, { indoor, objective });
  list = rebuildCauseEffectChain(list, { objective });
  list = enforceLivingStory(list, { mood, objective, theme });
  list = stampEndPlacements(list);
  // Re-enforce once so next-still slots match endPlacement after stamp
  list = enforceScreenContinuity(list, { objective, theme });
  // Close proximity must win AFTER screen continuity (continuity used to yank Mom to far walls)
  list = list.map((b) => {
    const beat = { ...b };
    applyCloseProximity(beat);
    return beat;
  });
  list = stampEndPlacements(list);
  list = assignBeatTimings(list, durationSec || KIDS_HIT_DURATION_SEC);
  return list;
}

/**
 * Drop bridges that don't connect different story rooms; force bridge locs
 * onto doorway/hallway; clear bridge flag on story rooms.
 */
function sanitizeBridgeBeats(beats, allowed = []) {
  const src = Array.isArray(beats) ? beats.map((b) => ({ ...b })) : [];
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const beat = src[i];
    if (!beat.bridge) {
      // Story beat wrongly tagged on a bridge location
      if (isBridgeLoc(beat.location)) {
        const prev = out[out.length - 1];
        beat.location =
          (prev && !isBridgeLoc(prev.location) && prev.location) ||
          "home";
      }
      out.push(beat);
      continue;
    }

    const prev = out[out.length - 1];
    const next = src[i + 1];
    const prevFam = prev ? roomFamily(prev.location) : "";
    const nextFam = next ? roomFamily(next.location) : "";
    // Useless: same story room on both sides, or missing neighbors
    if (
      !prev ||
      !next ||
      prevFam === "bridge" ||
      nextFam === "bridge" ||
      prevFam === nextFam
    ) {
      continue;
    }

    let loc = String(beat.location || "").toLowerCase();
    if (!isBridgeLoc(loc)) {
      loc =
        bridgeLocationForTransition(prev.location, next.location, allowed) ||
        "hallway";
    }
    beat.location = loc;
    beat.characters = [
      {
        name: "Adam",
        pose: "walk",
        expression: "curious",
        facing: beat.characters?.[0]?.facing || "front",
      },
    ];
    beat.cutMotivation = "exit";
    out.push(beat);
  }

  // Clear false "exit" cuts that don't actually leave the room
  for (let i = 0; i < out.length; i++) {
    const beat = out[i];
    const next = out[i + 1];
    if (!next || beat.bridge) continue;
    if (beat.cutMotivation !== "exit") continue;
    if (roomFamily(beat.location) === roomFamily(next.location) && !next.bridge) {
      beat.cutMotivation = "match_action";
      beat.exitDir = "center";
    }
  }
  return out;
}

/** Rewrite cause/effect that still mention rooms we left or outdoor when indoor. */
function scrubStaleGeographyText(beats, { indoor = false } = {}) {
  return (beats || []).map((b) => {
    const beat = { ...b };
    const loc = String(beat.location || "").replace(/_/g, " ");
    const scrub = (s) => {
      let t = String(s || "");
      if (indoor) {
        t = t
          .replace(/\bexits? to the lawn\b/gi, `celebrates in the ${loc}`)
          .replace(/\bopens toward lawn\b/gi, `opens toward the next room`)
          .replace(/\bto the lawn\b/gi, `in the ${loc}`)
          .replace(/\bon the lawn\b/gi, `inside`)
          .replace(/\bback (to |home\b)/gi, `continues in the ${loc}`);
      }
      t = t
        .replace(/\bturns back to home\b/gi, `continues the march in the ${loc}`)
        .replace(/\bback to home\b/gi, `stays in the ${loc}`);
      return t;
    };
    beat.cause = scrub(beat.cause);
    beat.effect = scrub(beat.effect);
    return beat;
  });
}

/**
 * Next-still screen target for Wan: end where the following keyframe begins.
 */
function stampEndPlacements(beats) {
  const list = Array.isArray(beats) ? beats : [];
  for (let i = 0; i < list.length; i++) {
    const cur = list[i];
    const next = list[i + 1];
    const startSlot = cur.placement?.Adam || "center";
    const traveling =
      cur.cutMotivation === "exit" || cur.bridge === true;
    if (!next) {
      cur.endPlacement = { Adam: startSlot };
      continue;
    }
    if (traveling) {
      let exit =
        cur.exitDir === "left" || cur.exitDir === "right"
          ? cur.exitDir
          : startSlot;
      // Bridges must stay on a side, never center
      if (cur.bridge && exit === "center") {
        exit = startSlot === "center" ? "right" : startSlot;
        cur.exitDir = exit;
        cur.enterDir = exit;
        if (startSlot === "center") {
          cur.placement = { Adam: exit };
        }
      }
      cur.endPlacement = { Adam: exit };
    } else {
      cur.endPlacement = { Adam: startSlot };
    }
  }
  // Sync next still starts to prior ends (same room / into bridge only)
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1];
    const beat = list[i];
    const aEnd = prev.endPlacement?.Adam || prev.placement?.Adam || "center";
    const same =
      roomFamily(prev.location) === roomFamily(beat.location);
    if (beat.bridge || same) {
      if (!beat.placement) beat.placement = {};
      beat.placement.Adam = aEnd === "center" && beat.bridge ? "right" : aEnd;
      if (beat.bridge) {
        beat.enterDir = beat.placement.Adam;
        beat.exitDir = beat.placement.Adam;
        beat.endPlacement = { Adam: beat.placement.Adam };
      } else if (!(beat.cutMotivation === "exit")) {
        beat.endPlacement = { Adam: beat.placement.Adam };
      }
    }
  }
  return list;
}

/** Rebuild cause→effect from actual locations/poses after geography repair. */
function rebuildCauseEffectChain(beats, { objective = "" } = {}) {
  return (beats || []).map((b, i, arr) => {
    const beat = { ...b };
    const prev = i > 0 ? arr[i - 1] : null;
    const lead = toddlerOf(beat);
    const help = helperOf(beat);
    const pose = lead?.pose || "stand";
    const loc = String(beat.location || "room").replace(/_/g, " ");
    const hint = String(beat.lyricHint || "").trim();

    if (!prev) {
      beat.cause = "song starts";
      beat.effect =
        hint ||
        (objective ? `starts working on: ${objective}` : `looks around the ${loc}`);
      return beat;
    }

    const prevEffect = String(prev.effect || prev.lyricHint || "previous action");
    beat.cause = prevEffect;

    if (beat.bridge) {
      beat.effect = `crosses toward ${String(arr[i + 1]?.location || "the next room").replace(/_/g, " ")}`;
    } else if (roomFamily(prev.location) !== roomFamily(beat.location)) {
      beat.effect = hint || `arrives in the ${loc} and ${pose}s`;
    } else if (help && lead) {
      beat.effect =
        hint ||
        `${help.name} ${help.pose}s → ${lead.name} ${pose}s in the ${loc}`;
    } else {
      beat.effect = hint || `keeps ${pose}ing in the ${loc}`;
    }
    return beat;
  });
}

/** Cast-agnostic: lead toddler on the beat (Adam or first non-helper). */
function toddlerOf(beat) {
  const chars = beat?.characters || [];
  return (
    chars.find((c) => /^adam$/i.test(c?.name)) ||
    chars.find((c) => !/^sasha$/i.test(c?.name)) ||
    chars[0] ||
    null
  );
}

/** Cast-agnostic: helper (Mom / Sasha) when present. */
function helperOf(beat) {
  const chars = beat?.characters || [];
  return chars.find((c) => /^sasha$/i.test(c?.name)) || null;
}

function intensityForArc(arc, indexInArc, arcLen, role) {
  const base =
    arc === "problem"
      ? 1
      : arc === "discovery"
        ? 2
        : arc === "fun"
          ? 3
          : arc === "celebration"
            ? 4
            : 2;
  const t = arcLen <= 1 ? 0 : indexInArc / (arcLen - 1);
  let n = Math.round(base + t * (arc === "fun" ? 2 : 1));
  if (role === "peak") n = Math.max(n, 5);
  if (role === "react") n = Math.min(5, n + 1);
  if (role === "setup") n = Math.max(1, n - 1);
  return Math.max(1, Math.min(5, n));
}

function cameraForRole(role, arc, hasHelper, pose) {
  if (role === "react") return "push_in";
  if (role === "peak") return hasHelper ? "pull_back" : "push_in";
  if (role === "setup") return "hold_wide";
  if (role === "anticipate") return pose === "kneel" ? "lower" : "none";
  if (pose === "walk" || pose === "stomp") return "track";
  if (pose === "kneel") return "lower";
  if (arc === "celebration") return hasHelper ? "pull_back" : "push_in";
  if (hasHelper && role === "action") return "track";
  return "none";
}

function cameraFramingForMotion(motion, current) {
  const m = normalizeCameraMotion(motion);
  if (m === "push_in" || m === "lower") return "close";
  if (m === "hold_wide" || m === "pull_back") return "full_body";
  if (m === "track") return current === "close" ? "medium" : current || "medium_full";
  return current || "medium_full";
}

function interactionForBeat(beat, prev) {
  const lead = toddlerOf(beat);
  const help = helperOf(beat);
  const leadName = lead?.name || "Adam";
  const helpName = help?.name || "";
  const pose = lead?.pose || "stand";
  const hPose = help?.pose || "";
  if (beat.bridge) return `${leadName} walks through doorway`;
  if (help && lead) {
    if (hPose === "kneel" && /stand|sit|point|wave/.test(pose))
      return `${helpName} kneels → ${leadName} looks up`;
    if (hPose === "point")
      return `${helpName} points → ${leadName} notices`;
    if (hPose === "hands_up" || pose === "hands_up")
      return `${helpName} opens arms → ${leadName} reaches`;
    if (pose === "walk" || pose === "clap")
      return `${leadName} runs to ${helpName}`;
    if (/celebrate|done|yay|smile|wave/.test(String(beat.lyricHint || "")))
      return `${leadName} waves to ${helpName}`;
    return `${helpName} ${hPose}s → ${leadName} ${pose}s`;
  }
  if (prev && toddlerOf(prev)?.pose === "point" && pose !== "point")
    return `${leadName} reacts then ${pose}s`;
  return `${leadName} ${pose}s`;
}

/**
 * Living-through-story repair: interaction chains, reaction beats,
 * emotion escalation, camera participation, phase rhythm, anti-stand-spam.
 * Cast-agnostic (toddler lead + optional helper) so new characters/songs inherit it.
 */
export function enforceLivingStory(beats, { mood = "energetic", objective = "", theme = "" } = {}) {
  const list = Array.isArray(beats) ? beats.map((b) => ({ ...b })) : [];
  if (!list.length) return list;

  const poseEscalation = {
    problem: mood === "calm" ? ["sit", "stand", "tiptoe", "wave"] : ["sit", "stand", "point", "wave"],
    discovery: ["point", "wave", "walk", "clap"],
    fun:
      mood === "calm"
        ? ["wave", "tiptoe", "hands_up", "clap"]
        : ["walk", "clap", "stomp", "hands_up", "wave"],
    celebration: ["wave", "hands_up", "clap", "kneel"],
  };

  // Pre-count arc lengths for emotion curves
  const arcCounts = {};
  const arcIndex = [];
  for (let i = 0; i < list.length; i++) {
    const arc = normalizeStoryBeat(list[i].storyBeat) || "fun";
    arcIndex[i] = arcCounts[arc] || 0;
    arcCounts[arc] = (arcCounts[arc] || 0) + 1;
  }

  const PHASE_CYCLE = ["setup", "anticipate", "action", "react", "followthrough"];
  let phaseCursor = 0;

  for (let i = 0; i < list.length; i++) {
    const beat = list[i];
    const prev = i > 0 ? list[i - 1] : null;
    const next = list[i + 1] || null;
    const arc = normalizeStoryBeat(beat.storyBeat) || "fun";
    const lead = toddlerOf(beat);
    const help = helperOf(beat);
    if (!lead) continue;

    // Walk to door only when already exiting / next is a bridge (don't invent teleports)
    if (
      next &&
      (next.bridge || beat.cutMotivation === "exit" || beat.bridge)
    ) {
      if (/stand|sit|wave|point/.test(lead.pose) && !beat.bridge) {
        lead.pose = "walk";
        beat.cutMotivation = "exit";
      }
    }

    // Anti stand-spam: escalate pose within arc
    if (prev && !beat.bridge) {
      const prevLead = toddlerOf(prev);
      const samePose =
        prevLead &&
        prevLead.pose === lead.pose &&
        roomFamily(prev.location) === roomFamily(beat.location);
      if (samePose && (lead.pose === "stand" || lead.pose === prevLead.pose)) {
        const alts = poseEscalation[arc] || poseEscalation.fun;
        const idx = Math.max(0, alts.indexOf(lead.pose));
        const nextPose = alts[Math.min(alts.length - 1, idx + 1)] || alts[alts.length - 1];
        if (nextPose !== lead.pose) lead.pose = nextPose;
      }
      // Third identical energetic pose → peak + followthrough alternate
      if (
        i >= 2 &&
        toddlerOf(list[i - 2])?.pose === lead.pose &&
        prevLead?.pose === lead.pose
      ) {
        const alts = poseEscalation[arc] || poseEscalation.fun;
        lead.pose = alts[(alts.indexOf(lead.pose) + 2) % alts.length] || "hands_up";
      }
    }

    // Dual-cast interaction: helper acts → toddler reacts (alternate focus)
    if (help && lead && !beat.bridge) {
      const pairIdx = i % 4;
      if (pairIdx === 0) {
        help.pose = help.pose === "stand" ? "kneel" : help.pose;
        if (lead.pose === "stand") lead.pose = "sit";
        lead.expression = "curious";
        beat.cutMotivation = beat.cutMotivation || "look";
      } else if (pairIdx === 1) {
        // Reaction beat — toddler notices
        if (/stand|sit/.test(lead.pose)) lead.pose = "point";
        lead.expression = "surprised";
        beat.cutMotivation = "look";
      } else if (pairIdx === 2) {
        if (/stand|sit|point/.test(lead.pose)) lead.pose = mood === "calm" ? "wave" : "walk";
        lead.expression = "happy";
        if (help.pose === "stand") help.pose = "hands_up";
      } else {
        lead.pose = arc === "celebration" || arc === "fun" ? "hands_up" : "clap";
        help.pose = "kneel";
        lead.expression = "excited";
        help.expression = "happy";
      }
    }

    // Phase / beatRole rhythm — recompute for living-story (ignore stale LLM/continuity phase)
    let role = "";
    if (beat.bridge) role = "action";
    else if (arc === "celebration" && i === list.length - 1) role = "peak";
    else if (
      /chorus/i.test(String(beat.section || "")) &&
      arc === "fun" &&
      arcIndex[i] >= Math.max(1, (arcCounts.fun || 1) - 1)
    ) {
      role = "peak";
    } else if (help && !beat.bridge && i % 4 === 1) {
      role = "react";
    } else {
      role = PHASE_CYCLE[phaseCursor % PHASE_CYCLE.length];
      phaseCursor += 1;
    }
    // Force react once after helper invite poses (not every consecutive beat)
    if (
      prev &&
      helperOf(prev) &&
      /kneel|point|hands_up/.test(helperOf(prev)?.pose || "") &&
      role !== "peak" &&
      normalizeBeatRole(prev.beatRole) !== "react" &&
      role !== "react"
    ) {
      role = "react";
    }
    // Avoid react→react stacks — settle into followthrough
    if (
      prev &&
      normalizeBeatRole(prev.beatRole) === "react" &&
      role === "react"
    ) {
      role = "followthrough";
    }
    beat.beatRole = role;
    beat.actionPhase = normalizeActionPhase(role) || role;

    const intensity = intensityForArc(arc, arcIndex[i], arcCounts[arc] || 1, role);
    beat.emotionIntensity = intensity;
    lead.expression = expressionForStory(arc, beat.lyricHint, mood, intensity);
    if (help) {
      help.expression =
        intensity >= 4 ? "happy" : arc === "problem" ? "curious" : "gentle_smile";
    }

    const camMotion =
      normalizeCameraMotion(beat.cameraMotion) ||
      cameraForRole(role, arc, !!help, lead.pose);
    beat.cameraMotion = camMotion || "none";
    beat.camera = cameraFramingForMotion(beat.cameraMotion, beat.camera);

    beat.interaction = String(beat.interaction || "").trim() || interactionForBeat(beat, prev);

    // Depth joins camera: near on push_in/react; far on hold_wide setup
    if (camMotion === "push_in" || role === "react") beat.depth = "near";
    else if (camMotion === "hold_wide" || role === "setup") beat.depth = "far";
    else if (!beat.depth) beat.depth = "mid";

    beat.characters = help ? [lead, help] : [lead];
  }

  // Second pass: rebuild interactions, force social-near (no body contact)
  let lastRole = "";
  for (let i = 0; i < list.length; i++) {
    const beat = list[i];
    if (!beat.bridge && beat.beatRole === lastRole && beat.beatRole === "action") {
      beat.beatRole = "followthrough";
      beat.actionPhase = "followthrough";
    }
    lastRole = beat.beatRole;
    beat.interaction = interactionForBeat(beat, i > 0 ? list[i - 1] : null);
    if (!beat.effect || /keeps \w+ing/.test(String(beat.effect))) {
      beat.effect = beat.interaction;
    }
    beat.lyricHint = stripPhysicalContactLanguage(beat.lyricHint || "");
    beat.interaction = stripPhysicalContactLanguage(beat.interaction || "");
    beat.effect = stripPhysicalContactLanguage(beat.effect || "");
    beat.cause = stripPhysicalContactLanguage(beat.cause || "");
    applySocialNear(beat);
  }

  void objective;
  void theme;
  return list;
}

/** True when dual-cast should stand near (social), not hug. */
function isSocialNearText(beat) {
  const t = [
    beat?.interaction,
    beat?.lyricHint,
    beat?.effect,
    beat?.cause,
  ]
    .map((s) => String(s || ""))
    .join(" ");
  return /kneel|look up|open arms|wave|stretch|dance|together|welcome|giggle|clap|point|mom|sasha/i.test(
    t,
  );
}

/**
 * Dual-cast mid-frame near each other — NO body contact / hug geometry.
 * closeInteraction stays false; proximity is "near" only.
 */
function applySocialNear(beat) {
  if (!beat || beat.bridge) return;
  const help = helperOf(beat);
  const lead = toddlerOf(beat);
  if (!help || !lead) {
    beat.proximity = "apart";
    beat.closeInteraction = false;
    return;
  }
  beat.placement = { Adam: "mid_left", Sasha: "mid_right" };
  beat.proximity = "near";
  beat.closeInteraction = false;
  if (!isSocialNearText(beat)) return;
  beat.depth = beat.depth === "far" ? "mid" : beat.depth || "mid";
  lead.facing = "three_quarter_right";
  help.facing = "three_quarter_left";
  const ix = String(beat.interaction || beat.lyricHint || "").toLowerCase();
  if (/kneel|welcome|open arms/.test(ix) || help.pose === "stand") {
    help.pose = /kneel/.test(ix) ? "kneel" : help.pose === "stand" ? "wave" : help.pose;
  }
  if (/stretch|sky|tree|hands/.test(ix)) {
    lead.pose = "hands_up";
  }
  beat.characters = [lead, help];
}

/** @deprecated alias — social near, never hug contact */
function applyCloseProximity(beat) {
  applySocialNear(beat);
}

function isCloseInteractionText(beat) {
  return isSocialNearText(beat);
}

/**
 * Scrub hug/kiss/embrace language from lyrics or beat text (kids-safe).
 */
export function stripPhysicalContactLanguage(text) {
  let s = String(text || "");
  const reps = [
    [/\bmorning\s+hug\b/gi, "morning stretch"],
    [/\btight\s+and\s+high\b/gi, "side by side"],
    [/\btight\s+and\s+sound\b/gi, "clap and smile"],
    [/\bpull(?:s|ing)?\s+me\s+close\b/gi, "waves open arms"],
    [/\bpull(?:s|ing)?\s+close\b/gi, "waves"],
    [/\bwrap(?:s|ping)?\s+arms?\b/gi, "waves open arms"],
    [/\bhold(?:s|ing)?\s+(me|you|him|her|tight)\b/gi, "waves to"],
    [/\bhigh[- ]?fives?\b/gi, "claps"],
    [/\bhand[- ]?holds?\b/gi, "waves"],
    [/\bcheek[- ]?to[- ]?cheek\b/gi, "side by side"],
    [/\bmouth\s+kiss\b/gi, "smile"],
    [/\bhugs?\b/gi, "wave"],
    [/\bkiss(?:es|ed|ing)?\b/gi, "smile"],
    [/\bembrace(?:d|s|ing)?\b/gi, "wave"],
    [/\bsnuggle(?:d|s|ing)?\b/gi, "smile"],
    [/\bcuddle(?:d|s|ing)?\b/gi, "smile"],
  ];
  for (const [re, to] of reps) s = s.replace(re, to);
  return s.replace(/\s{2,}/g, " ").trim();
}

/**
 * Spread unique lyric lines onto beats by section so hints don't repeat.
 * Call with full lyrics text when available.
 */
export function spreadLyricHints(beats, lyricsText) {
  const list = Array.isArray(beats) ? beats.map((b) => ({ ...b })) : [];
  if (!list.length) return list;

  const linesBySection = parseLyricLinesBySection(lyricsText);
  if (!Object.keys(linesBySection).length) return dedupeLyricHints(list);

  const used = new Set();
  const takeLine = (sectionKey, fallback) => {
    const pool = linesBySection[sectionKey] || linesBySection._all || [];
    for (const line of pool) {
      const key = line.toLowerCase();
      if (used.has(key)) continue;
      used.add(key);
      return line;
    }
    // Exhausted unique lines for section — try global unused
    for (const line of linesBySection._all || []) {
      const key = line.toLowerCase();
      if (used.has(key)) continue;
      used.add(key);
      return line;
    }
    return fallback || "";
  };

  for (const beat of list) {
    if (beat.bridge) {
      beat.lyricHint = beat.lyricHint || "through the door";
      continue;
    }
    const sec = String(beat.section || "").toLowerCase();
    let key = "_all";
    if (/intro/.test(sec)) key = "intro";
    else if (/verse\s*1|verse1/.test(sec)) key = "verse1";
    else if (/verse\s*2|verse2/.test(sec)) key = "verse2";
    else if (/chorus/.test(sec)) key = "chorus";
    else if (/outro/.test(sec)) key = "outro";

    const next = takeLine(key, beat.lyricHint);
    if (next) beat.lyricHint = next.slice(0, 80);
  }
  return dedupeLyricHints(list);
}

/** Clear consecutive duplicate lyric hints when no full lyrics available. */
function dedupeLyricHints(beats) {
  const list = Array.isArray(beats) ? beats.map((b) => ({ ...b })) : [];
  let prev = "";
  for (const beat of list) {
    if (beat.bridge) continue;
    const h = String(beat.lyricHint || "").trim().toLowerCase();
    if (h && h === prev) {
      beat.lyricHint = "";
    } else {
      prev = h;
    }
  }
  return list;
}

function parseLyricLinesBySection(lyricsText) {
  const text = String(lyricsText || "");
  if (!text.trim()) return {};
  const map = { intro: [], verse1: [], verse2: [], chorus: [], outro: [], _all: [] };
  let cur = "_all";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const sec = /^\[([^\]]+)\]/.exec(line);
    if (sec) {
      const s = sec[1].toLowerCase();
      if (/intro/.test(s)) cur = "intro";
      else if (/verse\s*1/.test(s)) cur = "verse1";
      else if (/verse\s*2/.test(s)) cur = "verse2";
      else if (/chorus/.test(s)) cur = "chorus";
      else if (/outro/.test(s)) cur = "outro";
      else cur = "_all";
      continue;
    }
    if (/^(title|objective|lyrics):/i.test(line)) continue;
    const clean = line.replace(/^["']|["']$/g, "").trim();
    if (!clean || clean.length < 3) continue;
    map[cur].push(clean);
    map._all.push(clean);
  }
  return map;
}

/** Full kids-hit plan repair + continuity validation helper. */
export function finalizeKidsHitPlan(
  plan,
  { theme, allowedLocations, durationSec, lyricsText } = {},
) {
  const objective = plan.objective || objectiveForTheme(theme || plan.theme || "");
  const beats = repairKidsHitBeats(plan.beats || [], {
    theme: theme || plan.theme,
    allowedLocations,
    durationSec: durationSec || plan.durationSec || KIDS_HIT_DURATION_SEC,
    lyricsText: lyricsText || "",
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
