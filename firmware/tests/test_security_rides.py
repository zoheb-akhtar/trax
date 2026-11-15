#!/usr/bin/env python3
"""Park-mode state machine + ride incident log, with synthetic camera frames.

    .venv/bin/python tests/test_security_rides.py
"""
import os
import shutil
import sys
import tempfile
import time

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import rides as RL  # noqa: E402
import security as S  # noqa: E402

tmp = tempfile.mkdtemp()
ok_all = []


def check(name, cond, extra=""):
    print(f"{'PASS' if cond else 'FAIL'}  {name} {extra}")
    ok_all.append(bool(cond))


def jpeg(i):
    img = np.full((240, 320, 3), 80, np.uint8)
    cv2.putText(img, str(i), (100, 130), cv2.FONT_HERSHEY_SIMPLEX, 2, (255, 255, 255), 3)
    return cv2.imencode(".jpg", img)[1].tobytes()


def feed(rec, seconds, t0=None):
    t = t0 or time.time()
    for i in range(int(seconds * 10)):
        rec.feed("front", jpeg(i), t + i * 0.1)
        rec.feed("rear", jpeg(i), t + i * 0.1)


# --- security: people / IMU -> states, events, recording
rec = S.Recorder(root=os.path.join(tmp, "rec"))
note = S.Notifier()
states = []
sec = S.SecurityMonitor(rec, note, on_state=states.append)
feed(rec, 3)
sec.arm()
sec.observe("rear", 0.0, [])
check("armed and quiet", sec.state == "armed" and not note.recent())
sec.observe("rear", 0.05, [(np.array([0.4, 0.5, 0.5, 0.75]), 0.8)])  # someone walking past, far
check("person nearby -> motion + recording", sec.state == "motion" and rec.recording is not None,
      f"events={[e['kind'] for e in note.recent()]}")
close = [(np.array([0.3, 0.1, 0.7, 0.95]), 0.9)]  # tall box: at the bike
sec.observe("rear", 0.05, close)
sec.imu_event("nudge", 0.12)  # ... and the bike is touched
check("person at the bike + touch -> intruder at once", sec.state == "intruder",
      f"events={[e['kind'] for e in note.recent()]}")
check("tamper event emitted with a recording", any(e["kind"] == "tamper" and e.get("recording") for e in note.recent()))
feed(rec, 1)
rec.active["until"] = 0  # finish the clip now
rec.tick()
d = os.path.join(rec.root, note.recent()[-1]["recording"])
time.sleep(1.5)  # writer threads flush
files = sorted(os.listdir(d))
check("recording has pre-roll MP4s + trigger frames", "front.mp4" in files and "front_trigger.jpg" in files, files)
n = int(cv2.VideoCapture(os.path.join(d, "front.mp4")).get(cv2.CAP_PROP_FRAME_COUNT))
check("pre-roll frames in the clip", n >= 30, f"frames={n}")
sec.disarm()
check("unlock -> disarmed", sec.state == "disarmed")

# --- IMU-only tamper (bike moved, nobody seen)
note2 = S.Notifier()
sec2 = S.SecurityMonitor(S.Recorder(root=os.path.join(tmp, "rec2")), note2)
sec2.arm()
sec2.imu_event("tamper", 25.0)
check("IMU tamper alone -> intruder + tamper event", sec2.state == "intruder" and note2.recent()[0]["kind"] == "tamper")

# --- ride log: close pass -> incident with clearance + clip
rec3 = S.Recorder(root=os.path.join(tmp, "rec3"))
feed(rec3, 2)
log = RL.RideLog(rec3, S.Notifier(), root=os.path.join(tmp, "rides"))
log.start()
alert = {"id": "close_pass-7", "kind": "close_pass", "level": "danger", "text": "Car passing close on your left",
         "side": "left", "trackId": 7}
det = {"id": 7, "label": "car", "distanceM": 6.0, "position": [-1.8, -6.0], "velocity": [0.0, 8.0],
       "speedKmh": 48.0, "closingMps": 8.0}
for _ in range(5):  # the same alert over several frames = one incident
    log.observe([alert], [det], {"lat": 42.34, "lon": -71.09}, 5.0)
cur = log.current()
check("one incident per alert, with clearance", len(cur["incidents"]) == 1 and cur["incidents"][0]["clearanceM"] == 0.5,
      cur["incidents"])
check("incident has a recording", cur["incidents"][0]["recording"] is not None)
r = log.end()
check("ride saved", os.path.exists(os.path.join(log.root, f"{r['id']}.json")) and r["closestPassM"] == 0.5)

shutil.rmtree(tmp, ignore_errors=True)
print(f"\n{sum(ok_all)}/{len(ok_all)} checks pass")
sys.exit(0 if all(ok_all) else 1)
