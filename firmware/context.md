# Velo device: full context

Everything about the bike device: hardware, wiring, how the pieces connect, the software on each part, what's tested, and the traps already hit. The app lives in the rest of this repo (renamed **Trax**). This folder is the device side.

For the app-facing contract (every `/state` field, alert kind, event, endpoint and suggested UI), see **[APP_INTEGRATION.md](APP_INTEGRATION.md)**. The original contract is `docs/device-api.md`, and it still holds.

---

## 1. What it is

Velo is "Ring for bikes + a sixth sense".

- **Ride mode:** Tesla-style perception around the bike. It covers:
  - cars, bikes, pedestrians, signs and lights
  - your lane, bike lanes and your predicted path
  - close passes, blind spots, right hooks and similar situations

  Results go to the app as warnings and a 3D view.
- **Park mode (security), when the bike is locked in the app:** it works like a Ring doorbell. Motion or a person near the bike, or the bike being touched or moved, triggers this sequence:
  1. Recording starts, including the seconds before the trigger.
  2. Faces are saved.
  3. An event is sent for a push notification.
  4. The LED ring turns orange, then amber, then red.

```
                     USB-C (adb + serial)                    later: Bluetooth / Wi-Fi
  ┌──────────────────────┐        ┌─────────────────────────────┐         ┌───────────┐
  │ Arduino UNO Q (4 GB) │◄──────►│ Mac = stand-in for the phone │◄──────►│ Trax app  │
  │  Linux (QRB2210):    │        │  velo_brain.py               │  HTTP  │           │
  │   camera servers     │ MJPEG  │   YOLO11 + YOLO-World + YOLOP│  :8000 │           │
  │   :5000 front        │───────►│   3D tracking, alerts        │        └───────────┘
  │   :5001 back         │        │   park mode, recordings      │
  │   :5002 seat (opt.)  │        │  seat webcam (USB, on Mac)   │
  │  STM32U585 MCU:      │ serial │                              │
  │   velo_mcu firmware  │◄──────►│  mcu.py                      │
  │   IMU / GPS / ring   │        └─────────────────────────────┘
  └──────────────────────┘
```

**Today the Mac stands in for the phone and runs the AI.** All perception logic is plain Python and numpy, and the models are standard YOLO and ONNX, so it can move to the phone (CoreML / TFLite) without changing the logic.

---

## 2. Hardware and exact wiring

| Part | Connection |
|---|---|
| **Arduino UNO Q 4 GB** + **UNO Media Carrier** | Qualcomm QRB2210 Linux (4× A53) + STM32U585 MCU (Zephyr Arduino core) |
| **Pi Camera v2 (IMX219) #1: FRONT** | Media Carrier CSI port **0**. Road ahead. Upright, no flip. |
| **Pi Camera v2 (IMX219) #2: BACK** | CSI port **1**. **Mounted upside down** (`--hflip --vflip`). Role: **security** (people, faces at the bike). |
| **Aluratek USB webcam ("HD Web Camera"): SEAT** | Back of the seat, facing backwards. Role: **road behind**. Today plugged into the **Mac** through a USB hub. |
| **MPU6050 IMU (HW-123)** | VCC → 3.3 V bus, GND → GND bus, SDA → **D20** (PB11, I2C2), SCL → **D21** (PB10). Address **0x68**. |
| **NEO-6M GPS (HW-248)** + external antenna | VCC → 3.3 V bus, GND, **TX → D0** (PB7, USART1 RX), GPS RX not connected. 9600 baud. |
| **Adafruit NeoPixel ring, 12 × RGBW (SK6812)** | 5V → 5 V bus, GND, **DIN → D6** (PB1). DOUT not connected. No level shifter, no series resistor (works). Bytes are G, R, B, W. |
| Power buses | Soldered on a SchmartBoard protoboard: **3.3 V** (UNO Q 3V3, IMU, GPS), **5 V** (UNO Q 5V, ring), **GND** (all). The buses are separate from each other, with a common ground. |
| ~~PAM8302 amp + speaker~~ | **Removed.** The amp overheated (shorted wiring). Audio comes from the phone app. |

