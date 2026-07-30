# AutoMusicVidGen

Nursery music-video generation + cartoon character LoRA datasets.

## Requirements
- Node.js 18+
- ComfyUI at `http://127.0.0.1:8188`
- Ollama `qwen3:14b` (lyrics / scene plans)
- ACE-Step 1.5 (path set in scripts)
- ffmpeg on PATH

## Characters

One JSON per character under `characters/`:

```
characters/
  adam.json      # toddler boy (family + LoRA shots)
  tom.json       # dad (family)
  sasha.json     # mom (family)
  tomchr.json    # kid Tom LoRA
  adam/ tom/ sasha/   # generated stills only (no JSON copies)
```

## Base checkpoint

Default checkpoint is `realcartoon3d_v15.safetensors` (SD1.5 cartoon — more identity-stable than DreamShaper).

Put the file in ComfyUI `models/checkpoints/`. Character JSON + `train-config.json` already point at it.

SDXL options (e.g. Autismmix Pony) need a separate SDXL OpenPose/FaceID path — not wired yet.

## Character dataset

Master must be generated and **approved** before keyframes/shots run.

### Adam
```bash
npm run generate:adam:master    # re-run until you like it
npm run generate:adam:approve
npm run generate:adam
npm run train:adam
```



Optional: `--ref "E:\path\to\ref.png"` · `--set-master "E:\path\to\still.png"` · `--force`

Outputs: `dataset/adam/` or `dataset/tom/`

### Identity locks (training plates)

- **Chroma-green backgrounds only** for master / keyframes / shots (`#00FF00` key) — captions include `plain solid chroma key green background` so the LoRA can drop it at inference. Never train kitchen/lawn/bedroom into the character LoRA; those are composited later.
- Song plates use the same green key → cut → composite onto empty scenes.
- **FaceID** on rebuilds and whenever denoise ≥ 0.65 (not on easy ~0.55 edits).
- **Keyframe refresh is off by default** — pass `--keyframe-refresh` only if you want shots to update the bank (risk of contamination).
- **Identity gate** — after each keyframe/shot, InsightFace similarity vs master; rejects and retries below threshold (`--identity-threshold 0.40`, `--identity-retries 3`, `--skip-identity-gate` to disable).
- Rebuild EmptyLatent only for sit, crawl, rear, and front→strict profile.

**Full remake after switching to chroma green** (wipe old gray plates, regenerate, retrain):

```bash
# Adam example — delete old dataset images first, then:
npm run generate:adam:master
npm run generate:adam:approve
npm run generate:adam
npm run train:adam
```

Then regen song keyframes with `--keyframes-only --replan`.

### Remake only certain poses

Leave the approved master alone. Fix the **keyframe** first if that pose bank image is wrong; otherwise remake only the bad **shots**.

1. **Decide where the bad pose lives**
   - Bad look in `dataset/<char>/keyframes/<pose>.png` → fix that keyframe, then remake shots that use it.
   - Keyframe looks fine, only `dataset/<char>/images/<trigger>_XX_….png` is off → remake that shot only.

2. **Remake one or a few shots** (usual case) — use shot `id`s from the character JSON:

```bash
node scripts/generate-dataset.js --character characters/adam.json --out dataset/adam --shots-only --only 04_sitting,05_crawling --force
```

- `--only` — comma-separated shot ids
- `--shots-only` — skip master; don’t rebuild the whole keyframe bank
- `--force` — overwrite those images (or delete the PNGs and omit `--force`)

3. **If the keyframe is the problem** — delete only the bad keyframe file(s), then:

```bash
node scripts/generate-dataset.js --character characters/adam.json --out dataset/adam --keyframes-only
```

That regenerates **missing** keyframes only (avoid `--force-keyframes` unless you want all of them remade). Then remake dependent shots with `--shots-only --only … --force`.

4. **Hard poses** (sit / crawl / profile / rear) — FaceID is already applied when denoise ≥ 0.65 or on rebuilds; add `--aux-faceid` only if you want FaceID on every remake including easy edits.

Don’t re-run full `generate:adam` / `generate:tom` or bare `--force` unless you intend to touch master/approval.

### Train LoRA

ComfyUI must be running. Edit `comfyRoot` in the train config if needed.

**Adam** (uses `dataset/adam/images` → `adamboy_character_v1`):
```bash
npm run train:adam
```

**Tom** (uses `dataset/tom/images` → `tomchr_character_v1`):
```bash
npm run train:tom
```

Or explicitly:
```bash
node scripts/train-lora.js --train-config train-config-adam.json --character characters/adam.json
```

Weights land in ComfyUI `models/loras/` and (if enabled) `loras/` in this repo. Trigger word: `adamboy`.

## Music / family video

Song keyframes use a **composite pipeline**: solo chroma-green character plates (one person each) → code cut + placement on the empty scene → low-denoise polish (~0.25). SD never draws two characters in one pass.

Beats in `scenes/actions.json` use frozen-frame fields: `camera`, `placement`, `pose`, `expression`, `facing` (no `lookAt`, no `prompt_extra`). Poses: `stand`, `sit`, `kneel`, `walk`, `wave`, `point`, `hands_up`, `clap`.

```bash
npm run family              # 02_0 lyrics + song + beat plan + composited keyframes → batches/
npm run family:chars        # shared character stills only

# Regen keyframes for an existing song (normalizes actions.json → frozen schema):
node scripts/02_0_generate-lyrics+song+scene+keyframes.js --song batches/<date>/<slug> --keyframes-only

# Re-plan beats with Qwen from lyrics.txt, then regen stills:
node scripts/02_0_generate-lyrics+song+scene+keyframes.js --song batches/<date>/<slug> --keyframes-only --replan

# After keyframes exist (and GPU is free — not during LoRA train):
node scripts/02_1_animate-keyframes.js --song batches/<date>/<slug>
node scripts/02_2_stitch-song.js --song batches/<date>/<slug>
```

Outputs per song:
```
batches/<date>/<slug>/
  <slug>.mp3
  lyrics.txt
  scenes/actions.json + room PNGs
  keyframes/*.png           ← one composited still per beat
  keyframes/plates/*.png    ← solo chroma-green plates (debug)
  clips/*.mp4               ← from 02_1 (Wan)
  final.mp4                 ← from 02_2 (clips + song)
```

`actions.json` beat shape:
```json
{
  "id": "01_intro",
  "location": "kitchen",
  "camera": "full_body",
  "placement": { "Tom": "left", "Adam": "right" },
  "characters": [
    { "name": "Tom", "pose": "kneel", "expression": "happy", "facing": "front" },
    { "name": "Adam", "pose": "clap", "expression": "happy", "facing": "front" }
  ]
}
```

Character LoRA files (Comfy `models/loras/`): set `loraName` in `characters/adam.json` / `tom.json` (e.g. `adamboy_character_v1.safetensors`, `tom_character_v1.safetensors`).
