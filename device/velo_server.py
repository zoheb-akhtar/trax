#!/usr/bin/env python3
"""
Velo device server (starter).

Speaks the API the phone app expects (see docs/device-api.md) with made-up
data, so the app can be tested without hardware. Runs on a laptop today and on
the Arduino UNO Q's Linux side later. Swap in the real pieces one at a time at
the three places marked REPLACE:

  1. read_frame()        -> the real camera picture
  2. detect()            -> the real vision model's output
  3. arm() / silence()   -> messages to the microcontroller (IMU, buzzer, LEDs)

Run:   python3 velo_server.py            (then point the app at <this-ip>:8000)
Fake a theft:  press Enter in this terminal, or  curl -X POST localhost:8000/debug/tamper
Fake a close pass:  curl -X POST localhost:8000/debug/car
Fake a pothole:     curl -X POST localhost:8000/debug/pothole
"""

from __future__ import annotations

import argparse
import io
import json
import math
import random
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

try:
    from PIL import Image, ImageDraw

    HAVE_PIL = True
except ImportError:  # /state still works; /stream returns 503
    HAVE_PIL = False

FRAME_W, FRAME_H = 640, 480
STREAM_FPS = 10
SIM_HZ = 10

# --- Camera geometry. Keep in step with src/device/geometry.ts in the app. ----------
H_FOV_DEG, V_FOV_DEG = 62.2, 48.8  # Raspberry Pi Camera Module 2 (IMX219)
FX = 0.5 / math.tan(math.radians(H_FOV_DEG) / 2)
FY = 0.5 / math.tan(math.radians(V_FOV_DEG) / 2)
CAMERA_HEIGHT_M = 1.0
SIZES = {"car": (1.5, 1.8), "person": (1.7, 0.5), "bicycle": (1.6, 0.6)}  # label -> (height m, width m)


def to_box(label: str, x: float, z: float):
    """World position (x right, -z ahead, metres) -> (camera, [x, y, w, h]) or None."""
    distance = abs(z)
    if distance < 1.2:
        return None  # alongside the bike: neither camera sees it
    camera = "front" if z < 0 else "rear"
    lateral = -x if camera == "rear" else x
    height, width = SIZES.get(label, (1.5, 1.0))
    h = height * FY / distance
    w = width * FX / distance
    cx = 0.5 + lateral * FX / distance
    cy = 0.5 + (CAMERA_HEIGHT_M - height / 2) * FY / distance
    if cx + w / 2 < 0 or cx - w / 2 > 1:
        return None
    return camera, [cx - w / 2, cy - h / 2, w, h]


# REPLACE: the real device reports its GPS module's fix here. This is 300 Massachusetts Ave, Boston.
START_POSITION = (42.3430, -71.0858)


# ---- REPLACE 4: the speaker -----------------------------------------------------------
# What the bike says to whoever is next to it the moment it is moved while armed. The real
# board must play this by itself, with the buzzer, without waiting for the phone.
TAMPER_WARNING = (
    "This bike is alarmed. You are being recorded, and the owner has been alerted. "
    "Please step away from the bike."
)


class Speaker:
    """The bike's speaker. Real version: a text-to-speech engine (espeak-ng, or piper for a
    nicer voice) and an audio player (ffplay or aplay) driving the amplifier.

    This one prints what it would say. With --speak, on a Mac, it says it out loud too.
    """

    def __init__(self) -> None:
        self.out_loud = False
        self.current: subprocess.Popen | None = None
        self.lock = threading.Lock()

    def _run(self, command: list[str], urgent: bool) -> None:
        with self.lock:
            if urgent and self.current and self.current.poll() is None:
                self.current.terminate()  # urgent lines cut off whatever is playing
            elif self.current and self.current.poll() is None:
                self.current.wait()  # routine lines wait their turn
            self.current = subprocess.Popen(command)

    def say(self, text: str, urgent: bool) -> None:
        print(f"[speaker] {'URGENT ' if urgent else ''}{text}", flush=True)
        if self.out_loud and shutil.which("say"):
            threading.Thread(target=self._run, args=(["say", text], urgent), daemon=True).start()

    def play(self, audio: bytes) -> None:
        print(f"[speaker] playing the owner's voice ({len(audio)} bytes)", flush=True)
        if self.out_loud and shutil.which("afplay"):
            path = os.path.join(tempfile.gettempdir(), "velo-owner-voice.m4a")
            with open(path, "wb") as file:
                file.write(audio)
            threading.Thread(target=self._run, args=(["afplay", path], True), daemon=True).start()


SPEAKER = Speaker()


