"""Velo road understanding: where the road is, the lane you are in, bike lanes, your path.

YOLOP (hustvl/YOLOP, trained on the BDD100K driving dataset) segments every frame of the front
camera into drivable road and lane lines. This module turns those masks into metres on the road
(geometry.CameraModel) and works out:

  * your lane: the nearest lane line or road edge on each side, as curves x(z), and its width
  * lane type: bike lane (narrow lane between a line and the curb, or green paint), traffic lane
    (car-width), or unknown, with a confidence
  * your offset from the lane centre
  * the ego path, Tesla-style: where the bike will be over the next ~20 m, from the IMU yaw rate
    and GPS speed when riding, otherwise following the shape of the lane / road ahead

Runs in its own thread at whatever rate the CPU allows (YOLOP-320: ~3 Hz on a MacBook Air in
Low Power Mode via OpenCV; much faster with `pip install onnxruntime`, used automatically).
"""

from __future__ import annotations

import math
import os
import threading
import time

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)

MASK_W = 160  # working resolution of the masks (width; height follows the frame's aspect)
Z_NEAR, Z_FAR = 1.5, 25.0


class _Yolop:
    def __init__(self, size):
        path = os.path.join(HERE, "models", f"yolop-{size}-{size}.onnx")
        self.size = size
        self.backend = "opencv"
        self.sess = None
        try:
            import onnxruntime as ort

            prov = [p for p in ("CoreMLExecutionProvider", "CPUExecutionProvider") if p in ort.get_available_providers()]
            self.sess = ort.InferenceSession(path, providers=prov)
            self.backend = "onnxruntime " + prov[0].replace("ExecutionProvider", "")
        except Exception:  # noqa: BLE001  (not installed, or this model won't load there)
            self.net = cv2.dnn.readNetFromONNX(path)
            self.outs = ["drive_area_seg", "lane_line_seg"]

    def __call__(self, bgr):
        """-> (drivable mask, lane mask), uint8 0/1, in the frame's own aspect ratio."""
        H, W = bgr.shape[:2]
        s = self.size
        r = min(s / W, s / H)
        nw, nh = int(round(W * r)), int(round(H * r))
        dw, dh = (s - nw) // 2, (s - nh) // 2
        canvas = np.full((s, s, 3), 114, np.uint8)
        canvas[dh:dh + nh, dw:dw + nw] = cv2.resize(bgr, (nw, nh), interpolation=cv2.INTER_AREA)
        x = (canvas[:, :, ::-1].astype(np.float32) / 255.0 - MEAN) / STD
        x = np.ascontiguousarray(x.transpose(2, 0, 1)[None])
        if self.sess is not None:
            _, da, ll = self.sess.run(None, {self.sess.get_inputs()[0].name: x})
        else:
            self.net.setInput(x)
            da, ll = self.net.forward(self.outs)
        da = da[0, :, dh:dh + nh, dw:dw + nw]
        ll = ll[0, :, dh:dh + nh, dw:dw + nw]
        return (da[1] > da[0]).astype(np.uint8), (ll[1] > ll[0]).astype(np.uint8)


def _worker(conn, size, threads):
    """Child process: JPEG in -> (drivable, lane) masks out. Its own process (and a capped thread
    count) so the CPU-heavy segmentation never starves the detectors in the brain process."""
    cv2.setNumThreads(threads)
    model = _Yolop(size)
    conn.send(("ready", model.backend))
    while True:
        jpeg = conn.recv()
        if jpeg is None:
            return
        img = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_REDUCED_COLOR_2)
        if img is None:
            conn.send(None)
            continue
        t0 = time.time()
        da, ll = model(img)
        mh = round(MASK_W * img.shape[0] / img.shape[1])
        conn.send((cv2.resize(da, (MASK_W, mh), interpolation=cv2.INTER_NEAREST),
                   cv2.resize(ll, (MASK_W, mh), interpolation=cv2.INTER_NEAREST), (time.time() - t0) * 1000))


