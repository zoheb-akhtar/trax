"""Velo perception core: per-camera detections -> one tracked, metric 3D picture around the bike.

  * stable global track ids across cameras (a car that passes you keeps its id when it leaves
    the seat camera and enters the front one)
  * metric position on the road (x right, z ahead, metres) from each camera's mount geometry
    (geometry.CameraModel): the box's ground-contact point fused with the object's typical size,
    weighted by how reliable each is at that distance
  * velocity (relative, and absolute when the bike's GPS speed is known), stationary / parked
  * collision prediction from the closest point of approach (CPA), plus time-to-contact from how
    fast the box grows (needs no size assumption, so it is the most trustworthy near-range cue)
  * traffic-light colour
  * rider situations with hysteresis: collision ahead, crossing pedestrian, right hook, door
    zone, vehicle in the bike lane, oncoming traffic, close pass, rear collision, blind spot,
    overtaking, emergency vehicles, red light, stop / yield / no-entry signs ...
  * a surroundings summary (nearest thing ahead / behind / left / right) for the app's UI

No I/O, no model, no web server (numpy, OpenCV for light colours, ultralytics' ByteTrack), so the
same logic can be ported to the phone.
"""

from __future__ import annotations

import math
from collections import Counter, deque
from types import SimpleNamespace

import cv2
import numpy as np

import geometry as G

# Typical real height (m) of each kind of object (for distance from apparent size).
HEIGHT_M = {"car": 1.5, "truck": 3.0, "bus": 3.0, "train": 3.5, "motorcycle": 1.4, "bicycle": 1.6,
            "person": 1.7, "dog": 0.6, "cat": 0.3, "horse": 1.6, "stop sign": 0.75, "traffic light": 1.0,
            "traffic cone": 0.7, "barrier": 1.0, "traffic sign": 0.75, "speed limit sign": 0.9,
            "crosswalk sign": 0.75, "yield sign": 0.75, "one way sign": 0.45, "no entry sign": 0.75,
            "scooter": 1.6, "wheelchair": 1.3, "stroller": 1.0, "skateboard": 1.7,
            "ambulance": 2.6, "fire truck": 3.2, "police car": 1.5}
# Footprint half-width (m) for collision envelopes.
HALF_W = {"vehicle": 0.95, "bicycle": 0.35, "person": 0.3, "animal": 0.3, "micromobility": 0.35, "obstacle": 0.3}
BIKE_HALF_W = 0.35

VEHICLES = {"car", "truck", "bus", "train", "motorcycle", "ambulance", "fire truck", "police car"}
EMERGENCY = {"ambulance", "fire truck", "police car"}
ANIMALS = {"cat", "dog", "horse"}
SIGNS = {"stop sign", "traffic sign", "speed limit sign", "crosswalk sign", "yield sign", "one way sign",
         "no entry sign"}
OBSTACLES = {"traffic cone", "barrier"}
MICRO = {"scooter", "skateboard", "wheelchair", "stroller"}
ELEVATED = SIGNS | {"traffic light"}  # not standing on the road: size-based distance only

CLASS_MIN_CONF = {"person": 0.40, "bicycle": 0.35, "car": 0.40, "motorcycle": 0.35, "bus": 0.40,
                  "train": 0.50, "truck": 0.40, "traffic light": 0.35, "stop sign": 0.50, "cat": 0.50,
                  "dog": 0.45, "horse": 0.50, "traffic cone": 0.30, "barrier": 0.30, "traffic sign": 0.30,
                  "speed limit sign": 0.35, "crosswalk sign": 0.35, "yield sign": 0.40, "one way sign": 0.40,
                  "no entry sign": 0.40, "bike lane marking": 0.25, "scooter": 0.35, "skateboard": 0.40,
                  "wheelchair": 0.40, "stroller": 0.40, "ambulance": 0.45, "fire truck": 0.45,
                  "police car": 0.50, "face": 0.35}

# camera models + roles; set by configure() (velo_brain calls it with velo_config.json)
CAMS: dict[str, G.CameraModel] = G.cameras_from_config(G.DEFAULT_CONFIG)


def configure(cfg):
    global CAMS
    CAMS = G.cameras_from_config(cfg)


def cam_model(camera):
    return CAMS.get(camera) or CAMS.setdefault(camera, G.CameraModel(role="road_rear", yaw_deg=180))


def role(camera):
    return cam_model(camera).role


def facing(camera: str) -> str:
    """'front' or 'rear': what the app calls the camera."""
    return "rear" if cam_model(camera).backward else "front"


def group(label: str) -> str:
    if label in VEHICLES:
        return "vehicle"
    if label in ANIMALS:
        return "animal"
    if label in SIGNS:
        return "sign"
    if label in OBSTACLES:
        return "obstacle"
    if label in MICRO:
        return "micromobility"
    return label


