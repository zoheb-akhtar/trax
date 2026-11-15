#!/usr/bin/env python3
"""Velo brain: Tesla-style perception for a bike, plus a Ring-doorbell park mode.

Runs on the Mac today, standing in for the phone. Cameras (velo_config.json sets each one's role
and mount):
    front  Pi camera 1 (board)     road ahead: lanes, path, everything on the road
    seat   USB webcam on the seat  road behind: cars coming up, close passes, blind spots
    rear   Pi camera 2 (board)     security: people and faces at the bike

RIDE mode ("ride" / "drive")
  * YOLO11 (COCO) on the front + seat cameras every frame, YOLO-World for cones, barriers, road
    signs, scooters, emergency vehicles a few times a second (detectors.py)
  * YOLOP road segmentation on the front camera: drivable area, lane lines, your lane, bike lane
    or not, the ego path (road.py)
  * one metric 3D world around the bike from all cameras: tracking, positions in metres,
    velocities, collision prediction, rider situations (perception.py)
  * the ring points at the most urgent hazard; crash + pothole events from the IMU
SECURITY mode ("security" / "park": the bike is locked in the app)
  * every camera watches for motion and people; the IMU watches for the bike being touched/moved
  * ring orange (armed) -> amber (someone near: recording) -> red (intruder: recording, faces,
    "tamper" event for a push notification) -> alarm (security.py)

    python velo_brain.py --show                  # brain + Tesla-style window
    python velo_brain.py --show --voice          # ... and spoken warnings
    python velo_brain.py --front video.mp4 --seat none --rear none --show   # test on a recording

API (port 8000, CORS *), the app's contract (docs/device-api.md in the app repo) + extensions:
    GET  /state                 mode, alarm, speedKmh, position, cameras, detections, events
                                + alerts, surroundings, road, security, mcu, perf
    GET  /stream?camera=front|rear|seat     GET /snapshot?camera=...
    GET  /events                newest first;  GET /events/stream  server-sent events
    GET  /recordings            recordings (park mode + ride incidents);  GET /recordings/<id>/<file>
    GET  /ride  /rides          this ride (distance, incidents, closest pass) / past rides
    GET  /hud                   live web HUD (Tesla-style ride view, Ring-style park view)
    POST /mode {"mode": "ride"|"security"}  (also "drive"/"park");  POST /lock  POST /unlock
    POST /alarm {"active": bool}   POST /chirp   POST /ring {"state": "armed"|...}
See APP_INTEGRATION.md for what each field means and how the app should show it.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import socket
import subprocess
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import cv2
import numpy as np

import board as B
import detectors as D
import geometry as G
import perception as P
import rides as RL
import security as S

HERE = os.path.dirname(os.path.abspath(__file__))


# ---- camera sources ---------------------------------------------------------------------
class Source:
    """Newest JPEG of one camera, with a sequence number and arrival time. Thread-safe."""

    def __init__(self, name):
        self.name = name
        self.jpeg, self.seq, self.t = None, 0, 0.0
        self.status = "connecting..."
        self.cond = threading.Condition()
        self._count, self._t0, self.fps = 0, time.time(), 0.0
        self.listeners = []

    def put(self, jpeg):
        now = time.time()
        with self.cond:
            self.jpeg, self.t = jpeg, now
            self.seq += 1
            self.cond.notify_all()
        for fn in self.listeners:
            fn(self.name, jpeg, now)
        self._count += 1
        if now - self._t0 >= 2:
            self.fps, self._count, self._t0 = self._count / (now - self._t0), 0, now

    def latest(self):
        with self.cond:
            return self.jpeg, self.seq, self.t

    def wait_next(self, seq, timeout=2.0):
        with self.cond:
            self.cond.wait_for(lambda: self.seq != seq, timeout=timeout)
            return self.jpeg, self.seq

    def live(self):
        return self.jpeg is not None and time.time() - self.t < 2.0


class MJPEGSource(Source):
    """An MJPEG stream. `url` is a URL, or a Board (then it finds the board again, over USB or
    Wi-Fi, whenever the stream drops)."""

    def __init__(self, name, url, board_cam=None):
        super().__init__(name)
        self.url, self.board_cam = url, board_cam or name
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        board = self.url if isinstance(self.url, B.Board) else None
        while True:
            url = board.url(self.board_cam) if board else self.url
            if url is None:
                self.status = "board not found: plug it in by USB"
                time.sleep(1)
                continue
            try:
                with urllib.request.urlopen(url, timeout=5) as resp:
                    self.status = "live"
                    if board:
                        board.found()
                    data = b""
                    while True:
                        chunk = resp.read(65536)
                        if not chunk:
                            break
                        data += chunk
                        end = data.rfind(b"\xff\xd9")
                        if end < 0:
                            continue
                        start = data.rfind(b"\xff\xd8", 0, end)
                        if start >= 0:
                            self.put(data[start:end + 2])
                        data = data[end + 2:]
            except Exception as e:  # board restarting, stream not up yet, cable pulled ...
                code = getattr(e, "code", None)
                self.status = ("no picture (is the webcam plugged in?)" if code == 503 and self.name == "seat"
                               else f"reconnecting ({type(e).__name__})")
                time.sleep(1)


class MacCameraSource(Source):
    """A camera plugged into this Mac, by name (the seat webcam): full view, 1280x720, 30 fps."""

    def __init__(self, name, device):
        super().__init__(name)

        def status(s):
            self.status = s

        threading.Thread(target=B.webcam_jpegs, args=(device, self.put, status), daemon=True).start()


class FileSource(Source):
    """A video file (testing on recorded rides), looped at its own frame rate."""

    def __init__(self, name, path):
        super().__init__(name)
        self.path = path
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        cap = cv2.VideoCapture(self.path)
        native = cap.get(cv2.CAP_PROP_FPS) or 30
        step = max(1, round(native / 12))  # ~12 fps is plenty for testing and spares the CPU
        period = step / native
        self.status = "live"
        while True:
            t0 = time.time()
            for _ in range(step - 1):
                cap.grab()
            ok, frame = cap.read()
            if not ok:
                cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                continue
            if frame.shape[1] > 960:
                frame = cv2.resize(frame, (960, round(960 * frame.shape[0] / frame.shape[1])), interpolation=cv2.INTER_AREA)
            ok, jpg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
            if ok:
                self.put(jpg.tobytes())
            time.sleep(max(0, period - (time.time() - t0)))


def make_source(name, spec, board):
    """spec: 'board', 'auto' (seat: this Mac's USB webcam if plugged in here, else the board's),
    a URL, a Mac camera name, or a video file."""
    if spec == "auto":
        cam = B.mac_usb_webcam()
        if cam:
            print(f"[brain] {name}: '{cam}' plugged into this Mac", flush=True)
            return MacCameraSource(name, cam)
        spec = "board"
    if spec == "board":
        return MJPEGSource(name, board)
    if spec.startswith("http"):
        return MJPEGSource(name, spec)
    if os.path.exists(spec):
        return FileSource(name, spec)
    return MacCameraSource(name, spec)


class Decoder:
    """Decodes JPEGs, at half size when they are big (the front camera's 1640x1232)."""

    def __init__(self):
        self.flag = cv2.IMREAD_COLOR

    def __call__(self, jpeg):
        img = cv2.imdecode(np.frombuffer(jpeg, np.uint8), self.flag)
        if img is not None and self.flag == cv2.IMREAD_COLOR and img.shape[1] > 1000:
            self.flag = cv2.IMREAD_REDUCED_COLOR_2
            img = cv2.resize(img, (img.shape[1] // 2, img.shape[0] // 2), interpolation=cv2.INTER_AREA)
        return img


# ---- the brain ------------------------------------------------------------------------
class Brain:
    def __init__(self, sources, cfg, detector, world=None, use_road=True, mcu=None, voice=False,
                 world_hz=3.0, security_cam_hz=2.0):
        self.sources, self.cfg = sources, cfg
        self.detector, self.world = detector, world
        self.faces = D.FaceDetector()
        self.world_hz, self.security_cam_hz = world_hz, security_cam_hz
        self.engine = P.Perception(cameras=tuple(sources))
        self.lock = threading.Lock()
        self.mode, self.alarm = "ride", False
        self.detections, self.alerts, self.surroundings = [], [], {}
        self.perf = {}
        self.voice = Voice() if voice else None
        self.decoders = {c: Decoder() for c in sources}
        self.frames = {}  # camera -> (bgr, t) newest decoded
        self.notifier = S.Notifier()
        self.recorder = S.Recorder()
        self.security = S.SecurityMonitor(self.recorder, self.notifier, on_state=self._ring_for_security)
        self.rides = RL.RideLog(self.recorder, self.notifier)
        self.rides.start()
        self.motion = {c: S.MotionDetector() for c in sources}
        for src in sources.values():
            src.listeners.append(self.recorder.feed)
        self.mcu = mcu
        if mcu:
            mcu.on_event = self._mcu_event
            r = cfg.get("ring", {})
            mcu.config(r.get("led0_deg", 0), r.get("clockwise", True), r.get("brightness", 0.12))
            mcu.mode("drive")
        imu = cfg.get("imu_yaw", {"axis": "gz", "sign": 1})
        self.road = None
        front = next((c for c in sources if P.role(c) == "road_front"), None)
        if use_road and front:
            import road as R

            self.road = R.RoadModel(P.cam_model(front), lambda: self._frame_for_road(front),
                                    lambda: (mcu.speed_mps() if mcu else None,
                                             mcu.yaw_rate(imu["axis"], imu["sign"]) if mcu else None))
        threading.Thread(target=self._run, daemon=True, name="brain").start()
        threading.Thread(target=self._ticker, daemon=True).start()

    def _frame_for_road(self, cam):
        if self.mode != "ride":
            return None, 0
        jpeg, _, t = self.sources[cam].latest()
        return (jpeg, t) if jpeg is not None and time.time() - t < 1.0 else (None, 0)

    # ---- MCU ----------------------------------------------------------------------------
    def _mcu_event(self, kind, value):
        print(f"[mcu] {kind} {value:.2f}", flush=True)
        gps = self.position()
        if kind in ("nudge", "tamper"):
            self.security.imu_event(kind, value)
        elif kind == "crash" and self.mode == "ride":
            self.notifier.emit("crash", severity=round(value, 1), **({"position": gps} if gps else {}))
        elif kind == "pothole" and self.mode == "ride":
            self.notifier.emit("pothole", id=f"bump-{int(time.time() * 1000)}", severity=round(value, 2),
                               **({"position": gps} if gps else {}))

    def _ring_for_security(self, state):
        if self.mcu:
            self.mcu.ring({"disarmed": "drive", "armed": "armed", "motion": "motion", "intruder": "intruder",
                           "alarm": "alarm"}.get(state, "armed"))

    def position(self):
        g = self.mcu.gps if self.mcu else None
        if g and g.get("fix") and time.time() - g["t"] < 5:
            return {"lat": g["lat"], "lon": g["lon"]}
        return None

    # ---- main loop -------------------------------------------------------------------------
    def _newest(self, cams, seen):
        out = []
        for cam in cams:
            jpeg, seq, t_recv = self.sources[cam].latest()
            if jpeg is not None and seq != seen.get(cam) and time.time() - t_recv < 1.0:
                img = self.decoders[cam](jpeg)
                if img is not None:
                    seen[cam] = seq
                    self.frames[cam] = (img, t_recv)
                    out.append((cam, t_recv, img))
        return out

    def _run(self):
        seen = {}
        n, t_win, infer_ms, age_ms = 0, time.time(), 0.0, 0.0
        last_world, last_sec, world_turn = 0.0, 0.0, 0
        road_cams = [c for c in self.sources if P.role(c).startswith("road")]
        sec_cams = [c for c in self.sources if P.role(c) == "security"]
        while True:
            if self.mode != "ride":
                self._security_step(seen)
                continue
            t_start = time.time()
            batch = self._newest(road_cams, seen)
            now = time.time()
            sec_batch = []
            if sec_cams and now - last_sec >= 1 / self.security_cam_hz:
                sec_batch = self._newest(sec_cams, seen)
                if sec_batch:
                    last_sec = now
            if not batch and not sec_batch:
                time.sleep(0.004)
                continue
            frames = [b[2] for b in batch + sec_batch]
            t0 = time.time()
            # one camera per call: each camera keeps one fixed input shape, so the GPU (MPS) never
            # recompiles for a new batch size / shape combination (that costs seconds)
            results = [self.detector([f])[0] for f in frames]
            t_yolo = time.time() - t0
            if self.world and batch and now - last_world >= 1 / self.world_hz:
                last_world = now
                # alternate cameras so each gets YOLO-World at world_hz / n
                pick = batch[world_turn % len(batch)]
                world_turn += 1
                tw = time.time()
                wres = self.world([pick[2]])[0]
                self._world_ms = (time.time() - tw) * 1000
                i = [b[0] for b in batch].index(pick[0])
                results[i] = D.merge(results[i], wres)
            t1 = time.time()
            self._yolo_ms = 0.8 * getattr(self, "_yolo_ms", t_yolo * 1000) + 0.2 * t_yolo * 1000
            for (cam, t_recv, img), (xyxy, conf, names) in zip(batch + sec_batch, results):
                if P.role(cam) == "security":  # the security camera reports people (+ faces) only
                    keep = [k for k, nm in enumerate(names) if nm == "person"]
                    xyxy, conf, names = xyxy[keep], conf[keep], [names[k] for k in keep]
                self.engine.update(cam, t_recv, xyxy, conf, names, img)
            road = self.road.state() if self.road else None
            ego = {"speed": self.mcu.speed_mps() if self.mcu else None}
            dets, alerts, sur = self.engine.snapshot(time.time(), ego=ego, road=road)
            with self.lock:
                self.detections, self.alerts, self.surroundings = dets, alerts, sur
            self.rides.observe(alerts, dets, self.position(), ego["speed"])
            if self.voice:
                self.voice.say(alerts)
            if self.mcu:
                top = next((a for a in alerts if a.get("bearingDeg") is not None), None)
                if top:
                    self.mcu.threat(top["bearingDeg"], P.LEVELS[top["level"]])
            n += 1
            infer_ms = 0.8 * infer_ms + 0.2 * (t1 - t0) * 1000 if infer_ms else (t1 - t0) * 1000
            age = (time.time() - min(b[1] for b in batch + sec_batch)) * 1000
            age_ms = 0.8 * age_ms + 0.2 * age if age_ms else age
            if time.time() - t_win >= 2:
                self._perf(n / (time.time() - t_win), infer_ms, age_ms, len(dets))
                n, t_win = 0, time.time()
            _ = t_start

    def _security_step(self, seen):
        """Park mode: motion on every camera ~5 Hz, people detection where something moves (and
        every 2 s anyway, for the app's parking counts), faces when someone is at the bike."""
        t0 = time.time()
        batch = self._newest(list(self.sources), seen)
        if not batch:
            time.sleep(0.02)
            return
        moving = []
        for cam, t, img in batch:
            score, _ = self.motion[cam](img)
            moving.append(score)
        now = time.time()
        due = now - getattr(self, "_last_people", 0) >= 2.0
        run = [b for b, m in zip(batch, moving) if m > 0.005 or due or self.security.state != "armed"]
        persons_by_cam = {}
        if run:
            self._last_people = now
            res = [self.detector([b[2]])[0] for b in run]
            for (cam, t, img), (xyxy, conf, names) in zip(run, res):
                keep = [k for k, nm in enumerate(names) if nm in ("person", "bicycle")]
                self.engine.update(cam, t, xyxy[keep], conf[keep], [names[k] for k in keep], img)
                persons = [(xyxy[k], float(conf[k])) for k, nm in enumerate(names) if nm == "person" and conf[k] > 0.45]
                persons_by_cam[cam] = persons
                if persons and self.security.want_face():
                    for fbox, _ in self.faces(img, [p[0] for p in persons]):
                        H, W = img.shape[:2]
                        x1, y1, x2, y2 = (fbox * [W, H, W, H]).astype(int)
                        pad = int(0.25 * (x2 - x1))
                        crop = img[max(0, y1 - pad):y2 + pad, max(0, x1 - pad):x2 + pad]
                        if crop.size:
                            self.security.face(crop)
        for (cam, t, img), m in zip(batch, moving):
            self.security.observe(cam, m, persons_by_cam.get(cam, []))
        dets, _, sur = self.engine.snapshot(time.time())
        with self.lock:
            self.detections, self.alerts, self.surroundings = dets, [], sur
        time.sleep(max(0.0, 0.2 - (time.time() - t0)))

    def _ticker(self):
        while True:
            self.security.tick()
            time.sleep(0.5)

    def _perf(self, hz, infer_ms, age_ms, tracks):
        self.perf = {"aiHz": round(hz, 1), "inferMs": round(infer_ms), "latencyMs": round(age_ms),
                     "yoloMs": round(getattr(self, "_yolo_ms", 0)), "worldMs": round(getattr(self, "_world_ms", 0)),
                     "cameraFps": {c: round(s.fps, 1) for c, s in self.sources.items()}, "tracks": tracks,
                     "road": {k: v for k, v in (self.road.state() if self.road else {}).items()
                              if k in ("model", "hz", "inferMs")}}

    # ---- API state ------------------------------------------------------------------------
    def state(self):
        with self.lock:
            cams = [c for c in ("front", "rear") if any(P.facing(s) == c for s in self.sources)]
            gps = self.mcu.gps if self.mcu else None
            out = {"mode": self.mode, "alarm": self.alarm, "cameras": cams, "sources": list(self.sources),
                   "roles": {c: P.role(c) for c in self.sources},
                   "detections": list(self.detections), "events": self.notifier.recent(),
                   "alerts": list(self.alerts), "surroundings": self.surroundings, "perf": dict(self.perf),
                   "security": self.security.status(), "ts": int(time.time() * 1000),
                   "cameraStatus": {c: {"live": s.live(), "fps": round(s.fps, 1), "status": s.status,
                                        "role": P.role(c)} for c, s in self.sources.items()}}
        pos = self.position()
        out["position"] = pos
        if gps and gps.get("fix") and gps.get("kmh") is not None:
            out["speedKmh"] = round(gps["kmh"], 1)
        if self.road and self.mode == "ride":
            out["road"] = self.road.state()
        if self.mcu:
            out["mcu"] = {"connected": self.mcu.connected, "imu": bool(self.mcu.hb and self.mcu.hb["imu"]),
                          "gps": bool(self.mcu.hb and self.mcu.hb["gps"]),
                          "satellites": gps["sats"] if gps else 0, "ring": self.mcu.hb["ring"] if self.mcu.hb else None}
        return out

    def set_mode(self, mode):
        mode = {"drive": "ride", "park": "security", "lock": "security", "unlock": "ride"}.get(mode, mode)
        with self.lock:
            self.mode = mode
            if mode == "ride":
                self.alarm = False
        if mode == "security":
            self.rides.end()
            self.security.arm()
            if self.mcu:
                self.mcu.mode("park")
        else:
            self.rides.start()
            self.security.disarm()
            if self.mcu:
                self.mcu.mode("drive")
        print(f"[brain] mode -> {mode}", flush=True)

    def set_alarm(self, active):
        with self.lock:
            self.alarm = active
        self.security.alarm(active)
        if self.mcu and not active:
            self._ring_for_security(self.security.state)
        print(f"[brain] alarm -> {active}", flush=True)


class Voice:
    """Spoken warnings via macOS `say` (the phone will use its own text-to-speech)."""

    SPEAK = {"collision", "close_pass", "rear_collision", "vehicle_behind", "closing_ahead", "in_path",
             "red_light", "stop_sign", "cyclist_behind", "right_hook", "crossing", "oncoming", "blind_spot",
             "door_zone", "emergency", "vehicle_in_bike_lane", "no_entry", "in_traffic_lane"}

    def __init__(self, cooldown_s=5.0):
        self.cooldown_s = cooldown_s
        self.last = {}
        self.spoken_ids = set()
        self.proc = None

    def say(self, alerts):
        now = time.time()
        for a in alerts:  # most severe first
            if a["kind"] not in self.SPEAK or a["id"] in self.spoken_ids:
                continue
            if now - self.last.get(a["kind"], 0) < self.cooldown_s:
                continue
            if self.proc and self.proc.poll() is None:
                if a["level"] != "danger":
                    return
                self.proc.terminate()
            self.last[a["kind"]] = now
            self.spoken_ids.add(a["id"])
            self.proc = subprocess.Popen(["say", "-r", "230", a["text"]])
            return


# ---- HTTP server: the app's device API ------------------------------------------------
def make_handler(brain: Brain):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            if self.command == "POST":
                super().log_message(fmt, *args)

        def _cors(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

        def _json(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self._cors()
            self.end_headers()
            self.wfile.write(data)

        def _file(self, path, ctype):
            data = open(path, "rb").read()
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self._cors()
            self.end_headers()
            self.wfile.write(data)

        def _body(self):
            length = int(self.headers.get("Content-Length") or 0)
            try:
                body = json.loads(self.rfile.read(length)) if length else {}
                return body if isinstance(body, dict) else {}
            except json.JSONDecodeError:
                return {}

        def _camera(self, url):
            cam = parse_qs(url.query).get("camera", ["front"])[0]
            cam = {"back": "rear"}.get(cam, cam)
            if cam == "rear" and "rear" not in brain.sources:
                cam = next((c for c in brain.sources if P.facing(c) == "rear"), "front")
            return brain.sources.get(cam) or next(iter(brain.sources.values()))

        def do_OPTIONS(self):
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self._cors()
            self.end_headers()

        def do_GET(self):
            url = urlparse(self.path)
            parts = [p for p in url.path.split("/") if p]
            if url.path == "/state":
                self._json(200, brain.state())
            elif url.path in ("/", "/hud"):
                self._file(os.path.join(HERE, "web", "hud.html"), "text/html; charset=utf-8")
            elif url.path in ("/snapshot", "/snapshot.jpg"):
                src = self._camera(url)
                jpeg, _, _ = src.latest()
                if jpeg is None:
                    return self._json(503, {"error": f"{src.name} camera: {src.status}"})
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(jpeg)))
                self.send_header("Cache-Control", "no-store")
                self._cors()
                self.end_headers()
                self.wfile.write(jpeg)
            elif url.path == "/stream":
                self._stream(self._camera(url))
            elif url.path == "/events":
                self._json(200, {"events": brain.notifier.recent(50)})
            elif url.path == "/events/stream":
                self._sse()
            elif url.path == "/ride":
                self._json(200, {"ride": brain.rides.current()})
            elif url.path == "/rides":
                self._json(200, {"rides": brain.rides.history()})
            elif url.path == "/recordings":
                self._json(200, {"recordings": brain.recorder.list()})
            elif len(parts) >= 3 and parts[0] == "recordings":
                path = os.path.realpath(os.path.join(S.REC_DIR, *parts[1:]))
                if not path.startswith(os.path.realpath(S.REC_DIR) + os.sep) or not os.path.isfile(path):
                    return self._json(404, {"error": "not found"})
                ctype = {".mp4": "video/mp4", ".jpg": "image/jpeg", ".json": "application/json"}.get(
                    os.path.splitext(path)[1], "application/octet-stream")
                self._file(path, ctype)
            else:
                self._json(404, {"error": "not found"})

        def do_POST(self):
            url = urlparse(self.path)
            body = self._body()
            if url.path == "/mode":
                if body.get("mode") not in ("ride", "security", "drive", "park"):
                    return self._json(400, {"error": 'mode must be "ride" or "security"'})
                brain.set_mode(body["mode"])
            elif url.path == "/lock":
                brain.set_mode("security")
            elif url.path == "/unlock":
                brain.set_mode("ride")
            elif url.path == "/alarm":
                brain.set_alarm(bool(body.get("active")))
            elif url.path == "/chirp":
                if brain.mcu:
                    brain.mcu.chirp()
            elif url.path == "/ring":
                if brain.mcu and body.get("state"):
                    brain.mcu.ring(str(body["state"]))
            else:
                return self._json(404, {"error": "not found"})
            self._json(200, {"ok": True})

        def _stream(self, src):
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self._cors()
            self.end_headers()
            seq, last = -1, time.time()
            try:
                while True:
                    jpeg, new = src.wait_next(seq)
                    if new == seq or jpeg is None:
                        if time.time() - last > 5:  # camera gone: free the connection (browsers allow ~6)
                            break
                        continue
                    seq, last = new, time.time()
                    self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                                     + str(len(jpeg)).encode() + b"\r\n\r\n" + jpeg + b"\r\n")
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                pass
            self.close_connection = True

        def _sse(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self._cors()
            self.end_headers()
            seq = brain.notifier.seq
            try:
                while True:
                    seq, new = brain.notifier.wait(seq)
                    if not new:
                        self.wfile.write(b": keepalive\n\n")
                    for ev in reversed(new):
                        self.wfile.write(f"data: {json.dumps(ev)}\n\n".encode())
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                pass
            self.close_connection = True

    return Handler


def lan_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return "localhost"


# ---- Tesla-style window -------------------------------------------------------------------
GROUP_COLOURS = {"vehicle": (80, 220, 80), "bicycle": (255, 170, 60), "person": (60, 200, 255),
                 "animal": (200, 120, 255), "sign": (230, 230, 230), "obstacle": (0, 140, 255),
                 "micromobility": (255, 120, 200), "traffic light": (220, 220, 220)}
LIGHT_BGR = {"red": (40, 40, 255), "yellow": (0, 210, 255), "green": (80, 230, 80)}
LEVEL_BGR = {"info": (200, 160, 40), "caution": (0, 170, 255), "danger": (40, 40, 240)}
FOOTPRINT_M = {"vehicle": (1.8, 4.4), "bicycle": (0.6, 1.8), "person": (0.6, 0.6), "animal": (0.5, 0.9),
               "obstacle": (0.4, 0.4), "micromobility": (0.6, 1.2)}
SEC_BGR = {"disarmed": (120, 120, 120), "armed": (0, 140, 255), "motion": (0, 200, 255),
           "intruder": (40, 40, 240), "alarm": (40, 40, 255)}


def colour_of(d):
    if d["label"] == "traffic light" and d.get("light"):
        return LIGHT_BGR[d["light"]]
    if d.get("threat", 0) >= 3:
        return (40, 40, 240)
    return GROUP_COLOURS.get(d.get("group") or P.group(d["label"]), (255, 255, 255))


def draw_tile(img, dets, cam, th, show_boxes, road=None, road_state=None):
    tw = round(th * img.shape[1] / img.shape[0])
    tile = cv2.resize(img, (tw, th), interpolation=cv2.INTER_LINEAR)
    if road is not None and show_boxes:
        tile = road.draw(tile, road_state)
    if not show_boxes:
        return tile
    views = []
    for d in dets:
        if d.get("source", d["camera"]) == cam:
            views.append((d, d["box"]))
        views += [(d, o["box"]) for o in d.get("alsoSeenBy", []) if o["source"] == cam]
    for d, (x, y, w, h) in views:
        p1, p2 = (int(x * tw), int(y * th)), (int((x + w) * tw), int((y + h) * th))
        col = colour_of(d)
        cv2.rectangle(tile, p1, p2, col, 3 if d.get("threat", 0) >= 2 else 2)
        text = f"{d['label'] if not d.get('light') else d['light'] + ' light'}"
        if "distanceM" in d and d["label"] != "traffic light":
            text += f" {d['distanceM']:.0f}m"
        if d.get("speedKmh") is not None and d["group"] == "vehicle":
            text += f" {d['speedKmh']:.0f}km/h"
        if d.get("lead"):
            text = "LEAD " + text
        if d.get("braking"):
            text += " BRAKING"
        (tw_, th_), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
        ty = max(p1[1], th_ + 6)
        lx = min(p1[0], tw - tw_ - 6)
        cv2.rectangle(tile, (lx, ty - th_ - 6), (lx + tw_ + 6, ty), col, -1)
        cv2.putText(tile, text, (lx + 3, ty - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1, cv2.LINE_AA)
    return tile


def draw_bev(dets, road_state, w, h, alerts, range_m=30.0):
    """Top-down view around the bike, ahead is up: lanes, the ego path, every object with its
    velocity, and the side zones lit when something is there."""
    view = np.full((h, w, 3), (30, 26, 24), np.uint8)
    cx, cy = w // 2, int(h * 0.58)
    s = (h * 0.55) / range_m
    to_px = lambda x, z: (int(cx + x * s), int(cy - z * s))  # noqa: E731
    for r in (5, 10, 20, 30):
        cv2.circle(view, (cx, cy), int(r * s), (50, 46, 44), 1, cv2.LINE_AA)
        cv2.putText(view, f"{r}m", (cx + 4, cy - int(r * s) + 12), cv2.FONT_HERSHEY_SIMPLEX, 0.35, (100, 95, 90), 1,
                    cv2.LINE_AA)
    sides = {a["side"] for a in alerts if a.get("side") in ("left", "right") and a["level"] in ("caution", "danger")}
    for side in sides:  # light the side zone (Tesla's blind-spot highlight)
        x0 = cx - int(3.5 * s) if side == "left" else cx + int(0.8 * s)
        cv2.rectangle(view, (x0, cy - int(6 * s)), (x0 + int(2.7 * s), cy + int(6 * s)), (0, 90, 200), -1)
    if road_state and road_state.get("ok"):
        for key in ("leftBoundary", "rightBoundary"):
            b = road_state.get(key)
            if b:
                pts = np.array([to_px(x, z) for x, z in b["points"]], np.int32)
                cv2.polylines(view, [pts], False, (240, 240, 240) if b["type"] == "line" else (90, 90, 255), 2,
                              cv2.LINE_AA)
        path = road_state.get("egoPath") or []
        if len(path) >= 2:
            lp = [to_px(x - 0.35, z) for x, z in path]
            rp = [to_px(x + 0.35, z) for x, z in path]
            colour = (90, 200, 90) if road_state.get("laneType") == "bike_lane" else (220, 160, 50)
            ov = view.copy()
            cv2.fillPoly(ov, [np.array(lp + rp[::-1], np.int32)], colour)
            cv2.addWeighted(ov, 0.55, view, 0.45, 0, view)
        lt = road_state.get("laneType", "unknown")
        if lt != "unknown":
            label = {"bike_lane": "BIKE LANE", "traffic_lane": "TRAFFIC LANE"}.get(lt, lt.upper())
            cv2.putText(view, f"{label} {road_state.get('laneConfidence', 0):.0%}", (8, h - 30),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (90, 220, 90) if lt == "bike_lane" else (0, 200, 255), 1,
                        cv2.LINE_AA)
    for d in dets:
        if "position" not in d or d.get("group") in ("sign",) or d["label"] in ("traffic light",):
            continue
        x, z = d["position"]
        if abs(z) > range_m + 5 or (d["label"] == "person" and d.get("onBicycle")):
            continue
        g = d.get("group") or P.group(d["label"])
        fw, fl = FOOTPRINT_M.get(g, (0.8, 0.8))
        px, pz = to_px(x, z)
        hw, hl = max(3, int(fw * s / 2)), max(3, int(fl * s / 2))
        col = colour_of(d)
        cv2.rectangle(view, (px - hw, pz - hl), (px + hw, pz + hl), col, -1, cv2.LINE_AA)
        if d.get("velocity"):
            vx, vz = d["velocity"]
            cv2.arrowedLine(view, (px, pz), to_px(x + vx * 1.0, z + vz * 1.0), (230, 230, 230), 1, cv2.LINE_AA,
                            tipLength=0.25)
        if d.get("threat", 0) >= 2:
            cv2.rectangle(view, (px - hw - 3, pz - hl - 3), (px + hw + 3, pz + hl + 3),
                          LEVEL_BGR["danger" if d["threat"] >= 3 else "caution"], 2, cv2.LINE_AA)
    cv2.rectangle(view, (cx - 3, cy - 9), (cx + 3, cy + 9), (255, 255, 255), -1)  # the bike
    cv2.putText(view, "AHEAD", (cx - 24, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (150, 150, 150), 1, cv2.LINE_AA)
    return view


def show_loop(brain: Brain, height):
    win = "Velo brain"
    cv2.namedWindow(win, cv2.WINDOW_NORMAL)
    th = height
    decoders = {c: Decoder() for c in brain.sources}
    frames = {c: None for c in brain.sources}
    shown = {c: 0 for c in brain.sources}
    show_boxes = True
    last_log = time.time()
    order = sorted(brain.sources, key=lambda c: {"road_front": 0, "road_rear": 1}.get(P.role(c), 2))
    while True:
        changed = False
        for cam, src in brain.sources.items():
            jpeg, seq, _ = src.latest()
            if jpeg is not None and seq != shown[cam]:
                frames[cam], shown[cam], changed = decoders[cam](jpeg), seq, True
        if changed or not any(shown.values()):
            st = brain.state()
            road_state = st.get("road")
            tiles = []
            for cam in order:
                src = brain.sources[cam]
                h_ = th if P.role(cam) != "security" else th // 2
                if frames[cam] is None or not src.live():
                    tile = np.zeros((h_, h_ * 4 // 3, 3), np.uint8)
                    cv2.putText(tile, f"{cam.upper()}: {src.status}"[:40], (10, h_ // 2), cv2.FONT_HERSHEY_SIMPLEX, 0.6,
                                (200, 200, 200), 1)
                else:
                    road = brain.road if P.role(cam) == "road_front" and st["mode"] == "ride" else None
                    tile = draw_tile(frames[cam], st["detections"], cam, h_, show_boxes, road, road_state)
                cv2.rectangle(tile, (0, h_ - 24), (tile.shape[1], h_), (0, 0, 0), -1)
                cv2.putText(tile, f"{cam.upper()} ({P.role(cam).replace('_', ' ')})  {src.fps:4.1f} fps", (8, h_ - 7),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
                tiles.append(tile)
            # security tile goes under the BEV
            sec = [t for c, t in zip(order, tiles) if P.role(c) == "security"]
            main = [t for c, t in zip(order, tiles) if P.role(c) != "security"]
            bev_w = th * 3 // 4
            bev = draw_bev(st["detections"], road_state, bev_w, th if not sec else th - sec[0].shape[0], st["alerts"])
            if sec:
                s_ = cv2.resize(sec[0], (bev_w, sec[0].shape[0] * bev_w // sec[0].shape[1]))
                bev = np.vstack([bev, s_])[:th]
                if bev.shape[0] < th:
                    bev = np.vstack([bev, np.zeros((th - bev.shape[0], bev_w, 3), np.uint8)])
            view = np.hstack(main + [bev])
            pf = st["perf"]
            sec_state = st["security"]["state"]
            mcu = st.get("mcu") or {}
            bar = (f"{st['mode'].upper()}  |  AI {pf.get('aiHz', 0):.1f} Hz  infer {pf.get('inferMs', 0)} ms  "
                   f"latency {pf.get('latencyMs', 0)} ms  road {pf.get('road', {}).get('hz', 0)} Hz  |  "
                   f"MCU {'ok' if mcu.get('connected') else '-'}  GPS {mcu.get('satellites', 0)} sats"
                   f"{'  ' + str(st.get('speedKmh')) + ' km/h' if st.get('speedKmh') is not None else ''}  |  "
                   f"P park  R ride  D boxes  Q quit")
            cv2.rectangle(view, (0, 0), (view.shape[1], 28), (0, 0, 0), -1)
            cv2.putText(view, bar, (8, 19), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
            y = 34
            if st["mode"] == "security":
                txt = f"PARKED: {sec_state.upper()}" + (f"  (recording {st['security']['recording']})"
                                                        if st["security"]["recording"] else "")
                (w_, h_), _ = cv2.getTextSize(txt, cv2.FONT_HERSHEY_SIMPLEX, 0.8, 2)
                cv2.rectangle(view, (8, y), (8 + w_ + 20, y + h_ + 16), SEC_BGR.get(sec_state, (100, 100, 100)), -1)
                cv2.putText(view, txt, (18, y + h_ + 8), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2, cv2.LINE_AA)
                y += h_ + 22
            for a in st["alerts"][:3]:
                (w_, h_), _ = cv2.getTextSize(a["text"], cv2.FONT_HERSHEY_SIMPLEX, 0.8, 2)
                cv2.rectangle(view, (8, y), (8 + w_ + 20, y + h_ + 16), LEVEL_BGR[a["level"]], -1)
                cv2.putText(view, a["text"], (18, y + h_ + 8), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2,
                            cv2.LINE_AA)
                y += h_ + 22
            cv2.imshow(win, view)
        if time.time() - last_log >= 5:
            last_log = time.time()
            print(f"[brain] {json.dumps(brain.state()['perf'])}", flush=True)
        key = cv2.waitKey(1) & 0xFF
        if key in (ord("q"), ord("Q"), 27):
            break
        if key in (ord("d"), ord("D")):
            show_boxes = not show_boxes
        if key in (ord("p"), ord("P")):
            brain.set_mode("security")
        if key in (ord("r"), ord("R")):
            brain.set_mode("ride")
    cv2.destroyAllWindows()


def main():
    p = argparse.ArgumentParser(description="Velo brain: Tesla-style perception + park mode + the app's API")
    p.add_argument("--front", default="board", help="'board', a URL, Mac camera name, or a video file")
    p.add_argument("--rear", default="board", help="Pi camera 2 (security camera): like --front, or 'none'")
    p.add_argument("--seat", default="auto", help="seat webcam (road behind): 'auto' = this Mac's USB webcam if "
                                                   "plugged in here, else the board's; or like --front, or 'none'")
    p.add_argument("--model", default=os.path.join(HERE, "yolo11s.pt"), help="COCO YOLO weights")
    p.add_argument("--imgsz", type=int, default=640)
    p.add_argument("--fp16", action="store_true", help="half precision (slower than fp32 on M1 MPS)")
    p.add_argument("--no-world", action="store_true", help="skip YOLO-World (signs, cones, scooters ...)")
    p.add_argument("--no-road", action="store_true", help="skip YOLOP road / lane understanding")
    p.add_argument("--no-mcu", action="store_true", help="don't talk to the STM32 (ring, IMU, GPS)")
    p.add_argument("--world-hz", type=float, default=3.0)
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--show", action="store_true", help="open the Tesla-style window")
    p.add_argument("--height", type=int, default=0, help="window tile height (default fits the screen)")
    p.add_argument("--voice", action="store_true", help="speak warnings (macOS say)")
    p.add_argument("--mode", default="ride", choices=("ride", "security"))
    a = p.parse_args()

    # Thread pools: torch and OpenCV each default to one thread per core and spin-wait; together
    # with the road process they oversubscribe the CPU and everything crawls. The heavy lifting
    # is on the GPU (YOLO) and in the road process, so small pools are faster overall.
    import torch

    torch.set_num_threads(2)
    cv2.setNumThreads(2)
    cfg = G.load_config()
    P.configure(cfg)
    board = B.Board()
    sources = {}
    for name, spec in (("front", a.front), ("seat", a.seat), ("rear", a.rear)):
        if spec.lower() != "none":
            sources[name] = make_source(name, spec, board)
    mcu = None
    if not a.no_mcu:
        import mcu as M

        mcu = M.Mcu()
    world = None
    if not a.no_world and os.path.exists(D.WorldDetector.PATH):
        world = D.WorldDetector()
    brain = Brain(sources, cfg, D.YoloDetector(a.model, a.imgsz, a.fp16), world, not a.no_road, mcu, a.voice,
                  world_hz=a.world_hz)
    if a.mode == "security":
        brain.set_mode("security")

    server = ThreadingHTTPServer(("0.0.0.0", a.port), make_handler(brain))
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f"[brain] app API on http://{lan_ip()}:{a.port}  (simulator: localhost:{a.port})", flush=True)

    import atexit

    atexit.register(brain.rides.end)
    if a.show:
        show_loop(brain, a.height or 420)
    else:
        try:
            while True:
                time.sleep(5)
                print(f"[brain] {json.dumps(brain.state()['perf'])}", flush=True)
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
