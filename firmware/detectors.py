"""Velo's object detectors. Every detector takes BGR frames and returns, per frame,
(xyxy normalized (N, 4), confidence (N,), labels [N]).

  YoloDetector   YOLO11 trained on COCO: cars, trucks, buses, motorcycles, bicycles, people,
                 traffic lights, stop signs, animals. The main detector, run on every frame.
  WorldDetector  YOLO-World v2 with Velo's own vocabulary (WORLD_VOCAB): what COCO doesn't
                 know: traffic cones, barricades, road signs, scooters, wheelchairs, strollers,
                 emergency vehicles, faces. Open-vocabulary, so the list is just text (re-bake
                 with tools/bake_world.py after editing). Run at a lower rate.
  FaceDetector   OpenCV cascades on the upper part of person boxes, for the security camera.

Swap point for the phone: the same interface over CoreML / TFLite exports.
"""

from __future__ import annotations

import os

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))

# COCO classes Velo cares about, with the confidence a track must reach once to be reported.
COCO_MIN_CONF = {"person": 0.40, "bicycle": 0.35, "car": 0.40, "motorcycle": 0.35, "bus": 0.40,
                 "train": 0.50, "truck": 0.40, "traffic light": 0.35, "stop sign": 0.50,
                 "cat": 0.50, "dog": 0.45, "horse": 0.50}

# (prompt for YOLO-World, Velo label, min confidence). Prompts use Objects365-style names, which
# YOLO-World knows best. Emergency vehicles are only kept when they sit on a COCO vehicle box
# (they refine its label), so a plain car can't become a "police car" by itself.
WORLD_VOCAB = [
    ("traffic cone", "traffic cone", 0.30),
    ("barricade", "barrier", 0.30),
    ("traffic sign", "traffic sign", 0.30),
    ("speed limit sign", "speed limit sign", 0.35),
    ("crosswalk sign", "crosswalk sign", 0.35),
    ("yield sign", "yield sign", 0.40),
    ("one way sign", "one way sign", 0.40),
    ("no entry sign", "no entry sign", 0.40),
    ("bicycle lane marking", "bike lane marking", 0.25),
    ("scooter", "scooter", 0.35),
    ("skateboard", "skateboard", 0.40),
    ("wheelchair", "wheelchair", 0.40),
    ("stroller", "stroller", 0.40),
    ("ambulance", "ambulance", 0.45),
    ("fire truck", "fire truck", 0.45),
    ("police car", "police car", 0.50),
    ("human face", "face", 0.35),
]
WORLD_MIN_CONF = {label: c for _, label, c in WORLD_VOCAB}
WORLD_REFINES = {"ambulance", "fire truck", "police car"}  # need a COCO vehicle underneath
ALL_MIN_CONF = {**COCO_MIN_CONF, **WORLD_MIN_CONF}


def _device():
    import torch

    return "mps" if torch.backends.mps.is_available() else "cpu"


class _Ultra:
    """Shared batching for ultralytics models: same-shape frames go through as one batch
    (letterboxed to e.g. 640x480); mixing shapes would pad every frame to a square."""

    def __init__(self, path, imgsz, half, keep):
        from ultralytics import YOLO

        self.device = _device()
        self.model = YOLO(path)
        self.imgsz, self.half = imgsz, half and self.device != "cpu"
        self.names = self.model.names
        self.classes = [i for i, n in self.names.items() if n in keep] if keep else None

    def run(self, frames, conf=0.1):
        by_shape = {}
        for i, f in enumerate(frames):
            by_shape.setdefault(f.shape, []).append(i)
        results = [None] * len(frames)
        for idx in by_shape.values():
            for i, r in zip(idx, self.model([frames[i] for i in idx], imgsz=self.imgsz, conf=conf, iou=0.5,
                                            classes=self.classes, device=self.device, half=self.half,
                                            verbose=False)):
                results[i] = r
        out = []
        for img, r in zip(frames, results):
            H, W = img.shape[:2]
            b = r.boxes
            xyxy = b.xyxy.cpu().numpy() / [W, H, W, H] if len(b) else np.zeros((0, 4))
            out.append((xyxy, b.conf.cpu().numpy(), [self.names[int(c)] for c in b.cls.tolist()]))
        return out


