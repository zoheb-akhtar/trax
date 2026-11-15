# Velo firmware guide

Everything the phone app needs from the device, in the order to build it, with a way to
check each step. Formats are in [device-api.md](device-api.md); this file is the plan.

## How to use this

1. Start from [`device/velo_server.py`](../device/velo_server.py). It already serves every
   address the app uses, with made-up data. Three places are marked `REPLACE`.
2. Work through the stages below in order. After each one, run the checker and then try
   the app.
3. Do not move on while the checker shows a `FAIL` for a stage you have finished.

```bash
python3 device/check_device.py <board-ip>:8000
```

The checker needs only Python's standard library. It briefly arms the device and sounds
the alarm, then restores it.

**Using an AI assistant:** give it this file, `device-api.md`, `velo_server.py`, and the
facts it cannot see: how the camera is read today, which pins each part is on, the exact
sensor and GPS modules, and Arduino's documentation for passing messages between the
UNO Q's Linux side and its microcontroller. Ask for one stage at a time.

## Division of work on the UNO Q

| Linux side (Python) | Microcontroller (Arduino sketch) |
| --- | --- |
| Web server the app talks to | Motion sensor (IMU) |
| Camera capture, stream and stills | Buzzer / speaker |
| Object detection and tracking | Status LEDs |
| Keeps the current state in memory | GPS, if wired here |
| Passes arm / alarm commands down | Reports "bike moved" up |

## Stage 1: reachable on the network

The app can do nothing until it can reach the board.

- [ ] The board joins the phone's hotspot automatically at power-on.
- [ ] The server starts automatically at power-on, listening on all interfaces
      (`0.0.0.0`), not just `localhost`.
- [ ] The board's address is easy to read: printed at start-up, or fixed.
- [ ] `GET /state` returns JSON. Every field is optional, so the starter server already
      passes.
- [ ] Responses carry `Access-Control-Allow-Origin: *`.

**Check:** the checker's "State" section passes. In the app's Device tab, enter the
address and tap Connect: the status reads "Connected".

Test on a phone hotspot early. Venue and campus Wi-Fi often stop devices seeing each other.

## Stage 2: camera

- [ ] `GET /stream?camera=front` serves MJPEG (`multipart/x-mixed-replace`), about
      640×480, 4:3.
- [ ] `GET /snapshot?camera=front` returns one JPEG of the current view.
- [ ] Capture runs in its own thread and keeps the latest frame in memory; the web
      handlers only send that frame.
- [ ] With one camera, ignore the `camera` parameter. With two, also list
      `"cameras": ["front", "rear"]` in `/state` and serve both.

**Check:** the checker's "Camera" section passes. The app's Ride tab shows the live
picture (tap Full view), and Security → View camera shows it too.

Which way the single camera faces matters: rear is the more useful view while riding.
Report it as `rear` if it faces backwards.

## Stage 3: security alarm

This is the core demo: arm, move the bike, alarm, photo.

- [ ] `POST /mode {"mode": "security"}` tells the microcontroller to start watching the
      motion sensor. `{"mode": "ride"}` stops it and clears any alarm.
- [ ] When the sensor trips while armed, the microcontroller sounds the buzzer **at
      once, by itself**. It must not wait for the phone or the network.
- [ ] It then tells the Linux side, which sets `"alarm": true` and adds an event to the
      front of `events`: `{"id": "<unique>", "kind": "tamper", "ts": <Unix milliseconds>}`.
- [ ] `POST /alarm {"active": false}` stops the buzzer and sets `alarm` to false.
- [ ] `POST /alarm {"active": true}` sounds the buzzer on purpose (the app's Sound alarm
      button). It does not add an event.
- [ ] The motion threshold ignores wind and passing traffic but catches a lift or a
      shake. Tune it on the real bike.
- [ ] A status LED shows armed / not armed.
- [ ] `/state` keeps the last 20 events, so the app can catch up after being out of range.

**Check:** the checker's "Mode and alarm" section passes. Then by hand: arm from the app,
move the bike, and confirm the buzzer sounds, the app shows the red "Bike moved" screen
with a picture, and Silence stops it. Repeat with the phone's Wi-Fi off: the buzzer must
still sound.

Better still: save the camera frame at the instant the sensor trips and tell the app
team, so the app can use that picture.

## Stage 4: detection

Needed for the 3D ride view, the "vehicle close" warning and close-pass history.

- [ ] Run a detector on camera frames in its own thread. A stock COCO model works: the
      app understands `car`, `truck`, `bus`, `motorcycle`, `bicycle`, `person`.
- [ ] Put results in `/state` as `detections`, each with `label`, `confidence`, `box`
      and `camera`.
- [ ] `box` is `[x, y, width, height]` as **fractions of the frame (0 to 1)**, origin
      top-left. Not pixels. Do not pad or clip boxes: the app estimates distance from
      box height.
- [ ] Give each object an `id` that stays the same while it is tracked. A simple
      nearest-box tracker between frames is enough. Without it, objects flicker.
- [ ] Send both the `bicycle` and the `person` for a cyclist; the app merges them.
- [ ] `/state` still answers in well under 200 ms while detection runs.

**Check:** the checker's "Detections" section passes with something in view. In the app,
boxes on the camera picture sit on the real objects, and the 3D view shows them at a
believable distance.

Measure and write down the detection rate. A few frames a second is usable. If the
picture is cropped or the lens differs from the Pi Camera Module 2, tell the app team:
the distance estimate depends on the field of view.

## Stage 5: speed and battery

- [ ] `speedKmh` from the GPS module, updated about once a second. Report `0` when
      stopped, and omit it until there is a fix.
- [ ] `position` (`{ "lat": ..., "lon": ... }`) from the same GPS fix, in **both** ride and
  security mode. This is what powers "find my bike". Omit it until the GPS has a fix.
- [ ] `battery` as 0–100, if the power board can report it. Omit it otherwise.

**Check:** the app's speed reads 0 at rest and rises when the bike moves.

## Stage 6: stretch

In rough order of value:

- [ ] Second camera, with detections tagged `front` or `rear`.
- [ ] Spoken warnings through the speaker and amplifier.
- [ ] A short video clip saved around each alarm and close pass.
- [ ] Alerts when the phone is away: join a known Wi-Fi network and send a push directly.

## Common mistakes

- Server bound to `localhost`, so only the board can reach it.
- Boxes in pixels instead of fractions.
- Event times in seconds instead of milliseconds.
- Detection running inside the request handler, making `/state` slow.
- The buzzer triggered by the Linux side only, so it fails when Linux is busy or rebooting.
- A new `id` for every detection on every frame.
- Removing power from the board without shutting Linux down, which can corrupt its storage.

## Done means

- [ ] `check_device.py` reports no `FAIL`.
- [ ] From the app: live picture, arm, move the bike, alarm with photo, silence.
- [ ] The alarm sounds with the phone disconnected.
- [ ] The board comes back by itself after a power cycle.
