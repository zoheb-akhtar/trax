#!/usr/bin/env python3
"""Velo hardware diagnostic: one command, PASS/FAIL for every part, then live readings.

    python3 ~/velo/hw_diag/hw_diag.py              full test, then live monitor (Ctrl+C to stop)
    python3 ~/velo/hw_diag/hw_diag.py --no-live    full test only (exit code 1 if anything FAILs)
    python3 ~/velo/hw_diag/hw_diag.py --live       skip the restart, just watch live readings
    python3 ~/velo/hw_diag/hw_diag.py --flash      force a recompile of the STM32 sketch

What it does:
  1. STM32: compiles + uploads hw_diag.ino the first time (or when you edit it), otherwise just
     restarts it, so the boot self-test (IMU, GPS, NeoPixel colours) runs fresh every time.
  2. Linux: runs cam_check.py on the board while the STM32 self-test runs, so everything is
     exercised at the same time. Read-only: it watches the existing camera services.
  3. Prints a PASS / WARN / FAIL table, then live IMU + GPS readings and error counters.

Board on USB (adb) is required for the STM32 output. Standard library only. Only one program
can read the board's serial port at a time: close imu_view.py / gps_view.py first.
"""

import argparse
import glob
import hashlib
import os
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, "out")
BIN = "~/hw_diag/build/hw_diag.ino.elf-zsk.bin"
RESTART = ("R=$(ls -d ~/.arduino15/packages/arduino/tools/remoteocd/*/ | head -1); "
           f"$R/remoteocd upload -a 0x80F0000 {BIN} 2>&1 | grep -iE 'error' || true")

LABELS = {
    "IMU": "IMU  MPU6050 (D20/D21)",
    "GPS": "GPS  NEO-6M (D0)",
    "NEOPIXEL": "LED  NeoPixel ring (D6)",
    "CAM_SENSORS": "CAM  IMX219 sensors",
    "CAM_FRONT": "CAM  front (CSI 0)",
    "CAM_BACK": "CAM  back (CSI 1)",
    "CAM_SEAT": "CAM  seat webcam (USB)",
    "CAM_KERNEL": "CAM  kernel log",
    "BOARD": "SYS  board health",
}
MCU_PARTS = ("IMU", "GPS", "NEOPIXEL")
TTY = sys.stdout.isatty()
C = {"PASS": "\033[32m", "WARN": "\033[33m", "FAIL": "\033[31m", "SKIP": "\033[90m", "B": "\033[1m", "0": "\033[0m"}
if not TTY:
    C = {k: "" for k in C}


def paint(status):
    return f"{C.get(status, '')}{status:<4}{C['0']}"


# ---------------------------------------------------------------- board access (adb, else ssh)
class Board:
    def __init__(self):
        self.ssh = None
        if subprocess.run(["adb", "get-state"], capture_output=True, text=True).stdout.strip() == "device":
            self.how = "USB"
            return
        host = os.environ.get("VELO_HOST", "uno-q.local")
        self.ssh = f"arduino@{host}"
        self.how = f"Wi-Fi ({host})"

    def run(self, cmd, timeout=120):
        argv = ["adb", "shell", cmd] if not self.ssh else ["ssh", "-o", "ConnectTimeout=5", self.ssh, cmd]
        return subprocess.run(argv, capture_output=True, text=True, timeout=timeout)

    def push(self, local, remote):
        argv = ["adb", "push", local, remote] if not self.ssh else ["scp", "-q", local, f"{self.ssh}:{remote}"]
        return subprocess.run(argv, capture_output=True, text=True).returncode == 0

    def pull(self, remote, local):
        argv = ["adb", "pull", remote, local] if not self.ssh else ["scp", "-q", f"{self.ssh}:{remote}", local]
        return subprocess.run(argv, capture_output=True, text=True).returncode == 0