class YoloDetector(_Ultra):
    def __init__(self, path=os.path.join(HERE, "yolo11s.pt"), imgsz=640, half=False):  # fp32 is faster on M1 MPS
        super().__init__(path, imgsz, half, COCO_MIN_CONF)
        print(f"[detect] {os.path.basename(path)} on {self.device}, imgsz {imgsz}{', fp16' if self.half else ''}",
              flush=True)

    def __call__(self, frames):
        return self.run(frames, conf=0.1)


class WorldDetector(_Ultra):
    """YOLO-World with Velo's baked vocabulary (models/velo-world.pt). Labels come out as Velo
    labels (the second column of WORLD_VOCAB)."""

    PATH = os.path.join(HERE, "models", "velo-world.pt")

    def __init__(self, path=PATH, imgsz=640, half=False):
        super().__init__(path, imgsz, half, None)
        self.map = {}
        for i, n in self.names.items():
            match = next((lab for prompt, lab, _ in WORLD_VOCAB if prompt == n), None)
            self.map[n] = match or n
        print(f"[detect] YOLO-World ({len(self.names)} Velo classes) on {self.device}", flush=True)

    def __call__(self, frames, only=None):
        out = []
        for xyxy, conf, names in self.run(frames, conf=0.15):
            labels = [self.map[n] for n in names]
            keep = [i for i, lab in enumerate(labels)
                    if conf[i] >= WORLD_MIN_CONF.get(lab, 0.3) * 0.8 and (only is None or lab in only)]
            out.append((xyxy[keep] if len(keep) else np.zeros((0, 4)), conf[keep] if len(keep) else np.zeros(0),
                        [labels[i] for i in keep]))
        return out


