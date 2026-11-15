#!/usr/bin/env python3
"""Safety monitor: every failure must be reported, and stale perception must never look like 'all clear'.

    .venv/bin/python tests/test_health.py
"""
import os
import sys
import time
from types import SimpleNamespace as NS

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import health as H  # noqa: E402

now = time.time()
ok_all = []


def check(name, cond, extra=""):
    print(f"{'PASS' if cond else 'FAIL'}  {name} {extra}")
    ok_all.append(bool(cond))


def src(age, fps, status="live"):
    return NS(t=now - age if age is not None else 0, fps=fps, status=status)


roles = {"front": "road_front", "seat": "road_rear", "rear": "security"}
good = {"front": src(0.05, 30), "seat": src(0.05, 30), "rear": src(0.1, 12)}
perf = {"aiHz": 8, "latencyMs": 150}
road = {"ok": True, "hz": 5}
mcu = NS(connected=True, gps={"fix": True})

h, al, stale = H.health(good, roles, "ride", now - 0.1, perf, road, mcu, now)
check("all healthy: status ok, no system alerts", h["status"] == "ok" and not al and not stale)

bad = dict(good, seat=src(5.0, 0, "reconnecting (TimeoutError)"))
h, al, _ = H.health(bad, roles, "ride", now - 0.1, perf, road, mcu, now)
check("rear camera frozen -> 'no warnings from behind'", any("from behind" in a["text"] for a in al), [a["text"] for a in al])
check("... and status down", h["status"] == "down" and h["parts"]["seat"]["status"] == "down")

slow = dict(good, front=src(0.1, 4))
h, al, _ = H.health(slow, roles, "ride", now - 0.1, perf, road, mcu, now)
check("front camera at 4 fps -> degraded + 'warnings delayed'", any("delayed" in a["text"] for a in al))

h, al, stale = H.health(good, roles, "ride", now - 3.0, perf, road, mcu, now)
check("perception stopped -> stale (drop detections) + danger alert",
      stale and any(a["level"] == "danger" for a in al), [a["text"] for a in al])

h, al, _ = H.health(good, roles, "ride", now - 0.1, {"aiHz": 2, "latencyMs": 900}, road, mcu, now)
check("overloaded -> caution 'warnings delayed'", any(a["level"] == "caution" and "overloaded" in a["text"] for a in al))

h, al, _ = H.health(good, roles, "ride", now - 0.1, perf, road, NS(connected=False, gps=None), now)
check("STM32 lost -> reported", h["parts"]["mcu"]["status"] == "down" and any("Ring" in a["text"] for a in al))

h, al, _ = H.health(dict(good, rear=src(9, 0, "gone")), roles, "security", None, {}, None, mcu, now)
check("park mode: security camera down -> reported", any("Security camera" in a["text"] for a in al))

print(f"\n{sum(ok_all)}/{len(ok_all)} checks pass")
sys.exit(0 if all(ok_all) else 1)
