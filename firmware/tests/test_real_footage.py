#!/usr/bin/env python3
"""Regression test on real street footage (YOLOP's sample drive, BDD100K-style dashcam frames).

    ./tools/get_testdata.sh                      # once: ~12 MB into testdata/
    .venv/bin/python tests/test_real_footage.py

Checks the whole pipeline (YOLO + zoom pass + YOLOP road + auto pitch + tracking + alerts) on a
stop-and-go expressway drive: the camera's pitch is unknown and must self-calibrate, the lane must
come out as a ~3-3.8 m traffic lane (not a bike lane), cars must be found, and there must be no
false danger alerts (cars in the next lanes being overtaken, a queue far ahead).
"""
import collections
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
video = os.path.join(HERE, "testdata", "drive.mp4")
if not os.path.exists(video):
    sys.exit("missing testdata/drive.mp4: run ./tools/get_testdata.sh")
out = subprocess.run([sys.executable, os.path.join(HERE, "tools", "eval_road.py"), video, "--every", "3",
                      "--max", "80", "--zoom", "--out", os.path.join(HERE, "testdata", "vid")],
                     capture_output=True, text=True, cwd=HERE).stdout
rows = [json.loads(l) for l in out.splitlines() if l.startswith("{")]
settled = rows[10:]  # after the pitch has calibrated
lanes = collections.Counter(r["laneType"] for r in settled)
widths = [r["laneWidthM"] for r in settled if r["laneWidthM"] and r["laneType"] == "traffic_lane"]
alerts = collections.Counter(a for r in rows for a in r["alerts"])
pitch = settled[-1]["pitchDeg"]
checks = {
    "pitch self-calibrated (camera tilted up ~5 deg)": -8 < pitch < -2,
    "lane is a traffic lane >= 85% of the time": lanes["traffic_lane"] >= 0.85 * len(settled),
    "median traffic-lane width 2.8-3.9 m": widths and 2.8 <= sorted(widths)[len(widths) // 2] <= 3.9,
    "cars detected in every frame": all(len(r["objects"]) >= 3 for r in rows),
    "no false danger alerts": not any(k in alerts for k in ("collision", "right_hook", "oncoming", "close_pass")),
}
for name, ok in checks.items():
    print(f"{'PASS' if ok else 'FAIL'}  {name}")
print(f"  (pitch {pitch}, lanes {dict(lanes)}, alerts {dict(alerts)})")
print(f"\n{sum(map(bool, checks.values()))}/{len(checks)} checks pass")
sys.exit(0 if all(checks.values()) else 1)
