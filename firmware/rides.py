"""Ride log + dashcam: Tesla-style incident clips and a summary of every ride.

While riding, every *dangerous* situation (close pass, near miss, right hook, rear collision,
oncoming car in your lane) becomes an incident: the recorder saves every camera from 6 s before
it to a few seconds after (security.Recorder, same files as park mode), with the GPS position and
what happened. A ride starts when ride mode starts and ends when the bike is locked (or the brain
stops); its summary is saved in rides/<id>.json and served at GET /ride and /rides.

Close passes are the cyclist's evidence: time, place, how close, the car's speed, and video.
"""

from __future__ import annotations

import json
import os
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
RIDES_DIR = os.path.join(HERE, "rides")
INCIDENT_KINDS = {"close_pass", "rear_collision", "collision", "right_hook", "oncoming"}


class RideLog:
    def __init__(self, recorder, notifier, root=RIDES_DIR):
        self.rec, self.notify, self.root = recorder, notifier, root
        os.makedirs(root, exist_ok=True)
        self.lock = threading.Lock()
        self.ride = None
        self._seen = {}  # alert id -> time first seen (an alert is one incident, however long it lasts)
        self._last_t = None

    def start(self):
        with self.lock:
            if self.ride:
                return
            ts = int(time.time() * 1000)
            self.ride = {"id": f"ride-{ts}", "started": ts, "ended": None, "durationS": 0, "distanceM": 0.0,
                         "maxSpeedKmh": 0.0, "incidents": [], "alertCounts": {}, "closestPassM": None,
                         "track": []}  # [lat, lon] every ~5 s
            self._seen, self._last_t = {}, None
            print(f"[ride] started {self.ride['id']}", flush=True)

    def end(self):
        with self.lock:
            r, self.ride = self.ride, None
        if not r:
            return None
        r["ended"] = int(time.time() * 1000)
        r["durationS"] = round((r["ended"] - r["started"]) / 1000)
        json.dump(r, open(os.path.join(self.root, f"{r['id']}.json"), "w"))
        print(f"[ride] ended {r['id']}: {r['distanceM'] / 1000:.2f} km, {len(r['incidents'])} incidents", flush=True)
        return r

    def observe(self, alerts, dets, gps, speed_mps):
        """Call once per perception cycle in ride mode."""
        now = time.time()
        with self.lock:
            r = self.ride
            if not r:
                return
            if self._last_t is not None and speed_mps is not None:
                r["distanceM"] += speed_mps * min(now - self._last_t, 2.0)
            self._last_t = now
            if speed_mps is not None:
                r["maxSpeedKmh"] = max(r["maxSpeedKmh"], round(speed_mps * 3.6, 1))
            if gps and (not r["track"] or now - r.get("_track_t", 0) >= 5):
                r["track"].append([round(gps["lat"], 6), round(gps["lon"], 6)])
                r["_track_t"] = now
            by_id = {d["id"]: d for d in dets}
            for a in alerts:
                if a["id"] in self._seen:
                    continue
                self._seen[a["id"]] = now
                r["alertCounts"][a["kind"]] = r["alertCounts"].get(a["kind"], 0) + 1
                if a["kind"] in INCIDENT_KINDS and a["level"] == "danger":
                    self._incident(r, a, by_id.get(a.get("trackId")), gps)
            for k in [k for k, t in self._seen.items() if now - t > 30]:
                del self._seen[k]

    def _incident(self, r, a, d, gps):
        ts = int(time.time() * 1000)
        inc = {"id": f"inc-{ts}", "ts": ts, "situation": a["kind"], "text": a["text"], "side": a.get("side"),
               "position": {"lat": gps["lat"], "lon": gps["lon"]} if gps else None}
        if d:
            inc.update(label=d["label"], distanceM=d.get("distanceM"), objectSpeedKmh=d.get("speedKmh"),
                       closingMps=d.get("closingMps"))
            if a["kind"] == "close_pass" and d.get("position") and d.get("velocity"):
                # side-of-car to bike clearance when it draws level
                x, z = d["position"]
                vx, vz = d["velocity"]
                if vz > 0.5 and z < 0:
                    pass_x = x + vx * (-z / vz)
                    clearance = round(max(0.0, abs(pass_x) - 0.95 - 0.35), 2)
                    inc["clearanceM"] = clearance
                    if r["closestPassM"] is None or clearance < r["closestPassM"]:
                        r["closestPassM"] = clearance
        inc["recording"] = self.rec.start(inc["id"], post_s=6.0, meta={"reason": a["text"], "ride": r["id"]})
        r["incidents"].append(inc)
        self.notify.emit("incident", **{k: v for k, v in inc.items() if k not in ("id", "ts")}, ride=r["id"])

    def current(self):
        with self.lock:
            r = dict(self.ride) if self.ride else None
        if r:
            r["durationS"] = round(time.time() - r["started"] / 1000)
            r.pop("_track_t", None)
        return r

    def history(self, limit=30):
        out = []
        for f in sorted(os.listdir(self.root), reverse=True)[:limit]:
            if f.endswith(".json"):
                try:
                    r = json.load(open(os.path.join(self.root, f)))
                    r.pop("_track_t", None)
                    out.append(r)
                except ValueError:
                    pass
        return out

