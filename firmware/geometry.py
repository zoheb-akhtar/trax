"""Camera geometry: pixels <-> metres on the road around the bike.

Bike frame (metres): x to the rider's right, z straight ahead, the road is the plane y = 0,
the bike is at the origin. Each camera has a lens (field of view), a mount height above the
road, a tilt (pitch, positive = looking down) and a heading (yaw: 0 = forward, 180 = backward).

    cam = CameraModel(hfov=62.2, vfov=48.8, height_m=1.0, pitch_deg=4, yaw_deg=0)
    x, z = cam.ground_point(u, v)        # image point (0-1) on the road -> metres
    u, v = cam.project(x, z)             # road point -> image point (or None if behind)

Mount settings live in velo_config.json (measure camera height with a tape; the pitch can be
read off a level, or tuned until the drawn ego path sits on the road).
"""

from __future__ import annotations

import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "velo_config.json")

DEFAULT_CONFIG = {
    "cameras": {
        # role: road_front = the road ahead; road_rear = the road behind; security = people at
        # the bike (faces, who is on it) and parked-mode watching.
        "front": {"role": "road_front", "hfov": 62.2, "vfov": 48.8, "height_m": 1.0, "pitch_deg": 4.0, "yaw_deg": 0},
        "seat": {"role": "road_rear", "hfov": 70.0, "vfov": 43.0, "height_m": 0.85, "pitch_deg": 4.0, "yaw_deg": 180},
        "rear": {"role": "security", "hfov": 62.2, "vfov": 48.8, "height_m": 0.9, "pitch_deg": 0.0, "yaw_deg": 180},
    },
    # NeoPixel ring: which way LED 0 points (degrees, 0 = ahead, 90 = right) and its direction
    "ring": {"led0_deg": 0, "clockwise": True, "brightness": 0.12},
}


def load_config(path=CONFIG_PATH):
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))
    if os.path.exists(path):
        user = json.load(open(path))
        for k, v in user.items():
            if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                for kk, vv in v.items():
                    if isinstance(vv, dict) and isinstance(cfg[k].get(kk), dict):
                        cfg[k][kk].update(vv)
                    else:
                        cfg[k][kk] = vv
            else:
                cfg[k] = v
    return cfg


class CameraModel:
    def __init__(self, hfov=62.2, vfov=48.8, height_m=1.0, pitch_deg=0.0, yaw_deg=0.0, role="road_front", **_):
        self.hfov, self.vfov = hfov, vfov
        self.fx = 0.5 / math.tan(math.radians(hfov) / 2)  # focal length in image widths
        self.fy = 0.5 / math.tan(math.radians(vfov) / 2)  # ... in image heights
        self.h = height_m
        self.pitch = math.radians(pitch_deg)
        self.yaw = yaw_deg
        self.role = role
        self.backward = abs(((yaw_deg + 180) % 360) - 180) > 90

    @property
    def horizon_v(self):
        """Image row (0-1) of the horizon: everything above it can't be on the road."""
        return 0.5 - math.tan(self.pitch) * self.fy

    def _cam_to_bike(self, x, z):
        return (-x, -z) if self.backward else (x, z)

    def ground_point(self, u, v):
        """Image point (0-1, origin top-left) of something touching the road -> (x, z) metres in
        the bike frame, or None if the point is at/above the horizon."""
        ang = self.pitch + math.atan((v - 0.5) / self.fy)  # angle below horizontal
        if ang <= math.radians(0.3):
            return None
        d = self.h / math.tan(ang)  # horizontal distance along the camera heading
        rng = math.hypot(d, self.h)  # slant range
        depth = rng * math.cos(ang - self.pitch)  # along the optical axis
        x = (u - 0.5) / self.fx * depth
        return self._cam_to_bike(x, d)

    def project(self, x, z):
        """Point on the road (bike frame) -> image point (u, v), or None if behind the camera."""
        if self.backward:
            x, z = -x, -z
        if z <= 0.1:
            return None
        # camera coordinates: forward along the tilted axis, down, right
        ca, sa = math.cos(self.pitch), math.sin(self.pitch)
        fwd = z * ca + self.h * sa
        down = self.h * ca - z * sa
        if fwd <= 0.05:
            return None
        return 0.5 + x / fwd * self.fx, 0.5 + down / fwd * self.fy

    def size_distance(self, box_h, real_h):
        """Distance from an object's apparent height and its typical real height."""
        return real_h * self.fy / box_h if box_h > 1e-3 else None

    def lateral(self, u, depth):
        return (u - 0.5) / self.fx * depth


def cameras_from_config(cfg):
    return {name: CameraModel(**c) for name, c in cfg["cameras"].items()}
