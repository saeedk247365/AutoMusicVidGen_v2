#!/usr/bin/env python3
"""Remove image background with rembg. Usage: rembg-cutout.py <in.png> <out.png>"""
import sys
from pathlib import Path

from rembg import remove


def main() -> int:
    if len(sys.argv) < 3:
        print("Usage: rembg-cutout.py <input.png> <output.png>", file=sys.stderr)
        return 2
    src = Path(sys.argv[1])
    dst = Path(sys.argv[2])
    if not src.is_file():
        print(f"Missing input: {src}", file=sys.stderr)
        return 1
    data = src.read_bytes()
    out = remove(data)
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(out)
    print(f"Wrote {dst} ({len(out)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