class _Dets:
    """The minimal results object ByteTrack wants (conf / xywh / cls arrays, boolean slicing)."""

    def __init__(self, xyxy, conf, cls):
        self.xyxy, self.conf, self.cls = xyxy, conf, cls
        self.xywh = np.column_stack([(xyxy[:, 0] + xyxy[:, 2]) / 2, (xyxy[:, 1] + xyxy[:, 3]) / 2,
                                     xyxy[:, 2] - xyxy[:, 0], xyxy[:, 3] - xyxy[:, 1]]) \
            if len(xyxy) else np.zeros((0, 4), np.float32)

    def __len__(self):
        return len(self.conf)

    def __getitem__(self, idx):
        return _Dets(self.xyxy[idx], self.conf[idx], self.cls[idx])


def _new_tracker(buffer_frames: int):
    from ultralytics.trackers.byte_tracker import BYTETracker

    args = SimpleNamespace(tracker_type="bytetrack", track_high_thresh=0.25, track_low_thresh=0.1,
                           new_track_thresh=0.30, track_buffer=buffer_frames, match_thresh=0.8,
                           fuse_score=True)
    return BYTETracker(args)


def _slope(ts, ys):
    """Least-squares slope of ys over ts (both 1-D)."""
    t = np.asarray(ts) - ts[-1]
    y = np.asarray(ys)
    tm = t.mean()
    den = ((t - tm) ** 2).sum()
    return float(((t - tm) * (y - y.mean())).sum() / den) if den > 1e-9 else 0.0


def light_colour(crop: np.ndarray) -> str:
    """Colour of a traffic light from its box crop (BGR): red / yellow / green / unknown.
    Counts bright, saturated pixels in each hue band: lit lamps are the brightest, most saturated
    things in a signal housing, for vertical and horizontal signals alike."""
    if crop is None or crop.size == 0 or min(crop.shape[:2]) < 4:
        return "unknown"
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    vmin = max(120, int(np.percentile(v, 90)) - 40)
    lit = (v >= vmin) & (s >= 80)
    red = int((lit & ((h <= 8) | (h >= 165))).sum())
    yellow = int((lit & (h >= 12) & (h <= 34)).sum())
    green = int((lit & (h >= 42) & (h <= 100)).sum())
    best, n = max((("red", red), ("yellow", yellow), ("green", green)), key=lambda kv: kv[1])
    return best if n >= max(3, 0.015 * crop.shape[0] * crop.shape[1]) else "unknown"


def locate(camera, label, box):
    """Metric position of a detection: ((x, z) bike frame, distance m, sigma m) or (None, None, None).

    Two estimates, fused by inverse variance:
      ground: where the box's bottom edge meets the road (exact for a flat road; error grows with
              the square of distance, and depends on the camera pitch)
      size:   typical real height / apparent height (error ~20 % at any distance: object sizes vary)
    Signs and traffic lights are elevated, so only the size estimate applies to them."""
    cam = cam_model(camera)
    x1, y1, x2, y2 = (float(v) for v in box)
    u = (x1 + x2) / 2
    h = y2 - y1
    est = []
    top_cut, bottom_cut = y1 < 0.01, y2 > 0.985
    if label in HEIGHT_M and not top_cut and not bottom_cut and h > 0.01:
        d = cam.size_distance(h, HEIGHT_M[label])
        est.append((d, 0.22 * d))
    if label not in ELEVATED and not bottom_cut:
        g = cam.ground_point(u, y2)
        if g is not None:
            d = abs(g[1])
            sigma = 0.05 + d * d / max(cam.h, 0.3) * 0.02  # ~1.1 deg of pitch / pixel uncertainty
            est.append((d, sigma))
    if not est:
        return None, None, None
    w = np.array([1 / s ** 2 for _, s in est])
    d = float(np.dot(w, [e[0] for e in est]) / w.sum())
    sigma = float(1 / math.sqrt(w.sum()))
    lateral = cam.lateral(u, d * math.cos(cam.pitch) + cam.h * math.sin(cam.pitch))
    x, z = (-lateral, -d) if cam.backward else (lateral, d)
    return (x, z), d, sigma


ACCEL_NOISE = {"vehicle": 3.0, "person": 1.5, "bicycle": 2.0, "micromobility": 2.0, "animal": 3.0}


