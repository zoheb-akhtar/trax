#!/usr/bin/env python3
"""
Checks a Velo device server against what the phone app needs.

    python3 check_device.py 192.168.1.50:8000
    python3 check_device.py localhost:8000

Prints PASS / FAIL / WARN for each requirement in docs/firmware-guide.md. It needs
only Python's standard library, so it runs on a laptop or on the board itself.

It switches the device between ride and security mode and sounds the alarm for a
moment, then puts things back as it found them.
"""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request

TIMEOUT = 5
results: list[tuple[str, str, str]] = []


def record(level: str, name: str, detail: str = "") -> None:
    results.append((level, name, detail))
    print(f"  {level:4}  {name}" + (f"  ({detail})" if detail else ""))


def get(base: str, path: str):
    return urllib.request.urlopen(base + path, timeout=TIMEOUT)


def post(base: str, path: str, body: dict) -> int:
    request = urllib.request.Request(
        base + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
        return response.status


def state(base: str) -> dict:
    with get(base, "/state") as response:
        return json.loads(response.read())


def check(name: str, ok: bool, detail: str = "", warn_only: bool = False) -> bool:
    record("PASS" if ok else ("WARN" if warn_only else "FAIL"), name, "" if ok else detail)
    return ok


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    base = sys.argv[1].rstrip("/")
    if not base.startswith("http"):
        base = "http://" + base
    print(f"Checking {base}\n")

    # ---- /state ---------------------------------------------------------------------
    print("State")
    try:
        with get(base, "/state") as response:
            headers = response.headers
            first = json.loads(response.read())
    except Exception as error:  # noqa: BLE001 - report anything that stops us reaching it
        record("FAIL", "GET /state answers with JSON", str(error))
        print("\nThe app cannot connect at all. Check the address, the network and the server.")
        return 1
    record("PASS", "GET /state answers with JSON")
    check("allows cross-origin requests", headers.get("Access-Control-Allow-Origin") == "*",
          "add the header Access-Control-Allow-Origin: *", warn_only=True)
    check('mode is "ride" or "security"', first.get("mode") in ("ride", "security"),
          f"got {first.get('mode')!r}")
    check("alarm is true or false", isinstance(first.get("alarm"), bool), f"got {first.get('alarm')!r}")
    check("battery is a number 0-100", isinstance(first.get("battery"), (int, float))
          and 0 <= first["battery"] <= 100, "missing: the app shows a dash", warn_only=True)
    check("speedKmh is a number", isinstance(first.get("speedKmh"), (int, float)),
          "missing: the app shows a dash until GPS works", warn_only=True)
    cameras = first.get("cameras") or ["front"]
    check('cameras lists "front" and/or "rear"', all(c in ("front", "rear") for c in cameras),
          f"got {cameras!r}")

    started = time.time()
    for _ in range(8):
        state(base)
    per_request = (time.time() - started) / 8
    check("answers fast enough to be polled 4 times a second", per_request < 0.2,
          f"{per_request * 1000:.0f} ms each: detection is probably blocking the server")

    # ---- Detections -----------------------------------------------------------------
    print("\nDetections (put a car, person or bike in view first)")
    samples = []
    for _ in range(6):
        samples.append(state(base).get("detections") or [])
        time.sleep(0.3)
    seen = [d for sample in samples for d in sample]
    if not seen:
        record("WARN", "detections are reported", "none seen: ride features will show nothing")
    else:
        record("PASS", "detections are reported")
        known = {"car", "truck", "bus", "motorcycle", "bicycle", "person"}
        check("labels are ones the app understands", all(d.get("label") in known for d in seen),
              f"got {sorted({str(d.get('label')) for d in seen} - known)}", warn_only=True)
        boxes_ok = all(
            isinstance(d.get("box"), list) and len(d["box"]) == 4
            and all(isinstance(n, (int, float)) and -0.05 <= n <= 1.05 for n in d["box"])
            for d in seen
        )
        check("boxes are [x, y, width, height] as fractions 0-1", boxes_ok,
              "looks like pixels: divide by the frame width and height")
        check('each has camera "front" or "rear"', all(d.get("camera", "front") in ("front", "rear") for d in seen))
        ids = [{d.get("id") for d in sample} for sample in samples if sample]
        stable = len(ids) > 1 and all(None not in s for s in ids) and bool(set.intersection(*ids))
        check("ids stay the same from one reading to the next", stable,
              "no tracking: objects will flicker in the 3D view", warn_only=True)

    # ---- Camera ---------------------------------------------------------------------
    print("\nCamera")
    for camera in cameras:
        try:
            with get(base, f"/snapshot?camera={camera}") as response:
                data = response.read()
            check(f"GET /snapshot?camera={camera} returns a JPEG", data[:2] == b"\xff\xd8",
                  f"content type {response.headers.get('Content-Type')}")
        except Exception as error:  # noqa: BLE001
            record("FAIL", f"GET /snapshot?camera={camera} returns a JPEG", str(error))
        try:
            with get(base, f"/stream?camera={camera}") as response:
                kind = response.headers.get("Content-Type", "")
                chunk = response.read(60000)
            check(f"GET /stream?camera={camera} is MJPEG", "multipart/x-mixed-replace" in kind, f"content type {kind}")
            check(f"the {camera} stream carries JPEG frames", b"\xff\xd8" in chunk)
        except Exception as error:  # noqa: BLE001
            record("FAIL", f"GET /stream?camera={camera} is MJPEG", str(error))

    # ---- Mode and alarm -------------------------------------------------------------
    print("\nMode and alarm")
    original = first.get("mode", "ride")
    try:
        post(base, "/mode", {"mode": "security"})
        time.sleep(0.4)
        check("POST /mode security arms the device", state(base).get("mode") == "security")
        post(base, "/alarm", {"active": True})
        time.sleep(0.4)
        check("POST /alarm active:true sounds the alarm", state(base).get("alarm") is True,
              "needed for the app's Sound alarm button", warn_only=True)
        post(base, "/alarm", {"active": False})
        time.sleep(0.4)
        check("POST /alarm active:false silences it", state(base).get("alarm") is False)
        post(base, "/mode", {"mode": "ride"})
        time.sleep(0.4)
        after = state(base)
        check("POST /mode ride disarms the device", after.get("mode") == "ride")
        check("going back to ride clears the alarm", after.get("alarm") is False)
    except Exception as error:  # noqa: BLE001
        record("FAIL", "mode and alarm requests succeed", str(error))
    finally:
        try:
            post(base, "/alarm", {"active": False})
            post(base, "/mode", {"mode": original})
        except Exception:  # noqa: BLE001
            pass

    # ---- Events ---------------------------------------------------------------------
    print("\nEvents")
    events = state(base).get("events") or []
    if not events:
        record("WARN", "events are reported", "none yet: arm it, move the bike, run this again")
    else:
        record("PASS", "events are reported")
        check("each event has a unique id", len({e.get("id") for e in events}) == len(events))
        check('kind is "tamper", "motion" or "crash"', all(e.get("kind") in ("tamper", "motion", "crash") for e in events))
        check("ts is Unix time in milliseconds",
              all(isinstance(e.get("ts"), (int, float)) and e["ts"] > 1e12 for e in events),
              "looks like seconds: multiply by 1000")
        times = [e.get("ts", 0) for e in events]
        check("newest event first", times == sorted(times, reverse=True))

    fails = sum(1 for level, _, _ in results if level == "FAIL")
    warns = sum(1 for level, _, _ in results if level == "WARN")
    print(f"\n{len(results) - fails - warns} passed, {warns} warnings, {fails} failed")
    print("Not checked here: that the buzzer is audible, that moving the bike trips the alarm, "
          "and that the alarm works with the phone disconnected. See docs/firmware-guide.md.")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
