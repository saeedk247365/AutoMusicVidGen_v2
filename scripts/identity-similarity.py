#!/usr/bin/env python3
"""Compare InsightFace embeddings: reference vs candidate. Prints JSON to stdout."""
from __future__ import annotations

import json
import sys

import cv2
import numpy as np


def largest_embedding(app, path: str):
    img = cv2.imread(path)
    if img is None:
        return None, "read_failed"
    faces = app.get(img)
    if not faces:
        return None, "no_face"
    face = max(
        faces,
        key=lambda f: float(f.bbox[2] - f.bbox[0]) * float(f.bbox[3] - f.bbox[1]),
    )
    emb = getattr(face, "normed_embedding", None)
    if emb is None:
        emb = face.embedding
        emb = emb / (np.linalg.norm(emb) + 1e-9)
    return np.asarray(emb, dtype=np.float32), "ok"


def main() -> int:
    if len(sys.argv) < 3:
        print(
            json.dumps(
                {
                    "ok": False,
                    "reason": "usage",
                    "similarity": None,
                    "message": "usage: identity-similarity.py <ref.png> <candidate.png>",
                }
            )
        )
        return 2

    ref_path, cand_path = sys.argv[1], sys.argv[2]
    try:
        from insightface.app import FaceAnalysis
    except Exception as e:
        print(
            json.dumps(
                {
                    "ok": False,
                    "reason": "import_error",
                    "similarity": None,
                    "message": str(e),
                }
            )
        )
        return 1

    app = FaceAnalysis(
        name="buffalo_l",
        providers=["CUDAExecutionProvider", "CPUExecutionProvider"],
    )
    app.prepare(ctx_id=0, det_size=(640, 640))

    a, ra = largest_embedding(app, ref_path)
    if a is None:
        print(json.dumps({"ok": False, "reason": ra, "similarity": None, "side": "ref"}))
        return 0
    b, rb = largest_embedding(app, cand_path)
    if b is None:
        print(json.dumps({"ok": False, "reason": rb, "similarity": None, "side": "candidate"}))
        return 0

    sim = float(np.dot(a, b))
    print(json.dumps({"ok": True, "reason": "ok", "similarity": sim}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
