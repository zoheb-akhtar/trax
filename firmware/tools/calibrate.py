#!/usr/bin/env python3
"""Calibrate a camera's mount (height, tilt, lens) so Velo's distances are right on YOUR bike.

    .venv/bin/python tools/calibrate.py                  # front camera (live, from the brain or the board)
    .venv/bin/python tools/calibrate.py --camera seat    # the rear-facing seat webcam
    .venv/bin/python tools/calibrate.py --known 5        # click the base of something exactly 5 m away

A metre grid is drawn on the road: lines every metre sideways, distance marks at 2-30 m. With the
bike upright on flat ground:
  1. measure the camera's height above the road with a tape; set it with A / D (2 cm steps)
  2. put an object (backpack, cone) at a measured distance, e.g. 5 m straight ahead
  3. start with --known 5 and click the object's base: the tilt is solved exactly. Or adjust the
     tilt with W / S until the object sits on the 5 m line.
  4. check a second distance (10 m) lands right; if not, adjust the lens width with J / L
  5. press P to save to velo_config.json (the brain uses it next start)
Keys: W/S tilt, A/D height, J/L lens, click = distance of that road point, P save, Q quit.
While riding, the brain also fine-tunes the tilt from the lane lines (auto-pitch).
"""
import argparse
import json
import math
import os
import sys
import threading
import time
import urllib.request

import cv2
import numpy as np

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)
import geometry as G  # noqa: E402


class Frames:
    """Newest frame from the brain's stream (if it runs), else the board, else a video file."""

    def __init__(self, camera, source):
        self.img = None
        self.status = "connecting"
        threading.Thread(target=self._run, args=(camera, source), daemon=True).start()

    def _run(self, camera, source):
        if source and os.path.exists(source):
            cap = cv2.VideoCapture(source)
            while True:
                ok, f = cap.read()
                if not ok:
                    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                    continue
                self.img, self.status = f, "file"
                time.sleep(1 / 15)
        urls = [source] if source else []
        urls.append(f"http://localhost:8000/stream?camera={camera}")
        try:
            import board as B

            u = B.Board().url(camera)
            if u:
                urls.append(u)
        except Exception:  # noqa: BLE001
            pass
        while True:
            for url in urls:
                try:
                    with urllib.request.urlopen(url, timeout=4) as r:
                        self.status = url
                        data = b""
                        while True:
                            chunk = r.read(65536)
                            if not chunk:
                                break
                            data += chunk
                            e = data.rfind(b"\xff\xd9")
                            s = data.rfind(b"\xff\xd8", 0, e) if e >= 0 else -1
                            if s >= 0:
                                self.img = cv2.imdecode(np.frombuffer(data[s:e + 2], np.uint8), cv2.IMREAD_COLOR)
                                data = data[e + 2:]
                except Exception:  # noqa: BLE001
                    continue
            self.status = "no camera: start the brain, or plug in the board"
            time.sleep(1)


