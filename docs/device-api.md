# Velo device API (what the app expects)

The app talks to the Velo device over the local network (phone hotspot). The
device runs a small HTTP server; port is up to you (the app takes `ip:port`).
Allow cross-origin requests (CORS `*`) so the web build works too.

## `GET /stream?camera=front` (or `rear`)

Live camera as MJPEG (`multipart/x-mixed-replace`). 4:3 is assumed (e.g. 640×480).
With one camera, ignore the `camera` parameter and always serve that camera.

## `GET /snapshot?camera=front` (or `rear`)

One still JPEG from that camera, right now. The app's ride history is built from these: it
fetches one from each camera every 10 seconds while riding, plus one at each close pass, and
stores them on the phone.

## `GET /state`

Polled by the app about 4 times a second. Every field is optional; send what you have.

```json
{
  "mode": "ride",
  "alarm": false,
  "battery": 82,
  "speedKmh": 21.5,
  "position": { "lat": 42.343, "lon": -71.0858 },
  "cameras": ["front", "rear"],
  "detections": [
    { "id": 7, "label": "car", "confidence": 0.91, "box": [0.12, 0.40, 0.30, 0.25], "camera": "rear" }
  ],
  "events": [
    { "id": "evt-1", "kind": "tamper", "ts": 1794627480000 }
  ]
}
```

- `mode`: `"ride"` or `"security"`.
- `alarm`: `true` while the alarm is sounding.
- `battery`: 0–100.
- `position`: the GPS fix, in decimal degrees. Leave it out (or send `null`) until there is a
  fix. The app uses it for "find my bike": it remembers the last position it heard, so it can
  show where the bike was when it went out of range.
- `detections[].box`: `[x, y, width, height]`, each 0–1 relative to the frame, origin top-left.
- `cameras`: which cameras are fitted. Defaults to `["front"]`. With both, the app shows a Front / Rear switch.
- `detections[].camera`: which camera saw it, `"front"` (default) or `"rear"`.
- `detections[].label`: `car`, `truck`, `bus` and `motorcycle` are treated as vehicles.
  `bicycle` is another cyclist: drawn in green, with a "Cyclist ahead / behind" notice when
  one is within 10 m. `person` is a pedestrian. These are the COCO class names, so a stock
  YOLO or MobileNet-SSD model already produces them.
- Detectors usually report a cyclist twice, as a `bicycle` and a `person`. Send both; the app
  drops the `person` whose box sits on a `bicycle` box.
- `detections[].id`: stable per tracked object. The 3D view needs this to move objects smoothly;
  without tracking, objects flicker. Keep the same id for as long as you track the object.
- Do not clip or pad boxes more than the detector already does: the app estimates distance from
  box height and sideways position from the box centre.

### How the app places objects in 3D

The app turns each box into a rough position around the bike (`src/device/geometry.ts`):

- distance = typical real height of that kind of object × focal length ÷ box height
  (car 1.5 m, truck/bus 3 m, motorcycle 1.4 m, bicycle with rider 1.6 m, person 1.7 m)
- sideways offset from where the box centre sits in the frame, scaled by that distance
- rear-camera detections go behind the bike and are mirrored left-to-right

It assumes the Raspberry Pi Camera Module 2 field of view (62.2° × 48.8°). If the stream is
cropped or a different lens is used, the constants at the top of that file need changing.

A vehicle estimated to be within 7 m, and within 3.2 m to either side, shows "Vehicle close".
- `events`: newest first. `kind` is `"tamper"`, `"motion"` or `"crash"`. `ts` is Unix milliseconds.

## `POST /mode`

Body: `{ "mode": "ride" }` or `{ "mode": "security" }`. Security mode arms the IMU alarm.

## `POST /alarm`

Body: `{ "active": false }` silences the alarm. `{ "active": true }` sounds it on purpose (the
app's "Sound alarm" button), without adding an event.

## `POST /chirp`

No body. A short beep and LED flash so the owner can find the bike. Does not add an event.

## Crash detection

When the IMU sees a fall while in ride mode (a hard jolt followed by the bike lying on its
side), add an event with `"kind": "crash"`. Do not sound the alarm. The app starts a
countdown and then prepares a message to the rider's emergency contact.

## Pictures of security events

When a new event appears in `/state`, the app immediately fetches `/snapshot` from each camera
and keeps those pictures with the event. The picture is therefore up to a quarter of a second
after the movement. Better: have the device save the frame at the moment the sensor trips and
serve that; tell the app team and the app will use it.