class Kalman:
    """Constant-velocity Kalman filter on the road plane: state (x, z, vx, vz) in the bike frame.
    Smooth positions and velocities for the 3D view, and a principled blend of noisy per-frame
    distances (far objects are noisier; locate() supplies each measurement's uncertainty)."""

    def __init__(self, x, z, sx, sz, t, accel):
        self.s = np.array([x, z, 0.0, 0.0])
        self.P = np.diag([sx * sx, sz * sz, 225.0, 225.0])  # velocity unknown at first: +-15 m/s
        self.t = self.t0 = t
        self.n = 1
        self.accel = accel

    def predict(self, t):
        dt = max(0.0, t - self.t)
        if dt == 0:
            return
        F = np.eye(4)
        F[0, 2] = F[1, 3] = dt
        q = self.accel ** 2
        G = np.array([[dt * dt / 2, 0], [0, dt * dt / 2], [dt, 0], [0, dt]])
        self.s = F @ self.s
        self.P = F @ self.P @ F.T + G @ G.T * q
        self.t = t

    def update(self, x, z, sx, sz, t):
        self.predict(t)
        H = np.zeros((2, 4))
        H[0, 0] = H[1, 1] = 1
        R = np.diag([sx * sx, sz * sz])
        y = np.array([x, z]) - H @ self.s
        S_ = H @ self.P @ H.T + R
        # gate wild measurements (a box jumping to another object): soften instead of following
        if float(y @ np.linalg.solve(S_, y)) > 25:
            R = R * 6
            S_ = H @ self.P @ H.T + R
        K = self.P @ H.T @ np.linalg.inv(S_)
        self.s = self.s + K @ y
        self.P = (np.eye(4) - K @ H) @ self.P
        self.n += 1

    def copy(self):
        k = Kalman(0, 0, 1, 1, self.t, self.accel)
        k.s, k.P, k.t0, k.n = self.s.copy(), self.P.copy(), self.t0, self.n
        return k


def brake_light_score(crop):
    """Fraction of bright, saturated red pixels in the lamp band of a vehicle seen from behind.
    Brake lights switching on make this jump; the brain compares it with the car's own recent
    baseline, so a red car doesn't look like it is braking."""
    if crop is None or crop.size == 0 or min(crop.shape[:2]) < 8:
        return None
    h = crop.shape[0]
    band = crop[int(0.25 * h):int(0.8 * h)]
    hsv = cv2.cvtColor(band, cv2.COLOR_BGR2HSV)
    red = ((hsv[..., 0] <= 8) | (hsv[..., 0] >= 170)) & (hsv[..., 1] >= 90) & (hsv[..., 2] >= 170)
    return float(red.mean())


class Track:
    def __init__(self, gid, camera, t):
        self.gid, self.camera = gid, camera
        self.first_seen = self.last_seen = t
        self.labels = Counter()
        self.max_conf = 0.0
        self.conf = 0.0
        self.box = None  # normalized x1, y1, x2, y2 (Kalman-smoothed by ByteTrack)
        self.hist = deque(maxlen=40)  # (t, box height, x, z) ; x/z None if unknown
        self.lights = deque(maxlen=7)
        self.handed_off = False
        self.kf = None  # Kalman filter on the road plane
        self.brake = deque(maxlen=30)  # (t, brake-light score)

    @property
    def label(self):
        # an emergency-vehicle label wins once it has been seen a few times
        for e in EMERGENCY:
            if self.labels[e] >= 3:
                return e
        return self.labels.most_common(1)[0][0]

    def confirmed(self):
        return self.max_conf >= CLASS_MIN_CONF.get(self.label, 0.5)

    def edge(self):
        x1, _, x2, _ = self.box
        return "left" if x1 < 0.03 else "right" if x2 > 0.97 else None

    def bike_side(self, image_edge):
        """Image edge -> side of the bike (a backward camera's left is the rider's right)."""
        if image_edge is None:
            return None
        if facing(self.camera) == "rear":
            return "right" if image_edge == "left" else "left"
        return image_edge


