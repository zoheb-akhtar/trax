#!/usr/bin/env python3
"""Velo camera server: streams camera frames as MJPEG over HTTP.

On the Arduino UNO Q (Linux) it captures the IMX219 through libcamera (Python bindings).
On a Mac (or any machine with a webcam) it can capture a webcam through OpenCV,
so the full pipeline can be tested without the board.

    UNO Q:  python3 uno_q_camera.py
    Mac:    python uno_q_camera.py --source 0 --port 5055

Endpoints:
    /               simple viewer page
    /stream         MJPEG stream (open this in mac_preview.py)
    /snapshot.jpg   latest single frame
"""

import argparse
import glob
import os
import re
import platform
import subprocess
import sys
import threading
import time

from flask import Flask, Response

SOI = b"\xff\xd8"  # JPEG start-of-image
EOI = b"\xff\xd9"  # JPEG end-of-image


class FrameBuffer:
    """Holds the most recent JPEG and wakes up waiting clients when a new one lands."""

    def __init__(self):
        self.jpeg = None
        self.count = 0
        self.cond = threading.Condition()

    def put(self, jpeg):
        with self.cond:
            self.jpeg = jpeg
            self.count += 1
            self.cond.notify_all()

    def wait_next(self, last_count, timeout=5.0):
        with self.cond:
            self.cond.wait_for(lambda: self.count != last_count, timeout=timeout)
            return self.jpeg, self.count


def limit_sensor_fps(cam_index, measured_fps, target_fps):
    """Stretch the IMX219 frame time via its vertical_blanking control (v4l2-ctl).
    libcamera's simple pipeline exposes no frame-rate control on this board."""
    import glob

    subdevs = sorted(
        "/dev/" + os.path.basename(d) for d in glob.glob("/sys/class/video4linux/v4l-subdev*")
        if "imx219" in open(os.path.join(d, "name")).read()
    )
    if cam_index >= len(subdevs) or measured_fps <= target_fps * 1.1:
        return
    dev = subdevs[cam_index]
    try:
        get = lambda args: subprocess.run(["v4l2-ctl", "-d", dev, *args],
                                          capture_output=True, text=True, check=True).stdout
        vblank = int(get(["--get-ctrl", "vertical_blanking"]).split(":")[1])
        height = int(get(["--get-subdev-fmt", "0"]).split("Width/Height")[1].split("/")[1].split()[0])
        new_vblank = int((height + vblank) * measured_fps / target_fps) - height
        get(["--set-ctrl", f"vertical_blanking={new_vblank}"])
        print(f"[camera] sensor {measured_fps:.0f} -> {target_fps} fps ({dev} vblank {vblank} -> {new_vblank})",
              flush=True)
    except Exception as e:
        print(f"[camera] could not limit sensor fps ({e}); install v4l-utils", flush=True)


def make_enhancer(contrast, saturation):
    """Cheap color fix-up for the software ISP (it has no color-correction matrix, so
    images come out flat). Contrast = S-curve LUT, saturation = blend away from gray."""
    import cv2
    import numpy as np

    x = np.arange(256) / 255.0
    curve = x + contrast * (x - 0.5) * (1 - np.abs(2 * x - 1))  # gentle S-curve, fixed ends
    lut = np.clip(curve * 255, 0, 255).astype(np.uint8)
    luma = np.array([0.114, 0.587, 0.299], np.float32)  # B, G, R weights
    sat_matrix = (saturation * np.eye(3) + (1 - saturation) * np.outer(np.ones(3), luma)).astype(np.float32)

    def enhance(img):
        if contrast:
            img = cv2.LUT(img, lut)
        if saturation != 1.0:
            img = cv2.transform(img, sat_matrix)  # one pass, ~3x faster than gray blending
        return img

    return enhance


# IMX219 full-field-of-view mode (2x2 binned). Smaller modes like 640x480 are a center
# crop, which looks zoomed in, so we always capture this and downscale.
SENSOR_FULL_FOV = (1640, 1232)


