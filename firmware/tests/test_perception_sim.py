#!/usr/bin/env python3
"""Scenario tests for perception.py: synthetic detections rendered through the real camera
geometry, run through tracking, 3D positions, velocities and the situation rules.

    .venv/bin/python tests/test_perception_sim.py
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import geometry as G  # noqa: E402
import perception as P  # noqa: E402

P.configure(G.DEFAULT_CONFIG)
WIDTH_M = {"car": 1.8, "person": 0.5, "bicycle": 0.6}


def box_for(camera, label, x, z):
    """Normalized xyxy of an object standing at (x, z) in the bike frame."""
    cam = P.cam_model(camera)
    cx, cz = (-x, -z) if cam.backward else (x, z)
    H, Wm = P.HEIGHT_M[label], WIDTH_M.get(label, 0.6)
    ca, sa = math.cos(cam.pitch), math.sin(cam.pitch)

    def proj(px, py, pz):  # py = height above road
        fwd = pz * ca + (cam.h - py) * sa
        down = (cam.h - py) * ca - pz * sa
        return 0.5 + px / fwd * cam.fx, 0.5 + down / fwd * cam.fy

    u1, v_top = proj(cx - Wm / 2, H, cz)
    u2, v_bot = proj(cx + Wm / 2, 0.0, cz)
    return [max(0, u1), max(0, v_top), min(1, u2), min(1, v_bot)]


import random  # noqa: E402

NOISE = [0.0]


def noisy(b):
    """Detector jitter: each box edge moves by ~NOISE of the box size."""
    if not NOISE[0]:
        return b
    w, h = b[2] - b[0], b[3] - b[1]
    return [b[0] + random.gauss(0, NOISE[0]) * w, b[1] + random.gauss(0, NOISE[0]) * h,
            b[2] + random.gauss(0, NOISE[0]) * w, b[3] + random.gauss(0, NOISE[0]) * h]


def run(name, steps, ego_speed=None, road=None, expect=(), forbid=(), check=None):
    eng = P.Perception(cameras=("front", "seat"))
    kinds, last = set(), None
    for i, frame in enumerate(steps):
        t = 100 + i * 0.1
        for cam in ("front", "seat"):
            objs = [(lab, x, z) for c, lab, x, z in frame if c == cam]
            boxes = [noisy(box_for(cam, lab, x, z)) for lab, x, z in objs]
            eng.update(cam, t, boxes or [[0, 0, 0, 0]][:0], [0.9] * len(boxes), [o[0] for o in objs])
        dets, alerts, sur = eng.snapshot(t, ego={"speed": ego_speed}, road=road)
        kinds |= {a["kind"] for a in alerts}
        last = (dets, alerts, sur)
    ok = all(k in kinds for k in expect) and not any(k in kinds for k in forbid)
    extra = check(last) if check else ""
    print(f"{'PASS' if ok and not extra.startswith('FAIL') else 'FAIL'}  {name}: alerts {sorted(kinds)} {extra}")
    return ok


def dist_check(target):
    def f(last):
        dets = last[0]
        if not dets:
            return "FAIL no detections"
        d = dets[0]
        x, z = d["position"]
        err = math.hypot(x - target[0], z - target[1])
        return f"| pos {d['position']} vel {d.get('velocity')} err {err:.2f} m" + (" FAIL" if err > 0.25 * math.hypot(*target) else "")
    return f


results = []
# 1. a car coming up from behind, passing with only 0.5 m between its side and the bike
steps = [[("seat", "car", -1.8, -25 + 1.2 * i)] for i in range(18)]  # 12 m/s closing
results.append(run("close pass on the left (seat cam)", steps, expect=["close_pass"]))
# 2. same car passing a safe 2.8 m away
steps = [[("seat", "car", -2.8, -25 + 1.2 * i)] for i in range(18)]
results.append(run("safe pass at 2.8 m", steps, forbid=["close_pass", "rear_collision"]))
# 3. car straight behind closing fast
steps = [[("seat", "car", 0.0, -20 + 1.0 * i)] for i in range(16)]
results.append(run("car right behind, closing", steps, expect=["rear_collision"]))
# 4. pedestrian crossing from the right into the path, 8 m ahead
steps = [[("front", "person", 3.0 - 0.15 * i, 8.0)] for i in range(14)]
results.append(run("pedestrian crossing ahead", steps, expect=["crossing"]))
# 5. static distance accuracy: car 12 m ahead, 1.5 m right
steps = [[("front", "car", 1.5, 12.0)] for _ in range(8)]
results.append(run("distance accuracy 12 m", steps, check=dist_check((1.5, 12.0))))
# 6. parked car on the right while riding at 5 m/s, passing with 0.75 m between its side and the
#    bike (it approaches at the bike's own speed)
steps = [[("front", "car", 2.05, 14 - 0.5 * i)] for i in range(14)]
results.append(run("parked car, door zone", steps, ego_speed=5.0, expect=["door_zone"], forbid=["collision"]))
# 7. oncoming car in our lane
steps = [[("front", "car", 0.3, 30 - 1.5 * i)] for i in range(14)]
results.append(run("oncoming car", steps, ego_speed=5.0, expect=["oncoming"]))
# 8. car turning right across the bike from the left
steps = [[("front", "car", -4.0 + 0.25 * i, 9.0)] for i in range(14)]
results.append(run("right hook", steps, expect=["right_hook"]))
# 9-10. the same close pass and parked car with realistic detector jitter (3 % of box size)
random.seed(1)
NOISE[0] = 0.03
steps = [[("seat", "car", -1.8, -25 + 1.2 * i)] for i in range(18)]
results.append(run("close pass, noisy boxes", steps, expect=["close_pass"]))
steps = [[("seat", "car", -2.8, -25 + 1.2 * i)] for i in range(18)]
results.append(run("safe pass, noisy boxes", steps, forbid=["close_pass", "rear_collision"]))
steps = [[("front", "car", 2.05, 14 - 0.5 * i)] for i in range(16)]
results.append(run("parked car, noisy boxes", steps, ego_speed=5.0, expect=["door_zone"], forbid=["collision"]))
NOISE[0] = 0.0


def brake_scenario():
    """Lead car 12 m ahead in our path; its tail lights switch on halfway through."""
    import cv2
    import numpy as np
    eng = P.Perception(cameras=("front", "seat"))
    kinds, lead_seen = set(), False
    for i in range(30):
        t = 200 + i * 0.1
        z = 12 - 0.05 * i
        b = box_for("front", "car", 0.0, z)
        img = np.full((616, 820, 3), 90, np.uint8)
        x1, y1, x2, y2 = int(b[0] * 820), int(b[1] * 616), int(b[2] * 820), int(b[3] * 616)
        cv2.rectangle(img, (x1, y1), (x2, y2), (60, 60, 60), -1)
        lamp = (40, 40, 255) if i >= 15 else (40, 40, 110)  # dim red -> bright red
        h = y2 - y1
        for lx in (x1 + 2, x2 - (x2 - x1) // 5 - 2):
            cv2.rectangle(img, (lx, y1 + int(0.45 * h)), (lx + (x2 - x1) // 5, y1 + int(0.6 * h)), lamp, -1)
        eng.update("front", t, [b], [0.9], ["car"], img)
        dets, alerts, _ = eng.snapshot(t, ego={"speed": 0.5})
        lead_seen |= any(d.get("lead") for d in dets)
        kinds |= {a["kind"] for a in alerts}
    ok = "lead_braking" in kinds and lead_seen
    print(f"{'PASS' if ok else 'FAIL'}  lead car brake lights: lead={lead_seen} alerts {sorted(kinds)}")
    return ok


results.append(brake_scenario())
print(f"\n{sum(results)}/{len(results)} scenarios pass")
sys.exit(0 if all(results) else 1)
