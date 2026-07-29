# AutoMusicVidGen

Nursery / family music-video generation scripts extracted from CartoonLoRATrainer.

## Requirements
- Node.js 18+
- Ollama with `qwen3:14b` (for lyrics / scene plans)
- ACE-Step 1.5 at the path configured in the scripts
- ComfyUI running (for character / scene stills)
- ffmpeg on PATH

## Run
```bash
npm run song
npm run nursery
npm run family
npm run family:chars
```

Outputs land under `scripts/custom_scripts/batches/`.
