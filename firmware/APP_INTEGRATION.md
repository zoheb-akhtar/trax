# Velo app integration guide

For the app team. The device (today: `velo_brain.py` on a Mac standing in for the phone) serves everything below on port 8000. Everything in the original contract (`docs/device-api.md` in the app repo) still works unchanged. This guide covers what's **new**, and suggests how to show it.

## Modes

| App action | Request | Device behaviour |
|---|---|---|
| Start ride | `POST /mode {"mode":"ride"}` or `POST /unlock` | Full road perception. The ring points at hazards. Crash and pothole detection run. |
| Lock bike | `POST /mode {"mode":"security"}` or `POST /lock` | Park mode, like a Ring doorbell. |
| Sound alarm | `POST /alarm {"active":true}` | Ring strobes red and white, and recording starts. |
| Silence | `POST /alarm {"active":false}` | |
| Find my bike | `POST /chirp` | Ring flashes white. |

`"drive"` and `"park"` are accepted as aliases of `"ride"` and `"security"`.

## `GET /state`: new fields

```jsonc
{
  "mode": "ride",
  "speedKmh": 18.4,                    // GPS, when there is a fix
  "position": {"lat": 42.34, "lon": -71.09},
  "detections": [ {
      "id": 12, "label": "car", "confidence": 0.88, "box": [x, y, w, h], "camera": "rear",
      "source": "seat",                // physical camera: front | seat | rear
      "group": "vehicle",              // vehicle | bicycle | person | animal | sign | obstacle | micromobility
      "distanceM": 9.2,
      "position": [-1.6, -9.0],        // metres, x = right, z = ahead (negative = behind)
      "bearingDeg": 190,               // 0 ahead, 90 right, 180 behind, 270 left
      "zone": "behind-left",           // ahead | ahead-left | ahead-right | left | right | behind...
      "velocity": [0.1, 6.2],          // m/s relative to the bike
      "closingMps": 6.1,               // + = getting closer
      "speedKmh": 41.0,                // its own speed over the ground (needs the bike's GPS speed)
      "ttcS": 1.4,                     // time to contact
      "cpa": {"tS": 1.5, "missM": 1.2},// closest approach: when, and how close
      "stationary": true,              // e.g. a parked car (needs GPS speed)
      "inPath": true,                  // inside the bike's predicted path corridor
      "lead": true,                    // the nearest vehicle / cyclist in your path
      "headwayS": 2.1,                 // seconds to reach the lead vehicle at your speed
      "braking": true,                 // its brake lights just came on
      "relevant": true,                // traffic lights: the one that applies to you
      "light": "red",                  // traffic lights only
      "threat": 3                      // 0 none, 1 info, 2 caution, 3 danger
  } ],
  "alerts": [ {
      "id": "close_pass-12", "kind": "close_pass", "level": "danger",
      "text": "Car passing close on your left",
      "side": "left",                  // ahead | behind | left | right: where to flash the UI
      "bearingDeg": 270, "trackId": 12, "since": 1794743400.1
  } ],
  "surroundings": {
    "zones": {                         // nearest thing in each direction (null = clear)
      "ahead":  {"id": 4, "label": "person", "distanceM": 7.8, "closingMps": 2.0, "threat": 2},
      "behind": null, "left": {...}, "right": null },
    "lane": {"laneType": "bike_lane", "laneConfidence": 0.65, "laneWidthM": 1.7, "offsetM": 0.2}
  },
  "road": {                            // ride mode, front camera
    "ok": true, "laneType": "bike_lane" | "traffic_lane" | "unknown", "laneConfidence": 0.65,
    "laneWidthM": 1.7, "offsetM": 0.2,              // + = right of the lane centre
    "laneStableS": 3.2,                             // how long the lane type has held (voted over ~2 s)
    "multiLane": true,                              // width > 4.6 m: a middle line was missed
    "pitchDeg": -1.5,                               // camera tilt, self-calibrated from the lane vanishing point
    "leftBoundary":  {"type": "line" | "edge", "distanceM": 0.9, "points": [[x, z], ...]},
    "rightBoundary": {...},
    "egoPath": [[x, z], ...]           // predicted path, 0-20 m ahead (Tesla's blue ribbon)
  },
  "security": {"state": "armed", "since": ..., "recording": "evt-...", "facesSaved": 2,
               "peopleSeen": {"front": 0, "rear": 1}},
  "mcu": {"connected": true, "imu": true, "gps": true, "satellites": 7, "ring": "armed"}
}
```

Distances and positions come from each camera's mount geometry (`velo_config.json`). They're good to about 10 % within 15 m once the mount height and tilt are measured. Use `ttcS`, `cpa` and `closingMps` for urgency, because they are more reliable than the exact distance.

## Alert kinds (ride mode)

**Show these as banners or voice. Suggested UI in brackets.**

