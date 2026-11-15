"""Ride capture + replay: Velo's data engine.

Record a real ride once (every camera + every IMU / GPS line from the STM32, time-stamped), then
replay it through the full brain as often as needed: tune thresholds, check a fix, prove a
warning fires (or doesn't) on real data from the real cameras.

    python velo_brain.py --record captures/ride1          # ride normally; everything is saved
    python velo_brain.py --replay captures/ride1 --show   # the same ride, through the whole system

Layout of a capture folder:
    <camera>.mjpeg   back-to-back JPEG frames      <camera>.idx   t, offset, size (one per frame)
    sensors.log      t <tab> raw STM32 line (I ..., G ..., E ..., H ...)
    meta.json        cameras, start time, config used
Front camera at 10 fps is ~150 MB a minute; --record-fps sets the rate.
"""

from __future__ import annotations

import json
import os
import threading
import time

import geometry as G
import mcu as M


class RideCapture:
    def __init__(self, folder, cameras, fps=10.0):
        os.makedirs(folder, exist_ok=True)
        self.folder, self.fps = folder, fps
        self.files = {c: (open(os.path.join(folder, f"{c}.mjpeg"), "ab"), open(os.path.join(folder, f"{c}.idx"), "a"))
                      for c in cameras}
        self.sensors = open(os.path.join(folder, "sensors.log"), "a")
        self.last = {}
        self.lock = threading.Lock()
        self.frames = 0
        json.dump({"cameras": list(cameras), "started": time.time(), "fps": fps, "config": G.load_config()},
                  open(os.path.join(folder, "meta.json"), "w"), indent=1)
        print(f"[capture] recording to {folder}", flush=True)

    def frame(self, camera, jpeg, t):
        if camera not in self.files or t - self.last.get(camera, 0) < 1.0 / self.fps - 0.003:
            return
        self.last[camera] = t
        with self.lock:
            data, idx = self.files[camera]
            off = data.tell()
            data.write(jpeg)
            idx.write(f"{t:.4f},{off},{len(jpeg)}\n")
            self.frames += 1
            if self.frames % 10 == 0:  # lose at most a second if the power goes
                for d, i in self.files.values():
                    d.flush(), i.flush()
                self.sensors.flush()

    def sensor(self, line):
        with self.lock:
            self.sensors.write(f"{time.time():.4f}\t{line}\n")

    def close(self):
        with self.lock:
            for d, i in self.files.values():
                d.close(), i.close()
            self.sensors.close()


def load_index(folder, camera):
    rows = []
    for ln in open(os.path.join(folder, f"{camera}.idx")):
        t, off, n = ln.strip().split(",")
        rows.append((float(t), int(off), int(n)))
    return rows


def capture_cameras(folder):
    return json.load(open(os.path.join(folder, "meta.json")))["cameras"]


def start_time(folder):
    ts = []
    for c in capture_cameras(folder):
        idx = load_index(folder, c)
        if idx:
            ts.append(idx[0][0])
    return min(ts) if ts else 0.0


def replay_frames(folder, camera, put, t0_capture, t0_wall, speed=1.0, loop=True):
    """Feed a camera's recorded JPEGs to put(jpeg) with the original timing."""
    idx = load_index(folder, camera)
    data = open(os.path.join(folder, f"{camera}.mjpeg"), "rb")
    while True:
        for t, off, n in idx:
            due = t0_wall + (t - t0_capture) / speed
            wait = due - time.time()
            if wait > 0:
                time.sleep(wait)
            data.seek(off)
            put(data.read(n))
        if not loop:
            return
        span = idx[-1][0] - t0_capture + 0.5 if idx else 1
        t0_wall += span / speed


class ReplayMcu(M.Mcu):
    """Plays a recorded sensors.log through the normal Mcu parser (same API as the live link)."""

    def __init__(self, folder, t0_capture, t0_wall, speed=1.0, on_event=None):
        self.on_event = on_event or (lambda kind, value: None)
        self.port, self.fd = None, None
        self.imu = self.gps = self.hb = None
        self.last_rx = 0.0
        self._want = {}
        self._lock = threading.Lock()
        self.folder, self.t0c, self.t0w, self.speed = folder, t0_capture, t0_wall, speed
        threading.Thread(target=self._play, daemon=True, name="replay-mcu").start()

    def send(self, line):
        return True  # replay: commands go nowhere

    def _play(self):
        path = os.path.join(self.folder, "sensors.log")
        if not os.path.exists(path):
            return
        rows = []
        for ln in open(path):
            t, _, line = ln.rstrip("\n").partition("\t")
            rows.append((float(t), line))
        t0w = self.t0w
        while True:
            for t, line in rows:
                wait = t0w + (t - self.t0c) / self.speed - time.time()
                if wait > 0:
                    time.sleep(wait)
                self._handle(line)
            span = rows[-1][0] - self.t0c + 0.5 if rows else 1
            t0w += span / self.speed
