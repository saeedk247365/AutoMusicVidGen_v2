#!/usr/bin/env python3
"""Download missing ComfyUI models from models.manifest.json into MODEL_DIR."""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

from huggingface_hub import hf_hub_download
from urllib.parse import urlparse

MANIFEST = Path(os.environ.get("MODEL_MANIFEST", "/opt/ComfyUI/models.manifest.json"))
MODEL_DIR = Path(os.environ.get("MODEL_CACHE", "/opt/ComfyUI/models"))
TOKEN = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")


def parse_hf_url(url: str):
    """
    https://huggingface.co/{repo}/resolve/{rev}/{path}
    → repo_id, revision, filename
    """
    p = urlparse(url)
    parts = [x for x in p.path.split("/") if x]
    # ['Comfy-Org', 'Wan_2.2_...', 'resolve', 'main', 'split_files', ...]
    if "resolve" not in parts:
        return None
    i = parts.index("resolve")
    repo_id = "/".join(parts[:i])
    revision = parts[i + 1]
    filepath = "/".join(parts[i + 2 :])
    return repo_id, revision, filepath


def already_ok(dest: Path, min_bytes: int = 1024) -> bool:
    return dest.is_file() and dest.stat().st_size >= min_bytes


def download_one(item: dict) -> None:
    rel = item["path"]
    dest = MODEL_DIR / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    if already_ok(dest):
        print(f"[skip] {rel} ({dest.stat().st_size / 1e9:.2f} GB)")
        return

    url = item["url"]
    required = bool(item.get("required", True))
    print(f"[download] {rel}")
    print(f"           {url}")

    parsed = parse_hf_url(url)
    try:
        import shutil

        if parsed:
            repo_id, revision, filepath = parsed
            cached = hf_hub_download(
                repo_id=repo_id,
                filename=filepath,
                revision=revision,
                token=TOKEN,
            )
            shutil.copy2(cached, dest)
        else:
            # GitHub releases / arbitrary HTTPS
            import urllib.request

            tmp = dest.with_suffix(dest.suffix + ".partial")
            urllib.request.urlretrieve(url, tmp)
            tmp.replace(dest)
    except Exception as e:
        msg = f"[error] {rel}: {e}"
        if required:
            print(msg, file=sys.stderr)
            raise
        print(msg + " (optional — continuing)")
        return

    if not already_ok(dest):
        raise RuntimeError(f"Download incomplete: {dest}")
    print(f"[ok] {rel} ({dest.stat().st_size / 1e9:.2f} GB)")


def main() -> int:
    if not MANIFEST.is_file():
        print(f"Missing manifest: {MANIFEST}", file=sys.stderr)
        return 1
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    models = data.get("models") or []
    print(f"Model download → {MODEL_DIR} ({len(models)} entries)")
    t0 = time.time()
    for item in models:
        download_one(item)
    print(f"All required models ready in {time.time() - t0:.0f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
