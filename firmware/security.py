"""Velo park mode: a Ring doorbell for the bike.

  MotionDetector   per camera: background subtraction (MOG2) on a small grey image; ignores
                   whole-frame light changes (clouds, headlights)
  Recorder         keeps the last few seconds of every camera in memory; on a trigger writes
                   H.264 MP4s that start BEFORE the trigger, plus the exact trigger frames
  Notifier         the event feed: /state events (app kinds: motion, tamper, crash, pothole),
                   /events/stream (server-sent events), optional webhook (VELO_WEBHOOK env).
                   Phone push (APNs / FCM) plugs in here: see APP_INTEGRATION.md
  SecurityMonitor  the state machine
                       disarmed  (ride mode)
                       armed     ring orange, watching (motion + people + IMU)
                       motion    someone near the bike: ring amber, recording, "motion" event
                       intruder  someone at / on the bike, or the IMU says it is being moved:
                                 ring red, recording, faces saved, "tamper" event (push)
                       alarm     owner pressed "sound alarm", or tamper keeps going
                   and back to armed after things are quiet for a while.
"""

from __future__ import annotations

import json
import os
import threading
import time
import urllib.request
from collections import deque

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REC_DIR = os.path.join(HERE, "recordings")


def new_event_id(prefix="evt"):
    return f"{prefix}-{int(time.time() * 1000)}"  # unique across reboots (the app needs that)


class MotionDetector:
    def __init__(self, width=160):
        self.width = width
        self.bg = cv2.createBackgroundSubtractorMOG2(history=200, varThreshold=28, detectShadows=False)
        self.frames = 0
        self.kernel = np.ones((3, 3), np.uint8)

    def __call__(self, bgr):
        """-> (score 0-1 = fraction of the frame moving, boxes normalized xyxy)."""
        h = round(self.width * bgr.shape[0] / bgr.shape[1])
        g = cv2.GaussianBlur(cv2.cvtColor(cv2.resize(bgr, (self.width, h), interpolation=cv2.INTER_AREA),
                                          cv2.COLOR_BGR2GRAY), (5, 5), 0)
        m = self.bg.apply(g)
        self.frames += 1
        if self.frames < 15:  # still learning the scene
            return 0.0, []
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, self.kernel)
        frac = float((m > 0).mean())
        if frac > 0.5:  # whole frame changed: lighting, not a person
            return 0.0, []
        boxes = []
        for c in cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]:
            x, y, w, hh = cv2.boundingRect(c)
            if w * hh >= 0.004 * self.width * h:
                boxes.append([x / self.width, y / h, (x + w) / self.width, (y + hh) / h])
        return (frac if boxes else 0.0), boxes


