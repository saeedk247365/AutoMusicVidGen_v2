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

Song keyframes use a **composite pipeline**: solo studio character plates → rembg cut → paste on empty scene.

```bash
npm run family              # classic: ~180s, 6–8 beats
npm run family:animate
npm run family:stitch
```

### Kids-hit mode (opt-in — does not change classic defaults)

Shorter home songs (~75s), timed dense beats, energetic Wan motion, stitch loop-fill (no freeze pad). Continuity contract: [docs/CONTINUITY.md](docs/CONTINUITY.md). Dry-run: `npm run family:kids:validate` (add `-- --repair` to exercise bridges). Golden: `batches/_templates/continuity-golden-rainy-march.json`.

```bash
npm run family:kids
npm run family:kids:animate -- --song batches/<date>/<slug> --force
npm run family:kids:stitch -- --song batches/<date>/<slug> --force
```

Or flags: `--kids-hit` on 02_0/02_1, `--loop-fill` on 02_2.

Classic regen still works:

```bash
node scripts/02_0_generate-lyrics+song+scene+keyframes.js --song batches/<date>/<slug> --keyframes-only
node scripts/02_0_generate-lyrics+song+scene+keyframes.js --song batches/<date>/<slug> --keyframes-only --replan
```

Outputs per song:

```
batches/<date>/<slug>/
  <slug>.mp3
  lyrics.txt
  scenes/actions.json + room PNGs
  keyframes/*.png
  clips/*.mp4
  final.mp4
```

Character LoRA files (Comfy `models/loras/`): set `loraName` in `characters/adam.json`.