def capture_libcamera(buf, cam_index, width, height, fps, quality, enhance):
    """UNO Q path: libcamera Python bindings (software ISP gives color + auto exposure).
    Captures the full sensor view, downscales to width x height, JPEG-encodes at `fps`."""
    import mmap
    import selectors

    import cv2
    import libcamera as lc
    import numpy as np

    cm = lc.CameraManager.singleton()
    if cam_index >= len(cm.cameras):
        sys.exit(f"[camera] camera {cam_index} not found ({len(cm.cameras)} detected); "
                 "enable it with: sudo arduino-linux-config hw enable media-carrier camera0=type1-2lanes")
    cam = cm.cameras[cam_index]
    cam.acquire()
    cfg = cam.generate_configuration([lc.StreamRole.Viewfinder])
    sc = cfg.at(0)
    # libcamera/DRM "RGB888" is stored B,G,R in memory = OpenCV's native order.
    # ("BGR888" is R,G,B in memory and made everything look color-swapped.)
    sc.pixel_format = lc.PixelFormat("RGB888")
    sc.size = lc.Size(*SENSOR_FULL_FOV)
    sc.buffer_count = 4
    cfg.validate()  # adjusts to what the ISP can do (1632x1232)
    cam.configure(cfg)
    w, h, stride = sc.size.width, sc.size.height, sc.stride
    print(f"[camera] libcamera {cam.id} -> {w}x{h}, output {width}x{height}", flush=True)

    stream = sc.stream
    alloc = lc.FrameBufferAllocator(cam)
    alloc.allocate(stream)
    reqs = []
    for i, fb in enumerate(alloc.buffers(stream)):
        r = cam.create_request(i)
        r.add_buffer(stream, fb)
        reqs.append(r)
    cam.start()
    for r in reqs:
        cam.queue_request(r)

    sel = selectors.DefaultSelector()
    sel.register(cm.event_fd, selectors.EVENT_READ)
    maps = {}
    params = [int(cv2.IMWRITE_JPEG_QUALITY), quality]
    interval, next_t = 1.0 / fps, 0.0
    t_start, n_frames, slowed = time.time(), 0, False
    while True:
        sel.select(2)
        for req in cm.get_ready_requests():
            now = time.time()
            n_frames += 1
            if not slowed and now - t_start > 2.0:
                # The ISP debayers every sensor frame, so slow the sensor itself to `fps`
                # instead of throwing frames away (halves CPU at 15 fps).
                slowed = True
                limit_sensor_fps(cam_index, n_frames / (now - t_start), fps)
            if now >= next_t - 0.3 * interval:
                next_t = max(next_t + interval, now - interval)
                p = req.buffers[stream].planes[0]
                key = (p.fd, p.offset)
                if key not in maps:
                    maps[key] = mmap.mmap(p.fd, p.offset + p.length, mmap.MAP_SHARED, mmap.PROT_READ)
                img = np.frombuffer(maps[key], np.uint8, count=stride * h, offset=p.offset)
                img = img.reshape(h, stride)[:, :w * 3].reshape(h, w, 3)
                img = enhance(cv2.resize(img, (width, height), interpolation=cv2.INTER_AREA))
                ok, jpg = cv2.imencode(".jpg", img, params)
                if ok:
                    buf.put(jpg.tobytes())
            req.reuse()
            cam.queue_request(req)


# ---------------------------------------------------------------------------------------
# Raw path (default on the UNO Q): our own small ISP on raw Bayer frames from V4L2.
# libcamera's software ISP maxes the analog gain (noisy, washed out) and costs ~1.5 cores;
# this path controls exposure itself and does the color work in cheap LUT/YCrCb steps.
# ---------------------------------------------------------------------------------------
V4L2_CID = {"exposure": 0x00980911, "vertical_blanking": 0x009E0901,
            "analogue_gain": 0x009E0903, "digital_gain": 0x009F0905}
VIDIOC_S_CTRL, VIDIOC_G_CTRL = 0xC008561C, 0xC008561B


