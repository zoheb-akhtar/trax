"""Velo safety monitor: never fail silently.

A rider who trusts "nothing behind you" must be told when the rear camera is down. health()
checks every part of the chain each time /state is read and returns:
  * a per-component status (ok / degraded / down) with the reason
  * system alerts, at the top of the alert list, saying exactly which warnings are unavailable
    ("Rear camera offline: no warnings from behind")
  * stale = the perception loop has stopped: the caller must drop the old detections, so the app
    never shows a frozen "all clear"
"""

from __future__ import annotations

import time

# minimum frame rates for a camera's warnings to be trusted
MIN_FPS = {"road_front": 8.0, "road_rear": 8.0, "security": 2.0}
WHAT = {"road_front": "no warnings ahead", "road_rear": "no warnings from behind",
        "security": "no security camera"}
NAME = {"road_front": "Front camera", "road_rear": "Rear camera", "security": "Security camera"}


def health(sources, roles, mode, last_ai_t, perf, road_state, mcu, now=None, calibrated=None):
    now = now or time.time()
    parts, alerts = {}, []

    def system_alert(key, level, text):
        alerts.append({"id": f"system-{key}", "kind": "system", "level": level, "text": text,
                       "camera": "front", "trackId": -1, "side": None, "bearingDeg": None, "since": now})

    for cam, src in sources.items():
        role = roles.get(cam, "road_front")
        age = now - src.t if src.t else None
        if age is None or age > 2.0:
            parts[cam] = {"status": "down", "reason": src.status}
            if mode == "ride" and role.startswith("road") or mode == "security":
                system_alert(f"cam-{cam}", "caution", f"{NAME.get(role, cam)} offline: {WHAT.get(role, '')}")
        elif src.fps and src.fps < MIN_FPS.get(role, 5):
            parts[cam] = {"status": "degraded", "reason": f"{src.fps:.0f} fps"}
            if mode == "ride" and role.startswith("road"):
                system_alert(f"cam-{cam}", "info", f"{NAME.get(role, cam)} slow ({src.fps:.0f} fps): warnings delayed")
        else:
            parts[cam] = {"status": "ok", "fps": round(src.fps, 1)}
        if calibrated is not None and role.startswith("road"):
            # distances (and close-pass clearances) are only as good as the mount calibration
            parts[cam]["calibrated"] = calibrated.get(cam) or False

    stale = False
    if mode == "ride":
        ai_age = now - last_ai_t if last_ai_t else None
        if ai_age is None or ai_age > 1.0:
            stale = ai_age is not None
            parts["perception"] = {"status": "down", "reason": "not running" if ai_age is None
                                   else f"no update for {ai_age:.1f} s"}
            if ai_age is not None:
                system_alert("perception", "danger", "Velo warnings stopped: ride with care")
        elif perf.get("latencyMs", 0) > 600 or perf.get("aiHz", 99) < 3:
            parts["perception"] = {"status": "degraded",
                                   "reason": f"{perf.get('aiHz')} Hz, {perf.get('latencyMs')} ms behind"}
            system_alert("perception", "caution", "Velo is overloaded: warnings delayed")
        else:
            parts["perception"] = {"status": "ok", "hz": perf.get("aiHz"), "latencyMs": perf.get("latencyMs")}
        if road_state is not None:
            if not road_state.get("ok") or road_state.get("hz", 0) < 0.5:
                parts["road"] = {"status": "degraded", "reason": road_state.get("error") or "slow / not running"}
            else:
                parts["road"] = {"status": "ok", "hz": road_state.get("hz")}
    if mcu is not None:
        if not mcu.connected:
            parts["mcu"] = {"status": "down", "reason": "no data from the STM32"}
            system_alert("mcu", "info", "Ring and motion sensor offline" if mode == "ride"
                         else "Motion sensor offline: tamper detection by camera only")
        else:
            parts["mcu"] = {"status": "ok"}
            g = mcu.gps
            parts["gps"] = {"status": "ok" if g and g.get("fix") else "degraded",
                            "reason": None if g and g.get("fix") else "no fix: speed-based warnings limited"}
    worst = "ok"
    for p in parts.values():
        if p["status"] == "down":
            worst = "down"
        elif p["status"] == "degraded" and worst == "ok":
            worst = "degraded"
    return {"status": worst, "parts": parts}, alerts, stale