class Recorder:
    """recorder.feed(camera, jpeg, t) for every frame; start(event_id) / stop()."""

    def __init__(self, preroll_s=6.0, fps=10.0, root=REC_DIR):
        self.preroll_s, self.fps, self.root = preroll_s, fps, root
        self.buf = {}  # camera -> deque[(t, jpeg)]
        self.last_t = {}
        self.active = None  # {"id", "dir", "until", "writers": {cam: Writer}}
        self.lock = threading.Lock()
        os.makedirs(root, exist_ok=True)

    def feed(self, camera, jpeg, t):
        if t - self.last_t.get(camera, 0) < 1.0 / self.fps - 0.005:
            return
        self.last_t[camera] = t
        with self.lock:
            q = self.buf.setdefault(camera, deque())
            q.append((t, jpeg))
            while q and t - q[0][0] > self.preroll_s:
                q.popleft()
            rec = self.active
        if rec:
            w = rec["writers"].get(camera)
            if w is None:
                w = rec["writers"][camera] = _Writer(os.path.join(rec["dir"], rec["name"](camera)), self.fps)
            w.put(jpeg)

    def start(self, event_id, post_s=12.0, meta=None):
        """Begin (or extend) a recording. Returns its id."""
        with self.lock:
            if self.active:
                self.active["until"] = max(self.active["until"], time.time() + post_s)
                return self.active["id"]
            d = os.path.join(self.root, event_id)
            os.makedirs(os.path.join(d, "faces"), exist_ok=True)
            # the same incident can re-trigger after a clip ended: add a numbered segment
            seg = sum(1 for f in os.listdir(d) if f.endswith(".mp4") and f.split(".")[0].split("-")[0] in self.buf)
            seg = seg // max(1, len(self.buf))
            name = (lambda cam: f"{cam}.mp4") if seg == 0 else (lambda cam: f"{cam}-{seg + 1}.mp4")
            writers = {}
            for cam, q in self.buf.items():
                writers[cam] = _Writer(os.path.join(d, name(cam)), self.fps)
                for _, jpeg in q:  # the seconds before the trigger
                    writers[cam].put(jpeg)
                if q and seg == 0:  # the frame at the moment of the trigger
                    open(os.path.join(d, f"{cam}_trigger.jpg"), "wb").write(q[-1][1])
            self.active = {"id": event_id, "dir": d, "until": time.time() + post_s, "writers": writers,
                           "started": time.time(), "name": name}
            if seg == 0:
                json.dump({"id": event_id, "started": int(time.time() * 1000), **(meta or {})},
                          open(os.path.join(d, "event.json"), "w"))
        print(f"[security] recording {event_id}", flush=True)
        return event_id

    def tick(self):
        """Call regularly: finishes the recording once its time is up."""
        with self.lock:
            rec = self.active
            if not rec or time.time() < rec["until"]:
                return
            self.active = None
        for w in rec["writers"].values():
            w.close()
        meta_path = os.path.join(rec["dir"], "event.json")
        try:
            meta = json.load(open(meta_path))
        except (OSError, ValueError):
            meta = {}
        meta.update(ended=int(time.time() * 1000), cameras=sorted(rec["writers"]),
                    durationS=round(meta.get("durationS", 0) + time.time() - rec["started"] + self.preroll_s, 1))
        json.dump(meta, open(meta_path, "w"))
        print(f"[security] saved {rec['dir']}", flush=True)

    def save_face(self, jpeg_or_bgr, name):
        rec = self.active
        if not rec:
            return None
        path = os.path.join(rec["dir"], "faces", name)
        if isinstance(jpeg_or_bgr, (bytes, bytearray)):
            open(path, "wb").write(jpeg_or_bgr)
        else:
            cv2.imwrite(path, jpeg_or_bgr)
        return path

    @property
    def recording(self):
        return self.active["id"] if self.active else None

    def list(self, limit=50):
        out = []
        for d in sorted(os.listdir(self.root), reverse=True)[:limit]:
            p = os.path.join(self.root, d, "event.json")
            if os.path.exists(p):
                try:
                    meta = json.load(open(p))
                except ValueError:
                    continue
                files = sorted(f for f in os.listdir(os.path.join(self.root, d)) if f.endswith((".mp4", ".jpg")))
                faces = sorted(os.listdir(os.path.join(self.root, d, "faces"))) \
                    if os.path.isdir(os.path.join(self.root, d, "faces")) else []
                out.append({**meta, "files": files, "faces": [f"faces/{f}" for f in faces]})
        return out