class SensorControls:
    """Set IMX219 controls on its V4L2 subdev with ioctls (fast enough to call per frame)."""

    def __init__(self, path):
        import fcntl
        import struct

        self._fcntl, self._struct = fcntl, struct
        self.fd = os.open(path, os.O_RDWR)

    def get(self, name):
        arg = bytearray(self._struct.pack("Ii", V4L2_CID[name], 0))
        self._fcntl.ioctl(self.fd, VIDIOC_G_CTRL, arg)
        return self._struct.unpack("Ii", arg)[1]

    def set(self, name, value):
        self._fcntl.ioctl(self.fd, VIDIOC_S_CTRL, bytearray(self._struct.pack("Ii", V4L2_CID[name], int(value))))


def find_v4l(name_prefix, kind="video"):
    for d in sorted(os.listdir("/sys/class/video4linux")):
        if d.startswith(kind) and not (kind == "video" and d.startswith("v4l")):
            with open(f"/sys/class/video4linux/{d}/name") as f:
                if f.read().strip().startswith(name_prefix):
                    return "/dev/" + d
    return None


# Sensor flips shift which color sits at the top-left pixel: (hflip, vflip) -> Bayer order
BAYER_ORDER = {(0, 0): "RGGB", (1, 0): "GRBG", (0, 1): "GBRG", (1, 1): "BGGR"}
FOURCC = {"RGGB": "RGGB", "GRBG": "GRBG", "GBRG": "GBRG", "BGGR": "BA81"}


def setup_raw_pipeline(cam_index, width, height, hflip=0, vflip=0):
    """Route sensor -> csiphyN -> csidN -> vfeN_rdi0 as 8-bit Bayer and return device paths."""
    out = subprocess.run(["media-ctl", "-d", "/dev/media0", "-p"], capture_output=True, text=True).stdout
    sensor = None
    for block in out.split("- entity")[1:]:
        title = block.split("(")[0].split(":", 1)[1].strip()
        if title.startswith("imx219") and f'"msm_csiphy{cam_index}"' in block:
            sensor = title
    if sensor is None:
        sys.exit(f"[camera] no imx219 linked to csiphy{cam_index}; enable it with "
                 f"sudo arduino-linux-config hw enable media-carrier camera{cam_index}=type1-2lanes")
    subdev = find_v4l(sensor, kind="v4l-subdev")
    subprocess.run(["v4l2-ctl", "-d", subdev, "--set-ctrl",
                    f"horizontal_flip={int(hflip)},vertical_flip={int(vflip)}"], check=True)
    fmt = f"S{BAYER_ORDER[(int(hflip), int(vflip))]}8_1X8/{width}x{height}"
    n = cam_index
    cmds = [
        ["-l", f'"msm_csiphy{n}":1->"msm_csid{n}":0[1]'],
        ["-l", f'"msm_csid{n}":1->"msm_vfe{n}_rdi0":0[1]'],
        ["-V", f'"{sensor}":0[fmt:{fmt}]'],
        ["-V", f'"msm_csiphy{n}":0[fmt:{fmt}]'],
        ["-V", f'"msm_csid{n}":0[fmt:{fmt}]'],
        ["-V", f'"msm_vfe{n}_rdi0":0[fmt:{fmt}]'],
    ]
    for c in cmds:
        subprocess.run(["media-ctl", "-d", "/dev/media0", *c], check=True)
    return sensor, find_v4l(f"msm_vfe{n}_video0"), subdev


def srgb(x):
    import numpy as np
    return np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(np.maximum(x, 0.0031308), 1 / 2.4) - 0.055)


def _die_with_parent():
    """Child gets SIGKILL when the server exits, so v4l2-ctl never keeps the camera busy."""
    import ctypes
    import signal
    ctypes.CDLL("libc.so.6", use_errno=True).prctl(1, signal.SIGKILL)  # PR_SET_PDEATHSIG


