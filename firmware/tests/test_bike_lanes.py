#!/usr/bin/env python3
"""Lane understanding on exact synthetic roads: road layouts in metres, projected through the real
front-camera model into the same masks YOLOP produces, then through road.py's analysis.

    .venv/bin/python tests/test_bike_lanes.py
"""
import os
import sys

import cv2
import numpy as np

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "tools"))
import geometry as G  # noqa: E402
import perception as P  # noqa: E402
import road as R  # noqa: E402
from eval_road import offline_road  # noqa: E402

cfg = G.load_config()
P.configure(cfg)
CAM = P.cam_model("front")
H_IMG, W_IMG = 616, 820
ok_all = []


class SIM:
    @staticmethod
    def box_for(camera, label, x, z, width_m=1.8):
        """Normalized xyxy of an object standing at (x, z) in the bike frame."""
        cam = P.cam_model(camera)
        H, ca, sa = P.HEIGHT_M[label], np.cos(cam.pitch), np.sin(cam.pitch)

        def proj(px, py, pz):
            fwd = pz * ca + (cam.h - py) * sa
            down = (cam.h - py) * ca - pz * sa
            return 0.5 + px / fwd * cam.fx, 0.5 + down / fwd * cam.fy
        u1, v1 = proj(x - width_m / 2, H, z)
        u2, v2 = proj(x + width_m / 2, 0.0, z)
        return [u1, v1, u2, v2]


def check(name, cond, extra=""):
    print(f"{'PASS' if cond else 'FAIL'}  {name} {extra}")
    ok_all.append(bool(cond))


def scene(road_x, lines, green=None, bike_x=0.0):
    """Masks + image for a straight road. road_x = (left, right) edge of the drivable surface,
    lines = x of painted lines, green = (x0, x1) of green paint. All relative to the bike, which
    sits at bike_x across the road (shifting it = the rider drifting sideways)."""
    rm, _ = offline_road(CAM)
    mh = round(R.MASK_W * H_IMG / W_IMG)
    X, Z = rm._ground_lut(mh, R.MASK_W)
    X = X + bike_x  # world x of each pixel
    pix = np.nan_to_num(Z, nan=0) / (CAM.fx * R.MASK_W) + 0.04  # half a pixel's width on the road
    valid = np.isfinite(Z)
    da = (valid & (X > road_x[0]) & (X < road_x[1])).astype(np.uint8)
    ll = np.zeros_like(da)
    for lx in lines:
        ll |= (valid & (np.abs(X - lx) < np.maximum(0.08, pix))).astype(np.uint8)
    img = np.full((H_IMG // 4, W_IMG // 4, 3), 110, np.uint8)
    if green:
        small = cv2.resize(((X > green[0]) & (X < green[1]) & valid).astype(np.uint8), (W_IMG // 4, H_IMG // 4),
                           interpolation=cv2.INTER_NEAREST)
        img[small > 0] = (60, 170, 60)
    return rm, img, da, ll


def analyse(road_x, lines, green=None, bike_x=0.0, frames=12):
    rm, img, da, ll = scene(road_x, lines, green, bike_x)
    rm.auto_pitch = False  # the synthetic road is drawn with the configured pitch
    st = None
    for i in range(frames):
        st = rm._analyse(img, da, ll, 100 + i * 0.2)
    return st


# 1. painted bike lane (1.7 m) between a line and the curb, car lane to the left
st = analyse(road_x=(-8.0, 0.9), lines=[-0.8, -4.3])
check("bike lane: line + curb, 1.7 m", st["laneType"] == "bike_lane" and st["laneConfidence"] >= 0.6
      and 1.4 < st["laneWidthM"] < 2.0, f"{st['laneType']} {st['laneConfidence']} {st.get('laneWidthM')}")
# 2. normal car lane, 3.5 m between two lines
st = analyse(road_x=(-6.0, 6.0), lines=[-1.75, 1.75])
check("car lane: 3.5 m between lines", st["laneType"] == "traffic_lane" and 3.2 < st["laneWidthM"] < 3.8,
      f"{st['laneType']} {st.get('laneWidthM')}")
# 3. green-painted bike lane (2.0 m), lines both sides
st = analyse(road_x=(-6.0, 4.0), lines=[-1.0, 1.0], green=(-1.0, 1.0))
check("green bike lane", st["laneType"] == "bike_lane" and st["laneConfidence"] >= 0.75,
      f"{st['laneType']} {st['laneConfidence']}")
# 4. wide road where the middle line was missed (7 m between the outer lines)
st = analyse(road_x=(-5.0, 5.0), lines=[-3.5, 3.5])
check("missed middle line: multi-lane, never a bike lane", st["laneType"] == "traffic_lane" and st.get("multiLane"),
      f"{st['laneType']} {st.get('laneWidthM')} multi={st.get('multiLane')}")
# 5. rider drifting toward the line of a bike lane (0.7 m left of the lane centre)
st = analyse(road_x=(-8.0, 0.9), lines=[-0.8, -4.3], bike_x=-0.65)
alerts = [k for k, _, _ in P._road_situations(st, [])]
check("drifting out of the bike lane", "leaving_bike_lane" in alerts, f"offset {st.get('offsetM')} alerts {alerts}")
# 6. a car stopped in the bike lane ahead (seen over several frames)
st = analyse(road_x=(-8.0, 0.9), lines=[-0.8, -4.3])
eng = P.Perception(cameras=("front",))
kinds = set()
for i in range(10):
    t = 300 + i * 0.1
    eng.update("front", t, [SIM.box_for("front", "car", 0.0, 14 - 0.2 * i)], [0.9], ["car"])
    st["laneStableS"] = 3.0
    _, al, _ = eng.snapshot(t, ego={"speed": 2.0}, road=st)
    kinds |= {a["kind"] for a in al}
check("car stopped in the bike lane ahead", "vehicle_in_bike_lane" in kinds, sorted(kinds))
# 7. the same car in a car lane: no bike-lane alert
st = analyse(road_x=(-6.0, 6.0), lines=[-1.75, 1.75])
eng = P.Perception(cameras=("front",))
kinds = set()
for i in range(10):
    t = 400 + i * 0.1
    eng.update("front", t, [SIM.box_for("front", "car", 0.0, 14 - 0.2 * i)], [0.9], ["car"])
    _, al, _ = eng.snapshot(t, ego={"speed": 2.0}, road=st)
    kinds |= {a["kind"] for a in al}
check("same car in a car lane: no bike-lane alert", "vehicle_in_bike_lane" not in kinds, sorted(kinds))

# 8. narrow lane painted on both sides: weak evidence alone (below the alert threshold) ...
st = analyse(road_x=(-6.0, 4.0), lines=[-0.9, 0.9])
check("narrow two-line lane alone: below alert confidence", st["laneConfidence"] < 0.55,
      f"{st['laneType']} {st['laneConfidence']}")
# ... until a painted bike symbol is seen in it (YOLO-World 'bike lane marking')
eng = P.Perception(cameras=("front",))
for i in range(4):
    t = 500 + i * 0.1
    eng.update("front", t, [SIM.box_for("front", "car", 0.0, 9.0, width_m=0.8)], [0.6], ["bike lane marking"])
    eng.snapshot(t, road=st)
rv = eng.road_view
check("bike symbol in the lane confirms the bike lane", rv["laneType"] == "bike_lane" and rv["laneConfidence"] >= 0.8,
      f"{rv['laneType']} {rv['laneConfidence']} {rv.get('laneEvidence')}")

print(f"\n{sum(ok_all)}/{len(ok_all)} checks pass")
sys.exit(0 if all(ok_all) else 1)