class Perception:
    """Feed it detections per camera with update(); read the world with snapshot()."""

    def __init__(self, cameras=("front", "seat"), track_buffer=15, lost_grace_s=0.4):
        self.trackers = {c: _new_tracker(track_buffer) for c in cameras}
        self.tracks: dict[tuple[str, int], Track] = {}
        self.lost_grace_s = lost_grace_s
        self._next_gid = 1
        self._alerts: dict[str, dict] = {}
        self._also = {}
        self.cam_t = {c: 0.0 for c in cameras}
        self._light_prev = {}
        self._green_until = 0.0

    # ---- tracking ----------------------------------------------------------------------
    def update(self, camera, t, xyxy_norm, conf, cls_names, frame=None):
        """One detector result for one camera. xyxy_norm: (N, 4) 0-1; conf: (N,); cls_names: N labels.
        frame: the BGR image the boxes refer to (for traffic-light colours)."""
        if camera not in self.trackers:
            self.trackers[camera] = _new_tracker(15)
            self.cam_t[camera] = 0.0
        xyxy = np.asarray(xyxy_norm, np.float32).reshape(-1, 4)
        conf = np.asarray(conf, np.float32).reshape(-1)
        names = list(cls_names)
        uniq = sorted(set(names))
        cls = np.array([uniq.index(n) for n in names], np.float32)
        scale = 1000.0  # ByteTrack's Kalman noise terms are tuned for pixel-ish units
        out = self.trackers[camera].update(_Dets(xyxy * scale, conf, cls))
        self.cam_t[camera] = t
        for x1, y1, x2, y2, tid, score, c, _ in out:
            key = (camera, int(tid))
            trk = self.tracks.get(key)
            box = np.clip(np.array([x1, y1, x2, y2]) / scale, 0, 1)
            label = uniq[int(c)]
            if trk is None:
                gid, prev = self._take_gid(camera, box, label, t)
                trk = Track(gid, camera, t)
                if prev is not None and prev.kf is not None:
                    trk.kf = prev.kf.copy()  # same object, other camera: keep its motion state
                self.tracks[key] = trk
            trk.last_seen, trk.box, trk.conf = t, box, float(score)
            trk.labels[label] += 1
            trk.max_conf = max(trk.max_conf, float(score))
            pos, dist, sigma = locate(camera, trk.label, box)
            trk.hist.append((t, float(box[3] - box[1]), *(pos if pos else (None, None))))
            if pos is not None and trk.label not in ELEVATED:
                # frame-to-frame jitter, not the absolute error: most distance error is a steady
                # bias (this car is taller than average), which doesn't disturb velocities
                sz = 0.05 + 0.04 * dist
                sx = 0.05 + 0.012 * dist
                if trk.kf is None:
                    trk.kf = Kalman(pos[0], pos[1], sx, sz, t, ACCEL_NOISE.get(group(trk.label), 2.0))
                else:
                    trk.kf.update(pos[0], pos[1], sx, sz, t)
            if frame is not None and group(trk.label) == "vehicle" and facing(camera) == "front" \
                    and float(box[3] - box[1]) > 0.05:
                H, W = frame.shape[:2]
                bx1, by1, bx2, by2 = (box * [W, H, W, H]).astype(int)
                sc = brake_light_score(frame[max(0, by1):by2, max(0, bx1):bx2])
                if sc is not None:
                    trk.brake.append((t, sc))
            if trk.label == "traffic light" and frame is not None:
                H, W = frame.shape[:2]
                bx1, by1, bx2, by2 = (box * [W, H, W, H]).astype(int)
                trk.lights.append(light_colour(frame[by1:by2, bx1:bx2]))
        for key in [k for k, v in self.tracks.items() if k[0] == camera and t - v.last_seen > 3.0]:
            del self.tracks[key]

    def _take_gid(self, camera, box, label, t):
        """A new track: if a matching object just left another camera on the same side of the bike
        (it is passing us, or we it), it is the same object: reuse its id."""
        probe = Track(0, camera, t)
        probe.box = box
        probe.labels[label] += 1
        side = probe.bike_side(probe.edge())
        if side:
            best = None
            for (cam, _), old in self.tracks.items():
                if facing(cam) == facing(camera) or old.handed_off or not old.confirmed() or old.box is None:
                    continue
                gone = t - old.last_seen
                if 0.1 < gone < 4.0 and group(old.label) == group(label) and \
                        old.bike_side(old.edge()) == side and (best is None or old.last_seen > best.last_seen):
                    best = old
            if best:
                best.handed_off = True
                return best.gid, best
        self._next_gid += 1
        return self._next_gid - 1, None

    # ---- motion -------------------------------------------------------------------------
    @staticmethod
    def _motion(trk, now):
        """(x, z, vx, vz relative m/s, ttc s from box growth): from the Kalman filter when it has
        settled, else from the recent track history."""
        hist = [p for p in trk.hist if now - p[0] <= 1.0]
        pos = [p for p in list(trk.hist)[-3:] if p[2] is not None]
        x = z = vx = vz = ttc = None
        if pos:
            x = float(np.median([p[2] for p in pos]))
            z = float(np.median([p[3] for p in pos]))
        if len(hist) >= 4 and hist[-1][0] - hist[0][0] >= 0.35:
            ts = [p[0] for p in hist]
            x1, y1, x2, y2 = trk.box
            truncated = y1 < 0.01 or y2 > 0.99 or (y2 - y1) > 0.9
            if not truncated:
                rate = _slope(ts, [math.log(max(p[1], 1e-4)) for p in hist])  # 1/s
                if rate > 0.08:
                    ttc = 1.0 / rate
            mp = [p for p in hist if p[2] is not None]
            if len(mp) >= 4 and mp[-1][0] - mp[0][0] >= 0.35:
                mts = [p[0] for p in mp]
                vx, vz = _slope(mts, [p[2] for p in mp]), _slope(mts, [p[3] for p in mp])
        kf = trk.kf
        if kf is not None and kf.n >= 3:
            k = kf.copy()
            k.predict(max(now, k.t))  # where it is now (it may have been seen a moment ago)
            x, z = float(k.s[0]), float(k.s[1])
            if kf.n >= 5 and kf.t - kf.t0 >= 0.4:
                vx, vz = float(k.s[2]), float(k.s[3])
        trk.vel_std = float(math.sqrt(max(kf.P[3, 3], 0))) if kf is not None else 99.0
        return x, z, vx, vz, ttc

    @staticmethod
    def _braking(trk, now):
        """True when the car's brake lights just came on (score jumps above its own baseline)."""
        pts = [(t, s) for t, s in trk.brake if now - t <= 3.0]
        if len(pts) < 6:
            return False
        recent = float(np.median([s for t, s in pts[-3:]]))
        base = float(np.percentile([s for t, s in pts[:-3]], 25))
        return recent > 0.004 and recent > 2.5 * base + 0.002

    # ---- output -------------------------------------------------------------------------
    def snapshot(self, now, ego=None, road=None):
        """-> (detections in the app's /state format + extras, alerts, surroundings).

        ego: {"speed": m/s or None} from GPS. road: road.RoadModel.state() or None."""
        ego = ego or {}
        v_ego = ego.get("speed")
        live = [t for t in self.tracks.values()
                if not t.handed_off and t.box is not None and t.confirmed()
                and now - t.last_seen <= self.lost_grace_s]
        live = self._merge_same_direction(live)
        bikes = [t.box for t in live if t.label == "bicycle"]
        # the traffic light that applies to us: ahead, central, big (nearest)
        lights = [t for t in live if t.label == "traffic light" and facing(t.camera) == "front"]
        relevant = min(lights, key=lambda t: abs((t.box[0] + t.box[2]) / 2 - 0.5) - 2 * (t.box[3] - t.box[1]),
                       default=None)
        dets, wanted = [], {}
        for trk in sorted(live, key=lambda t: t.gid):
            x1, y1, x2, y2 = (float(v) for v in trk.box)
            label = trk.label
            x, z, vx, vz, ttc = self._motion(trk, now)
            d = {"id": trk.gid, "label": label, "confidence": round(trk.conf, 3),
                 "box": [round(x1, 4), round(y1, 4), round(x2 - x1, 4), round(y2 - y1, 4)],
                 "camera": facing(trk.camera), "source": trk.camera, "group": group(label)}
            also = [{"source": o.camera, "box": [round(float(o.box[0]), 4), round(float(o.box[1]), 4),
                                                 round(float(o.box[2] - o.box[0]), 4),
                                                 round(float(o.box[3] - o.box[1]), 4)]}
                    for o in self._also.get(trk.gid, [])]
            if also:
                d["alsoSeenBy"] = also
            if x is not None:
                d.update(distanceM=round(math.hypot(x, z), 1), position=[round(x, 2), round(z, 2)],
                         bearingDeg=round(math.degrees(math.atan2(x, z)) % 360), zone=_zone(x, z))
            if vx is not None:
                d["velocity"] = [round(vx, 2), round(vz, 2)]  # relative to the bike, m/s
                # closing speed: how fast the distance shrinks
                rng = math.hypot(x, z) if x is not None else None
                if rng and rng > 0.5:
                    d["closingMps"] = round(-(x * vx + z * vz) / rng, 1)
                if v_ego is not None:
                    ax, az = vx, vz + v_ego  # absolute (ground) velocity
                    d["speedKmh"] = round(math.hypot(ax, az) * 3.6, 1)
                    if v_ego > 1.5 and math.hypot(ax, az) < 1.0 and getattr(trk, "vel_std", 99) < 1.0:
                        d["stationary"] = True
            if ttc is not None:
                d["ttcS"] = round(ttc, 1)
            if x is not None and vx is not None:
                cpa = _cpa(x, z, vx, vz)
                if cpa:
                    d["cpa"] = {"tS": round(cpa[0], 1), "missM": round(cpa[1], 2)}
            if trk.last_seen < self.cam_t.get(trk.camera, 0):
                d["coasting"] = True
            riding = label == "person" and any(_overlap(trk.box, b) > 0.3 for b in bikes)
            if riding:
                d["onBicycle"] = True
            if label == "traffic light":
                votes = Counter(c for c in trk.lights if c != "unknown")
                if votes:
                    colour, n = votes.most_common(1)[0]
                    if n >= min(3, len(trk.lights)):
                        d["light"] = colour
                if trk is relevant:
                    d["relevant"] = True
                    self._light_change(trk.gid, d.get("light"), now, v_ego)
            if d["group"] == "vehicle" and facing(trk.camera) == "front" and self._braking(trk, now):
                d["braking"] = True
            if road and x is not None and road.get("ok"):
                d["inPath"] = _in_corridor(road, x, z, 0.9)
            threats = _threats(trk, d, ttc, riding, road, v_ego) if role(trk.camera) != "security" else []
            for kind, level, text in threats:
                wanted[f"{kind}-{trk.gid}"] = {"id": f"{kind}-{trk.gid}", "kind": kind, "level": level, "text": text,
                                               "camera": facing(trk.camera), "source": trk.camera,
                                               "trackId": trk.gid, "bearingDeg": d.get("bearingDeg"),
                                               "side": _side(d)}
            d["threat"] = max((LEVELS[lv] for _, lv, _ in threats), default=0)
            dets.append(d)
        # lead vehicle: the nearest thing ahead in the bike's path
        ahead = [d for d in dets if d["camera"] == "front" and d["group"] in ("vehicle", "bicycle", "micromobility")
                 and "position" in d and d["position"][1] > 0
                 and abs(d["position"][0] - (_path_x(road, d["position"][1]) if road and road.get("ok") else 0)) < 1.3]
        if ahead:
            lead = min(ahead, key=lambda d: d["position"][1])
            lead["lead"] = True
            if v_ego and v_ego > 1:
                lead["headwayS"] = round(lead["position"][1] / v_ego, 1)
            if lead.get("braking") and lead["position"][1] < 30:
                wanted[f"lead_braking-{lead['id']}"] = {
                    "id": f"lead_braking-{lead['id']}", "kind": "lead_braking", "level": "caution",
                    "text": f"{lead['label'].capitalize()} ahead braking", "camera": "front", "source": lead["source"],
                    "trackId": lead["id"], "bearingDeg": lead.get("bearingDeg"), "side": "ahead"}
        if now < self._green_until:
            wanted["green_light"] = {"id": "green_light", "kind": "green_light", "level": "info",
                                     "text": "Light is green", "camera": "front", "source": "front",
                                     "trackId": -1, "bearingDeg": 0, "side": "ahead"}
        for kind, level, text in _road_situations(road, dets):
            wanted[kind] = {"id": kind, "kind": kind, "level": level, "text": text, "camera": "front",
                            "source": "front", "trackId": -1, "bearingDeg": 0, "side": "ahead"}
        return dets, self._update_alerts(wanted, now), surroundings(dets, road)

    def _light_change(self, gid, colour, now, v_ego):
        """Tesla's green-light chime: the light we are waiting at turned green."""
        prev = self._light_prev.get(gid)
        if colour:
            self._light_prev = {gid: colour}
        stopped = v_ego is None or v_ego < 1.0
        if prev in ("red", "yellow") and colour == "green" and stopped:
            self._green_until = now + 3.0

    def _merge_same_direction(self, live):
        """Two cameras facing the same way can see the same car. Pair tracks of the same kind at
        about the same metric spot, give the pair one id for good, report it from the camera that
        sees it best (road cameras before the security camera)."""
        withpos = [t for t in live if t.hist and t.hist[-1][2] is not None]
        for a in withpos:
            for b in withpos:
                if a.camera >= b.camera or a.gid == b.gid or group(a.label) != group(b.label) \
                        or facing(a.camera) != facing(b.camera):
                    continue
                xa, za = a.hist[-1][2], a.hist[-1][3]
                xb, zb = b.hist[-1][2], b.hist[-1][3]
                if abs(za - zb) < max(2.0, 0.3 * max(abs(za), abs(zb))) and abs(xa - xb) < 1.5:
                    keep, other = (a, b) if a.first_seen <= b.first_seen else (b, a)
                    other.gid = keep.gid
        best = {}
        for t in live:
            cur = best.get(t.gid)
            if cur is None or _rank(t) < _rank(cur):
                best[t.gid] = t
        self._also = {}
        for t in live:
            if best[t.gid] is not t:
                self._also.setdefault(t.gid, []).append(t)
        return list(best.values())

    def _update_alerts(self, wanted, now, hold_s=1.0):
        for aid, a in wanted.items():
            if aid in self._alerts:
                self._alerts[aid].update(a, lastTrue=now)
            else:
                self._alerts[aid] = {**a, "since": now, "lastTrue": now}
        for aid in [k for k, a in self._alerts.items() if now - a["lastTrue"] > hold_s]:
            del self._alerts[aid]
        # most severe first; at equal severity the more specific situation wins ("oncoming car in
        # your lane" says more than "vehicle ahead: brake")
        out = sorted(self._alerts.values(),
                     key=lambda a: (-LEVELS[a["level"]], KIND_RANK.get(a["kind"], 5), a["since"]))
        top = {}
        for a in out:  # one alert per tracked object: its most severe one
            top.setdefault(a["trackId"] if a["trackId"] >= 0 else a["id"], a)
        out = [a for a in out if top[a["trackId"] if a["trackId"] >= 0 else a["id"]] is a]
        return [{k: v for k, v in a.items() if k != "lastTrue"} for a in out]