def capture_raw(buf, cam_index, out_w, out_h, fps, quality, opts):
    import cv2
    import numpy as np

    W, H, BLACK = 1640, 1232, 16  # IMX219 full-view binned mode; black level 64/1023 -> 16/255
    cv2.setNumThreads(1)  # parallelism comes from our workers; nested OpenCV pools just spin
    hf, vf = int(opts.get("hflip", 0)), int(opts.get("vflip", 0))
    sensor, video, subdev = setup_raw_pipeline(cam_index, W, H, hf, vf)
    order = BAYER_ORDER[(hf, vf)]
    # (row, col) of each color in the 2x2 cell; flips move R/B and the two greens
    POS = {"R": (vf, hf), "G1": (vf, 1 - hf), "G2": (1 - vf, hf), "B": (1 - vf, 1 - hf)}
    color_at = {v: k[0] for k, v in POS.items()}  # (row, col) -> "R"/"G"/"B"
    # OpenCV names Bayer codes by the 2nd-row 2nd/3rd pixels: RGGB->BG, GRBG->GB, GBRG->GR, BGGR->RG
    BAYER2GRAY = {"RGGB": cv2.COLOR_BayerBG2GRAY, "GRBG": cv2.COLOR_BayerGB2GRAY,
                  "GBRG": cv2.COLOR_BayerGR2GRAY, "BGGR": cv2.COLOR_BayerRG2GRAY}[order]
    idx = {k: 2 * r + c for k, (r, c) in POS.items()}  # channel index across the two row views
    MIX = [idx["B"], 0, idx["G1"], 1, idx["R"], 2]
    ctl = SensorControls(subdev)

    # Frame timing: frame_length lines at line_time each. Pick vblank for the target fps.
    pixel_rate = int(subprocess.run(["v4l2-ctl", "-d", subdev, "--get-ctrl", "pixel_rate"],
                                    capture_output=True, text=True).stdout.split(":")[1])
    hblank = int(subprocess.run(["v4l2-ctl", "-d", subdev, "--get-ctrl", "horizontal_blanking"],
                                capture_output=True, text=True).stdout.split(":")[1])
    line_time = (W + hblank) / pixel_rate
    frame_len = int(1.0 / (fps * line_time))
    ctl.set("vertical_blanking", frame_len - H)
    max_exp = frame_len - 4
    if opts.get("max_exposure_ms"):  # short shutter = no motion blur; gain makes up the light
        max_exp = min(max_exp, max(1, int(opts["max_exposure_ms"] / 1000 / line_time)))
    flicker_lines = (1.0 / opts["flicker_hz"]) / line_time if opts["flicker_hz"] else 0
    # Half-res output: each RGGB cell becomes one RGB pixel directly (sharp, no demosaic),
    # about 1/3 of the full-res CPU cost.
    binned = out_w <= W // 2 and out_h <= H // 2
    print(f"[camera] raw {sensor} via {video}: {W}x{H} @ {fps} fps -> {out_w}x{out_h}"
          f"{' (binned)' if binned else ''}, {order}{' hflip' if hf else ''}{' vflip' if vf else ''}, "
          f"{opts['workers']} workers", flush=True)

    # Auto exposure / white balance state (updated by the capture thread).
    state = {"exp": 2000.0, "gain": 1.0, "wb": np.array([1.6, 1.0, 1.8]), "lut": None, "lut_key": None}
    x = np.arange(256, dtype=np.float64)
    contrast = opts["contrast"]

    def build_lut(wb):
        """Two 2-channel LUTs for the raw Bayer rows: (R, G) on even rows, (G, B) on odd rows.
        Each: subtract black level, white-balance gain, sRGB gamma, gentle S-curve."""
        def curve(gain):
            lin = np.clip((x - BLACK) / (255 - BLACK) * gain, 0, 1)
            y = srgb(lin)
            y = y + contrast * (y - 0.5) * (1 - np.abs(2 * y - 1))
            return np.clip(y * 255 + 0.5, 0, 255).astype(np.uint8)
        c = {"R": curve(wb[0]), "G": curve(wb[1]), "B": curve(wb[2])}
        rows = [np.stack([c[color_at[(row, 0)]], c[color_at[(row, 1)]]], -1).reshape(256, 1, 2)
                for row in (0, 1)]
        return rows[0], rows[1], c["R"], c["G"], c["B"]

    s = opts["saturation"]
    import simplejpeg  # libjpeg-turbo; encodes straight from Y/Cb/Cr planes

    # Saturation as y = s*x + 128*(1-s) on the Cb/Cr planes (cheap arithmetic, no LUT).
    sat_beta = 128.0 * (1.0 - s)

    def auto_exposure_and_wb(raw):
        # one RGGB cell from every 8x8 block -> 205x154 samples per color
        r, g1, g2, b = (raw[i::8, j::8].astype(np.float32) - BLACK for i, j in (POS[k] for k in ("R", "G1", "G2", "B")))
        g = (g1 + g2) * 0.5
        # AE on green, ignoring clipped highlights so lamps don't darken everything
        lum = float(np.clip(g, 0, 239 - BLACK).mean()) / (255 - BLACK)
        lum = max(lum, 1e-3)
        total = state["exp"] * state["gain"] * (opts["ae_target"] / lum) ** 0.5  # damped step
        total = min(max(total, 4.0), max_exp * 10.6)
        exp = min(total, max_exp)
        if flicker_lines and exp > flicker_lines:  # whole flicker periods -> no banding
            exp = max(flicker_lines, (exp // flicker_lines) * flicker_lines)
        gain = min(max(total / exp, 1.0), 10.6)
        state["exp"], state["gain"] = exp, gain
        ctl.set("exposure", exp)
        ctl.set("analogue_gain", 256 - 256 / gain)
        # Gray-world AWB on mid-tones only, heavily smoothed
        mask = (g > 8) & (g < 200)
        if mask.sum() > 200:
            rm, gm, bm = r[mask].mean(), g[mask].mean(), b[mask].mean()
            target = np.clip(np.array([gm / max(rm, 1), 1.0, gm / max(bm, 1)]), 0.5, 4.0)
            state["wb"] = state["wb"] * 0.9 + target * 0.1
        key = tuple(np.round(state["wb"], 2))
        if key != state["lut_key"]:
            state["lut"], state["lut_key"] = build_lut(state["wb"]), key

    def process(raw):
        """Full res, ~60 ms of CPU per frame on the UNO Q (single thread):
        raw LUT -> luma at full res, chroma at half res (JPEG 4:2:0 stores it that way
        anyway) -> encode the planes directly, skipping every full-res color conversion."""
        if binned:
            return process_binned(raw)
        lut_rg, lut_gb = state["lut"][:2]
        rl = np.empty_like(raw)
        q_in, q_out = raw.reshape(H // 2, 2, W // 2, 2), rl.reshape(H // 2, 2, W // 2, 2)
        cv2.LUT(q_in[:, 0], lut_rg, dst=q_out[:, 0])  # even rows (R G R G ... when unflipped)
        cv2.LUT(q_in[:, 1], lut_gb, dst=q_out[:, 1])  # odd rows  (G B G B ...)
        y = cv2.cvtColor(rl, BAYER2GRAY)
        small = np.empty((H // 2, W // 2, 3), np.uint8)  # one BGR pixel per RGGB cell
        cv2.mixChannels([q_out[:, 0], q_out[:, 1]], [small], MIX)
        _, cr, cb = cv2.split(cv2.cvtColor(small, cv2.COLOR_BGR2YCrCb))
        if s != 1.0:  # color correction: the IMX219's raw colors are muted
            cr = cv2.addWeighted(cr, s, cr, 0, sat_beta)
            cb = cv2.addWeighted(cb, s, cb, 0, sat_beta)
        if (out_w, out_h) != (W, H):
            y = cv2.resize(y, (out_w, out_h), interpolation=cv2.INTER_AREA)
            cr = cv2.resize(cr, (out_w // 2, out_h // 2), interpolation=cv2.INTER_AREA)
            cb = cv2.resize(cb, (out_w // 2, out_h // 2), interpolation=cv2.INTER_AREA)
        return simplejpeg.encode_jpeg_yuv_planes(y, cb, cr, quality=quality)

    def process_binned(raw):
        _, _, lr, lg, lb = state["lut"]
        q = raw.reshape(H // 2, 2, W // 2, 2)
        plane = {k: cv2.extractChannel(q[:, r], c) for k, (r, c) in POS.items()}
        g = cv2.addWeighted(plane["G1"], 0.5, plane["G2"], 0.5, 0)
        bgr = cv2.merge([cv2.LUT(plane["B"], lb), cv2.LUT(g, lg), cv2.LUT(plane["R"], lr)])
        if (out_w, out_h) != (W // 2, H // 2):
            bgr = cv2.resize(bgr, (out_w, out_h), interpolation=cv2.INTER_AREA)
        y, cr, cb = cv2.split(cv2.cvtColor(bgr, cv2.COLOR_BGR2YCrCb))  # full-range, like JPEG
        cr = cv2.resize(cr, (out_w // 2, out_h // 2), interpolation=cv2.INTER_AREA)
        cb = cv2.resize(cb, (out_w // 2, out_h // 2), interpolation=cv2.INTER_AREA)
        if s != 1.0:
            cr = cv2.addWeighted(cr, s, cr, 0, sat_beta)
            cb = cv2.addWeighted(cb, s, cb, 0, sat_beta)
        return simplejpeg.encode_jpeg_yuv_planes(y, cb, cr, quality=quality)

    # Workers pull the newest raw frame, so slow encoding drops frames instead of adding lag.
    # Each frame is claimed by exactly one worker (no duplicate encodes).
    latest = {"raw": None, "seq": 0, "claimed": 0}
    cond = threading.Condition()
    published = {"seq": 0}

    def worker():
        while True:
            with cond:
                cond.wait_for(lambda: latest["seq"] > latest["claimed"])
                raw, seq = latest["raw"], latest["seq"]
                latest["claimed"] = seq
            jpg = process(raw)
            with cond:
                if jpg and seq > published["seq"]:
                    published["seq"] = seq
                    published["count"] = published.get("count", 0) + 1
                    buf.put(jpg)

    for _ in range(opts["workers"]):
        threading.Thread(target=worker, daemon=True).start()

    frame_bytes = W * H
    cmd = ["v4l2-ctl", "-d", video, f"--set-fmt-video=width={W},height={H},pixelformat={FOURCC[order]}",
           "--stream-mmap=4", "--stream-to=-"]
    while True:
        subprocess.run(["pkill", "-f", f"v4l2-ctl -d {video} "], check=False)  # stale capture holds the device
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0,
                                preexec_fn=_die_with_parent)
        seq = 0
        stats = {"t": time.time(), "seq": 0, "out": published.get("count", 0)}
        while True:
            data = bytearray(frame_bytes)
            view, got = memoryview(data), 0
            while got < frame_bytes:
                n = proc.stdout.readinto(view[got:])
                if not n:
                    break
                got += n
            if got < frame_bytes:
                break
            raw = np.frombuffer(data, np.uint8).reshape(H, W)
            seq += 1
            now = time.time()
            if now - stats["t"] >= 10:
                dt, out = now - stats["t"], published.get("count", 0)
                wb = state["wb"]
                print(f"[camera] sensor {(seq - stats['seq']) / dt:.1f} fps, sent {(out - stats['out']) / dt:.1f} fps, "
                      f"exposure {state['exp'] * line_time * 1000:.1f} ms, gain {state['gain']:.1f}x, "
                      f"wb R{wb[0]:.2f} B{wb[2]:.2f}", flush=True)
                stats.update(t=now, seq=seq, out=out)
            if seq % 2 == 0 or state["lut"] is None:
                auto_exposure_and_wb(raw)
            with cond:
                latest["raw"], latest["seq"] = raw, latest["seq"] + 1
                cond.notify()
        proc.kill()
        print("[camera] raw stream ended; restarting in 1s", flush=True)
        time.sleep(1)


def capture_gstreamer(buf, width, height, fps, quality):
    """Alternative path: gst-launch writes back-to-back JPEGs to stdout; split them on SOI/EOI.
    (libcamerasrc 0.4 on the UNO Q currently delivers no frames; kept for newer images.)"""
    cmd = [
        "gst-launch-1.0", "-q",
        "libcamerasrc", "!",
        f"video/x-raw,width={width},height={height},framerate={fps}/1", "!",
        "videoconvert", "!",
        "jpegenc", f"quality={quality}", "!",
        "fdsink", "fd=1",
    ]
    while True:
        print("[camera] starting:", " ".join(cmd), flush=True)
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, bufsize=0)
        data = b""
        while True:
            chunk = proc.stdout.read(65536)
            if not chunk:
                break
            data += chunk
            while True:
                start = data.find(SOI)
                if start < 0:
                    data = b""
                    break
                end = data.find(EOI, start + 2)
                if end < 0:
                    data = data[start:]
                    break
                buf.put(data[start:end + 2])
                data = data[end + 2:]
        proc.wait()
        print(f"[camera] gstreamer exited ({proc.returncode}); restarting in 2s", flush=True)
        time.sleep(2)


def find_usb_webcam():
    """/dev/videoN of the first USB (UVC) webcam that can stream MJPEG, or None."""
    for d in sorted(glob.glob("/sys/class/video4linux/video*"), key=lambda p: int(re.sub(r"\D", "", p) or 0)):
        try:
            if os.path.basename(os.path.realpath(f"{d}/device/driver")) != "uvcvideo":
                continue
        except OSError:
            continue
        dev = "/dev/" + os.path.basename(d)
        fmts = subprocess.run(["v4l2-ctl", "-d", dev, "--list-formats"], capture_output=True, text=True).stdout
        if "MJPG" in fmts:
            return dev
    return None


def capture_usb(buf, device, width, height, fps):
    """USB webcam (e.g. the seat camera): the webcam already compresses to JPEG, so its frames are
    passed straight through. No decode or encode on the board: almost no CPU."""
    while True:
        dev = device or find_usb_webcam()
        if not dev:
            print("[camera] no USB webcam found; retrying in 3s", flush=True)
            time.sleep(3)
            continue
        subprocess.run(["pkill", "-f", f"v4l2-ctl -d {dev} "])
        subprocess.run(["v4l2-ctl", "-d", dev, f"--set-fmt-video=width={width},height={height},pixelformat=MJPG",
                        f"--set-parm={fps}"], capture_output=True)
        # keep the frame rate steady: by default UVC webcams slow down in dim light to expose longer
        for ctl in ("exposure_dynamic_framerate=0", "exposure_auto_priority=0"):
            subprocess.run(["v4l2-ctl", "-d", dev, "-c", ctl], capture_output=True)
        fmt = subprocess.run(["v4l2-ctl", "-d", dev, "--get-fmt-video"], capture_output=True, text=True).stdout
        print(f"[camera] USB webcam {dev}: " + " ".join(fmt.split()), flush=True)
        proc = subprocess.Popen(["v4l2-ctl", "-d", dev, "--stream-mmap=4", "--stream-to=-"],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, preexec_fn=_die_with_parent)
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
                buf.put(data[start:end + 2])
                data = data[end + 2:]
            if len(data) > 8_000_000:  # garbage without frame markers: resync
                data = b""
        proc.wait()
        print(f"[camera] USB webcam stream ended ({proc.returncode}); retrying in 2s", flush=True)
        time.sleep(2)


def capture_opencv(buf, index, width, height, fps, quality):
    """Webcam path (Mac/dev): OpenCV capture + JPEG encode."""
    import cv2

    cap = cv2.VideoCapture(index)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
    cap.set(cv2.CAP_PROP_FPS, fps)
    if not cap.isOpened():
        sys.exit(f"[camera] could not open webcam {index} "
                 "(on macOS, allow Camera access for your terminal app in System Settings)")
    print(f"[camera] webcam {index} opened", flush=True)
    params = [int(cv2.IMWRITE_JPEG_QUALITY), quality]
    while True:
        ok, frame = cap.read()
        if not ok:
            time.sleep(0.05)
            continue
        if frame.shape[1] != width or frame.shape[0] != height:
            frame = cv2.resize(frame, (width, height))
        ok, jpg = cv2.imencode(".jpg", frame, params)
        if ok:
            buf.put(jpg.tobytes())


PAGE = """<!doctype html><html><head><meta name=viewport content="width=device-width">
<title>Velo camera</title><style>body{margin:0;background:#111;display:grid;place-items:center;height:100vh}
img{max-width:100%;max-height:100vh}</style></head><body><img src="/stream"></body></html>"""


def make_app(buf):
    app = Flask(__name__)

    @app.route("/")
    def index():
        return PAGE

    @app.route("/stream")
    def stream():
        def gen():
            count = -1
            while True:
                jpeg, count = buf.wait_next(count)
                if jpeg is None:
                    continue
                yield (b"--frame\r\nContent-Type: image/jpeg\r\n"
                       b"Content-Length: " + str(len(jpeg)).encode() + b"\r\n\r\n" + jpeg + b"\r\n")

        return Response(gen(), mimetype="multipart/x-mixed-replace; boundary=frame")

    @app.route("/snapshot.jpg")
    def snapshot():
        jpeg, _ = buf.wait_next(-1, timeout=5)
        if jpeg is None:
            return "no frame yet", 503
        return Response(jpeg, mimetype="image/jpeg")

    return app


def main():
    on_linux = platform.system() == "Linux"
    p = argparse.ArgumentParser(description="Velo MJPEG camera server")
    p.add_argument("--source", default="raw" if on_linux else "0",
                   help="'raw' (UNO Q, own ISP), 'usb' (USB webcam, MJPEG passthrough), 'libcamera', "
                        "'gstreamer', or a webcam index like 0")
    p.add_argument("--device", default=None, help="usb: /dev/videoN (default: first USB webcam found)")
    p.add_argument("--camera", type=int, default=0, help="media-carrier camera (0 or 1)")
    p.add_argument("--width", type=int, default=None, help="output width (raw default 1640, full view)")
    p.add_argument("--height", type=int, default=None, help="output height (raw default 1232)")
    p.add_argument("--fps", type=int, default=30)
    p.add_argument("--quality", type=int, default=85, help="JPEG quality 1-100")
    p.add_argument("--contrast", type=float, default=0.12, help="S-curve strength, 0 = off")
    p.add_argument("--saturation", type=float, default=1.5,
                   help="color correction strength (the IMX219's raw colors are muted); 1.0 = none")
    p.add_argument("--ae-target", type=float, default=0.17, help="auto-exposure linear mid level")
    p.add_argument("--max-exposure-ms", type=float, default=0,
                   help="cap the shutter time (e.g. 17 for moving cars); 0 = up to one frame")
    p.add_argument("--flicker-hz", type=float, default=120, help="mains flicker (120 US, 100 EU, 0 off)")
    p.add_argument("--workers", type=int, default=3, help="raw: parallel encode threads")
    p.add_argument("--hflip", action="store_true", help="raw: mirror left-right (in the sensor, free)")
    p.add_argument("--vflip", action="store_true", help="raw: flip upside down (both = rotate 180)")
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--port", type=int, default=5000)
    a = p.parse_args()

    buf = FrameBuffer()
    if a.source == "raw":
        opts = {"contrast": a.contrast, "saturation": a.saturation, "ae_target": a.ae_target,
                "flicker_hz": a.flicker_hz, "workers": a.workers,
                "max_exposure_ms": a.max_exposure_ms, "hflip": a.hflip, "vflip": a.vflip}
        target, args = capture_raw, (buf, a.camera, a.width or 1640, a.height or 1232, a.fps, a.quality, opts)
    elif a.source == "libcamera":
        a.width, a.height = a.width or 816, a.height or 616
        enhance = make_enhancer(a.contrast, a.saturation)
        target, args = capture_libcamera, (buf, a.camera, a.width, a.height, a.fps, a.quality, enhance)
    elif a.source == "usb":
        target, args = capture_usb, (buf, a.device, a.width or 1280, a.height or 720, a.fps)
    elif a.source == "gstreamer":
        target, args = capture_gstreamer, (buf, a.width or 640, a.height or 480, a.fps, a.quality)
    else:
        target, args = capture_opencv, (buf, int(a.source), a.width or 1280, a.height or 720, a.fps, a.quality)
    threading.Thread(target=target, args=args, daemon=True).start()

    print(f"[server] http://<this-device-ip>:{a.port}/  (stream at /stream)", flush=True)
    make_app(buf).run(host=a.host, port=a.port, threaded=True)


if __name__ == "__main__":
    main()
