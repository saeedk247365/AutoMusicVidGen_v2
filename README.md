# AutoMusicVidGen

End-to-end preschool music videos: **train Adam’s LoRA → write a song → stills → Wan clips → final.mp4**.

---

## Full chain (character → final video)

Do this once for the character, then repeat the music-video steps for each song.

### 0. Prerequisites (always on)

| Need | Check |
|------|--------|
| Node.js 18+ | `node -v` |
| ComfyUI | `http://127.0.0.1:8188` running (see start command below) |
| Checkpoint | `realcartoon3d_v15.safetensors` in Comfy `models/checkpoints/` |
| Ollama | `qwen3:14b` pulled (`ollama pull qwen3:14b`) |
| ACE-Step 1.5 | Path configured in the 02_0 script |
| ffmpeg | On `PATH` |
| rembg (Python) | Used for character cutouts during keyframes |

**Start ComfyUI (CLI)** — optional if you use `npm run mvid` (it starts ComfyUI when needed). For manual stage runs:

```powershell
npm run comfy
```

Or from the repo root:

```powershell
cd ComfyUI
.\venv\Scripts\python.exe main.py --listen 127.0.0.1 --port 8188
```

Ready when the UI answers at `http://127.0.0.1:8188`.

Character definition lives in `characters/adam.json` (trigger word `adamboy`, LoRA name wired for inference).

---

### 1. Create / approve the character (dataset)

Generate a **master** still on chroma-green, approve it, then build keyframes + training shots:

```bash
npm run generate:adam:master    # re-run until you like the face/outfit
npm run generate:adam:approve   # locks master — required before full dataset
npm run generate:adam           # keyframes + shots → dataset/adam/
```

Optional: `--ref "E:\path\to\ref.png"` · `--set-master "E:\path\to\still.png"` · `--force`

Outputs: `dataset/adam/` (master, keyframes, captioned images for training).