def zoom_window(cam, shape, path_u=0.5, frac=0.5):
    """The 'narrow camera' crop for the zoom pass: half the frame's width and height, centred on
    where the path meets the horizon. Far objects there are tiny at full frame; at 2x they're
    found about twice as often (measured on BDD100K street frames). -> (x0, y0, x1, y1) pixels."""
    H, W = shape[:2]
    cw, ch = int(W * frac), int(H * frac)
    cx = int(min(max(path_u, frac / 2), 1 - frac / 2) * W)
    hv = min(max(cam.horizon_v, 0.25), 0.75)
    cy = int((hv + 0.1) * H)  # a little below the horizon: far things stand on the road there
    x0 = max(0, min(W - cw, cx - cw // 2))
    y0 = max(0, min(H - ch, cy - ch // 2))
    return x0, y0, x0 + cw, y0 + ch


def merge_zoom(base, zoom, window, shape):
    """Add zoom-pass detections (in crop coordinates) that the full-frame pass missed."""
    bx, bc, bn = base
    zx, zc, zn = zoom
    H, W = shape[:2]
    x0, y0, x1, y1 = window
    sx, sy = (x1 - x0) / W, (y1 - y0) / H
    bx = np.asarray(bx).reshape(-1, 4)
    add_x, add_c, add_n = [], [], []
    for b, c, n in zip(np.asarray(zx).reshape(-1, 4), np.asarray(zc).reshape(-1), zn):
        # crop edges cut objects in half: only keep boxes well inside the crop
        if b[0] < 0.01 or b[1] < 0.01 or b[2] > 0.99 or b[3] > 0.99:
            continue
        full = np.array([x0 / W + b[0] * sx, y0 / H + b[1] * sy, x0 / W + b[2] * sx, y0 / H + b[3] * sy])
        if any(_iou(full, o) > 0.4 for o in bx) or any(_iou(full, o) > 0.4 for o in add_x):
            continue
        add_x.append(full), add_c.append(c), add_n.append(n)
    if not add_x:
        return base
    return (np.vstack([bx, np.array(add_x)]), np.concatenate([np.asarray(bc).reshape(-1), np.array(add_c)]),
            list(bn) + add_n)


def drop_ego(xyxy, conf, names, ignore_bottom=0.0):
    """Remove the camera's own vehicle: a car's hood or the bike's front wheel / handlebar shows up
    as a huge box glued to the bottom edge. ignore_bottom (velo_config.json, per camera) also drops
    anything that starts below that line."""
    keep = []
    for i, b in enumerate(np.asarray(xyxy).reshape(-1, 4)):
        hood = b[3] > 0.97 and b[1] > 0.6 and (b[2] - b[0]) > 0.45
        if hood or (ignore_bottom and b[1] > ignore_bottom):
            continue
        keep.append(i)
    xyxy = np.asarray(xyxy).reshape(-1, 4)
    return xyxy[keep], np.asarray(conf).reshape(-1)[keep], [names[i] for i in keep]


def merge(coco, world):
    """Combine one frame's COCO and YOLO-World results.

    World boxes that duplicate a COCO object are dropped, except emergency vehicles, which
    relabel the COCO vehicle they sit on (an ambulance is still tracked as a vehicle). Faces are
    left out here: they are not tracked objects (see FaceDetector / the security camera)."""
    cx, cc, cn = coco
    wx, wc, wn = world
    cx, cn = np.asarray(cx).reshape(-1, 4), list(cn)
    cc = np.asarray(cc).reshape(-1)
    add_x, add_c, add_n = [], [], []
    for b, c, n in zip(np.asarray(wx).reshape(-1, 4), np.asarray(wc).reshape(-1), wn):
        if n == "face":
            continue
        ious = [_iou(b, cb) for cb in cx]
        best = int(np.argmax(ious)) if ious else -1
        if n in WORLD_REFINES:
            if best >= 0 and ious[best] > 0.5 and cn[best] in ("car", "truck", "bus") and c >= WORLD_MIN_CONF[n]:
                cn[best] = n
            continue
        if best >= 0 and ious[best] > 0.6:
            continue  # same thing COCO already has
        add_x.append(b), add_c.append(c), add_n.append(n)
    if add_x:
        cx = np.vstack([cx, np.array(add_x)])
        cc = np.concatenate([cc, np.array(add_c)])
        cn = cn + add_n
    return cx, cc, cn


def _iou(a, b):
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / ua if ua > 0 else 0.0


class FaceDetector:
    """Faces inside person boxes (OpenCV cascades: frontal + profile, both directions).
    Cheap enough to run on every security-camera frame that has people in it."""

    def __init__(self):
        root = cv2.data.haarcascades
        self.frontal = cv2.CascadeClassifier(os.path.join(root, "haarcascade_frontalface_default.xml"))
        self.profile = cv2.CascadeClassifier(os.path.join(root, "haarcascade_profileface.xml"))

    def __call__(self, frame, person_boxes):
        """person_boxes: normalized xyxy. Returns [(normalized xyxy, score)]."""
        H, W = frame.shape[:2]
        gray = cv2.equalizeHist(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY))
        found = []
        for x1, y1, x2, y2 in person_boxes:
            # the head is in the top ~40% of a person box
            px1, py1 = int(x1 * W), int(y1 * H)
            px2, py2 = int(x2 * W), int((y1 + 0.45 * (y2 - y1)) * H)
            roi = gray[max(0, py1):max(0, py2), max(0, px1):max(0, px2)]
            if roi.size == 0 or min(roi.shape) < 24:
                continue
            m = max(20, int(0.12 * (px2 - px1)))
            hits = list(self.frontal.detectMultiScale(roi, 1.1, 5, minSize=(m, m)))
            if not hits:
                hits = list(self.profile.detectMultiScale(roi, 1.1, 5, minSize=(m, m)))
                flipped = self.profile.detectMultiScale(cv2.flip(roi, 1), 1.1, 5, minSize=(m, m))
                hits += [(roi.shape[1] - fx - fw, fy, fw, fh) for fx, fy, fw, fh in flipped]
            for fx, fy, fw, fh in hits[:1]:  # one face per person
                found.append((np.array([(px1 + fx) / W, (py1 + fy) / H, (px1 + fx + fw) / W,
                                        (py1 + fy + fh) / H]), float(fw * fh) / (W * H)))
        return found
