#!/usr/bin/env python3
"""Velo camera check, runs on the UNO Q's Linux side. Read-only.

It does not open the cameras itself, so it can't disturb the working pipeline: it watches the
running velo-front / velo-back (and optional velo-seat) services by pulling all their MJPEG
streams at the same time, exactly as the Velo app does. It also checks that both IMX219 sensors
are linked, and that the kernel logs no camera errors during the test.

    python3 ~/hw_diag/cam_check.py            (hw_diag.py on the Mac runs this for you)

Prints  RESULT <name> <PASS|WARN|FAIL|SKIP> <message>  lines. Saves one frame per camera to
/tmp/velo_hw_diag_<name>.jpg.
"""

import re
import subprocess
import threading
import time
import urllib.request

SECONDS = 6
CAMS = [  # result name, service, port, required
    ("CAM_FRONT", "velo-front", 5000, True),
    ("CAM_BACK", "velo-back", 5001, True),
    ("CAM_SEAT", "velo-seat", 5002, False),
]


def sh(cmd):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True).stdout


def result(name, status, msg):
    print(f"RESULT {name} {status} {msg}", flush=True)


def kernel_camera_errors():
    out = sh("dmesg 2>/dev/null")
    if not out:
        return None
    return [l for l in out.splitlines()
            if re.search(r"imx219|cci|csid|csiphy|vfe|camss", l, re.I)
            and re.search(r"error|fail|timeout|-110|-121", l, re.I)]


def sensors():
    """{csiphy index: entity name} for every IMX219 linked in the media graph (read-only query)."""
    out = sh("media-ctl -d /dev/media0 -p 2>/dev/null")
    found = {}
    for block in out.split("- entity")[1:]:
        title = block.split("(")[0].split(":", 1)[-1].strip()
        m = re.search(r'"msm_csiphy(\d)"', block)
        if title.startswith("imx219") and m:
            found[int(m.group(1))] = title
    return found


def grab(port, out):
    """Read the MJPEG stream for SECONDS, count frames, keep the last one."""
    out.update(frames=0, first=None, last_t=None, jpeg=None, error=None)
    t0 = time.time()
    try:
        r = urllib.request.urlopen(f"http://127.0.0.1:{port}/stream", timeout=5)
        buf = b""
        while time.time() - t0 < SECONDS:
            chunk = r.read(16384)
            if not chunk:
                break
            buf += chunk
            while True:
                i = buf.find(b"Content-Length: ")
                if i < 0:
                    buf = buf[-64:]
                    break
                j = buf.find(b"\r\n\r\n", i)
                if j < 0:
                    buf = buf[i:]
                    break
                n = int(buf[i + 16:j])
                if len(buf) < j + 4 + n:
                    buf = buf[i:]
                    break
                out["jpeg"] = buf[j + 4:j + 4 + n]
                buf = buf[j + 4 + n:]
                out["frames"] += 1
                now = time.time()
                out["first"] = out["first"] or now
                out["last_t"] = now
        r.close()
    except Exception as e:  # noqa: BLE001  (report any failure as text)
        out["error"] = str(e)


def image_stats(jpeg):
    try:
        import cv2
        import numpy as np
    except ImportError:
        return None
    img = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_GRAYSCALE)
    if img is None:
        return None
    return img.shape[1], img.shape[0], float(img.mean()), float(img.std())


def main():
    errs_before = kernel_camera_errors()
    found = sensors()
    if len(found) >= 2:
        result("CAM_SENSORS", "PASS", "2 IMX219 sensors linked: " +
               ", ".join(f"{v} on csiphy{k}" for k, v in sorted(found.items())))
    else:
        missing = [str(i) for i in (0, 1) if i not in found]
        result("CAM_SENSORS", "FAIL", f"IMX219 missing on CSI port {', '.join(missing)}: reseat that ribbon "
               "(contacts facing the right way, latch closed) and reboot the board")

    active = {}
    for name, svc, port, required in CAMS:
        state = sh(f"systemctl is-active {svc}").strip()
        if state == "active":
            active[name] = (svc, port, {})
        elif required:
            result(name, "FAIL", f"{svc} service is {state or 'missing'}: start the pipeline with ./start.sh on the Mac")
        else:
            result(name, "SKIP", f"{svc} not running (optional seat webcam)")

    threads = [threading.Thread(target=grab, args=(port, st)) for _, (_, port, st) in active.items()]
    for t in threads:
        t.start()
    for t in threads:
        t.join(SECONDS + 10)

    streaming = sum(1 for _, _, st in active.values() if st.get("frames"))
    together = f", {streaming} streams at once" if streaming > 1 else ""
    for name, (svc, port, st) in active.items():
        if not st.get("frames") and name == "CAM_SEAT":
            result(name, "SKIP", "velo-seat runs but sends no frames: seat webcam not plugged into the board (optional)")
            continue
        if st.get("error") and not st.get("frames"):
            result(name, "FAIL", f"{svc} is running but its stream on port {port} failed ({st['error']}). "
                   f"See: journalctl -u {svc} -n 30")
            continue
        if not st.get("frames"):
            result(name, "FAIL", f"{svc} is running but sent no frames in {SECONDS} s: the camera stalled. "
                   f"See: journalctl -u {svc} -n 30 (an imx219/CCI -110 error means a loose ribbon)")
            continue
        fps = (st["frames"] - 1) / (st["last_t"] - st["first"]) if st["frames"] > 1 else 0
        open(f"/tmp/velo_hw_diag_{name}.jpg", "wb").write(st["jpeg"])
        stats = image_stats(st["jpeg"])
        size = f"{stats[0]}x{stats[1]}, " if stats else ""
        msg = f"{size}{fps:.1f} fps{together}"
        if stats and stats[3] < 4:
            result(name, "WARN", f"{msg}, but the image is almost uniform (brightness {stats[2]:.0f}/255): "
                   "lens covered, very dark, or a dead sensor")
        elif fps < 5:
            result(name, "WARN", f"{msg}: slow (expected 10-30 fps). Board overloaded or too hot?")
        else:
            result(name, "PASS", f"{msg}, brightness {stats[2]:.0f}/255" if stats else msg)

    errs_after = kernel_camera_errors()
    new = None if errs_before is None or errs_after is None else errs_after[len(errs_before):]
    temps = [int(open(p).read()) / 1000 for p in sh("ls /sys/class/thermal/thermal_zone*/temp").split()]
    load = open("/proc/loadavg").read().split()[0]
    mem = re.search(r"MemAvailable:\s+(\d+)", open("/proc/meminfo").read())
    info = f"SoC {max(temps):.0f} C, load {load}, {int(mem.group(1)) // 1024} MB RAM free" if temps and mem else ""
    if new:
        result("CAM_KERNEL", "FAIL", f"kernel logged camera errors during the test: {new[-1][:150]}")
    elif new is None:
        result("CAM_KERNEL", "SKIP", "kernel log not readable")
    else:
        old = f" ({len(errs_before)} older ones since boot)" if errs_before else ""
        result("CAM_KERNEL", "PASS", f"no camera errors during the test{old}")
    hot = temps and max(temps) > 80
    result("BOARD", "WARN" if hot else "PASS", info + (": hot, add airflow before closing the enclosure" if hot else ""))


if __name__ == "__main__":
    main()