**Board electrical facts** (UNO Q datasheet ABX00162):
- **Logic levels:** header pins are **3.3 V**. Most are 5 V-tolerant as inputs. Exceptions:
  - **D3 (PB0)** is never 5 V-tolerant.
  - **A0–A5** are not 5 V-tolerant in analog mode.
- **5V pin:** this is `5V_SYS`, the diode-OR of USB-C (5 V / 3 A) and the DC-in buck. It reads about 0.35 V below USB (Schottky drop), so 4.6–5.0 V is normal. It's shared with the whole board, cameras included.
- **3V3 pin:** comes from the board's 3.3 V buck (3.1–3.5 V). The datasheet gives no current limit for the header pin. The IMU (about 4 mA) and GPS (about 45 mA peak) are a light load.
- **Ring data line:** the ring wants a high level of at least 0.7 × 5 V = 3.5 V, and D6 gives 3.3 V. That's marginal but works. If it flickers on battery, add a 74AHCT125 level shifter and a 330–470 Ω resistor in series with DIN.
  - Full-white draw: about 1 A. The firmware caps brightness at about 12 %.
- **Power supply:** use **5 V / 3 A**. On the Mac's USB power the board **browned out twice** at about 3.1 CPU cores of camera load.

---

## 3. How things connect

### Mac ↔ board: one USB-C cable

The UNO Q has **one** USB-C port. It is **either**:
- **the link to the Mac** (adb + serial), which is what we use for testing, **or**
- **a USB host** for a hub (webcam, power bank), as on the bike.

**Never both at once.**

Over that USB-C link:
- **adb**, as user `arduino`. Ask the owner for the sudo password and export it as `BOARD_PASSWORD` for `start.sh`.
- **Camera streams:** port forwards `adb forward tcp:5055 tcp:5000`, `5056→5001`, `5057→5002`. The Mac uses 5055+ because **Mac port 5000 is AirPlay**. `board.py` sets these up automatically.
- **STM32 serial:** shows up on the Mac as `/dev/cu.usbmodem*`. The path is:

  STM32 `Monitor` → `arduino-router` → socat ↔ `/dev/ttyGS0` (USB gadget) → Mac.

  It's bidirectional, and the baud setting doesn't matter. Read it with:
  ```
  stty -f /dev/cu.usbmodem* 9600 raw -echo; cat /dev/cu.usbmodem*
  ```
  **Only one program can hold the port**: the brain, `hw_diag`, `imu_view` or `gps_view`.

### USB hub (Inland 3-in-1 USB-C)

- Its **built-in cable is the host side**. Its **USB-C port is a power-only PD input**, and anything plugged in there gets no data.
- **Testing:**
  - board → straight into one Mac USB-C port
  - hub cable → the Mac's other port
  - webcam → hub USB-A
  - Mac charger → hub PD port
- **On the bike (not verified yet):**
  - hub cable → board, so the board becomes the USB host
  - webcam → hub USB-A
  - power bank → hub PD port
  - Then the board has no USB link to a computer; the app talks to it wirelessly.
- **NEVER force host mode in software** (`/sys/class/usb_role/.../role`). It killed both IMX219 cameras (CCI I²C timeout `-110`) until a reboot.

### Wireless

- **Not used for testing:** the owner wants testing wired only.
- **Planned:** Bluetooth / Wi-Fi to the phone app, later.
- **Already on the board:** an older Wi-Fi setup exists (NetworkManager connection to a phone hotspot, sshd with key auth, `uno-q.local` via avahi). `board.py` and `start.sh` fall back to it if no USB is found.

---

## 4. Board Linux side: cameras

- **Server:** `uno_q_camera.py` is a Flask MJPEG server. Endpoints: `/stream`, `/snapshot.jpg`.
- **`--source raw` (default):** skips libcamera, whose software ISP is noisy and washed out. It:
  - reads raw Bayer frames via `media-ctl` links + `v4l2-ctl --stream-to=-`
  - runs its own auto-exposure, white balance and gamma in Python
  - encodes with `simplejpeg`