class RoadModel:
    """road = RoadModel(camera_model, get_jpeg, get_motion); road.state() -> dict for /state.

    get_jpeg() -> (jpeg bytes, t) or (None, 0): the newest front-camera frame.
    get_motion() -> (speed m/s or None, yaw rate rad/s or None): from GPS + IMU."""

    def __init__(self, cam, get_jpeg, get_motion=lambda: (None, None), size=320, threads=2):
        import multiprocessing as mp

        self.cam, self.get_jpeg, self.get_motion = cam, get_jpeg, get_motion
        ctx = mp.get_context("spawn")
        self.conn, child = ctx.Pipe()
        self.proc = ctx.Process(target=_worker, args=(child, size, threads), daemon=True)
        self.proc.start()
        self.name = f"yolop-{size}"
        self.lock = threading.Lock()
        self._state = {"ok": False, "model": self.name}
        self.masks = None  # (drivable, lane, t) for drawing
        self.hz, self.infer_ms = 0.0, 0.0
        self._lut = None
        self._fits = {"left": None, "right": None}  # smoothed (coeffs, type, t)
        self.auto_pitch = True
        self._votes = __import__("collections").deque()
        self._pitch0, self._pitch_est, self._pitch_n = cam.pitch, None, 0
        threading.Thread(target=self._run, daemon=True, name="road").start()

    # ---- main loop ----------------------------------------------------------------------
    def _run(self):
        msg = self.conn.recv()
        self.name += f" ({msg[1]})"
        last_t, n, t_win = 0.0, 0, time.time()
        while True:
            jpeg, t = self.get_jpeg()
            if jpeg is None or t == last_t:
                time.sleep(0.02)
                continue
            last_t = t
            self.conn.send(jpeg)
            res = self.conn.recv()
            if res is None:
                continue
            da, ll, ms = res
            # a small copy of the frame for the paint-colour check
            img = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_REDUCED_COLOR_4)
            self.infer_ms = ms if not self.infer_ms else 0.8 * self.infer_ms + 0.2 * ms
            state = self._analyse(img, da, ll, t)
            with self.lock:
                self.masks = (da, ll, t)
                self._state = state
            n += 1
            if time.time() - t_win >= 2:
                self.hz, n, t_win = n / (time.time() - t_win), 0, time.time()

    def state(self):
        with self.lock:
            s = dict(self._state)
        s["hz"], s["inferMs"] = round(self.hz, 1), round(self.infer_ms)
        return s

    # ---- geometry helpers -----------------------------------------------------------------
    def _ground_lut(self, h, w):
        """(x, z) on the road for every mask pixel (NaN above the horizon), cached per pitch."""
        cam = self.cam
        key = (h, w, round(cam.pitch, 4), cam.h, cam.fx, cam.fy, cam.backward)
        if self._lut is None or self._lut[0] != key:
            u = (np.arange(w) + 0.5) / w
            v = (np.arange(h) + 0.5) / h
            ang = cam.pitch + np.arctan((v - 0.5) / cam.fy)            # per row: angle below horizontal
            ok = ang > np.radians(0.3)
            d = np.where(ok, cam.h / np.tan(np.where(ok, ang, 1.0)), np.nan)
            depth = np.hypot(d, cam.h) * np.cos(ang - cam.pitch)
            X = ((u[None, :] - 0.5) / cam.fx) * depth[:, None]
            Z = np.repeat(d[:, None], w, axis=1)
            if cam.backward:
                X, Z = -X, -Z
            self._lut = (key, X.astype(np.float32), Z.astype(np.float32))
        return self._lut[1], self._lut[2]

    def _horizon_from_lanes(self, ll):
        """Image row (0-1) of the vanishing point where lane lines converge, or None.
        Straight segments of lane paint (Hough) leaning left and right are intersected; the median
        intersection height is the horizon. That gives the camera's true pitch on this road."""
        h, w = ll.shape
        segs = cv2.HoughLinesP((ll * 255).astype(np.uint8), 1, np.pi / 90, threshold=12,
                               minLineLength=max(8, h // 8), maxLineGap=6)
        if segs is None:
            return None
        lines = []
        for x1, y1, x2, y2 in segs[:, 0]:
            if y1 == y2:
                continue
            slope = (x2 - x1) / (y2 - y1)  # dx per dy
            if 0.15 < abs(slope) < 4:      # not horizontal (stop lines) nor vertical
                lines.append((x1, y1, slope, np.hypot(x2 - x1, y2 - y1)))
        left = [l for l in lines if l[2] < 0]   # x decreases going down: line on the left of the view
        right = [l for l in lines if l[2] > 0]
        ys, ws = [], []
        for a in left:
            for b in right:
                # x = xa + sa*(y - ya) = xb + sb*(y - yb)  ->  y
                y = (b[0] - a[0] + a[2] * a[1] - b[2] * b[1]) / (a[2] - b[2])
                x = a[0] + a[2] * (y - a[1])
                if -0.2 * h < y < 0.9 * h and -0.25 * w < x < 1.25 * w:
                    ys.append(y / h)
                    ws.append(a[3] * b[3])
        if len(ys) < 2:
            return None
        order = np.argsort(ys)
        cw = np.cumsum(np.array(ws)[order])
        return float(np.array(ys)[order][np.searchsorted(cw, cw[-1] / 2)])  # weighted median

    def _auto_pitch(self, ll, t):
        """Nudge the camera pitch toward what the lane vanishing point says (smoothed, clamped)."""
        v = self._horizon_from_lanes(ll)
        if v is None:
            return
        target = math.atan((0.5 - v) / self.cam.fy)
        base = self._pitch0
        target = min(max(target, base - math.radians(12)), base + math.radians(12))
        self._pitch_est = target if self._pitch_est is None else 0.85 * self._pitch_est + 0.15 * target
        self._pitch_n += 1
        if self._pitch_n >= 3:
            self.cam.pitch = round(self._pitch_est / math.radians(0.25)) * math.radians(0.25)

    # ---- analysis -------------------------------------------------------------------------
    def _analyse(self, img, da, ll, t):
        h, w = da.shape
        if self.auto_pitch:
            self._auto_pitch(ll, t)
        X, Z = self._ground_lut(h, w)
        valid = np.isfinite(Z) & (Z >= Z_NEAR) & (Z <= Z_FAR)
        out = {"ok": True, "model": self.name, "ts": int(t * 1000), "pitchDeg": round(math.degrees(self.cam.pitch), 2)}
        out["drivableFraction"] = round(float(da[valid].mean()) if valid.any() else 0.0, 3)

        # lane-line points on the road
        sel = valid & (ll > 0)
        lx, lz = X[sel], Z[sel]
        lines = self._lane_lines(lx, lz)

        # road edges: the drivable span that contains the bike's own heading, row by row
        edges = self._road_edges(da, X, Z, valid)

        left = self._pick("left", lines, edges, t)
        right = self._pick("right", lines, edges, t)
        speed, yaw_rate = self.get_motion()
        path = self._ego_path(left, right, edges, speed, yaw_rate)
        out["egoPath"] = [[round(x, 2), round(z, 1)] for x, z in path]
        if left:
            out["leftBoundary"] = self._boundary_out(left)
        if right:
            out["rightBoundary"] = self._boundary_out(right)
        lt, conf, width = self._lane_type(img, left, right, path)
        # vote over the last ~2 s: one frame missing a line shouldn't flip the lane type
        self._votes.append((t, lt, conf))
        while self._votes and t - self._votes[0][0] > 2.0:
            self._votes.popleft()
        tally = {}
        for _, k, c in self._votes:
            tally[k] = tally.get(k, 0.0) + max(c, 0.05)
        lt = max(tally, key=tally.get)
        same = [c for _, k, c in self._votes if k == lt]
        conf = sum(same) / len(self._votes)  # agreement-weighted confidence
        since = next((tt for tt, k, _ in self._votes if k == lt), t)
        out.update(laneType=lt, laneConfidence=round(conf, 2), laneStableS=round(t - since, 1))
        if width:
            out["laneWidthM"] = round(width, 2)
            if width > 4.6:
                out["multiLane"] = True
            out["offsetM"] = round(-(_x_at(left, 4.0) + _x_at(right, 4.0)) / 2, 2)  # + = right of centre
        return out

    def _lane_lines(self, lx, lz):
        """Lane-line candidates as quadratic x(z) fits: [(coeffs, n points)] sorted by x at 4 m."""
        if len(lx) < 25:
            return []
        # where the lines are, sideways: a histogram over 2-20 m. Dashed lines have gaps, so look
        # further than the solid-line-friendly near field, and weight far points up (perspective
        # makes them sparse in the mask)
        near = (lz >= 2) & (lz < 20)
        if near.sum() < 10:
            return []
        hist, edges = np.histogram(lx[near], bins=np.arange(-8, 8.01, 0.25), weights=0.5 + lz[near] / 10)
        hist = np.convolve(hist, [1, 2, 1], "same")
        peaks = [i for i in range(1, len(hist) - 1)
                 if hist[i] >= hist[i - 1] and hist[i] > hist[i + 1] and hist[i] >= 5]
        fits = []
        for i in peaks:
            x0 = (edges[i] + edges[i + 1]) / 2
            # follow the line outwards in z with a sliding window
            pts_x, pts_z = [], []
            xc = x0
            for z0 in np.arange(Z_NEAR, Z_FAR, 1.0):
                m = (lz >= z0) & (lz < z0 + 1.0) & (np.abs(lx - xc) < 0.45 + 0.03 * z0)
                if m.sum() >= 2:
                    xc = float(np.median(lx[m]))
                    pts_x.extend(lx[m]), pts_z.extend(lz[m])
            if len(pts_x) >= 8 and (max(pts_z) - min(pts_z)) > 3:
                deg = 2 if max(pts_z) - min(pts_z) > 8 else 1
                c = np.polyfit(pts_z, pts_x, deg)
                if deg == 1:
                    c = np.array([0.0, *c])
                fits.append((c, len(pts_x)))
        # merge near-duplicates (both edges of one painted line)
        fits.sort(key=lambda f: np.polyval(f[0], 4.0))
        merged = []
        for c, n in fits:
            if merged and abs(np.polyval(c, 4.0) - np.polyval(merged[-1][0], 4.0)) < 0.35:
                if n > merged[-1][1]:
                    merged[-1] = (c, n)
                continue
            merged.append((c, n))
        return merged

    def _road_edges(self, da, X, Z, valid):
        """Left/right edge of the drivable area around the bike's heading: [(z, x_left, x_right)]."""
        h, w = da.shape
        rows = []
        for r in range(h - 1, -1, -2):
            zs = Z[r]
            if not np.isfinite(zs).any():
                break
            z = float(np.nanmedian(zs))
            if z < Z_NEAR:
                continue
            if z > Z_FAR:
                break
            col = int(np.nanargmin(np.abs(X[r])))  # the column straight ahead at this distance
            if not da[r, col]:
                continue
            row = da[r]
            a = col
            while a > 0 and row[a - 1]:
                a -= 1
            b = col
            while b < w - 1 and row[b + 1]:
                b += 1
            xl = float(X[r, a]) if a > 0 else None  # touching the frame edge = edge not seen
            xr = float(X[r, b]) if b < w - 1 else None
            rows.append((z, xl, xr))
        return rows

    def _pick(self, side, lines, edges, t):
        """The boundary of the bike's lane on one side: nearest lane line or road edge, smoothed."""
        sign = -1 if side == "left" else 1
        cand = None
        line = [c for c, _ in lines if sign * np.polyval(c, 4.0) > 0.15]
        if line:
            c = min(line, key=lambda c: abs(np.polyval(c, 4.0)))
            cand = (c, "line")
        epts = [(z, xl if side == "left" else xr) for z, xl, xr in edges]
        epts = [(z, x) for z, x in epts if x is not None and sign * x > 0.15]
        if len(epts) >= 5:
            zz, xx = np.array(epts).T
            deg = 2 if zz.max() - zz.min() > 8 else 1
            c = np.polyfit(zz, xx, deg)
            if deg == 1:
                c = np.array([0.0, *c])
            # the road edge bounds the lane only if it is nearer than the nearest line
            if cand is None or abs(np.polyval(c, 4.0)) < abs(np.polyval(cand[0], 4.0)) - 0.2:
                cand = (c, "edge")
        prev = self._fits[side]
        if cand is None:
            if prev and t - prev[2] < 1.0:
                return prev  # hold briefly through gaps in the paint
            self._fits[side] = None
            return None
        c, kind = cand
        if prev and t - prev[2] < 1.0 and prev[1] == kind and abs(np.polyval(prev[0], 4.0) - np.polyval(c, 4.0)) < 0.6:
            c = 0.6 * np.asarray(c) + 0.4 * np.asarray(prev[0])  # temporal smoothing
        self._fits[side] = (np.asarray(c), kind, t)
        return self._fits[side]

    @staticmethod
    def _boundary_out(b):
        c, kind, _ = b
        return {"type": kind, "distanceM": round(abs(float(np.polyval(c, 4.0))), 2),
                "points": [[round(float(np.polyval(c, z)), 2), round(z, 1)] for z in np.arange(2.0, 20.1, 2.0)]}

    def _ego_path(self, left, right, edges, speed, yaw_rate):
        zs = np.arange(0.0, 20.1, 1.0)
        if speed is not None and yaw_rate is not None and speed > 1.0:
            k = yaw_rate / speed  # curvature 1/m (+ = turning right)
            k = float(np.clip(k, -0.2, 0.2))
            return [(0.5 * k * z * z, z) for z in zs]
        # not moving (or no IMU/GPS): follow the shape of the lane / road ahead
        if left and right:
            mid = lambda z: (np.polyval(left[0], z) + np.polyval(right[0], z)) / 2  # noqa: E731
        elif left or right:
            b = left or right
            mid = lambda z: np.polyval(b[0], z)  # noqa: E731
        elif len(edges) >= 5 and all(xl is not None and xr is not None for _, xl, xr in edges[:5]):
            zz = np.array([e[0] for e in edges if e[1] is not None and e[2] is not None])
            mm = np.array([(e[1] + e[2]) / 2 for e in edges if e[1] is not None and e[2] is not None])
            c = np.polyfit(zz, mm, 1 if zz.max() - zz.min() < 8 else 2)
            mid = lambda z: np.polyval(c, z)  # noqa: E731
        else:
            return [(0.0, z) for z in zs]
        base = mid(2.0)
        return [(float(np.clip(mid(max(z, 2.0)) - base, -6, 6)), z) for z in zs]

    def _lane_type(self, img, left, right, path):
        """('bike_lane' | 'traffic_lane' | 'unknown', confidence, lane width or None)."""
        green = self._green_paint(img, path)
        if green > 0.18:
            return "bike_lane", min(0.95, 0.6 + green), self._width(left, right)
        width = self._width(left, right)
        if width is None:
            return "unknown", 0.0, None
        lk, rk = left[1], right[1]
        if 0.9 <= width <= 2.4 and lk == "line" and rk == "edge":
            return "bike_lane", 0.65, width  # narrow lane between a line and the curb (right-hand traffic)
        if 0.9 <= width <= 2.4 and lk == "line" and rk == "line":
            return "bike_lane", 0.5, width  # buffered / painted both sides
        if width > 4.6:
            return "traffic_lane", 0.3, width  # wider than any lane: a middle line was missed (multi-lane)
        if width >= 2.6:
            return "traffic_lane", 0.6 if lk == rk == "line" else 0.45, width
        return "unknown", 0.2, width

    @staticmethod
    def _width(left, right):
        if not (left and right):
            return None
        w = _x_at(right, 4.0) - _x_at(left, 4.0)
        return w if 0.5 < w < 8 else None

    def _green_paint(self, img, path):
        """Fraction of green paint in a 1.6 m-wide corridor along the path, 2-12 m ahead."""
        H, W = img.shape[:2]
        left, right = [], []
        for x, z in path:
            if 2 <= z <= 12:
                a = self.cam.project(x - 0.8, z)
                b = self.cam.project(x + 0.8, z)
                if a and b:
                    left.append((a[0] * W, a[1] * H))
                    right.append((b[0] * W, b[1] * H))
        if len(left) < 2:
            return 0.0
        poly = np.array(left + right[::-1], np.int32)
        mask = np.zeros((H, W), np.uint8)
        cv2.fillPoly(mask, [poly], 1)
        if mask.sum() < 50:
            return 0.0
        hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
        g = (hsv[..., 0] >= 35) & (hsv[..., 0] <= 85) & (hsv[..., 1] >= 70) & (hsv[..., 2] >= 50)
        return float((g & (mask > 0)).sum()) / float(mask.sum())

    # ---- drawing (Tesla-style overlay) ------------------------------------------------------
    def draw(self, tile, state=None):
        """Overlay drivable area, lane lines, lane boundaries and the ego path on a resized frame."""
        if self.masks is None:
            return tile
        da, ll, t = self.masks
        if time.time() - t > 1.5:
            return tile
        th, tw = tile.shape[:2]
        dam = cv2.resize(da, (tw, th), interpolation=cv2.INTER_LINEAR) > 0
        llm = cv2.resize(ll, (tw, th), interpolation=cv2.INTER_LINEAR) > 0
        over = tile.copy()
        over[dam] = (0.55 * over[dam] + 0.45 * np.array([255, 140, 40])).astype(np.uint8)  # blue road
        over[llm] = (40, 220, 255)  # lane lines: yellow
        cv2.addWeighted(over, 0.7, tile, 0.3, 0, tile)
        s = state or self.state()
        for key, col in (("leftBoundary", (255, 255, 255)), ("rightBoundary", (255, 255, 255))):
            b = s.get(key)
            if b:
                pts = [self.cam.project(x, z) for x, z in b["points"]]
                pts = np.array([(u * tw, v * th) for p in pts if p for u, v in [p]], np.int32)
                if len(pts) >= 2:
                    style = (col if b["type"] == "line" else (80, 80, 255))
                    cv2.polylines(tile, [pts], False, style, 2, cv2.LINE_AA)
        path = s.get("egoPath") or []
        if path:
            lpts, rpts = [], []
            for x, z in path:
                if z < 1.5:
                    continue
                a, b = self.cam.project(x - 0.35, z), self.cam.project(x + 0.35, z)
                if a and b:
                    lpts.append((a[0] * tw, a[1] * th))
                    rpts.append((b[0] * tw, b[1] * th))
            if len(lpts) >= 2:
                poly = np.array(lpts + rpts[::-1], np.int32)
                ribbon = tile.copy()
                colour = (90, 230, 90) if s.get("laneType") == "bike_lane" else (255, 180, 60)
                cv2.fillPoly(ribbon, [poly], colour)
                cv2.addWeighted(ribbon, 0.45, tile, 0.55, 0, tile)
        return tile


def _x_at(b, z):
    return float(np.polyval(b[0], z))
