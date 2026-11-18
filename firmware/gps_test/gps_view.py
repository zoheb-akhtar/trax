#!/usr/bin/env python3
"""Live NEO-6M GPS viewer in the browser.

Reads what gps_test.ino prints on the board's USB serial port and shows it at
http://localhost:8091: fix status, position on a map, speed, satellites with signal bars,
data health and the raw NMEA sentences.

    python3 ~/trax/gps_test/gps_view.py

Needs the UNO Q on USB with gps_test.ino running on the STM32 (../flash_mcu.sh gps_test).
Only one program can read the serial port at a time. Standard library only.
"""

import glob
import json
import os
import subprocess
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8091
HERE = os.path.dirname(os.path.abspath(__file__))

events = []          # (seq, dict), the last few hundred
seq = 0
cond = threading.Condition()


def push(d):
    global seq
    with cond:
        seq += 1
        events.append((seq, d))
        del events[:-400]
        cond.notify_all()


def parse_status(text):
    """'GPS fix=1 sats=7 lat=42.1 ...' -> dict with numbers where possible."""
    out = {}
    for part in text.split()[1:]:
        if "=" not in part:
            continue
        k, v = part.split("=", 1)
        if v == "-":
            out[k] = None
            continue
        if k in ("utc", "date"):  # keep leading zeros: 064501.00 is 06:45:01
            out[k] = v
            continue
        try:
            out[k] = int(v)
        except ValueError:
            try:
                out[k] = float(v)
            except ValueError:
                out[k] = v
    return out


def reader():
    last_state = None
    while True:
        ports = glob.glob("/dev/cu.usbmodem*")
        if not ports:
            if last_state != "noboard":
                push({"type": "link", "text": "board not found: plug the UNO Q into this Mac by USB"})
                last_state = "noboard"
            time.sleep(1)
            continue
        try:
            subprocess.run(["stty", "-f", ports[0], "9600", "raw", "-echo"], check=True, capture_output=True)
            with open(ports[0], "rb", buffering=0) as f:
                push({"type": "link", "text": "connected, waiting for the GPS sketch..."})
                last_state = "open"
                buf = b""
                while True:
                    chunk = f.read(4096)
                    if not chunk:
                        time.sleep(0.01)
                        continue
                    buf += chunk
                    *lines, buf = buf.split(b"\n")
                    for raw in lines:
                        text = raw.decode(errors="replace").strip()
                        if text.startswith("NMEA "):
                            push({"type": "nmea", "text": text[5:], "t": time.time()})
                        elif text.startswith("GPS-HINT "):
                            push({"type": "hint", "text": text[9:]})
                        elif text.startswith("GPS "):
                            push({"type": "status", **parse_status(text), "t": time.time()})
                        elif text:
                            push({"type": "other", "text": text[:200]})
        except OSError as e:
            push({"type": "link", "text": f"serial port error ({e.strerror}); is another program reading it?"})
            last_state = "error"
            time.sleep(1)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == "/events":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            with cond:
                mine = events[-60][0] - 1 if len(events) >= 60 else 0  # replay a little history
            try:
                while True:
                    with cond:
                        cond.wait_for(lambda: events and events[-1][0] > mine, timeout=15)
                        new = [(s, d) for s, d in events if s > mine]
                    if not new:
                        self.wfile.write(b": keepalive\n\n")
                    for s, d in new:
                        self.wfile.write(f"data: {json.dumps(d)}\n\n".encode())
                        mine = s
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                return
        else:
            body = open(os.path.join(HERE, "gps_view.html"), "rb").read()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)


if __name__ == "__main__":
    threading.Thread(target=reader, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    print(f"GPS viewer on http://localhost:{PORT}  (Ctrl+C to stop)", flush=True)
    if os.environ.get("NO_BROWSER") != "1":
        webbrowser.open(f"http://localhost:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