- **Run as systemd services** (`board/*.service`, installed by `start.sh`). They autostart at boot with staggered sleeps and `Restart=always`:

  | Service | Port | Output |
  |---|---|---|
  | `velo-front` | 5000 | camera 0, 1640×1232 full view, 30 fps (about 2 cores) |
  | `velo-back` | 5001 | camera 1, 820×616 binned, `--hflip --vflip`, fps from `~/velo/back.env` (default 15; `start.sh --full` = 30) |
  | `velo-seat` | 5002 | USB webcam MJPEG passthrough. Only gives frames if the webcam is plugged into the **board**. |

- **Enabling the cameras** (needed once; reboot after):
  ```
  sudo arduino-linux-config hw enable media-carrier camera0=type1-2lanes camera1=type1-2lanes
  ```
  The sensors appear as `imx219 2-0010` (front) and `3-0010` (back). Linux `i2c-2` and `i2c-3` are the camera buses: don't probe them.
- **`./start.sh`** (Mac):
  - pushes `uno_q_camera.py` and the service files
  - restarts the services over adb (or ssh)
  - writes `.board`
- **Gotchas:**
  - The board clock resets every boot.
  - Internet for the board over USB: run `tools/usb_proxy.py` on the Mac, then `adb reverse tcp:8899 tcp:8899`.
  - Reboot with `sudo systemctl reboot`, not `adb reboot`.
  - `pkill -f uno_q_camera.py` inside an adb shell kills that shell too. Use the pattern `"[u]no_q_camera.py"` in its own adb call.

---

## 5. STM32 side (MCU)

**Toolchain (no App Lab):**
- Compile on the board: `arduino-cli compile -b arduino:zephyr:unoq` (core `arduino:zephyr` 0.11.0-rc5).
- Flash with `remoteocd upload -a 0x80F0000 <sketch>.ino.elf-zsk.bin`.
- `./flash_mcu.sh <folder>` does both from the Mac, over adb or ssh.
- **The STM32 runs one sketch at a time.**

**Core gotchas (rc5):**
- **Serial ports:**
  - `Serial` = **USART1 = D0 / D1**. This is the GPS.
  - `Serial1` = **LPUART1 = the Bridge link to Linux. Never use it.**
- **I²C:** `Wire` = I2C2 on the header (D20 / D21). `Wire1` = I2C4 on the Qwiic connector.
- **Output:** goes through `Monitor` (`Arduino_RouterBridge`, folder `Arduino_BridgeImola`). `Monitor.read()` works too.
  - The MsgPack, ArxContainer, ArxTypeTraits and DebugLog libraries had to be installed in `~/Arduino/libraries` on the board.
- **Missing math functions (link errors):** `sinf`, `fmodf`, `acosf`, `lroundf`. Use `atan2f`, `sqrtf` and `floorf` instead.
- **`.ino` preprocessing:** it breaks template functions, and a template parameter named `F` clashes with the `F()` macro.
- **NeoPixel:** no library supports this core, so the ring is **bit-banged**. The code:
  1. finds D6's GPIO register at runtime (port B pin 1)
  2. times each bit with the DWT cycle counter (160 MHz)
  3. disables interrupts for about 0.5 ms per frame

**`velo_mcu/`: the production firmware the brain talks to.** It works standalone too: when parked, tamper turns the ring red without the Mac.

```
Brain -> MCU:  PING | MODE off|drive|park | RING off|drive|armed|motion|intruder|alarm
               THREAT <bearing deg> <level 0-3> | CHIRP | BRIGHT <0-255> | LED0 <deg> <cw 0|1>
MCU -> brain:  I ax ay az gx gy gz (20 Hz) | G fix sats lat lon kmh course hdop (1 Hz)
               E nudge|tamper|crash|pothole <value> | H <mode> <ring> imu= gps= up= (2 s) | OK/ERR <cmd>
```

- **IMU:** runs at 100 Hz, ±8 g / ±500°/s, through a median filter. One-sample gyro glitches were seen on this module; a real touch lasts many samples.
- **Park mode:**
  - On arming, it measures the gyro's offset at rest (this MPU6050 reads about 3°/s when still).
  - **nudge:** a jolt over 0.09 g, or rotation over 15°/s.
  - **tamper:** a jolt over 0.35 g, rotation over 70°/s, sustained movement, or the bike tilted more than 20° from its armed position.
