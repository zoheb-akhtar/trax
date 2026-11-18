"""Finds the Trax cameras, wherever they are plugged in. Used by trax_brain.py and mac_preview.py.

Board (front + back cameras, and the seat webcam when it hangs off the board):
  1. USB cable to this Mac  -> adb port forwards, localhost:5055-5057   (no network needed)
  2. Wi-Fi                  -> uno-q.local (or the last IP start.sh saw), ports 5000-5002
Re-checked every few seconds while a stream is down, so unplugging the cable and going over
Wi-Fi (or the other way round) recovers by itself. The camera servers on the board start at
boot (systemd), so nothing has to be launched on the board.

Seat webcam (USB webcam on the back of the seat): if it is plugged into this Mac, it is read
here at full field of view (1920x1080 sensor mode, 30 fps) through OpenCV, looked up by name
each time (OpenCV's camera numbers shift when an iPhone camera comes and goes); otherwise its
stream comes from the board.
"""

from __future__ import annotations

import os
import re
import socket
import subprocess
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
CAM_INDEX = {"front": 0, "rear": 1, "seat": 2}
HOSTNAME = os.environ.get("TRAX_HOST", "uno-q.local")


class Board:
    def __init__(self, recheck_s=3.0):
        self.recheck_s = recheck_s
        self.lock = threading.Lock()
        self.host, self.how, self.t = None, "searching", 0.0

    def url(self, cam):
        """Stream URL for a board camera, or None if the board can't be found right now."""
        with self.lock:
            if self.host is None or time.time() - self.t > self.recheck_s:
                self._find()
            if self.host is None:
                return None
            port = (5055 if self.host == "localhost" else 5000) + CAM_INDEX[cam]
            return f"http://{self.host}:{port}/stream"

    def found(self):
        """Call when a stream connected, so a working route isn't re-checked needlessly."""
        with self.lock:
            self.t = time.time() + 3600

    def _find(self):
        self.t = time.time()
        old = self.host
        if _adb_device():
            for i in range(3):
                subprocess.run(["adb", "forward", f"tcp:{5055 + i}", f"tcp:{5000 + i}"], capture_output=True)
            self.host, self.how = "localhost", "USB"
        else:
            ip = _resolve(HOSTNAME) or _last_ip()
            self.host, self.how = (ip, f"Wi-Fi {ip}") if ip else (None, "not found (USB or Wi-Fi)")
        if self.host != old:
            print(f"[board] {self.how}", flush=True)
            if self.host and self.host != "localhost":
                try:
                    with open(os.path.join(HERE, ".board"), "w") as f:
                        f.write(self.host)
                except OSError:
                    pass


def _adb_device():
    try:
        out = subprocess.run(["adb", "get-state"], capture_output=True, text=True, timeout=3)
        return out.stdout.strip() == "device"
    except (OSError, subprocess.TimeoutExpired):
        return False


def _resolve(name, timeout=2.0):
    """Hostname -> IP, giving up after `timeout` (a missing .local name can hang for seconds)."""
    box = []
    t = threading.Thread(target=lambda: box.append(_try(socket.gethostbyname, name)), daemon=True)
    t.start()
    t.join(timeout)
    return box[0] if box else None


def _try(fn, *a):
    try:
        return fn(*a)
    except OSError:
        return None


def _last_ip():
    """The board's last known Wi-Fi IP, if something answers there."""
    try:
        ip = open(os.path.join(HERE, ".board")).read().strip()
    except OSError:
        return None
    if not ip or ip == "localhost":
        return None
    try:
        with socket.create_connection((ip, 5000), timeout=1):
            return ip
    except OSError:
        return None


# ---- webcams on this Mac -----------------------------------------------------------------
BUILT_IN = re.compile(r"FaceTime|iPhone|iPad|Desk View|Capture screen|OBS|Virtual|Continuity", re.I)


