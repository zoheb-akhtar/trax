# Trax camera

## Board (UNO Q) — current working setup
Quick start from the Mac (also the fix whenever the preview says URLError, e.g. after the board restarted):
    ./start.sh          # front 30 fps + back 15 fps, safe on the Mac's USB power
    ./start.sh --full   # back at 30 fps too: ~3.1 cores; on Mac USB power this browned the board out twice
Board user `arduino`; password: ask the owner (export it as BOARD_PASSWORD for start.sh). Reached over USB with `adb`.
Both cameras enabled with:
    sudo arduino-linux-config hw enable media-carrier camera0=type1-2lanes camera1=type1-2lanes   (then reboot)
Camera 0 (CAM0) = front, camera 1 (CAM1) = back. Power the board off before plugging ribbon cables.

Start both streams on the board (front 1640x1232 30 fps on :5000; back 820x616 30 fps on :5001, where
each RGGB cell becomes one pixel (no demosaic, ~1/2 the CPU), with a short shutter so passing cars don't blur):
    adb push uno_q_camera.py /home/arduino/trax/
    adb shell 'cd ~/trax && (setsid nohup python3 uno_q_camera.py --camera 0 --port 5000 > server.log 2>&1 < /dev/null &)'
    adb shell 'cd ~/trax && (setsid nohup python3 uno_q_camera.py --camera 1 --port 5001 --width 820 --height 616 --fps 30 --workers 2 --max-exposure-ms 17 --hflip --vflip > server_back.log 2>&1 < /dev/null &)'
--hflip mirrors the front camera like a selfie view (done in the sensor, no CPU; --vflip flips
upside down; the pipeline follows the Bayer order the flips produce).
CPU with both running: ~3.1 of 4 cores (front ~1.95, back ~1.15). Use a 5V/3A supply.

View both side by side on the Mac with YOLO (Mac port 5000 is AirPlay, so forward to 5055/5056):
    adb forward tcp:5055 tcp:5000
    adb forward tcp:5056 tcp:5001
    source .venv/bin/activate
    python mac_preview.py                 # or one stream: python mac_preview.py http://localhost:5055/stream
The preview redraws once per screen refresh (macOS waitKey costs ~11 ms) and runs YOLO in its own
thread, so video plays at ~30 fps per camera while boxes update at ~17 Hz.
Keys: D = toggle YOLO, Q = quit.  Over Wi-Fi instead: http://UNO_Q_IP:5000/stream and :5001/stream

Capture (default `--source raw`) skips libcamera: it reads raw Bayer frames from the sensor
(full-view 1640x1232 mode, 30 fps) through `v4l2-ctl` and runs its own image pipeline in Python:
black level, gray-world white balance, sRGB gamma + light S-curve, chroma at half res, then encodes
the YUV planes directly with simplejpeg (JPEG q85). Auto-exposure drives the sensor's exposure and
analog gain itself (flicker-aware, 120 Hz). Measured: 30 fps sent at ~2 of 4 cores, ~200 KB/frame.
Tuning: --contrast (0.12), --saturation (1.5), --ae-target (0.17), --quality (85), --workers (3).
`--source libcamera` is the old path (software ISP: noisy, washed out, 15 fps).
simplejpeg isn't in apt: on the Mac, `pip download simplejpeg --platform manylinux2014_aarch64
--python-version 313 --only-binary=:all:`, push the wheel, unzip it into ~/.local/lib/python3.13/site-packages.
Power: the board reset once at ~3.2 cores of load from the Mac's USB port; use a 5V/3A USB-C supply if it drops.
On the board, stop the server with a separate command: adb shell 'pkill -f "[u]no_q_camera.py"'

## Board internet over USB (no Wi-Fi)
    python3 tools/usb_proxy.py 8899 &      # on the Mac
    adb reverse tcp:8899 tcp:8899          # apt on the board already points at it
The board clock resets on boot; set it before apt:
    adb shell "echo $BOARD_PASSWORD | sudo -S date -u -s '$(date -u '+%Y-%m-%d %H:%M:%S')'"

## Mac-only testing with the webcam
    python uno_q_camera.py --source 0 --port 5055
    python mac_preview.py http://localhost:5055/stream     # or: python mac_preview.py 0

## Note
On the owner's Mac, .venv reuses ~/duino-vision/.venv packages (OpenCV, ultralytics, torch) via a .pth file
because the Mac disk was full; only Flask lives in this venv.

## Trax brain: dual-camera perception + the app's device API

`trax_brain.py` (runs on the Mac now, standing in for the phone) reads both camera streams,
runs YOLO11s on the newest front + rear frame together, tracks everything with stable ids
across both cameras (`perception.py`), and serves the app's API (`docs/device-api.md` in the
app repo) on port 8000.

```bash
./start.sh                                             # cameras on the board
source .venv/bin/activate
python trax_brain.py --show                            # + demo window with top-down radar
python trax_brain.py --show --voice                    # + spoken warnings
python trax_brain.py --front 0 --rear none --seat none --show   # Mac webcam only (testing)
```

Point the app at `<Mac IP>:8000` (printed on start) or `localhost:8000` in the simulator.

- `/stream?camera=front|rear`, `/snapshot?camera=…`: the board's JPEGs passed through untouched
  (full frame rate, no re-encoding).
- `/state`: the app's fields (`detections` with `id`, `label`, `confidence`, `box`, `camera`), plus
  extensions the app can adopt: `distanceM`, `position` [x right, z ahead] in metres (**approximate**,
  from box height), `closingMps`, `ttcS` (time to contact, from box growth: independent of object
  size, the trustworthy one), `light` (traffic-light colour), `onBicycle`, `coasting`, `threat` (0-3),
  and top-level `alerts` (`collision`, `closing_ahead`, `in_path`, `vehicle_behind`, `close_pass`,
  `rear_collision`, `cyclist_behind`, `red_light`, `yellow_light`, `stop_sign`) and `perf`.
- A car that passes you keeps its id when it leaves the rear camera and enters the front one.
- Security mode (`POST /mode`) pauses detection. IMU / speaker / recording go on the board (next).

Measured on the M1 in Low Power Mode, both cameras: ~10 Hz AI, ~85 ms inference, ~120 ms
from frame arrival to `/state`, ~40% CPU. Single camera: ~22 Hz, 64 ms. Low Power Mode off is
faster. `--model yolo11n.pt` gives ~28 Hz for both cameras at lower accuracy.

### Seat camera (USB webcam, 2nd rear view)

The Aluratek USB webcam on the back of the seat runs on the board with `--source usb` (port 5002,
Mac 5057, started by `start.sh`). The webcam compresses to JPEG itself, so the board just passes
its frames through: almost no CPU. The brain treats it as a second rear-facing camera: its
detections go to the app as `camera: "rear"` with `source: "seat"`, and a car seen by both rear
cameras is reported once (one id, the seat camera's box, the other view in `alsoSeenBy`).
`mac_preview.py` and `trax_brain.py --show` show all three cameras. Webcam plugged into the Mac
instead (testing): `python trax_brain.py --show --seat 1` (1 = second camera on the Mac).

### Connecting (no hotspot needed when wired)

`trax_brain.py` and `mac_preview.py` find everything by themselves (`board.py`):
- **Board:** USB cable to the Mac first (adb, no network at all), else Wi-Fi (`uno-q.local`).
  Re-checked whenever a stream drops, so swapping cable/Wi-Fi recovers on its own.
  The camera servers start at boot on the board (systemd `trax-front/back/seat`).
- **Seat webcam:** used on the Mac if plugged in here (opened by name via ffmpeg), else the board's.

Wired setup on the MacBook: board -> one USB-C port directly; hub (webcam) -> the other.
The hub's USB-C port only charges: a board plugged in there gets power but no data.
`./start.sh` is only needed to push a new `uno_q_camera.py` to the board.

## Perception v2: Tesla-style ride mode + Ring-style park mode (2026-11-15)

```
.venv/bin/python trax_brain.py --show --voice     # everything, with the Tesla-style window (P park, R ride)
.venv/bin/python tests/test_perception_sim.py     # 12 traffic scenarios (clean + noisy) through the real geometry
.venv/bin/python tests/test_security_rides.py     # park-mode state machine, recordings, ride incidents
./flash_mcu.sh trax_mcu                           # STM32 firmware the brain talks to (ring, IMU, GPS)
```

| File | What |
|---|---|
| `detectors.py` | YOLO11 (COCO) + YOLO-World with Trax's vocabulary (`models/trax-world.pt`, re-bake: `tools/bake_world.py`) + face finder |
| `road.py` | YOLOP (BDD100K) drivable area + lane lines, in its own process: your lane, bike lane or not, ego path |
| `geometry.py` | camera mount model: pixels <-> metres on the road. Mounts in `trax_config.json` |
| `perception.py` | tracking across cameras, metric 3D positions, velocities, collision prediction (CPA), rider situations |
| `security.py` | park mode: motion detection, pre-trigger recording (H.264), faces, events, state machine |
| `mcu.py` + `trax_mcu/` | STM32 link + firmware: ring patterns, hazard direction, IMU tamper / crash / pothole, GPS |
| `rides.py` | ride log + dashcam: danger situations become incidents with clips, GPS and close-pass clearance |
| `web/hud.html` | live web HUD at `http://localhost:8000/hud` (Tesla ride view, Ring park view) |
| `api/trax-api.ts` | TypeScript types + client for the app |
| `APP_INTEGRATION.md` | for the app team: every field, alert kind, event, endpoint, and UI suggestions |

Camera roles: front = road ahead, seat webcam = road behind, Pi camera 2 (`rear`) = security (people, faces).
Measured on the M1 Air (Low Power Mode, battery): ~9 Hz full loop, YOLO 77 ms, YOLO-World 60 ms, road 5.5 Hz.