def _rank(t):
    r = role(t.camera)
    return (0 if r.startswith("road") else 1, -t.last_seen)


LEVELS = {"info": 1, "caution": 2, "danger": 3}
KIND_RANK = {"oncoming": 0, "right_hook": 0, "close_pass": 0, "rear_collision": 1, "crossing": 1, "door_zone": 1,
             "lead_braking": 2, "blind_spot": 2, "vehicle_in_bike_lane": 2, "emergency": 2,
             "collision": 4, "closing_ahead": 6, "in_path": 6, "beside": 7, "vehicle_behind": 7}


def _overlap(a, b):
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    area = max((a[2] - a[0]) * (a[3] - a[1]), 1e-6)
    return ix * iy / area


def _cpa(x, z, vx, vz, horizon=5.0):
    """Closest point of approach of an object at (x, z) moving at (vx, vz) relative to the bike:
    (time s, miss distance m), or None if it is not getting closer within `horizon` s."""
    v2 = vx * vx + vz * vz
    if v2 < 0.09:
        return None
    t = -(x * vx + z * vz) / v2
    if t <= 0 or t > horizon:
        return None
    return t, math.hypot(x + vx * t, z + vz * t)


def _zone(x, z):
    if z > 1.0:
        return "ahead" if abs(x) < 1.0 else ("ahead-left" if x < 0 else "ahead-right")
    if z < -1.0:
        return "behind" if abs(x) < 1.0 else ("behind-left" if x < 0 else "behind-right")
    return "left" if x < 0 else "right"


