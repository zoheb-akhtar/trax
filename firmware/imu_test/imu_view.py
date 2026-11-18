#!/usr/bin/env python3
"""Live MPU6050 viewer in the browser.

Reads the readings the STM32 prints (imu_test.ino) from the board's USB serial port and shows
them at http://localhost:8090: a 3D board that tilts with the sensor, rotation speed, shake,
temperature and live graphs.

    python3 ~/trax/imu_test/imu_view.py

Needs the UNO Q on USB with imu_test.ino running. Close any other `cat /dev/cu.usbmodem*`
first: only one program can read the port at a time. Standard library only.
"""

import glob
import json
import os
import re
import subprocess
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8090
HERE = os.path.dirname(os.path.abspath(__file__))
NUM = re.compile(r"[-+]?\d+\.\d+")

latest = {"t": 0}
cond = threading.Condition()


def reader():
    while True:
        ports = glob.glob("/dev/cu.usbmodem*")
        if not ports:
            set_status("board not found: plug the UNO Q into this Mac by USB")
            time.sleep(1)
            continue
        try:
            subprocess.run(["stty", "-f", ports[0], "9600", "raw", "-echo"], check=True, capture_output=True)
            with open(ports[0], "rb", buffering=0) as f:
                set_status("waiting for readings...")
                buf = b""
                while True:
                    chunk = f.read(4096)
                    if not chunk:
                        time.sleep(0.01)
                        continue
                    buf += chunk
                    *lines, buf = buf.split(b"\n")
                    for line in lines:
                        text = line.decode(errors="ignore")
                        nums = NUM.findall(text)
                        if "|" in text and len(nums) == 7:
                            ax, ay, az, gx, gy, gz, temp = map(float, nums)
                            publish({"ax": ax, "ay": ay, "az": az, "gx": gx, "gy": gy, "gz": gz,
                                     "temp": temp, "t": time.time(), "status": "live"})
                        elif text.strip():
                            set_status(text.strip()[:120])
        except OSError as e:
            set_status(f"serial port error ({e.strerror}); is another program reading it?")
            time.sleep(1)


def set_status(s):
    publish({**latest, "status": s, "t": latest.get("t", 0)}, bump=False)


def publish(d, bump=True):
    global latest
    with cond:
        latest = d
        cond.notify_all()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == "/events":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            try:
                while True:
                    with cond:
                        cond.wait(timeout=1.0)
                        d = latest
                    self.wfile.write(f"data: {json.dumps(d)}\n\n".encode())
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                return
        else:
            body = open(os.path.join(HERE, "imu_view.html"), "rb").read()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)


if __name__ == "__main__":
    threading.Thread(target=reader, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    print(f"IMU viewer on http://localhost:{PORT}  (Ctrl+C to stop)", flush=True)
    if os.environ.get("NO_BROWSER") != "1":
        webbrowser.open(f"http://localhost:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