| kind | level | when | suggested UI |
|---|---|---|---|
| `collision` | danger | something in your path will be hit in < 2.5 s | full-screen red, "Brake", haptic |
| `rear_collision` | danger | vehicle about to hit you from behind | red flash on the rear edge |
| `close_pass` | danger | car will pass < 1 m from you (3-foot rule) | red flash on that side, log it for ride history |
| `right_hook` | danger | car ahead-left turning across your path | red flash ahead |
| `oncoming` | danger / info | vehicle coming at you in your lane | |
| `crossing` | caution | pedestrian / cyclist / scooter about to cross your path | |
| `closing_ahead` | caution | closing fast on something ahead | |
| `in_path` | caution | person, animal, cone or barrier in your path | |
| `blind_spot` | caution | vehicle beside / just behind you | light the side zone (Tesla's blue / orange lane highlight) |
| `beside` | caution | vehicle right next to you, ahead camera | as above |
| `vehicle_behind` | caution | car approaching from behind | rear indicator |
| `cyclist_behind` | caution | cyclist / scooter catching up | |
| `door_zone` | caution / info | parked car on your right | "watch for doors" |
| `vehicle_in_bike_lane` | caution | car / truck stopped or driving in your bike lane | |
| `emergency` | caution / danger | ambulance, fire truck, police car | "pull right" |
| `in_traffic_lane` | caution | you're in a car lane with a car coming up behind | |
| `leaving_bike_lane` | info | drifting out of the bike lane | |
| `system` | info / caution / danger | part of Velo is down: see `health` | always show; speak caution and above |
| `lead_braking` | caution | the car ahead in your path just hit its brakes (brake lights) | red glow on the lead car |
| `green_light` | info | you're stopped and the light that applies to you turned green | chime (Tesla's green-light chime) |
| `red_light` / `yellow_light` | info | only for the light that applies to you (`relevant`) | traffic-light icon |
| `stop_sign` / `yield_sign` / `no_entry` / `crosswalk` | info / caution | | sign icon |

Alerts have hysteresis: each is held for about 1 s after the condition clears, so they don't flicker. There is one alert per tracked object, its most severe. Sort order is most severe first.

**3D view:**
- Put each detection at `position` (metres), moving smoothly by `id`.
- Draw `velocity` as a short arrow.
- Draw `road.leftBoundary` / `rightBoundary` as lane lines: dashed white for `"line"`, red curb for `"edge"`.
- Draw `road.egoPath` as the ribbon: green in a bike lane, blue otherwise.
- Light the left or right zone when `surroundings.zones.left/right` has something with `threat >= 2`.

## Safety monitor (`health`) — show it

```jsonc
"health": {"status": "ok" | "degraded" | "down",
           "parts": {"front": {"status": "ok", "fps": 30, "calibrated": "2026-11-16"},
                     "seat": {"status": "down", "reason": "reconnecting"},
                     "perception": {"status": "ok", "hz": 8.1, "latencyMs": 160},
                     "road": {...}, "mcu": {...}, "gps": {"status": "degraded", "reason": "no fix ..."}}}
```

- **When a part is down, a `system` alert leads the alert list** and says which warnings are unavailable, e.g. "Rear camera offline: no warnings from behind". **Show it, and speak it.** A rider who thinks "nothing behind me" must know when Velo can't see behind.
- **If perception stops**, `detections` and `alerts` come back empty, plus a danger `system` alert: "Velo warnings stopped: ride with care". The app should never show a frozen "all clear".
- **`calibrated: false` on a road camera** means distances are approximate. Prompt the owner to run `tools/calibrate.py`.

## Alert confirmation

A new alert must hold for **two perception cycles** (about 0.15 s) before it appears, which removes one-frame glitches. An **imminent** danger (contact in under 1.2 s) appears immediately. When something dangerous is near, the device drops its optional passes (zoom, YOLO-World) to run its loop as fast as possible.

## Ride log and dashcam incidents

Every **danger** situation while riding (`close_pass`, `collision`, `rear_collision`, `right_hook`, `oncoming`) becomes an **incident**, like Tesla's dashcam:
- every camera is saved from 6 s before to 6 s after
- an `incident` event is sent with the GPS position, the car's speed and, for close passes, the measured **clearance** (side of the car to the bike)

```
GET /ride    -> {"ride": {id, started, durationS, distanceM, maxSpeedKmh, incidents: [...],
                          alertCounts: {kind: n}, closestPassM, track: [[lat, lon], ...]}}
GET /rides   -> {"rides": [...]}  past rides (a ride ends when the bike is locked)
```

Each incident has these fields: `{id, ts, situation, text, side, position, label, distanceM, objectSpeedKmh, closingMps, clearanceM, recording}`. Its video is at `/recordings/<recording>/front.mp4` (and `seat.mp4` / `rear.mp4`).

**Ride history idea:** a map of the `track` with incident pins. Tapping a pin plays the clip and shows "Car passed 0.5 m from you at 48 km/h". That's evidence of close passes for the rider.

## Which camera is "rear"

