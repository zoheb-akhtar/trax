"""Link to the STM32 running velo_mcu.ino, over the UNO Q's USB serial port, or over Wi-Fi.

With the USB cable in, it uses /dev/cu.usbmodem*. Without it (the board on its own charger, on
the same Wi-Fi), it connects to the board's sensor port instead: VELO_HOST (default
uno-q.local), port VELO_MCU_PORT (default 5010). The board serves that port with
board/velo-mcu.service (see board/README_MCU_WIFI.md).

    mcu = Mcu(on_event=print)       # finds /dev/cu.usbmodem*, reconnects by itself
    mcu.mode("park")                # MODE off|drive|park
    mcu.ring("intruder")            # RING off|drive|armed|motion|intruder|alarm
    mcu.threat(270, 3)              # drive: light the ring toward a hazard (bearing, level 0-3)
    mcu.imu, mcu.gps                # latest readings (dicts), mcu.connected

Only one program can use the serial port: close hw_diag / imu_view / gps_view first.
"""

from __future__ import annotations

import glob
import os
import socket
import subprocess
import termios
import threading
import time


WIFI_HOST = os.environ.get("VELO_HOST", "uno-q.local")
WIFI_PORT = int(os.environ.get("VELO_MCU_PORT", "5010"))


class Mcu:
    def __init__(self, on_event=None, port=None):
        self.on_event = on_event or (lambda kind, value: None)
        self.port = port
        self.fd = None
        self.over_wifi = False  # True when the link is the board's sensor port, not USB
        self.imu = None   # {"ax","ay","az","gx","gy","gz","t"}
        self.gps = None   # {"fix","sats","lat","lon","kmh","course","hdop","t"}
        self.hb = None    # {"mode","ring","imu","gps","up","t"}
        self.last_rx = 0.0
        self._want = {}   # last mode / ring / config sent, re-sent after a reconnect
        self._lock = threading.Lock()
        threading.Thread(target=self._run, daemon=True, name="mcu").start()

    # ---- commands -----------------------------------------------------------------------
    def send(self, line):
        fd = self.fd
        if fd is None:
            return False
        try:
            with self._lock:
                os.write(fd, (line + "\n").encode())
            return True
        except OSError:
            return False

    def mode(self, m):
        self._want["mode"] = f"MODE {m}"
        self._want.pop("ring", None)
        return self.send(f"MODE {m}")

    def ring(self, state):
        self._want["ring"] = f"RING {state}"
        return self.send(f"RING {state}")

    def threat(self, bearing_deg, level):
        return self.send(f"THREAT {int(bearing_deg) % 360} {int(level)}")

    def chirp(self):
        return self.send("CHIRP")

    def config(self, led0_deg=0, clockwise=True, brightness=0.12):
        self._want["led0"] = f"LED0 {int(led0_deg)} {1 if clockwise else 0}"
        self._want["bright"] = f"BRIGHT {int(max(0, min(1, brightness)) * 255)}"
        self.send(self._want["led0"])
        self.send(self._want["bright"])

    @property
    def connected(self):
        return time.time() - self.last_rx < 3.0

    def speed_mps(self):
        g = self.gps
        if g and g.get("fix") and time.time() - g["t"] < 3 and g["kmh"] is not None:
            # a parked GPS wanders at 0.5-2 km/h: call that stopped (no phantom distance or motion)
            return g["kmh"] / 3.6 if g["kmh"] >= 2.0 else 0.0
        return None

    def yaw_rate(self, axis="gz", sign=1.0):
        """Rotation rate about the vertical (rad/s, + = turning right). Axis/sign depend on how
        the IMU is mounted: set imu_yaw in velo_config.json."""
        i = self.imu
        if i and time.time() - i["t"] < 0.5:
            return sign * i[axis] * 3.14159265 / 180
        return None

    # ---- reader ---------------------------------------------------------------------------
    def _open(self):
        self.over_wifi = False
        ports = [self.port] if self.port else sorted(glob.glob("/dev/cu.usbmodem*"))
        for p in ports:
            try:
                subprocess.run(["stty", "-f", p, "9600", "raw", "-echo"], capture_output=True, timeout=5)
                fd = os.open(p, os.O_RDWR | os.O_NOCTTY)
                termios.tcflush(fd, termios.TCIFLUSH)
                return fd
            except OSError:
                continue
        # No USB cable: try the board's sensor port over Wi-Fi.
        try:
            sock = socket.create_connection((WIFI_HOST, WIFI_PORT), timeout=3)
            sock.settimeout(None)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
            self.over_wifi = True
            return sock.detach()  # a plain file descriptor: os.read / os.write work on it
        except OSError:
            return None

    def _run(self):
        while True:
            self.fd = self._open()
            if self.fd is None:
                time.sleep(2)
                continue
            for line in self._want.values():  # restore state after a reconnect
                self.send(line)
            buf = b""
            try:
                while True:
                    chunk = os.read(self.fd, 4096)
                    if not chunk:
                        if self.over_wifi:
                            break  # the board closed the connection: reconnect
                        time.sleep(0.01)
                        continue
                    buf += chunk
                    *lines, buf = buf.split(b"\n")
                    for raw in lines:
                        self._handle(raw.decode(errors="replace").strip())
            except OSError:
                pass
            try:
                os.close(self.fd)
            except OSError:
                pass
            self.fd = None
            time.sleep(1)

    def _handle(self, line):
        if not line:
            return
        now = time.time()
        p = line.split()
        try:
            if p[0] == "I" and len(p) == 7:
                v = [float(x) for x in p[1:]]
                self.imu = dict(zip(("ax", "ay", "az", "gx", "gy", "gz"), v), t=now)
            elif p[0] == "G" and len(p) == 8:
                num = lambda s: None if s == "-" else float(s)  # noqa: E731
                self.gps = {"fix": p[1] == "1", "sats": int(p[2]), "lat": num(p[3]), "lon": num(p[4]),
                            "kmh": num(p[5]), "course": num(p[6]), "hdop": num(p[7]), "t": now}
            elif p[0] == "E" and len(p) >= 3:
                self.on_event(p[1], float(p[2]))
            elif p[0] == "H" and len(p) >= 6:
                kv = dict(x.split("=") for x in p[3:] if "=" in x)
                self.hb = {"mode": p[1], "ring": p[2], "imu": kv.get("imu") == "1", "gps": kv.get("gps") == "1",
                           "up": int(kv.get("up", 0)), "t": now}
        except (ValueError, IndexError):
            return
        self.last_rx = now
