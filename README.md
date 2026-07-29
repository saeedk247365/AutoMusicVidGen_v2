# AutoMusicVidGen

Nursery / family music-video generation and cartoon character LoRA tooling (from CartoonLoRATrainer).

## Requirements
- Node.js 18+
- Ollama with `qwen3:14b` (for lyrics / scene plans)
- ACE-Step 1.5 at the path configured in the scripts
- ComfyUI running (dataset, LoRA train, stills, Wan video)
- ffmpeg on PATH

## Layout
```
characters/   cast defs (family + LoRA characters) + ref stills
scenes/       shared empty-room defs + stills
batches/      song project outputs
dataset/      LoRA training images + captions
loras/        trained LoRA weights (local)
scripts/      all pipeline entrypoints
lib/          shared Comfy / OpenPose helpers
```

## Music / family pipelines
```bash
npm run song
npm run nursery
npm run family
npm run family:chars
```

Song outputs land under `batches/`. Shared characters and scenes live at the repo root.

## Character dataset + LoRA
```bash
# 1) Build dataset
npm run generate
npm run generate:new:tom

# 2) Train LoRA via ComfyUI TrainLoraNode
npm run train

# 3) Generate stills / video with trained LoRA
npm run gen:test
npm run video:test
npm run scene:test
```

Edit `character.json` and `train-config.json` (especially `comfyRoot`) before training.