Details (identity gate, remake one pose, chroma rules): see [Character dataset](#character-dataset) below.

---

### 2. Train the LoRA

ComfyUI must be running. Train config: `train-config-adam.json`.

```bash
npm run train:adam
```

Weights land in ComfyUI `models/loras/` (and optionally `loras/` in this repo). Trigger: **`adamboy`**. Set `loraName` in `characters/adam.json` if the filename differs.

---

### 3. Make a music video (`npm run mvid`)

Opens an **Express + EJS** multi-tab studio in your browser (`http://127.0.0.1:3847/`). Starts ComfyUI if needed, then generates each stage and **waits for Approve** (lyrics → song → storyline/scenes/scripts → keyframes → clips → **final.mp4**).

```bash
npm run mvid
```

- **Lyrics** tab is editable — edit before Approve  
- **Auto-approve all** (toolbar checkbox) skips gates and runs end-to-end  
- **Regenerate** re-runs the current stage  
- **Output** — `Preview 768×768` (default) or `YouTube 1920×1088` for production (stills + Wan + stitch; 16-aligned ~1080p)  
- **Batch** — open any `batches/<date>/<slug>` to review generated assets in the tabs  
- **GPU** — `Local` | `Split (local + Salad Wan)` | `Salad Cloud` — split runs prep/stills locally and Wan clips on Salad when configured  

```bash
npm run mvid -- --count 1
npm run mvid -- --theme "rainy day indoor march"
npm run mvid -- --song batches/<date>/<slug>   # resume existing song folder
npm run mvid -- --classic                      # longer ~180s classic path
npm run mvid -- --auto-approve                 # no pauses (watch in GUI)
npm run mvid -- --port 3847
```

Creates `batches/<YYYYMMDD>/<slug>/` with `lyrics.txt`, `<slug>.mp3`, `scenes/actions.json`, `keyframes/`, `clips/`, and **`final.mp4`**.

**Headless / manual stages** (no GUI):

```bash
npm run mvid:lyrics -- --count 1
npm run mvid:animate -- --song batches/<date>/<slug> --force
npm run mvid:stitch -- --song batches/<date>/<slug> --force
npm run mvid:validate -- --song batches/<date>/<slug>
```

Contract: [docs/CONTINUITY.md](docs/CONTINUITY.md). Golden storyboard: `batches/_templates/continuity-golden-rainy-march.json`.

#### What each stage does

```
characters/adam.json
        │
        ▼
  dataset + LoRA (adamboy)     ← steps 1–2 (once)
        │
        ▼
  02_0 --kids-hit              ← lyrics → ACE mp3 → Qwen beats → plates → rembg → keyframes
        │                         (GUI pauses after lyrics, song, plan, keyframes)
        ▼
  02_1 --kids-hit              ← Wan I2V per keyframe
        │
        ▼
  02_2 --loop-fill             ← timed concat + audio → final.mp4
```

#### Regen / replan an existing song

Keep the mp3; rebuild beats and/or stills:

```bash
# Replan beats from lyrics.txt, then regenerate keyframes
node scripts/02_0_generate-lyrics+song+scene+keyframes.js --kids-hit --song batches/<date>/<slug> --keyframes-only --replan --theme "rainy day indoor march"

# Layout-only (reuse cutouts)
node scripts/02_0_generate-lyrics+song+scene+keyframes.js --kids-hit --song batches/<date>/<slug> --keyframes-only --force --reuse-cutouts
```

Then: `npm run mvid -- --song batches/<date>/<slug>` (or animate + stitch manually).

---

### 4. Classic path (longer songs)

~180s, fewer beats, freeze-pad stitch:

```bash
npm run mvid -- --classic
# or: npm run mvid:classic
```

Add `--auto-approve` to skip GUI gates. Stages: `mvid:classic:lyrics` · `mvid:classic:animate` · `mvid:classic:stitch`.
---

### Output layout

```
batches/<date>/<slug>/
  <slug>.mp3
  lyrics.txt
  kids-hit-meta.json          # kids-hit only
  scenes/actions.json + room PNGs
  keyframes/*.png
  keyframes/plates/  cutouts/
  clips/*.mp4
  final.mp4
```

Empty room stills are shared under `scenes/` (`home`, `kitchen`, `doorway`, `hallway`, …).

---

## Requirements

- Node.js 18+
- ComfyUI at `http://127.0.0.1:8188` — `npm run comfy` (or `cd ComfyUI` then `.\venv\Scripts\python.exe main.py --listen 127.0.0.1 --port 8188`)
- Ollama `qwen3:14b` (lyrics / scene plans)
- ACE-Step 1.5 (path set in scripts)
- ffmpeg on PATH

## Characters

One JSON per character under `characters/`:

```
characters/
  adam.json      # toddler boy (family + LoRA shots)
  adam/          # generated stills only (no JSON copies)
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

Outputs: `dataset/adam/`

### Identity locks (training plates)

- **Chroma-green backgrounds only** for master / keyframes / shots (`#00FF00` key) — captions include `plain solid chroma key green background` so the LoRA can drop it at inference. Never train kitchen/lawn/bedroom into the character LoRA; those are composited later.
- Song plates use the same green key → cut → composite onto empty scenes.
- **FaceID** on rebuilds and whenever denoise ≥ 0.65 (not on easy ~0.55 edits).
- **Keyframe refresh is off by default** — pass `--keyframe-refresh` only if you want shots to update the bank (risk of contamination).
- **Identity gate** — after each keyframe/shot, InsightFace similarity vs master; rejects and retries below threshold (`--identity-threshold 0.40`, `--identity-retries 3`, `--skip-identity-gate` to disable).
- Rebuild EmptyLatent only for sit, crawl, rear, and front→strict profile.

**Full remake after switching to chroma green** (wipe old gray plates, regenerate, retrain):

```bash
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

Don’t re-run full `generate:adam` or bare `--force` unless you intend to touch master/approval.

### Train LoRA

ComfyUI must be running. Edit `comfyRoot` in the train config if needed.

**Adam** (uses `dataset/adam/images` → `adamboy_character_v2`):

```bash
npm run train:adam
```

Or explicitly:

```bash
node scripts/train-lora.js --train-config train-config-adam.json --character characters/adam.json
```

Weights land in ComfyUI `models/loras/` and (if enabled) `loras/` in this repo. Trigger word: `adamboy`.

## Music video details (`mvid`)

Song keyframes use a **composite pipeline**: solo studio character plates → rembg cut → paste on empty scene.

### Kids-hit (default for `npm run mvid`)

Shorter home songs (~75s), timed dense beats, energetic Wan motion, stitch loop-fill (no freeze pad). Continuity: [docs/CONTINUITY.md](docs/CONTINUITY.md). Dry-run: `npm run mvid:validate` (add `-- --repair` to exercise bridges). Golden: `batches/_templates/continuity-golden-rainy-march.json`.

Interactive GUI (default):

```bash
npm run mvid
```

Headless stages:

```bash
npm run mvid:lyrics
npm run mvid:animate -- --song batches/<date>/<slug> --force
npm run mvid:stitch -- --song batches/<date>/<slug> --force
```

### Classic path

```bash
npm run mvid -- --classic
npm run mvid:classic:lyrics
npm run mvid:classic:animate
npm run mvid:classic:stitch
```

Classic regen still works:

```bash
node scripts/02_0_generate-lyrics+song+scene+keyframes.js --song batches/<date>/<slug> --keyframes-only
node scripts/02_0_generate-lyrics+song+scene+keyframes.js --song batches/<date>/<slug> --keyframes-only --replan
```

Character LoRA files (Comfy `models/loras/`): set `loraName` in `characters/adam.json`.