#!/usr/bin/env python3
"""Run Velo's road understanding + detection on images or a video and save annotated frames.

    .venv/bin/python tools/eval_road.py testdata/*.jpg --out testdata/out
    .venv/bin/python tools/eval_road.py ride.mp4 --every 15 --out testdata/out

Draws YOLOP's drivable area / lane lines, the lane boundaries road.py picked, the ego path, the
lane type, and YOLO boxes with their estimated distances, and prints the road state per frame.
--hfov/--height/--pitch describe the camera (defaults: a car dashcam like BDD100K's).
"""
import argparse
import glob
import json
import os
import sys
import threading

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import detectors as D  # noqa: E402
import geometry as G  # noqa: E402
import perception as P  # noqa: E402
import road as R  # noqa: E402


def offline_road(cam, size=320):
    """A RoadModel without its worker process/thread, for frame-by-frame evaluation."""
    rm = object.__new__(R.RoadModel)
    rm.cam, rm.get_motion = cam, (lambda: (None, None))
    rm.lock, rm._lut, rm._fits = threading.Lock(), None, {"left": None, "right": None}
    rm.masks, rm._state, rm.hz, rm.infer_ms = None, {}, 0.0, 0.0
    rm.auto_pitch, rm._pitch0, rm._pitch_est, rm._pitch_n = True, cam.pitch, None, 0
    rm._votes = __import__("collections").deque()
    rm.name = f"yolop-{size}"
    model = R._Yolop(size)

    def step(img, t):
        da, ll = model(img)
        mh = round(R.MASK_W * img.shape[0] / img.shape[1])
        da = cv2.resize(da, (R.MASK_W, mh), interpolation=cv2.INTER_NEAREST)
        ll = cv2.resize(ll, (R.MASK_W, mh), interpolation=cv2.INTER_NEAREST)
        small = cv2.resize(img, (img.shape[1] // 4, img.shape[0] // 4), interpolation=cv2.INTER_AREA)
        st = rm._analyse(small, da, ll, t)
        rm.masks, rm._state = (da, ll, __import__("time").time()), st  # draw() wants a fresh wall-clock time
        return st
    return rm, step


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("inputs", nargs="+")
    ap.add_argument("--out", default="testdata/out")
    ap.add_argument("--every", type=int, default=10, help="video: analyse every Nth frame")
    ap.add_argument("--max", type=int, default=40)
    ap.add_argument("--hfov", type=float, default=66.0)
    ap.add_argument("--vfov", type=float, default=0, help="default: from hfov and the frame aspect")
    ap.add_argument("--height", type=float, default=1.35)
    ap.add_argument("--pitch", type=float, default=2.0)
    ap.add_argument("--size", type=int, default=320)
    ap.add_argument("--zoom", action="store_true", help="add the centre zoom pass")
    ap.add_argument("--single", action="store_true", help="inputs are unrelated still images")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    frames = []
    for inp in a.inputs:
        for path in sorted(glob.glob(inp)):
            if path.lower().endswith((".mp4", ".mov", ".avi")):
                cap = cv2.VideoCapture(path)
                fps = cap.get(cv2.CAP_PROP_FPS) or 30
                i = 0
                while len(frames) < a.max:
                    ok, f = cap.read()
                    if not ok:
                        break
                    if i % a.every == 0:
                        frames.append((f"{os.path.splitext(os.path.basename(path))[0]}_{i:05d}.jpg", f, i / fps))
                    i += 1
            else:
                frames.append((os.path.basename(path), cv2.imread(path), len(frames) * 5.0))

    h, w = frames[0][1].shape[:2]
    vfov = a.vfov or np.degrees(2 * np.arctan(np.tan(np.radians(a.hfov / 2)) * h / w))
    cam = G.CameraModel(hfov=a.hfov, vfov=vfov, height_m=a.height, pitch_deg=a.pitch)
    cfg = G.load_config()
    cfg["cameras"]["front"].update(hfov=a.hfov, vfov=vfov, height_m=a.height, pitch_deg=a.pitch)
    P.configure(cfg)
    cam = P.cam_model("front")  # one camera object: the road model's auto-pitch must reach the distances too
    rm, step = offline_road(cam, a.size)
    det = D.YoloDetector()
    eng = P.Perception(cameras=("front",))
    summary = []
    for name, img, t in frames:
        st = step(img, t)
        res = det([img])[0]
        if a.zoom:
            win = D.zoom_window(cam, img.shape)
            zres = det([img[win[1]:win[3], win[0]:win[2]]])[0]
            res = D.merge_zoom(res, zres, win, img.shape)
            cv2.rectangle(img_dbg := img, (win[0], win[1]), (win[2], win[3]), (255, 255, 255), 1)
        xyxy, conf, labels = D.drop_ego(*res)
        if a.single:  # unrelated still images: show each twice so the tracker confirms them
            eng = P.Perception(cameras=("front",))
            eng.update("front", t - 0.05, xyxy, conf, labels, img)
        eng.update("front", t, xyxy, conf, labels, img)
        dets, alerts, _ = eng.snapshot(t, road=st)
        tile = rm.draw(img.copy(), st)
        for d in dets:
            x, y, bw, bh = d["box"]
            p1, p2 = (int(x * w), int(y * h)), (int((x + bw) * w), int((y + bh) * h))
            col = (40, 40, 240) if d.get("threat", 0) >= 2 else (80, 220, 80)
            cv2.rectangle(tile, p1, p2, col, 2)
            txt = f"{d['label']} {d['distanceM']:.0f}m" if d.get("distanceM") is not None else d["label"]
            if d.get("inPath"):
                txt += " IN PATH"
            cv2.putText(tile, txt, (p1[0], max(14, p1[1] - 5)), cv2.FONT_HERSHEY_SIMPLEX, 0.55, col, 2, cv2.LINE_AA)
        info = f"{st.get('laneType')} {st.get('laneConfidence', 0):.0%}"
        if st.get("laneWidthM"):
            info += f"  width {st['laneWidthM']:.1f} m  offset {st.get('offsetM', 0):+.1f} m"
        for k in ("leftBoundary", "rightBoundary"):
            if st.get(k):
                info += f"  {k[:1].upper()}:{st[k]['type']}@{st[k]['distanceM']:.1f}m"
        cv2.rectangle(tile, (0, 0), (w, 30), (0, 0, 0), -1)
        cv2.putText(tile, info, (8, 21), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1, cv2.LINE_AA)
        cv2.imwrite(os.path.join(a.out, os.path.splitext(name)[0] + ".jpg"), tile)
        row = {"frame": name, **{k: st.get(k) for k in ("laneType", "laneConfidence", "laneWidthM", "offsetM",
                                                         "drivableFraction", "pitchDeg")},
               "left": st.get("leftBoundary", {}).get("type"), "right": st.get("rightBoundary", {}).get("type"),
               "objects": [(d["label"], d.get("distanceM")) for d in dets][:6],
               "alerts": [al["kind"] for al in alerts]}
        summary.append(row)
        print(json.dumps(row))
    json.dump(summary, open(os.path.join(a.out, "summary.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
