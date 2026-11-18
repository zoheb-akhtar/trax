#!/usr/bin/env python3
"""Trax Mac preview: shows a live camera feed with optional YOLO object detection.

    python mac_preview.py                               # front + back + seat (board over USB or Wi-Fi)
    python mac_preview.py http://localhost:5055/stream  # one stream
    python mac_preview.py 0                             # Mac webcam directly

Keys:  D = toggle YOLO detection   Q / Esc = quit
"""

import argparse
import os
import threading
import time
import urllib.request

import cv2
import numpy as np

import board as B

HERE = os.path.dirname(os.path.abspath(__file__))


class MJPEGReader:
    """Reads an MJPEG HTTP stream in a background thread and keeps only the newest frame,
    so the preview never falls behind. Reconnects automatically."""

    def __init__(self, url, max_width=1280, name="front"):
        self.url, self.name = url, name
        self.max_width = max_width  # bigger JPEGs decode at half size: faster, plenty for display + YOLO
        self.flag = cv2.IMREAD_COLOR
        self.frame = None
        self.seq = 0
        self.status = "connecting..."
        self.lock = threading.Lock()
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        brd = self.url if isinstance(self.url, B.Board) else None
        while True:
            url = brd.url(self.name) if brd else self.url
            if url is None:
                self.status = "board not found: plug it in by USB, or same Wi-Fi"
                time.sleep(1)
                continue
            try:
                with urllib.request.urlopen(url, timeout=5) as resp:
                    self.status = "live"
                    if brd:
                        brd.found()
                    data = b""
                    while True:
                        chunk = resp.read(16384)
                        if not chunk:
                            break
                        data += chunk
                        end = data.rfind(b"\xff\xd9")
                        if end < 0:
                            continue
                        start = data.rfind(b"\xff\xd8", 0, end)
                        if start >= 0:
                            img = cv2.imdecode(np.frombuffer(data[start:end + 2], np.uint8), self.flag)
                            if img is not None and self.flag == cv2.IMREAD_COLOR and img.shape[1] > self.max_width:
                                self.flag = cv2.IMREAD_REDUCED_COLOR_2
                            if img is not None:
                                with self.lock:
                                    self.frame = img
                                    self.seq += 1
                        data = data[end + 2:]
            except Exception as e:
                self.status = f"reconnecting ({type(e).__name__})"
                time.sleep(1)

    def read(self):
        with self.lock:
            return self.frame, self.seq


class MacCameraReader(MJPEGReader):
    """A camera on this Mac by name (e.g. the seat webcam), via ffmpeg."""

    def __init__(self, device, max_width=1280):
        self.max_width, self.flag = max_width, cv2.IMREAD_COLOR
        self.frame, self.seq, self.status = None, 0, "connecting..."
        self.lock = threading.Lock()

        def on_jpeg(jpeg):
            img = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
            if img is not None:
                with self.lock:
                    self.frame = img
                    self.seq += 1

        def on_status(s):
            self.status = s

        threading.Thread(target=B.webcam_jpegs, args=(device, on_jpeg, on_status), daemon=True).start()


class WebcamReader:
    def __init__(self, index):
        self.cap = cv2.VideoCapture(index)
        if not self.cap.isOpened():
            raise SystemExit(f"could not open webcam {index} "
                             "(allow Camera access for your terminal in System Settings)")
        self.status = "live"
        self.seq = 0

    def read(self):
        ok, frame = self.cap.read()
        self.seq += ok
        return (frame if ok else None), self.seq


def load_model(path):
    from ultralytics import YOLO
    import torch

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"[yolo] loading {path} on {device}", flush=True)
    return YOLO(path), device


class Detector:
    """Runs YOLO in its own thread on the newest frames, so the video plays at full camera
    speed and the boxes update as fast as the model allows."""

    def __init__(self, model_path, conf, readers, enabled=True):
        self.model_path, self.conf, self.readers = model_path, conf, readers
        self.enabled = enabled
        self.boxes = [[] for _ in readers]  # per source: [(x1, y1, x2, y2, label)]
        self.rate = 0.0
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        model, device = load_model(self.model_path)
        seen = [0] * len(self.readers)
        while True:
            reads = [r.read() for r in self.readers]
            idx = [i for i, (f, n) in enumerate(reads) if f is not None and n != seen[i]]
            if not self.enabled or not idx:
                time.sleep(0.005)
                continue
            t0 = time.time()
            results = model([reads[i][0] for i in idx], conf=self.conf, device=device, verbose=False)
            for i, res in zip(idx, results):
                seen[i] = reads[i][1]
                self.boxes[i] = [(*map(int, xyxy), f"{res.names[int(c)]} {p:.2f}")
                                 for xyxy, c, p in zip(res.boxes.xyxy.tolist(), res.boxes.cls, res.boxes.conf)]
            self.rate = 0.8 * self.rate + 0.2 / max(time.time() - t0, 1e-3)


COLORS = {"person": (60, 200, 255), "car": (80, 220, 80), "truck": (80, 220, 80),
          "bus": (80, 220, 80), "motorcycle": (255, 160, 60), "bicycle": (255, 160, 60)}