def mac_cameras():
    """Video devices macOS sees, by name, in ffmpeg's order."""
    try:
        out = subprocess.run(["ffmpeg", "-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
                             capture_output=True, text=True, timeout=10).stderr
    except (OSError, subprocess.TimeoutExpired):
        return []
    video = out.split("audio devices")[0]
    return re.findall(r"\]\s+\[\d+\]\s+(.+)", video)


def mac_usb_webcam():
    """Name of a USB webcam plugged into this Mac (not the built-in or iPhone cameras), or None."""
    return next((n.strip() for n in mac_cameras() if not BUILT_IN.search(n)), None)


HERE = os.path.dirname(os.path.abspath(__file__))
CAMS_BIN = os.path.join(HERE, "tools", "mac_cams")


def opencv_index(name):
    """OpenCV camera number of the Mac camera called `name` (tools/mac_cams lists AVFoundation's
    order, which OpenCV uses), or None. Compiles the helper with swiftc the first time."""
    src = CAMS_BIN + ".swift"
    try:
        if not os.path.exists(CAMS_BIN) or os.path.getmtime(CAMS_BIN) < os.path.getmtime(src):
            subprocess.run(["swiftc", "-O", src, "-o", CAMS_BIN], capture_output=True, timeout=180)
        out = subprocess.run([CAMS_BIN], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    for line in out.splitlines():
        i, _, n = line.partition("\t")
        if n.strip() == name.strip():
            return int(i)
    return None


def webcam_jpegs(name, on_jpeg, on_status, width=1280, height=720, fps=30, stop=None):
    """Seat webcam on this Mac, full view and sharp: the sensor's 1920x1080 mode (the only one
    that isn't a cropped centre) at 30 fps through OpenCV (macOS decodes the webcam's MJPEG),
    scaled to width x height and passed to on_jpeg(bytes) as JPEGs. ffmpeg can't do this: above
    640x480 it only gets the webcam's slow raw modes (2-8 fps).
    The capture runs in a child process (OpenCV must open Mac cameras on a main thread), so this
    is safe to call from any thread. Runs until stop() is true, or forever; restarts on errors.
    Falls back to ffmpeg_jpegs (640x480, cropped) if OpenCV isn't installed."""
    import struct
    import sys
    try:
        import cv2  # noqa: F401  (only checking it's available to the child)
    except ImportError:
        return ffmpeg_jpegs(name, on_jpeg, on_status)
    while not (stop and stop()):
        proc = subprocess.Popen([sys.executable, os.path.abspath(__file__), "--webcam", name,
                                 str(width), str(height), str(fps)],
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        live = False
        try:
            while not (stop and stop()):
                head = proc.stdout.read(4)
                if len(head) < 4:
                    break
                jpeg = proc.stdout.read(struct.unpack(">I", head)[0])
                if not live:
                    on_status("live")
                    live = True
                on_jpeg(jpeg)
        finally:
            proc.kill()
            err = proc.stderr.read().decode(errors="replace").strip().splitlines()
            proc.wait()
        if not (stop and stop()):
            on_status(err[-1] if err else f"'{name}' stopped; retrying")
            time.sleep(2)


def _webcam_child(name, width, height, fps):
    """Child process of webcam_jpegs: capture on this main thread, write <4-byte length><jpeg>."""
    import struct
    import sys
    import cv2
    idx = opencv_index(name)
    if idx is None:
        sys.exit(f"'{name}' not found")
    cap = cv2.VideoCapture(idx, cv2.CAP_AVFOUNDATION)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1920)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 1080)
    cap.set(cv2.CAP_PROP_FPS, fps)
    if not cap.isOpened():
        sys.exit("cannot open the webcam (camera permission for Terminal / VS Code?)")
    out = sys.stdout.buffer
    fails = 0
    while fails < 60:
        ok, frame = cap.read()
        if not ok:
            fails += 1
            time.sleep(0.03)
            continue
        fails = 0
        if frame.shape[1] != width:
            frame = cv2.resize(frame, (width, height), interpolation=cv2.INTER_AREA)
        ok, jpg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
        if ok:
            out.write(struct.pack(">I", len(jpg)) + jpg.tobytes())
            out.flush()
    sys.exit("webcam stopped sending frames")


def ffmpeg_jpegs(name, on_jpeg, on_status, width=640, height=480, fps=30):
    """Webcam at 640x480: at 720p the Mac takes uncompressed video, which overruns the webcam's USB 2.0 link (~4 fps).
    640x480 is a steady 30 fps, 4:3 like the other cameras, and YOLO runs at 640 anyway.
    Reads a Mac camera by name and calls on_jpeg(bytes) for every frame. Runs forever
    (call it in a thread); restarts ffmpeg if the camera drops out."""
    while True:
        cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "avfoundation",
               "-framerate", str(fps), "-video_size", f"{width}x{height}", "-pixel_format", "nv12",
               "-i", f"{name}:none", "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "4", "-"]
        proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        on_status("live")
        data = b""
        while True:
            chunk = proc.stdout.read(65536)
            if not chunk:
                break
            data += chunk
            while True:
                start = data.find(b"\xff\xd8")
                end = data.find(b"\xff\xd9", start + 2) if start >= 0 else -1
                if end < 0:
                    break
                on_jpeg(data[start:end + 2])
                data = data[end + 2:]
        proc.wait()
        on_status(f"'{name}' stopped; retrying")
        time.sleep(2)


if __name__ == "__main__":
    import sys
    if len(sys.argv) == 6 and sys.argv[1] == "--webcam":
        try:
            _webcam_child(sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]))
        except BrokenPipeError:
            pass