def draw_grid(img, cam, sign):
    """Road grid in metres. sign = +1 for a forward camera, -1 for a backward one."""
    H, W = img.shape[:2]
    out = img.copy()

    def P(x, z):
        uv = cam.project(x * sign, z * sign)
        return None if uv is None else (int(uv[0] * W), int(uv[1] * H))
    for x in np.arange(-4, 4.01, 1.0):  # sideways lines
        pts = [P(x, z) for z in np.arange(1.5, 40, 0.5)]
        pts = [p for p in pts if p and -W < p[0] < 2 * W]
        col = (0, 255, 255) if x == 0 else (255, 255, 255)
        for a, b in zip(pts, pts[1:]):
            cv2.line(out, a, b, col, 2 if x == 0 else 1, cv2.LINE_AA)
    for z in (2, 3, 5, 10, 15, 20, 30):  # distance marks
        a, b = P(-4, z), P(4, z)
        if a and b:
            cv2.line(out, a, b, (0, 200, 255) if z in (5, 10) else (200, 200, 200), 2 if z in (5, 10) else 1, cv2.LINE_AA)
            cv2.putText(out, f"{z} m", (min(b[0], W - 60), b[1] - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 220, 255), 2,
                        cv2.LINE_AA)
    hv = int(cam.horizon_v * H)
    cv2.line(out, (0, hv), (W, hv), (255, 120, 0), 1, cv2.LINE_AA)
    cv2.putText(out, "horizon", (8, hv - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 120, 0), 1, cv2.LINE_AA)
    return cv2.addWeighted(out, 0.75, img, 0.25, 0)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--camera", default="front", choices=("front", "seat", "rear"))
    ap.add_argument("--source", help="stream URL or video file (default: the brain / the board)")
    ap.add_argument("--known", type=float, help="click the base of an object this many metres away to solve the tilt")
    ap.add_argument("--snapshot", help="render one frame with the grid to this file and exit (no window)")
    a = ap.parse_args()

    cfg = G.load_config()
    c = dict(cfg["cameras"][a.camera])
    sign = -1 if abs(((c.get("yaw_deg", 0) + 180) % 360) - 180) > 90 else 1
    frames = Frames(a.camera, a.source)
    t0 = time.time()
    while frames.img is None and time.time() - t0 < 15:
        time.sleep(0.1)
    if frames.img is None:
        sys.exit(f"no picture from the {a.camera} camera ({frames.status})")
    aspect = frames.img.shape[0] / frames.img.shape[1]

    def model():
        vfov = math.degrees(2 * math.atan(math.tan(math.radians(c["hfov"] / 2)) * aspect))
        return G.CameraModel(**{**c, "vfov": vfov if a.camera == "seat" else c.get("vfov", vfov)})

    if a.snapshot:
        cv2.imwrite(a.snapshot, draw_grid(frames.img, model(), sign))
        print("saved", a.snapshot)
        return

    click = {}

    def on_mouse(ev, x, y, *_):
        if ev == cv2.EVENT_LBUTTONDOWN:
            click["uv"] = (x / frames.img.shape[1], y / frames.img.shape[0])
            if a.known:  # solve the tilt so this point is exactly `known` metres away
                ang = math.atan(c["height_m"] / a.known)
                cam = model()
                c["pitch_deg"] = round(math.degrees(ang - math.atan((click["uv"][1] - 0.5) / cam.fy)), 2)
                print(f"tilt solved: {c['pitch_deg']} deg (object at {a.known} m)")

    win = f"Velo calibration: {a.camera}"
    cv2.namedWindow(win, cv2.WINDOW_NORMAL)
    cv2.setMouseCallback(win, on_mouse)
    print(__doc__.split("Keys:")[1])
    while True:
        cam = model()
        view = draw_grid(frames.img, cam, sign)
        if "uv" in click:
            u, v = click["uv"]
            g = cam.ground_point(u, v)
            p = (int(u * view.shape[1]), int(v * view.shape[0]))
            cv2.circle(view, p, 7, (0, 0, 255), 2)
            if g:
                cv2.putText(view, f"{math.hypot(*g):.2f} m  (x {g[0]:+.2f}, z {g[1]:+.2f})", (p[0] + 10, p[1] - 10),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2, cv2.LINE_AA)
        info = f"height {c['height_m']:.2f} m   tilt {c['pitch_deg']:+.2f} deg   lens {c['hfov']:.1f} deg   P save  Q quit"
        cv2.rectangle(view, (0, 0), (view.shape[1], 30), (0, 0, 0), -1)
        cv2.putText(view, info, (8, 21), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1, cv2.LINE_AA)
        cv2.imshow(win, view)
        k = cv2.waitKey(30) & 0xFF
        if k in (ord("q"), 27):
            break
        step = {ord("w"): ("pitch_deg", 0.25), ord("s"): ("pitch_deg", -0.25), ord("d"): ("height_m", 0.02),
                ord("a"): ("height_m", -0.02), ord("l"): ("hfov", 1.0), ord("j"): ("hfov", -1.0)}.get(k)
        if step:
            c[step[0]] = round(c[step[0]] + step[1], 3)
        if k == ord("p"):
            user = json.load(open(G.CONFIG_PATH)) if os.path.exists(G.CONFIG_PATH) else {}
            user.setdefault("cameras", {}).setdefault(a.camera, {}).update(
                {k_: c[k_] for k_ in ("height_m", "pitch_deg", "hfov")}, calibrated=time.strftime("%Y-%m-%d"))
            if a.camera == "seat":
                user["cameras"][a.camera]["vfov"] = round(model().vfov, 2)
            json.dump(user, open(G.CONFIG_PATH, "w"), indent=2)
            print(f"saved {a.camera}: height {c['height_m']} m, tilt {c['pitch_deg']} deg, lens {c['hfov']} deg -> {G.CONFIG_PATH}")
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
