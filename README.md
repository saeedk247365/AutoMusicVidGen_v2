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

## Character dataset

Master must be generated and **approved** before keyframes/shots run.

### Adam
```bash
npm run generate:adam:master    # re-run until you like it
npm run generate:adam:approve
npm run generate:adam
```

### Tom (LoRA kid)
```bash
npm run generate:tom:master
npm run generate:tom:approve
npm run generate:tom
```

Optional: `--ref "E:\path\to\ref.png"` · `--set-master "E:\path\to\still.png"` · `--force`

Outputs: `dataset/adam/` or `dataset/tom/`

### Train LoRA
```bash
npm run train
```

Edit `train-config.json` (`comfyRoot`) first.

## Music / family video
```bash
npm run song
npm run nursery
npm run family
npm run family:chars
```

Outputs: `batches/`