# ---------------------------------------------------------------- STM32 serial reader
class Mcu(threading.Thread):
    def __init__(self, port):
        super().__init__(daemon=True)
        self.port = port
        self.results = {}
        self.live = None
        self.nmea = ""
        self.done = threading.Event()
        self.lines = 0
        self.echo = True  # print NEO colour lines as they happen

    def reset(self):
        self.results.clear()
        self.done.clear()

    def run(self):
        subprocess.run(["stty", "-f", self.port, "9600", "raw", "-echo"], capture_output=True)
        with open(self.port, "rb", buffering=0) as f:
            buf = b""
            while True:
                chunk = f.read(4096)
                if not chunk:
                    time.sleep(0.01)
                    continue
                buf += chunk
                *lines, buf = buf.split(b"\n")
                for raw in lines:
                    self.handle(raw.decode(errors="replace").strip())

    def handle(self, text):
        self.lines += 1
        if text.startswith("LIVE "):
            d = {}
            for part in text.split()[1:]:
                k, _, v = part.partition("=")
                try:
                    d[k] = float(v)
                except ValueError:
                    d[k] = None
            self.live = d
        elif text.startswith("NMEA "):
            self.nmea = text[5:]
        elif text.startswith("RESULT "):
            _, name, status, msg = (text.split(" ", 3) + [""])[:4]
            self.results[name] = (status, msg)
        elif text.startswith("NEO ") and self.echo:
            colour = text[4:]
            print(f"     ring: {colour.lower()}" + ("  (look at the ring now)" if colour == "RED" else ""), flush=True)
        elif text == "SELFTEST DONE":
            self.done.set()


def port_is_busy(port):
    out = subprocess.run(["lsof", "-t", port], capture_output=True, text=True).stdout.split()
    return [p for p in out if p != str(os.getpid())]


# ---------------------------------------------------------------- seat webcam on this Mac
def mac_webcam_check(seconds=6):
    """Grab the seat webcam on this Mac through board.webcam_jpegs, the exact capture velo_brain.py
    uses (full view, 1280x720). Returns (status, message), or None if no USB webcam is on the Mac."""
    sys.path.insert(0, ROOT)
    import board as B
    name = B.mac_usb_webcam()
    if not name:
        return None
    py = os.path.join(ROOT, ".venv", "bin", "python")
    script = f"""
import sys, time, json; sys.path.insert(0, {ROOT!r})
import board as B
s = {{"n": 0, "t0": None, "jpeg": b"", "sizes": [], "status": []}}
def on(j):
    s["t0"] = s["t0"] or time.time(); s["n"] += 1; s["jpeg"] = j; s["sizes"].append(len(j))
end = time.time() + 2 + {seconds}
B.webcam_jpegs({name!r}, on, s["status"].append, stop=lambda: time.time() > end)
if s["jpeg"]: open({os.path.join(OUT, "seat.jpg")!r}, "wb").write(s["jpeg"])
dt = time.time() - s["t0"] if s["t0"] else 0
print(json.dumps({{"fps": (s["n"] - 1) / dt if dt > 0 and s["n"] > 1 else 0, "kb": sum(s["sizes"]) / max(1, len(s["sizes"])) / 1024, "status": s["status"]}}))
"""
    os.makedirs(OUT, exist_ok=True)
    try:
        r = subprocess.run([py if os.path.exists(py) else "python3", "-c", script], capture_output=True, text=True, timeout=seconds + 40)
        d = __import__("json").loads(r.stdout.strip().splitlines()[-1])
    except Exception as e:  # noqa: BLE001
        return "FAIL", f"'{name}' capture failed: {e}"
    if d["fps"] <= 0:
        return "FAIL", f"'{name}' gave no frames ({'; '.join(d['status'])}). Camera permission for Terminal / VS Code?"
    msg = f"'{name}' on this Mac, full view 1280x720, {d['fps']:.1f} fps alongside the board cameras"
    if d["kb"] < 15:
        return "WARN", msg + f", but frames are tiny ({d['kb']:.0f} KB): lens covered or very dark?"
    if d["fps"] < 20:
        return "WARN", msg + ": slow (expected ~30), the USB hub may be sharing bandwidth"
    return "PASS", msg


# ---------------------------------------------------------------- live view
def bar(v, full, width=20):
    n = max(0, min(width, int(round(abs(v) / full * width))))
    return "█" * n + "·" * (width - n)