class _Writer:
    """Decodes JPEGs and writes an H.264 MP4 in its own thread."""

    def __init__(self, path, fps):
        self.path, self.fps = path, fps
        self.q = deque()
        self.cond = threading.Condition()
        self.closed = False
        threading.Thread(target=self._run, daemon=True).start()

    def put(self, jpeg):
        with self.cond:
            self.q.append(jpeg)
            self.cond.notify()

    def close(self):
        with self.cond:
            self.closed = True
            self.cond.notify()

    def _run(self):
        vw = None
        while True:
            with self.cond:
                self.cond.wait_for(lambda: self.q or self.closed, timeout=1)
                if not self.q and self.closed:
                    break
                if not self.q:
                    continue
                jpeg = self.q.popleft()
            img = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
            if img is None:
                continue
            if img.shape[1] > 1280:
                img = cv2.resize(img, (img.shape[1] // 2, img.shape[0] // 2), interpolation=cv2.INTER_AREA)
            if vw is None:
                vw = cv2.VideoWriter(self.path, cv2.VideoWriter_fourcc(*"avc1"), self.fps, (img.shape[1], img.shape[0]))
                size = (img.shape[1], img.shape[0])
            if (img.shape[1], img.shape[0]) != size:
                img = cv2.resize(img, size)
            vw.write(img)
        if vw is not None:
            vw.release()


class Notifier:
    """Events for the app. kinds the app knows: motion, tamper, crash, pothole (others ignored)."""

    def __init__(self, keep=50):
        self.events = deque(maxlen=keep)
        self.cond = threading.Condition()
        self.seq = 0
        self.webhook = os.environ.get("VELO_WEBHOOK")

    def emit(self, kind, **fields):
        ts = int(time.time() * 1000)
        ev = {"id": fields.pop("id", None) or f"evt-{ts}", "kind": kind, "ts": ts, **fields}
        with self.cond:
            self.events.appendleft(ev)
            self.seq += 1
            self.cond.notify_all()
        print(f"[event] {json.dumps(ev)}", flush=True)
        if self.webhook:
            threading.Thread(target=self._post, args=(ev,), daemon=True).start()
        # TODO(app/push): send a push notification to the owner's phone here (APNs / FCM via the
        # app backend). Payload: ev (+ /recordings/<id>/<camera>_trigger.jpg for the picture).
        return ev

    def _post(self, ev):
        try:
            req = urllib.request.Request(self.webhook, json.dumps(ev).encode(), {"Content-Type": "application/json"})
            urllib.request.urlopen(req, timeout=5).read()
        except Exception as e:  # noqa: BLE001
            print(f"[event] webhook failed: {e}", flush=True)

    def recent(self, n=20):
        with self.cond:
            return list(self.events)[:n]

    def wait(self, seq, timeout=15):
        with self.cond:
            self.cond.wait_for(lambda: self.seq != seq, timeout=timeout)
            return self.seq, list(self.events)[: max(0, self.seq - seq)] if self.seq != seq else []


class SecurityMonitor:
    """Feed it observations; it decides the state, records, and emits events.

    observe(camera, motion_score, persons) per analysed frame; persons = [(xyxy, conf)].
    imu_event(kind, value) from the MCU ("nudge" / "tamper")."""

    QUIET_S = 20.0           # quiet time before going back to armed
    CLOSE_PERSON_H = 0.45    # a person box this tall (fraction of frame) is at the bike
    DWELL_S = 4.0            # someone near this long becomes an intruder

    def __init__(self, recorder: Recorder, notifier: Notifier, on_state=None):
        self.rec, self.notify = recorder, notifier
        self.on_state = on_state or (lambda s: None)
        self.state = "disarmed"
        self.since = time.time()
        self.last_activity = 0.0
        self.near_since = None
        self.event_id = None
        self.faces_saved = 0
        self.lock = threading.Lock()
        self.people = {}  # camera -> count (the app's parking stats)

    def _set(self, s):
        if s != self.state:
            self.state, self.since = s, time.time()
            print(f"[security] -> {s}", flush=True)
            self.on_state(s)

    def arm(self):
        with self.lock:
            self.near_since, self.event_id = None, None
            self._set("armed")

    def disarm(self):
        with self.lock:
            self._set("disarmed")
            self.event_id = None

    def alarm(self, active):
        with self.lock:
            if active and self.state != "disarmed":
                self._set("alarm")
                self._start("alarm")
            elif not active and self.state == "alarm":
                self._set("intruder" if time.time() - self.last_activity < self.QUIET_S else "armed")

    def _start(self, why, kind=None, **extra):
        """Start/extend the recording; emit an event when there is a new one of this kind."""
        new = self.event_id is None
        if new:
            self.event_id = new_event_id()
            self.faces_saved = 0
        self.rec.start(self.event_id, meta={"reason": why})
        if kind:
            self.notify.emit(kind, recording=self.event_id, reason=why,
                             snapshots=f"/recordings/{self.event_id}/", **extra)

    def observe(self, camera, motion, persons, now=None):
        now = now or time.time()
        with self.lock:
            self.people[camera] = len(persons)
            if self.state == "disarmed":
                return
            close = [p for p in persons if (p[0][3] - p[0][1]) >= self.CLOSE_PERSON_H]
            active = motion > 0.01 or persons
            if active:
                self.last_activity = now
            if close:
                self.near_since = self.near_since or now
            elif not persons:
                self.near_since = None
            if self.state == "armed" and (persons or motion > 0.03):
                self._set("motion")
                self._start("motion", "motion", camera=camera, people=len(persons))
            if self.state in ("armed", "motion") and close and now - self.near_since >= self.DWELL_S:
                self._set("intruder")
                self._start("person at the bike", "tamper", camera=camera, people=len(persons))
            if self.state in ("motion", "intruder") and now - self.last_activity > self.QUIET_S:
                self._set("armed")
                self.event_id = None
            elif self.event_id and active:
                self.rec.start(self.event_id)  # keep recording while something happens

    def imu_event(self, kind, value):
        with self.lock:
            if self.state == "disarmed":
                return
            self.last_activity = time.time()
            if kind == "tamper":
                if self.state != "alarm":
                    self._set("intruder")
                self._start("bike moved", "tamper", severity=round(value, 2))
            elif kind == "nudge" and self.near_since is not None and self.state in ("armed", "motion"):
                # a person right at the bike AND the bike being touched: that's someone handling it
                self._set("intruder")
                self._start("person touching the bike", "tamper", severity=round(value, 2))
            elif kind == "nudge" and self.state == "armed":
                self._set("motion")
                self._start("bike touched", "motion", severity=round(value, 2))

    def want_face(self):
        return self.state in ("intruder", "alarm", "motion") and self.faces_saved < 12

    def face(self, crop_bgr):
        if self.rec.save_face(crop_bgr, f"face_{self.faces_saved:02d}.jpg"):
            self.faces_saved += 1

    def tick(self):
        self.rec.tick()
        with self.lock:
            if self.state in ("motion", "intruder") and time.time() - self.last_activity > self.QUIET_S:
                self._set("armed")
                self.event_id = None

    def status(self):
        return {"state": self.state, "since": int(self.since * 1000), "recording": self.rec.recording,
                "event": self.event_id, "facesSaved": self.faces_saved, "peopleSeen": dict(self.people)}