def draw_boxes(frame, boxes):
    for x1, y1, x2, y2, label in boxes:
        color = COLORS.get(label.rsplit(" ", 1)[0], (255, 255, 255))
        cv2.rectangle(frame, (x1, y1), (x2, y2), color, 3)
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.8, 2)
        cv2.rectangle(frame, (x1, max(y1 - th - 10, 0)), (x1 + tw + 8, max(y1, th + 10)), color, -1)
        cv2.putText(frame, label, (x1 + 4, max(y1 - 6, th + 4)), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 0), 2)


def main():
    p = argparse.ArgumentParser(description="Trax live preview + YOLO")
    p.add_argument("sources", nargs="*",
                   default=["board", "board", "auto"],
                   help="MJPEG stream URLs or webcam indexes, shown side by side")
    p.add_argument("--names", default="FRONT,BACK,SEAT", help="labels for the sources, comma-separated")
    p.add_argument("--model", default=os.path.join(HERE, "yolov8n.pt"),
                   help="YOLO weights (downloads yolov8n.pt if missing)")
    p.add_argument("--conf", type=float, default=0.4)
    p.add_argument("--height", type=int, default=0, help="display height of each tile (default fits the screen)")
    p.add_argument("--no-detect", action="store_true", help="start with detection off")
    a = p.parse_args()

    if not os.path.exists(a.model):
        a.model = os.path.basename(a.model)  # let ultralytics download it

    board = B.Board()
    cams = ["front", "rear", "seat"]

    def reader(i, src):
        name = cams[i] if i < len(cams) else "front"
        if src == "auto":
            webcam = B.mac_usb_webcam()
            if webcam:
                return MacCameraReader(webcam)
            src = "board"
        if src == "board":
            return MJPEGReader(board, name=name)
        if src.isdigit():
            return WebcamReader(int(src))
        return MJPEGReader(src) if src.startswith("http") else MacCameraReader(src)

    readers = [reader(i, src) for i, src in enumerate(a.sources)]
    names = (a.names.split(",") + [f"CAM {i}" for i in range(len(readers))])[:len(readers)]
    detector = Detector(a.model, a.conf, readers, enabled=not a.no_detect)
    win = "Trax"
    cv2.namedWindow(win, cv2.WINDOW_NORMAL)
    th = a.height or (540 if len(readers) <= 2 else 400)
    tw = th * 4 // 3  # placeholder tiles; live tiles keep each camera's own shape

    # One redraw per screen refresh with the newest frame from every camera.
    # (On macOS each waitKey costs ~11 ms, so redrawing per incoming frame halves the fps.)
    shown = [0] * len(readers)
    counts = [0] * len(readers)
    rates = [0.0] * len(readers)
    last_log = time.time()
    while True:
        reads = [r.read() for r in readers]
        if any(n != shown[i] for i, (_, n) in enumerate(reads)) or not any(shown):
            tiles = []
            for i, (name, reader, (frame, n)) in enumerate(zip(names, readers, reads)):
                if n != shown[i]:
                    counts[i] += 1
                    shown[i] = n
                if frame is None:
                    tile = np.zeros((th, tw, 3), np.uint8)
                    cv2.putText(tile, f"{name}: {reader.status}", (20, th // 2),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.8, (200, 200, 200), 2)
                else:
                    frame = frame.copy()
                    found = []
                    if detector.enabled:
                        draw_boxes(frame, detector.boxes[i])
                        found = [b[4].rsplit(" ", 1)[0] for b in detector.boxes[i]]
                    w = round(th * frame.shape[1] / frame.shape[0])
                    tile = cv2.resize(frame, (w, th), interpolation=cv2.INTER_LINEAR)
                    summary = ", ".join(f"{found.count(k)} {k}" for k in sorted(set(found)))
                    cv2.rectangle(tile, (0, th - 30), (w, th), (0, 0, 0), -1)
                    cv2.putText(tile, f"{name} {rates[i]:4.1f} fps  {summary}", (8, th - 9),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1)
                tiles.append(tile)
            view = np.hstack(tiles)
            status = f"YOLO {detector.rate:4.1f} Hz (D)" if detector.enabled else "YOLO OFF (D)"
            cv2.rectangle(view, (0, 0), (view.shape[1], 30), (0, 0, 0), -1)
            cv2.putText(view, f"{status} | Q quit", (8, 21), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1)
            cv2.imshow(win, view)

        now = time.time()
        if now - last_log >= 2:
            rates = [c / (now - last_log) for c in counts]
            counts = [0] * len(readers)
            if int(now) % 10 < 2:
                print(f"[preview] {', '.join(f'{nm} {r:.1f} fps' for nm, r in zip(names, rates))}, "
                      f"YOLO {detector.rate:.1f} Hz", flush=True)
            last_log = now

        key = cv2.waitKey(1) & 0xFF
        if key in (ord("q"), ord("Q"), 27):
            break
        if key in (ord("d"), ord("D")):
            detector.enabled = not detector.enabled

    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