class Device:
    """Everything the app can see or change. One instance, shared by all threads."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.mode = "ride"
        self.alarm = False
        self.battery = 82.0
        self.speed_kmh = 0.0
        # Where the "bike" is. While the alarm sounds it drifts away, as if being carried off.
        self.lat, self.lon = START_POSITION
        self.events: list[dict] = []
        self.detections: list[dict] = []
        self.started = time.time()
        self._next_id = 1
        # Simulated traffic:
        # [id, label, x, z, speed along z (m/s), respawn z, leave z, extra respawn distance]
        # The first car passes close enough to count as a close pass, so it comes round only
        # every minute or two; the rest keep the scene busy without setting off warnings.
        self._tracks = [
            [self._new_id(), "car", -2.0, 22.0, -4.0, 150.0, -45.0, 500.0],
            [self._new_id(), "car", -5.5, -10.0, -7.0, 35.0, -60.0, 25.0],
            [self._new_id(), "bicycle", -0.9, 14.0, -1.6, 60.0, -38.0, 120.0],  # a cyclist overtaking
            [self._new_id(), "person", 2.4, -30.0, 6.0, -35.0, 12.0, 25.0],
        ]

    def _new_id(self) -> int:
        self._next_id += 1
        return self._next_id - 1

    # ---- REPLACE 2: the real vision model -------------------------------------------
    def detect(self, dt: float) -> list[dict]:
        """Return this moment's detections.

        Real version: run the model on the latest frame from each camera and return
        one dict per object: id (stable while you track it), label, confidence,
        box [x, y, w, h] as fractions of the frame, and camera ("front"/"rear").
        Labels the app understands: car, truck, bus, motorcycle, bicycle, person.
        Report other cyclists as "bicycle" (the COCO class name).
        """
        out = []
        for t in self._tracks:
            t[3] += t[4] * dt
            passed = t[3] < t[6] if t[4] < 0 else t[3] > t[6]
            if passed:
                t[0] = self._new_id()
                t[3] = t[5] + random.random() * t[7] * (1 if t[5] >= 0 else -1)
            seen = to_box(t[1], t[2], t[3])
            if seen:
                camera, box = seen
                out.append(
                    {"id": t[0], "label": t[1], "confidence": 0.9, "box": box, "camera": camera}
                )
        return out

    def detect_parked(self, elapsed: float) -> list[dict]:
        """While parked: what the front camera sees at a bike rack.

        Real version: keep running the model while armed (a frame every few seconds is
        enough) so the app can count the other bikes at the rack and people passing. The app
        turns this into anonymous parking data: how full racks get, and for how long.
        """
        # Other bikes locked up beside this one; one arrives and leaves every so often.
        slots = [(-1.6, -3.0), (-0.8, -3.2), (0.0, -3.4), (0.8, -3.2), (1.6, -3.0), (2.4, -3.6)]
        present = 3 + int((math.sin(elapsed / 40) + 1) * 1.5)  # 3 to 6 bikes
        out = []
        for i, (x, z) in enumerate(slots[:present]):
            seen = to_box("bicycle", x, z)
            if seen:
                camera, box = seen
                out.append({"id": 9000 + i, "label": "bicycle", "confidence": 0.85, "box": box, "camera": camera})
        # Now and then someone walks past the rack.
        if int(elapsed / 15) % 3 == 0:
            seen = to_box("person", 3.0 - (elapsed % 15) * 0.4, -6.0)
            if seen:
                camera, box = seen
                out.append({"id": 9100 + int(elapsed / 45), "label": "person", "confidence": 0.9, "box": box, "camera": camera})
        return out

    def summon_car(self) -> None:
        """Testing only: brings the close-passing car up behind the bike now."""
        with self.lock:
            self._tracks[0][0] = self._new_id()
            self._tracks[0][3] = 28.0

    # ---- REPLACE 3: the microcontroller (IMU, buzzer, LEDs) -------------------------
    def arm(self, armed: bool) -> None:
        """Real version: tell the microcontroller to start/stop watching the IMU."""
        print(f"[mcu] {'ARM' if armed else 'DISARM'}")

    def silence(self) -> None:
        """Real version: tell the microcontroller to stop the buzzer."""
        print("[mcu] SILENCE")

    def tamper(self) -> None:
        """Call this when the microcontroller reports the bike was moved."""
        with self.lock:
            if self.mode != "security":
                self.mode = "security"
                self.arm(True)
            self.alarm = True
            now = int(time.time() * 1000)
            self.events.insert(0, {"id": f"evt-{now}", "kind": "tamper", "ts": now})
            del self.events[20:]
        print("[event] bike moved -> alarm on")
        SPEAKER.say(TAMPER_WARNING, urgent=True)

    def crash(self) -> None:
        """Call this when the IMU sees a fall while riding (a hard jolt, then the bike on its side)."""
        with self.lock:
            now = int(time.time() * 1000)
            self.events.insert(0, {"id": f"evt-{now}", "kind": "crash", "ts": now})
            del self.events[20:]
        print("[event] crash detected")

    def pothole(self, severity: float | None = None) -> None:
        """Call this when the IMU feels a sharp jolt while riding.

        Real version (on the microcontroller): read the MPU6050's vertical acceleration
        at 100 Hz or more. While the bike is moving, a spike more than ~0.8 g beyond normal
        gravity, lasting under 0.2 s, is a pothole or kerb. Report the peak as "severity" (g),
        with the GPS position, and wait ~2 s before reporting another so one hole counts once.
        A spike followed by the bike staying tilted over is a crash instead (see crash()).
        """
        with self.lock:
            now = int(time.time() * 1000)
            g = round(severity if severity is not None else 1.0 + random.random() * 1.5, 2)
            self.events.insert(
                0,
                {
                    "id": f"bump-{now}",
                    "kind": "pothole",
                    "ts": now,
                    "severity": g,
                    "position": {"lat": self.lat, "lon": self.lon},
                },
            )
            del self.events[20:]
        print(f"[event] pothole ({g} g)")

    # ---- Called by the HTTP handlers -------------------------------------------------
    def set_mode(self, mode: str) -> None:
        with self.lock:
            self.mode = mode
            if mode == "ride":
                self.alarm = False
            # Arming or disarming means the owner is with the bike: the pretend theft is over,
            # so the bike is back where it started.
            self.lat, self.lon = START_POSITION
        self.arm(mode == "security")

    def set_alarm(self, active: bool) -> None:
        with self.lock:
            self.alarm = active
        if not active:
            self.silence()

    def snapshot(self) -> dict:
        with self.lock:
            return {
                "mode": self.mode,
                "alarm": self.alarm,
                "battery": round(self.battery, 1),
                "speedKmh": round(self.speed_kmh, 1),
                "position": {"lat": round(self.lat, 6), "lon": round(self.lon, 6)},
                "speaker": True,
                "cameras": ["front", "rear"],
                "detections": list(self.detections),
                "events": list(self.events),
            }

    def run(self) -> None:
        """Background loop: keeps detections, speed and battery up to date."""
        dt = 1 / SIM_HZ
        next_bump = time.time() + 40 + random.random() * 50
        while True:
            if self.mode == "ride" and time.time() > next_bump:
                self.pothole()  # now and then the road is rough
                next_bump = time.time() + 40 + random.random() * 50
            elapsed = time.time() - self.started
            riding = self.mode == "ride"
            detections = self.detect(dt) if riding else self.detect_parked(elapsed)
            with self.lock:
                self.detections = detections
                self.speed_kmh = 22 + math.sin(elapsed / 3) * 4 if riding else 0.0
                self.battery = max(5.0, 82 - elapsed / 120)
                if self.alarm and self.mode == "security":
                    # About 1.5 m/s to the north-east: someone walking off with the bike.
                    self.lat += 1.0e-5 * dt
                    self.lon += 1.0e-5 * dt
            time.sleep(dt)


DEVICE = Device()


# ---- REPLACE 1: the real camera -----------------------------------------------------
def read_frame(camera: str) -> bytes:
    """Return one JPEG-encoded frame for "front" or "rear".

    Real version, with OpenCV:
        ok, frame = capture[camera].read()
        ok, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
        return jpeg.tobytes()

    This placeholder draws a plain road and a block wherever a simulated object
    is, so you can check the app's boxes land on the right spot.
    """
    image = Image.new("RGB", (FRAME_W, FRAME_H), (27, 36, 52))
    draw = ImageDraw.Draw(image)
    draw.rectangle([0, FRAME_H // 2, FRAME_W, FRAME_H], fill=(44, 47, 54))
    for d in DEVICE.snapshot()["detections"]:
        if d["camera"] != camera:
            continue
        x, y, w, h = d["box"]
        colour = {"car": (150, 156, 166), "bicycle": (61, 214, 163)}.get(d["label"], (120, 150, 200))
        draw.rectangle(
            [x * FRAME_W, y * FRAME_H, (x + w) * FRAME_W, (y + h) * FRAME_H], fill=colour
        )
    draw.text((12, 10), f"TEST PICTURE  {camera.upper()}  {time.strftime('%H:%M:%S')}", fill=(255, 255, 255))
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=70)
    return buffer.getvalue()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # keep the terminal for events, not every poll
        if self.command == "POST":
            super().log_message(fmt, *args)

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _json(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        self.wfile.write(data)

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            parsed = json.loads(self.rfile.read(length))
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self._cors()
        self.end_headers()

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/state":
            self._json(200, DEVICE.snapshot())
        elif url.path == "/snapshot":
            camera = parse_qs(url.query).get("camera", ["front"])[0]
            self._snapshot("rear" if camera == "rear" else "front")
        elif url.path == "/stream":
            camera = parse_qs(url.query).get("camera", ["front"])[0]
            self._stream("rear" if camera == "rear" else "front")
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        url = urlparse(self.path)
        if url.path == "/play":  # a recording of the owner's voice, played at the bike
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            if not 0 < length <= 5_000_000:
                return self._json(413, {"error": "recording missing or too large"})
            SPEAKER.play(self.rfile.read(length))
            return self._json(200, {"ok": True})
        body = self._body()
        if url.path == "/mode":
            mode = body.get("mode")
            if mode not in ("ride", "security"):
                return self._json(400, {"error": 'mode must be "ride" or "security"'})
            DEVICE.set_mode(mode)
            self._json(200, {"ok": True})
        elif url.path == "/alarm":
            DEVICE.set_alarm(bool(body.get("active")))
            self._json(200, {"ok": True})
        elif url.path == "/say":
            text = str(body.get("text") or "").strip()[:300]
            if not text:
                return self._json(400, {"error": "text is required"})
            SPEAKER.say(text, bool(body.get("urgent")))
            self._json(200, {"ok": True})
        elif url.path == "/chirp":
            print("[mcu] CHIRP")  # REPLACE: a short beep and LED flash, to find the bike
            self._json(200, {"ok": True})
        elif url.path == "/debug/crash":  # testing only: remove on the real device
            DEVICE.crash()
            self._json(200, {"ok": True})
        elif url.path == "/debug/pothole":  # testing only: the bike hits a pothole
            DEVICE.pothole(2.2)
            self._json(200, {"ok": True})
        elif url.path == "/debug/car":  # testing only: a car comes up close behind
            DEVICE.summon_car()
            self._json(200, {"ok": True})
        elif url.path == "/debug/tamper":  # testing only: remove on the real device
            DEVICE.tamper()
            self._json(200, {"ok": True})
        else:
            self._json(404, {"error": "not found"})

    def _snapshot(self, camera: str) -> None:
        """One still picture. The app saves these for its ride history."""
        if not HAVE_PIL:
            return self._json(503, {"error": "no camera source: pip install pillow"})
        jpeg = read_frame(camera)
        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(jpeg)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        self.wfile.write(jpeg)

    def _stream(self, camera: str) -> None:
        if not HAVE_PIL:
            return self._json(503, {"error": "no camera source: pip install pillow"})
        self.send_response(200)
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self._cors()
        self.end_headers()
        try:
            while True:
                jpeg = read_frame(camera)
                self.wfile.write(
                    b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                    + str(len(jpeg)).encode()
                    + b"\r\n\r\n"
                    + jpeg
                    + b"\r\n"
                )
                time.sleep(1 / STREAM_FPS)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the app closed the stream
        self.close_connection = True


def lan_addresses() -> list[str]:
    found = set()
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))  # no packet is sent; just picks the outgoing interface
            found.add(s.getsockname()[0])
    except OSError:
        pass
    return sorted(found)


def wait_for_enter() -> None:
    """Press Enter in the terminal to pretend someone moved the bike."""
    try:
        for _ in sys.stdin:
            DEVICE.tamper()
    except (OSError, ValueError):
        pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Velo device server (starter)")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--speak", action="store_true",
                        help="say the bike's lines out loud on this Mac, as if it were the speaker")
    args = parser.parse_args()
    SPEAKER.out_loud = args.speak

    threading.Thread(target=DEVICE.run, daemon=True).start()
    if sys.stdin and sys.stdin.isatty():
        threading.Thread(target=wait_for_enter, daemon=True).start()

    server = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    server.daemon_threads = True
    print(f"Velo device server on port {args.port}")
    for address in lan_addresses():
        print(f"  In the app's Device tab, enter:  {address}:{args.port}")
    print(f"  From the iOS simulator on this Mac:   localhost:{args.port}")
    if not HAVE_PIL:
        print("  Pillow not installed: /stream is off (pip install -r requirements.txt)")
    print("  Press Enter here to fake someone moving the bike.")
    print("  Speaker: " + ("out loud on this Mac" if args.speak else "printed here (add --speak to hear it)"))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
