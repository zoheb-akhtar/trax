#!/bin/bash
# Downloads / builds the model weights Trax needs (they're too big for git) into firmware/models/.
#   ./tools/get_models.sh
set -e
cd "$(dirname "$0")/.."
mkdir -p models
# YOLOP (hustvl/YOLOP, MIT, trained on BDD100K): drivable area + lane lines for road.py
for f in yolop-320-320.onnx yolop-640-640.onnx; do
  [ -f "models/$f" ] || curl -L --fail -o "models/$f" "https://github.com/hustvl/YOLOP/raw/main/weights/$f"
done
# YOLO11s (COCO): ultralytics downloads it on first use; fetch it now so the first run is quick
[ -f yolo11s.pt ] || python -c "from ultralytics import YOLO; YOLO('yolo11s.pt')"
# YOLO-World with Trax's vocabulary (cones, signs, scooters, emergency vehicles, faces)
[ -f models/trax-world.pt ] || python tools/bake_world.py
ls -la models yolo11s.pt