def _side(d):
    pos = d.get("position")
    if not pos:
        return d["camera"] == "front" and "ahead" or "behind"
    x, z = pos
    if abs(x) > 1.0 and abs(z) < 6:
        return "left" if x < 0 else "right"
    return "ahead" if z > 0 else "behind"


def _side_text(x):
    return "on your left" if x < -0.6 else "on your right" if x > 0.6 else ""


def _path_x(road, z):
    path = road.get("egoPath") or []
    if not path or z <= 0:
        return 0.0
    zs = [p[1] for p in path]
    return float(np.interp(z, zs, [p[0] for p in path]))


def _in_corridor(road, x, z, half_w):
    return bool(0 < z < 25 and abs(x - _path_x(road, z)) < half_w)


def _in_lane(road, x, z):
    lb, rb = road.get("leftBoundary"), road.get("rightBoundary")
    if not (lb and rb) or not (0 < z < 25):
        return False
    xl = float(np.interp(z, [p[1] for p in lb["points"]], [p[0] for p in lb["points"]]))
    xr = float(np.interp(z, [p[1] for p in rb["points"]], [p[0] for p in rb["points"]]))
    return xl < x < xr


def _threats(trk, d, ttc, riding, road, v_ego):
    """Rider-relevant situations for one tracked object: [(kind, level, text)]."""
    label, g = trk.label, group(trk.label)
    pos, vel = d.get("position"), d.get("velocity")
    x, z = pos if pos else (((trk.box[0] + trk.box[2]) / 2 - 0.5) * 10, None)
    vx, vz = vel if vel else (0.0, 0.0)
    side = _side_text(x)
    half = HALF_W.get(g, 0.3) + BIKE_HALF_W
    cpa = d.get("cpa")
    what = {"vehicle": label.capitalize() if label in EMERGENCY else "Vehicle", "bicycle": "Cyclist",
            "person": "Pedestrian", "animal": "Animal", "micromobility": label.capitalize(),
            "obstacle": label.capitalize()}.get(g)
    out = []
    if facing(trk.camera) == "front":
        road_ok = bool(road and road.get("ok"))
        in_path = d.get("inPath") if road_ok and pos else abs(x) < 1.5
        if what and not (label == "person" and riding):
            # collision-type warnings only for things in the path or really moving into it, and only
            # once the velocity estimate has settled (no false alarms from the first noisy frames)
            settled = getattr(trk, "vel_std", 99) < 1.2
            entering = pos and abs(x) >= half + 0.3 and abs(vx) > 0.5 and np.sign(vx) == -np.sign(x)
            in_lane = pos and abs(x) < half + 0.3
            hit_soon = (settled and (in_lane or entering) and cpa and cpa["tS"] < 2.5 and cpa["missM"] < half + 0.2) \
                or (in_path and ttc is not None and ttc < 2.5)
            near_soon = (settled and (in_lane or entering) and cpa and cpa["tS"] < 4 and cpa["missM"] < half + 0.5) \
                or (in_path and ttc is not None and ttc < 5)
            oncoming = g == "vehicle" and pos and settled and vz < -((v_ego or 0) + 3) and abs(x) < 4 and z < 40
            if oncoming:
                head_on = abs(x) < half + 0.3 and z < 25
                out.append(("oncoming", "danger" if head_on else "info",
                            f"Oncoming {label} in your lane" if head_on else f"Oncoming {label} {side}".strip()))
            elif hit_soon:
                out.append(("collision", "danger", f"{what} ahead: brake"))
            elif g == "vehicle" and pos and x < -0.5 and vx > 0.7 and 0 < z < 15:
                out.append(("right_hook", "danger", f"{what} turning across you"))
            elif g in ("person", "animal", "micromobility", "bicycle") and pos and abs(vx) > 0.7 and 0 < z < 15 \
                    and abs(x - (_path_x(road, z) if road_ok else 0)) < 4 \
                    and np.sign(-(x - (_path_x(road, z) if road_ok else 0))) == np.sign(vx):
                out.append(("crossing", "caution", f"{what} crossing ahead"))
            elif near_soon:
                out.append(("closing_ahead", "caution", f"Closing on {what.lower()} ahead"))
            elif g in ("person", "animal", "obstacle") and in_path and pos and z < 12:
                out.append(("in_path", "caution", f"{what} in your path"))
            if g == "vehicle" and road_ok and pos and road.get("laneType") == "bike_lane" \
                    and road.get("laneConfidence", 0) >= 0.5 and _in_lane(road, x, z):
                out.append(("vehicle_in_bike_lane", "caution", f"{what} in the bike lane ahead"))
            if g == "vehicle" and d.get("stationary") and pos and 0.6 < x < 2.8 and 1 < z < 15:
                clearance = x - HALF_W["vehicle"] - BIKE_HALF_W  # a car door opens ~1 m
                out.append(("door_zone", "caution" if clearance < 1.2 else "info",
                            "Parked car on your right: watch for doors"))
            if g == "vehicle" and pos and abs(z) < 4 and 0.8 < abs(x) < 3.0:
                out.append(("beside", "caution", f"{what} {side}".strip()))
            if label in EMERGENCY and pos and z < 60:
                out.append(("emergency", "caution", f"{label.capitalize()} ahead"))
        dist = d.get("distanceM")
        if label == "traffic light" and d.get("relevant") and d.get("light") in ("red", "yellow") \
                and (dist is None or dist < 60):
            out.append((f"{d['light']}_light", "info", f"{d['light'].capitalize()} light ahead"))
        if label == "stop sign" and (dist is None or dist < 30):
            out.append(("stop_sign", "info", "Stop sign ahead"))
        if label == "yield sign" and (dist is None or dist < 30):
            out.append(("yield_sign", "info", "Yield ahead"))
        if label == "no entry sign" and (dist is None or dist < 30):
            out.append(("no_entry", "caution", "No entry ahead"))
        if label == "crosswalk sign" and (dist is None or dist < 40):
            out.append(("crosswalk", "info", "Crosswalk ahead"))
    else:  # behind the rider
        approaching = (d.get("closingMps") or 0) > 1.0 or (ttc is not None and ttc < 6)
        dist = d.get("distanceM")
        if g == "vehicle" and pos and dist is not None:
            # where will it be, sideways, when it draws level with the bike (z = 0)?
            pass_x = x + vx * (-z / vz) if vz > 0.5 and z < 0 else None
            t_pass = -z / vz if pass_x is not None else None
            if approaching and ((cpa and cpa["tS"] < 3 and cpa["missM"] < half) or
                                (ttc is not None and ttc < 3 and abs(x) < 0.9)):
                out.append(("rear_collision", "danger", f"{label.capitalize()} right behind you"))
            elif pass_x is not None and t_pass < 4 and abs(pass_x) - HALF_W["vehicle"] - BIKE_HALF_W < 1.0:
                # side-of-car to bike clearance under 1 m when it draws level (3-foot rule)
                pside = "on your left" if pass_x < 0 else "on your right"
                out.append(("close_pass", "danger", f"{label.capitalize()} passing close {pside}"))
            elif -6 < z < 1 and 0.7 < abs(x) < 3.5:
                out.append(("blind_spot", "caution", f"{label.capitalize()} {side}".strip()))
            elif approaching and dist < 30:
                lvl = "caution" if label not in EMERGENCY else "danger"
                text = (f"{label.capitalize()} behind you: move right" if label in EMERGENCY else
                        f"{label.capitalize()} approaching from behind {side}".strip())
                out.append(("emergency" if label in EMERGENCY else "vehicle_behind", lvl, text))
        elif g in ("bicycle", "micromobility") and approaching and dist is not None and dist < 12:
            out.append(("cyclist_behind", "caution", f"{what} behind {side}".strip()))
    return out


