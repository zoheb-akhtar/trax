#!/usr/bin/env python3
"""Bakes Trax's open-vocabulary detector: YOLO-World v2 (s) with Trax's own class list.

YOLO-World finds things from text prompts. Baking runs the CLIP text encoder once and stores the
class embeddings inside models/trax-world.pt, so the brain needs no CLIP at run time.
Re-run after editing WORLD_VOCAB in detectors.py.

    python tools/bake_world.py

Needs ultralytics + CLIP (`pip install git+https://github.com/ultralytics/CLIP.git`). The
YOLO-World weights (yolov8s-worldv2.pt, ~25 MB) and CLIP ViT-B/32 (~340 MB) download on first
use, unless already on this machine: set WORLD_WEIGHTS to an existing yolov8s-worldv2.pt and
CLIP_DIR to a folder holding weights/clip/ViT-B-32.pt (the owner's Mac uses ~/duino-vision).
"""
import os
import shutil
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
from detectors import WORLD_VOCAB  # noqa: E402

_local = os.path.expanduser("~/duino-vision")
SRC = os.environ.get("WORLD_WEIGHTS") or (os.path.join(_local, "yolov8s-worldv2.pt")
                                          if os.path.exists(os.path.join(_local, "yolov8s-worldv2.pt"))
                                          else "yolov8s-worldv2.pt")
CLIP_DIR = os.environ.get("CLIP_DIR") or (_local if os.path.isdir(os.path.join(_local, "weights", "clip")) else None)
OUT = os.path.join(HERE, "models", "trax-world.pt")

if __name__ == "__main__":
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    if CLIP_DIR:
        os.chdir(CLIP_DIR)  # ultralytics looks for CLIP in ./weights/clip
    from ultralytics import YOLO

    m = YOLO(SRC)
    m.set_classes([v[0] for v in WORLD_VOCAB])
    for attr in ("clip_model", "text_model"):  # cached CLIP encoder: not needed once baked
        if hasattr(m.model, attr):
            setattr(m.model, attr, None)
    tmp = os.path.join(HERE, "models", "trax-world.tmp.pt")
    m.save(tmp)
    shutil.move(tmp, OUT)
    print("saved", OUT, "with", len(WORLD_VOCAB), "classes")