The app knows `front` and `rear`. `/stream?camera=rear` shows:
- **while riding:** the **seat webcam**, the road behind (falling back to the security camera if the webcam is off)
- **while parked:** the **security camera** (Pi camera 2)

`/state.rearCamera` says which physical camera that is right now. `detections` only contains rear detections **from that camera**, so boxes always land on the picture the app shows. Detections from the other rear camera go to `otherDetections`. To show a specific camera, use `/stream?camera=seat` or `/stream?camera=security`.

## Camera status

`cameraStatus` in `/state`: `{front: {live, fps, status, role}, seat: {...}, rear: {...}}`. Only open `/stream` for cameras with `live: true`. Browsers allow about 6 connections per host, and a dead stream holds one.

## Reference UI and types

- **`GET /hud`:** a live web HUD served by the device, using only this API. Ride view: Tesla-style 3D scene, cameras with boxes, alerts, ride stats. Park view: Ring-style status ring, alarm / chirp / unlock buttons, live cameras, event timeline with trigger frames, faces and video. Open `http://<device>:8000/hud` and read `firmware/web/hud.html`, which has the projection math, box drawing and SSE handling.
- **`firmware/api/velo-api.ts`:** TypeScript types for every response, plus a small typed `VeloClient` (`state()`, `lock()`, `recordings()`, `fileUrl()`, `onEvent()`...) and helpers (`topAlert`, `litSides`, `project`). It passes `tsc --strict`. Copy it into `src/device/`.

## Park mode (security)

**States** (`security.state`), with the ring colour on the bike:

| state | ring | meaning |
|---|---|---|
| `armed` | orange, breathing | locked and watching |
| `motion` | amber spinner | someone near, or the bike was touched. Recording. Event `motion`. |
| `intruder` | red flashing | someone at the bike for > 4 s; someone at the bike **while** it is touched (immediately); or the bike was moved, lifted or tipped (IMU). Recording, faces saved. Event `tamper`. |
| `alarm` | red + white strobe | owner pressed "sound alarm" |

The STM32 turns the ring red **by itself** on tamper, even with no phone or brain connected.

**Events** (`/state` → `events`, newest first; also `GET /events`):

```json
{"id": "evt-1794743581343", "kind": "tamper", "ts": 1794743581343, "reason": "bike moved",
 "recording": "evt-1794743581343", "snapshots": "/recordings/evt-1794743581343/", "severity": 0.45}
```

Kinds are the app's existing ones: `motion`, `tamper`, `crash`, `pothole`. Pothole and crash events carry `position` (GPS) and `severity` (g) as the device API specifies.

**Live push:** `GET /events/stream` is a Server-Sent Events stream with one `data: {event}` per new event. An app in the foreground can listen there instead of polling.

**Recordings:**
- `GET /recordings` returns a list with `id`, `reason`, `started`, `ended`, `durationS`, `cameras`, `files` and `faces`.
- Files are at `GET /recordings/<id>/<file>`:
  - `front.mp4`, `rear.mp4`, `seat.mp4`: H.264, plays on iOS and Android. Each starts 6 s **before** the trigger.
  - `<camera>_trigger.jpg`: the exact frame when it tripped. Use this for the notification picture.
  - `faces/face_00.jpg` ...: face crops of whoever was at the bike.
- If the same incident re-triggers, extra segments are named `front-2.mp4` and so on.
- **Watch live:** use `/stream?camera=rear` (the security camera) or `front` / `seat`.

## TODO for the app (not implemented on the device side)

- [ ] **Push notifications.**
  - `security.Notifier.emit` is the hook. It already POSTs every event as JSON to `VELO_WEBHOOK` if that environment variable is set.
  - Point it at the app backend and send APNs / FCM from there, with `<camera>_trigger.jpg` as the picture.
- [ ] **Lock / unlock button:** `POST /lock` and `POST /unlock`.
- [ ] **Event screen:** trigger picture, face crops, video player for the MP4s, "Sound alarm" button, and a live view.
- [ ] **Ride HUD:**
  - alert banners by `level`
  - side-zone highlights from `alerts[].side` or `surroundings.zones`
  - lane status from `surroundings.lane`
  - 3D view as described above
- [ ] **Voice:** speak `alerts[].text` for `level >= caution`, at most one every few seconds per kind. `velo_brain.py --voice` shows the cadence.
- [ ] **Connection:** Bluetooth / Wi-Fi to the phone (planned). Today it's the Mac over USB.

## Notes for the device side

- **Moving to the phone:** the models are in `detectors.py` and `road.py`. Each is a standard export:
  - YOLO11 and YOLO-World: `yolo export format=coreml`
  - YOLOP: ONNX → CoreML
- **Perception logic:** `perception.py` is plain numpy, so it ports directly.
- **Mount calibration:** set `velo_config.json` → `cameras.<name>.height_m` / `pitch_deg` after mounting.
  - Check: the drawn ego path should sit flat on the road in `velo_brain.py --show`.
  - Check: a car known to be 10 m away should read about 10 m.