def _road_situations(road, dets):
    """Situations about the road itself (not one object)."""
    if not road or not road.get("ok"):
        return []
    out = []
    lt, conf = road.get("laneType"), road.get("laneConfidence", 0)
    behind = [d for d in dets if d["group"] == "vehicle" and (d.get("position") or [0, 1])[1] < 0
              and (d.get("closingMps") or 0) > 1]
    if lt == "traffic_lane" and conf >= 0.55 and behind:
        out.append(("in_traffic_lane", "caution", "You're in the traffic lane, car behind"))
    off = road.get("offsetM")
    width = road.get("laneWidthM")
    if lt == "bike_lane" and conf >= 0.6 and off is not None and width and abs(off) > width / 2 - 0.2:
        out.append(("leaving_bike_lane", "info", "Drifting out of the bike lane"))
    return out


def surroundings(dets, road=None):
    """Nearest relevant thing in each direction, for the app's UI (car on your left, etc.)."""
    zones = {"ahead": None, "behind": None, "left": None, "right": None}
    for d in dets:
        if d["group"] in ("sign",) or d["label"] in ("traffic light", "face") or "position" not in d:
            continue
        x, z = d["position"]
        if abs(x) > 1.0 and abs(z) < 6:
            key = "left" if x < 0 else "right"
        else:
            key = "ahead" if z > 0 else "behind"
        cur = zones[key]
        if cur is None or d["distanceM"] < cur["distanceM"]:
            zones[key] = {"id": d["id"], "label": d["label"], "distanceM": d["distanceM"],
                          "closingMps": d.get("closingMps"), "threat": d.get("threat", 0)}
    out = {"zones": zones}
    if road and road.get("ok"):
        out["lane"] = {k: road.get(k) for k in ("laneType", "laneConfidence", "laneWidthM", "offsetM")
                       if road.get(k) is not None}
    return out
