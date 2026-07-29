#!/usr/bin/env python3
"""Generic ACE-Step 1.5 song generator for music-video pipelines."""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import time
from pathlib import Path

ACE_ROOT = Path(r"C:\Users\Saeed Khan\AppData\Local\ProdesecStudio\ACE-Step-1.5")
sys.path.insert(0, str(ACE_ROOT))

for proxy in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
    os.environ.pop(proxy, None)

from acestep.handler import AceStepHandler
from acestep.llm_inference import LLMHandler
from acestep.inference import GenerationParams, GenerationConfig, generate_music


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--caption", required=True)
    ap.add_argument("--lyrics", required=True, help="Lyrics text, or path to .txt file")
    ap.add_argument("--duration", type=float, default=90)
    ap.add_argument("--bpm", type=int, default=100)
    ap.add_argument("--seed", type=int, default=2026)
    ap.add_argument("--steps", type=int, default=8)
    ap.add_argument("--keyscale", default="C major")
    ap.add_argument("--lm", default="acestep-5Hz-lm-1.7B")
    ap.add_argument("--backend", default="pt", choices=("pt", "vllm", "mlx"))
    ap.add_argument("--no-thinking", action="store_true")
    args = ap.parse_args()

    lyrics = args.lyrics
    lyrics_path = Path(lyrics)
    if lyrics_path.exists() and lyrics_path.is_file():
        lyrics = lyrics_path.read_text(encoding="utf-8")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    save_dir = out.parent / "_ace_work"
    save_dir.mkdir(parents=True, exist_ok=True)

    print(f"ACE-Step root: {ACE_ROOT}")
    print(f"Duration={args.duration}s bpm={args.bpm} steps={args.steps}")

    dit = AceStepHandler()
    status, ok = dit.initialize_service(
        project_root=str(ACE_ROOT),
        config_path="acestep-v15-turbo",
        device="auto",
        offload_to_cpu=True,
    )

    def _safe(msg: object) -> str:
        return str(msg).encode("ascii", "replace").decode("ascii")

    if not ok:
        print(f"DiT init failed: {_safe(status)}", file=sys.stderr)
        return 1
    print(f"DiT: {_safe(status)}")

    llm = LLMHandler()
    status, ok = llm.initialize(
        checkpoint_dir=str(ACE_ROOT / "checkpoints"),
        lm_model_path=args.lm,
        backend=args.backend,
        device="auto",
        offload_to_cpu=True,
        dtype=None,
    )
    if not ok:
        print(f"LLM init failed: {_safe(status)}", file=sys.stderr)
        return 1
    print(f"LLM: {_safe(status)}")

    params = GenerationParams(
        task_type="text2music",
        thinking=not args.no_thinking,
        caption=args.caption,
        lyrics=lyrics,
        bpm=args.bpm,
        keyscale=args.keyscale,
        timesignature="4",
        vocal_language="en",
        duration=args.duration,
        inference_steps=args.steps,
        guidance_scale=1.0,
        seed=args.seed,
        use_cot_metas=False,
        use_cot_caption=False,
        use_cot_language=False,
    )
    config = GenerationConfig(
        batch_size=1,
        audio_format=out.suffix.lstrip(".") or "mp3",
    )

    t0 = time.time()
    result = generate_music(
        dit,
        llm,
        params=params,
        config=config,
        save_dir=str(save_dir),
    )
    elapsed = time.time() - t0
    if not result.success:
        print(f"Generation failed: {result.error}", file=sys.stderr)
        return 1

    audios = result.audios or []
    if not audios:
        print("No audio returned", file=sys.stderr)
        return 1

    src = Path(audios[0]["path"] if isinstance(audios[0], dict) else audios[0])
    if not src.exists():
        print(f"Missing output file: {src}", file=sys.stderr)
        return 1

    shutil.copy2(src, out)
    print(f"Saved: {out} ({out.stat().st_size} bytes) in {elapsed:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
