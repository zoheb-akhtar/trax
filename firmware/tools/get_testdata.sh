#!/bin/bash
# Real street footage for tests/test_real_footage.py and tools/eval_road.py (~12 MB, not in git):
# YOLOP's sample inference data (github.com/hustvl/YOLOP, MIT): 6 BDD100K dashcam frames + a drive.
set -e
cd "$(dirname "$0")/.."
mkdir -p testdata
B=https://github.com/hustvl/YOLOP/raw/main/inference
for f in 0ace96c3-48481887 3c0e7240-96e390d2 7dd9ef45-f197db95 8e1c1ab0-a8b92173 9aa94005-ff1d4c9a adb4871d-4d063244; do
  [ -f "testdata/$f.jpg" ] || curl -sL --fail -o "testdata/$f.jpg" "$B/images/$f.jpg"
done
[ -f testdata/drive.mp4 ] || curl -sL --fail -o testdata/drive.mp4 "$B/videos/1.mp4"
ls -la testdata