- **Ride mode:**
  - **pothole:** a vertical jolt over 0.8 g lasting under 0.2 s while moving.
  - **crash:** a jolt over 2.5 g, then lying more than 60° on its side for 2 s.
  - Both follow the app spec.
- **Ring patterns:**

  | State | Pattern |
  |---|---|
  | drive | dim white marker ahead, plus coloured LEDs toward the hazard (blue = info, amber = caution, flashing red = danger) |
  | armed | orange breathing |
  | motion | amber spinner |
  | intruder | red flashing |
  | alarm | red + white strobe |
  | chirp | white flashes |

**Test sketches** (flashing any of them replaces `velo_mcu`; run `./flash_mcu.sh velo_mcu` to go back):
- `hw_diag/`: PASS / FAIL for every part. Run `python3 hw_diag/hw_diag.py`.
- `imu_test/` + `imu_view.py`: browser 3D tilt view on :8090.
- `gps_test/` + `gps_view.py`: map view on :8091.
- `neopixel_test/` and `neopixel_anim/`.

---

## 6. The brain (Mac): `velo_brain.py`

| File | What |
|---|---|
| `detectors.py` | **YOLO11s** (COCO: vehicles, bikes, people, lights, stop signs) on every frame. **YOLO-World v2**, baked with Velo's vocabulary, at about 3 Hz: cones, barriers, speed limit / yield / crosswalk / one-way / no-entry signs, scooters, wheelchairs, strollers, ambulance / fire truck / police car (only relabels a COCO vehicle), faces. Plus OpenCV face cascades. |
| `road.py` | **YOLOP** (BDD100K) drivable area + lane lines on the front camera, in its **own process** (2 threads). It works out: lane boundaries (line or curb), lane width, **bike lane** (narrow lane between a line and the curb, or green paint), offset from the lane centre, and the **ego path** (from IMU yaw rate + GPS speed when moving, otherwise following the lane shape). |
| `geometry.py` + `velo_config.json` | Each camera's lens FOV, mount height, tilt and heading. Converts pixels to metres on the road. **Calibrate after mounting:** set `height_m` / `pitch_deg` so the drawn path sits on the road and a car known to be 10 m away reads 10 m. Also holds camera roles and ring orientation. |
| `perception.py` | ByteTrack per camera, with **global ids across cameras** (a car passing from the seat view to the front view keeps its id, and its motion state). Distance is the ground-contact point fused with the typical object size. A **Kalman filter** per track (constant velocity on the road plane) gives smooth positions and velocities. On top of that: closest-point-of-approach collision prediction (collision warnings only once the velocity has settled, and only for things in or entering the path), the **lead vehicle** and its **brake lights**, the **traffic light that applies to you**, and a **green-light alert**. About 25 situation types; the more specific alert wins at equal severity. |
| `rides.py` | Ride log + dashcam: each danger situation becomes an **incident** with clips from 6 s before, GPS, the car's speed and the close-pass **clearance**. Ride summary at `/ride`; history at `/rides`. |
| `web/hud.html` | Live web HUD at `/hud`. Ride view: Tesla-style 3D chase view. Park view: Ring-style. Uses only the public API, as a reference for the app. |
| `api/velo-api.ts` | TypeScript types for every response, plus a typed client. Passes `tsc --strict`. Copy it into the app. |
| `security.py` | Park mode: MOG2 motion detection, a recorder that keeps 6 s of pre-roll and writes H.264 MP4s plus trigger JPEGs, face crops, a Notifier (events, SSE, optional `VELO_WEBHOOK` POST), and the state machine. |
| `mcu.py` | Serial link to `velo_mcu`. |
| `board.py` | Finds the board (adb first, else Wi-Fi) and sets up forwards. Captures the **seat webcam on the Mac**, as explained below. |
| `mac_preview.py` | Simple camera preview with YOLO. |
| `tests/test_perception_sim.py` | 12 synthetic traffic scenarios through the real geometry, including noisy detector boxes and a lead car's brake lights coming on. **All 12 pass.** |
| `tests/test_security_rides.py` | Park-mode state machine, pre-roll recordings and ride incidents. **11/11 pass.** |
| `tests/test_real_footage.py` | **Real street video** (YOLOP's sample expressway drive, fetched by `tools/get_testdata.sh`). Checks: pitch self-calibrates, lane comes out as a 2.8–3.9 m traffic lane, cars are found in every frame, and there are **no false danger alerts**. **5/5 pass.** |
| `tools/eval_road.py` | Runs the whole pipeline on any images or video and saves annotated frames (road, lanes, path, boxes with distances). Use it on your own ride recordings. |

**Gotcha:** browsers allow about 6 connections per host. Never keep an MJPEG stream open for a camera that isn't live: check `cameraStatus[cam].live`. The brain also closes a stream after 5 s without frames.

**Camera roles** (`velo_config.json`):
- `front` = `road_front`
- `seat` = `road_rear`
- `rear` (Pi camera 2) = `security`

In the app's `camera` field, `seat` and `rear` both report as `"rear"`, and `source` gives the physical camera.

**Seat webcam on the Mac:**
- **Why not ffmpeg:** the webcam's only full-view mode is **1920×1080**; every other size crops the centre (the "zoomed in" look). ffmpeg only gets its slow raw modes above 640×480 (2–8 fps).
- **What it does instead:** captures through **OpenCV at 1080p30**, scaled to 1280×720.
- **Child process:** OpenCV must open Mac cameras on a main thread, so capture runs in a child process (`board.py --webcam`).
- **Picking the camera:** OpenCV numbers cameras **sorted by unique ID**, while macOS's own list order changes between runs. `tools/mac_cams.swift` (compiled automatically) maps the camera name to OpenCV's number.
- **One reader at a time:** opening the webcam from several programs at once froze it, and only a replug fixed it.

**Models** (not in git): run `./tools/get_models.sh`. It downloads YOLOP and YOLO11s and bakes `models/velo-world.pt`.

**Run:**
```
pip install -r requirements.txt && ./tools/get_models.sh
./flash_mcu.sh velo_mcu                          # once
python velo_brain.py --show --voice              # P = park, R = ride, D = boxes, Q = quit
python velo_brain.py --front ride.mp4 --seat none --rear none --no-mcu --show   # test on a recording
```

**Performance** (M1 MacBook Air, battery, Low Power Mode):

| | Measured |
|---|---|
| Full loop | ~9 Hz (5.6 Hz with the window) |
| YOLO11s per camera | 77 ms |
| YOLO-World | 60 ms |
| YOLOP-320 | ~150 ms (5 Hz) |

Lessons:
- **Run the detector per camera.** Apple MPS recompiles kernels for every new batch-size / shape combination, which costs seconds.
- **Cap the torch and OpenCV thread pools at 2.** Otherwise they oversubscribe the CPU.
- **fp32 is faster than fp16** on M1 MPS.
- **Low Power Mode** roughly halves everything.

---

## 6b. Safety: how Velo avoids failing silently

- **`health.py`, the safety monitor:**
  - **Every camera:** frame age and rate. Road cameras need 8 fps or more, the security camera 2.
  - **Perception:** loop rate and latency.
  - **Road model, STM32 and GPS.**
  - **Mount calibration** of each road camera.
  - **When a part is down,** a `system` alert leads the list and says which warnings are unavailable. It's also spoken with `--voice`.
  - **If perception stops,** detections are dropped, so the app never shows a frozen "all clear".
- **Alert confirmation:** an alert must hold for 2 cycles before it fires, except imminent ones (contact in under 1.2 s), which fire at once.
- **Focus mode:** when something dangerous is near, the optional passes (zoom, YOLO-World) are skipped to keep the loop fast.
- **Bike lanes need evidence:** a curb next to a narrow lane, green paint, or a **painted bike symbol** seen by YOLO-World. A narrow lane painted on both sides alone stays below the alert threshold, because a wrong camera height can make a car lane look narrow.

## 6c. Data engine: record, replay, calibrate

- **Record:** `velo_brain.py --record captures/ride1` saves every camera (10 fps) plus every IMU / GPS line, time-stamped. It flushes about every second, so a crash loses at most a second.
- **Replay:** `velo_brain.py --replay captures/ride1 [--show]` re-runs a recorded ride through the whole system, IMU and GPS included. This is how to tune thresholds and prove a fix on **real** rides.
- **Calibrate:** `tools/calibrate.py [--camera seat] [--known 5]` draws a live metre grid on the road.
  - Set the measured height, then click the base of an object at a known distance to solve the tilt exactly.
  - Check a second distance and adjust the lens if needed, then press P to save. This marks the camera `calibrated` in the health report.
  - **Seat webcam lens:** the specs disagree (65° or 90°), so the default of 78° must be measured.
- **Tests:** `./run_tests.sh` runs everything: 13 traffic scenarios, 9 bike-lane checks, 11 park/ride checks, 8 safety-monitor checks, and 5 real-footage checks.

## 7. Status

**Verified on the real hardware (2026-11-15):**
- **`hw_diag`, all parts together:**
  - IMU PASS
  - GPS PASS (3D fix outdoors)
  - ring PASS
  - front camera 1640×1232 at 30 fps
  - back camera 820×616 at 15 fps
  - seat webcam 30 fps
  - no camera kernel errors
- **Brain live:**
  - detections and tracking
  - MCU link both ways (PING/PONG, mode changes, 20 Hz IMU)
  - ring follows the state
- **Park mode live:**
  - lock → orange
  - touch → amber, recording and `motion` event
  - valid H.264 MP4s and trigger frames
  - 0 false alarms in 40 s idle after the median filter
- **Perception scenarios** (12/12): close pass, safe pass, rear collision, crossing pedestrian, 12 m distance accurate to 1 cm, door zone, oncoming car, right hook; close pass, safe pass and door zone again with 3 % box jitter; and lead-car brake lights.
- **HUD** at `/hud`, live in Chrome:
  - ride view: AI 8.4 Hz, road model 5.4 Hz, GPS fix
  - park view: detected the owner at the bike → "Someone nearby", recording
- **GPS:** reports a fix with 5 satellites indoors near a window. Readings under 2 km/h count as stopped (GPS jitter).

**Validated on real street footage** (YOLOP / BDD100K samples: day, night, snow, highway, city):
- YOLOP's drivable area and lane lines are solid in all conditions.
- Fixes made from what it showed:
  - **Auto-pitch:** the camera tilt self-calibrates from the lane vanishing point. Without it, a wrong tilt made a 3.4 m car lane read as a 2.1 m "bike lane".
  - **Lane voting:** the lane type is voted over about 2 s, and the bike-lane alert needs a stable lane.
  - **Zoom pass:** a 2× centre crop at about 3 Hz, alternating with YOLO-World. It finds about 2× more distant cars.
  - **Ego filter:** detections of the car's own hood are dropped. For the bike's wheel or handlebar, also see `ignore_bottom` in `velo_config.json`.
  - **Clipped boxes:** objects cut off by the frame edge are placed by their inner edge.
  - **Time to contact** from box growth needs a big enough box and a clean trend.
  - **`oncoming`** needs GPS speed (otherwise slower traffic looks oncoming).
  - **`right_hook`** needs a predicted path that actually crosses yours.
- Night-time image brightening was tested and **hurts** YOLO, so it isn't used.

**Bike-lane logic** is verified on exact synthetic roads (`tests/test_bike_lanes.py`, 9/9). The cases are:
- a line plus curb lane of 1.7 m
- a green-painted lane
- a 3.5 m car lane
- a missed middle line
- drifting out of the lane
- a car stopped in the bike lane, with no alert for the same car in a car lane
- a narrow two-line lane confirmed only by a bike symbol

**Not yet verified:**
- A **real** bike lane, through Velo's own cameras. Record a ride with `--record`, replay it, and check.
- The mount calibration on the bike. Run `tools/calibrate.py` for front and seat.
- Camera mount calibration (`velo_config.json`).
- Crash and pothole detection on a real ride.
- The bike power setup: board as USB host through the hub, on a power bank.
- The wireless link to the app (Bluetooth / Wi-Fi).
- Running the AI on the phone (CoreML export failed with torch 2.12 + coremltools 9; needs torch ≤ 2.7).

**Next:**
1. Record a ride and tune the road model plus the alert thresholds.
2. Calibrate the mounts.
3. App: push notifications, lock button, event screen, ride HUD (see APP_INTEGRATION.md).
4. Phone port.