def live_view(mcu, seconds):
    import math
    print(f"\n{C['B']}LIVE{C['0']}  shake / tilt the IMU, move the GPS antenna. Ctrl+C to stop.")
    print("ring: green = level, blue LED = tilt direction, white flash = shake, red = IMU lost\n")
    t0 = time.time()
    first = None
    drawn = 0
    try:
        while seconds <= 0 or time.time() - t0 < seconds:
            d = mcu.live
            if not d:
                time.sleep(0.2)
                if time.time() - t0 > 8:
                    print("no live data from the STM32 (is hw_diag running? try --flash)")
                    return None, None
                continue
            first = first or dict(d)
            g = lambda k: d.get(k) or 0.0  # noqa: E731
            ax, ay, az = g("ax"), g("ay"), g("az")
            amag = math.sqrt(ax * ax + ay * ay + az * az)
            roll = math.degrees(math.atan2(ay, az))
            pitch = math.degrees(math.atan2(-ax, math.hypot(ay, az)))
            gmag = math.sqrt(g("gx") ** 2 + g("gy") ** 2 + g("gz") ** 2)
            if d.get("fix"):
                gps = f"{C['PASS']}{'3D' if d.get('mode') == 3 else '2D'} FIX{C['0']}  {g('lat'):.6f}, {g('lon'):.6f}  {g('spd'):.1f} km/h"
            else:
                gps = f"{C['WARN']}no fix{C['0']} (needs open sky)"
            age = g("age")
            gps_ok = age < 3000
            imu_ok = d.get("imu") == 1
            ierr = int(g("ierr") - first.get("ierr", 0))
            gbad = int(g("gbad") - first.get("gbad", 0))
            stable = imu_ok and gps_ok and ierr == 0 and gbad == 0
            rows = [
                f"IMU  {'ok ' if imu_ok else C['FAIL'] + 'LOST' + C['0']} accel x {ax:+5.2f}  y {ay:+5.2f}  z {az:+5.2f} g   |a| {amag:4.2f} g   temp {g('t'):4.1f} C",
                f"     tilt  roll {roll:+6.1f}°  pitch {pitch:+6.1f}°     shake {bar(g('peak') - 1, 2)} peak {g('peak'):4.2f} g",
                f"     gyro  x {g('gx'):+7.1f}  y {g('gy'):+7.1f}  z {g('gz'):+7.1f} °/s    spin {bar(gmag, 250)}",
                f"GPS  {gps}   sats used {int(g('sats'))} / {int(g('view'))} in view",
                f"     best signal {int(g('snr')):2d} dB {bar(g('snr'), 50)}   data {'flowing' if gps_ok else C['FAIL'] + 'STOPPED' + C['0']}",
                f"     {mcu.nmea[:90]}",
                f"HEALTH  imu read errors {ierr}   gps bad checksums {gbad}   uptime {int(g('up'))} s   "
                + (f"{C['PASS']}STABLE{C['0']}" if stable else f"{C['FAIL']}PROBLEM{C['0']}"),
            ]
            if TTY:
                if drawn:
                    sys.stdout.write(f"\033[{drawn}F")
                sys.stdout.write("".join(r + "\033[K\n" for r in rows))
                drawn = len(rows)
            elif time.time() - drawn >= 2:  # not a terminal: one plain line every 2 s
                drawn = time.time()
                print(" | ".join(r.strip() for r in (rows[0], rows[3], rows[6])))
            sys.stdout.flush()
            time.sleep(0.2)
    except KeyboardInterrupt:
        pass
    if not mcu.live or not first:
        return None, None
    d = mcu.live
    return int((d.get("ierr") or 0) - (first.get("ierr") or 0)), int((d.get("gbad") or 0) - (first.get("gbad") or 0))


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description="Velo hardware diagnostic")
    ap.add_argument("--flash", action="store_true", help="recompile + upload the STM32 sketch")
    ap.add_argument("--live", action="store_true", help="skip the self-test, only show live readings")
    ap.add_argument("--no-live", action="store_true", help="stop after the PASS/FAIL table")
    ap.add_argument("--no-cams", action="store_true", help="skip the camera check")
    ap.add_argument("--seconds", type=float, default=0, help="live view duration (0 = until Ctrl+C)")
    a = ap.parse_args()

    print(f"{C['B']}Velo hardware diagnostic{C['0']}")
    ports = sorted(glob.glob("/dev/cu.usbmodem*"))
    board = Board()
    if not ports and board.how == "USB":
        print("board on adb but no serial port: replug the USB cable")
    if board.run("true", timeout=15).returncode != 0:
        sys.exit("board not found: plug the UNO Q into this Mac by USB (or set VELO_HOST for Wi-Fi)")
    print(f"board: {board.how}")

    mcu = None
    if ports:
        busy = port_is_busy(ports[0])
        if busy:
            sys.exit(f"the board's serial port is in use by PID {', '.join(busy)} (imu_view.py / gps_view.py / cat?). Close it first.")
        mcu = Mcu(ports[0])
        mcu.start()
    else:
        print("no USB serial port: STM32 results need the board on USB. Running the camera check only.")

    if a.live:
        if not mcu:
            sys.exit("--live needs the board on USB")
        ierr, gbad = live_view(mcu, a.seconds)
        return

    # 1. STM32: recompile only if the sketch changed, otherwise restart it
    t_mcu = None
    if mcu:
        local = hashlib.md5(open(os.path.join(HERE, "hw_diag.ino"), "rb").read()).hexdigest()
        remote = board.run(f"md5sum ~/hw_diag/hw_diag.ino 2>/dev/null; test -f {BIN} && echo HAVE_BIN").stdout
        if a.flash or local not in remote or "HAVE_BIN" not in remote:
            print("\n[1/3] STM32: compiling + uploading hw_diag (about a minute)...")
            r = subprocess.run([os.path.join(ROOT, "flash_mcu.sh"), "hw_diag"], capture_output=True, text=True)
            if r.returncode != 0:
                sys.exit("compile/upload failed:\n" + r.stdout + r.stderr)
        else:
            print("\n[1/3] STM32: restarting hw_diag...")
            board.run(RESTART)
        mcu.reset()
        t_mcu = time.time()
        print("     self-test running: keep the IMU still for 5 s")

    # 2. Cameras, while the STM32 test runs
    cam_results = {}
    if not a.no_cams:
        print("[2/3] cameras: pulling every stream at once for 6 s...")
        seat = {}
        seat_t = threading.Thread(target=lambda: seat.update(r=mac_webcam_check()), daemon=True)
        seat_t.start()
        board.run("mkdir -p ~/hw_diag")
        board.push(os.path.join(HERE, "cam_check.py"), "/home/arduino/hw_diag/cam_check.py")
        out = board.run("python3 ~/hw_diag/cam_check.py", timeout=60).stdout
        for line in out.splitlines():
            if line.startswith("RESULT "):
                _, name, status, msg = (line.split(" ", 3) + [""])[:4]
                cam_results[name] = (status, msg)
        if not cam_results:
            cam_results["CAM_SENSORS"] = ("FAIL", "camera check didn't run: " + (out or "no output")[-200:])
        seat_t.join(30)
        if seat.get("r"):
            cam_results["CAM_SEAT"] = seat["r"]
        elif cam_results.get("CAM_SEAT", ("SKIP",))[0] == "SKIP":
            cam_results["CAM_SEAT"] = ("SKIP", "no USB webcam on this Mac or the board (optional)")
        os.makedirs(OUT, exist_ok=True)
        for name in ("CAM_FRONT", "CAM_BACK", "CAM_SEAT"):
            if cam_results.get(name, ("",))[0] in ("PASS", "WARN"):
                board.pull(f"/tmp/velo_hw_diag_{name}.jpg", os.path.join(OUT, f"{name.lower()[4:]}.jpg"))

    # 3. Wait for the STM32 results
    mcu_results = {}
    if mcu:
        print("[3/3] waiting for the STM32 self-test...")
        mcu.done.wait(max(1, 40 - (time.time() - t_mcu)))
        time.sleep(0.3)
        mcu.echo = False
        mcu_results = dict(mcu.results)
        for p in MCU_PARTS:
            if p not in mcu_results:
                mcu_results[p] = ("FAIL", "no result from the STM32 (sketch not running? try --flash)"
                                  if mcu.lines == 0 else "the STM32 didn't report this test")

    # table
    allres = {**mcu_results, **cam_results}
    print(f"\n{C['B']}{'PART':<26}RESULT  DETAILS{C['0']}")
    for key in LABELS:
        if key in allres:
            status, msg = allres[key]
            print(f"{LABELS[key]:<26}{paint(status)}    {msg}")
    fails = [k for k, (s, _) in allres.items() if s == "FAIL"]
    warns = [k for k, (s, _) in allres.items() if s == "WARN"]
    if any(k in cam_results for k in ("CAM_FRONT", "CAM_BACK")) and os.path.isdir(OUT):
        print(f"\ncamera frames saved: open {OUT}")
    if "NEOPIXEL" in mcu_results and mcu_results["NEOPIXEL"][0] == "PASS":
        print("ring: the STM32 can't see the LEDs. PASS means the signal is good; you confirm the colours by eye.")
    verdict = "FAIL" if fails else "WARN" if warns else "PASS"
    names = ", ".join(LABELS[k].split("  ", 1)[1] for k in fails + warns if k in LABELS)
    print(f"\n{C['B']}OVERALL{C['0']}  {paint(verdict)}  {names}".rstrip())

    if mcu and not a.no_live:
        ierr, gbad = live_view(mcu, a.seconds)
        if ierr is not None:
            ok = ierr == 0 and gbad == 0
            print(f"\nwhile live: {ierr} IMU read errors, {gbad} GPS bad checksums -> "
                  f"{paint('PASS' if ok else 'FAIL')} {'stable together' if ok else 'intermittent: check solder joints / loose wires'}")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
