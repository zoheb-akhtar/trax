# Trax device API (what the app expects)

The app talks to the Trax device over the local network (phone hotspot). The
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
  "speaker": true,
  "cameras": ["front", "rear"],
  "detections": [
    { "id": 7, "label": "car", "confidence": 0.91, "box": [0.12, 0.40, 0.30, 0.25], "camera": "rear" }
  ],
  "events": [
    { "id": "evt-1794627480000", "kind": "tamper", "ts": 1794627480000 }
  ]
}
```

- `mode`: `"ride"` or `"security"`.
- `alarm`: `true` while the alarm is sounding.
- `battery`: 0–100.
- `speaker`: `true` when the speaker works and `/say` and `/play` are available. While it is
  `true` and the bike is in ride mode, the app speaks through the bike instead of the phone.
- `position`: the GPS fix, in decimal degrees. Leave it out (or send `null`) until there is a
  fix. The app uses it for "find my bike": it remembers the last position it heard, so it can
  show where the bike was when it went out of range.
- `detections[].box`: `[x, y, width, height]`, each 0–1 relative to the frame, origin top-left.
- `cameras`: which cameras are fitted. Defaults to `["front"]`. With both, the app shows a Front / Rear switch.
- `detections[].camera`: which camera saw it, `"front"` or `"rear"`. **Always send it.** If it
  is missing, the app assumes the only fitted camera (or `front` with two).
- `detections[].label`: `car`, `truck`, `bus` and `motorcycle` are treated as vehicles.
  `bicycle` is another cyclist: drawn in green, with a "Cyclist ahead / behind" notice when
  one is within 10 m. `person` is a pedestrian. These are the COCO class names. A COCO-trained YOLO
  produces them as is; the common Caffe MobileNet-SSD is trained on VOC instead, has no `truck`,
  and says `motorbike` (the app maps that to `motorcycle`).
- Detectors usually report a cyclist twice, as a `bicycle` and a `person`. Send both; the app
  drops the `person` whose box sits on a `bicycle` box.
- `detections[].confidence`: 0–1. The app ignores anything under 0.5, so filter or tune with
  that in mind.
- `detections[].id`: a number, stable per tracked object. The 3D view needs this to move objects smoothly;
  without tracking, objects flicker. Keep the same id for as long as you track the object.
- Do not clip or pad boxes more than the detector already does: the app estimates distance from
  box height and sideways position from the box centre.
- **Keep detecting while armed** (`mode: "security"`), at least one frame every few seconds. The
  app counts the other bikes (`bicycle`) and people (`person`) the cameras see while parked, for
  its parking data: how full each rack gets and how busy it is. Only the counts are kept.

### How the app places objects in 3D

The app turns each box into a rough position around the bike (`src/device/geometry.ts`):

- distance = typical real height of that kind of object × focal length ÷ box height
  (car 1.5 m, truck/bus 3 m, motorcycle 1.4 m, bicycle with rider 1.6 m, person 1.7 m)
- sideways offset from where the box centre sits in the frame, scaled by that distance
- rear-camera detections go behind the bike and are mirrored left-to-right

It assumes the Raspberry Pi Camera Module 2 field of view (62.2° × 48.8°) and a **4:3 frame
(e.g. 640×480)**. With a 16:9 camera, boxes land in the wrong place on the picture and distances
are off; capture at 4:3, or tell the app team the frame size and lens. "Mirrored" above is the
app's geometry for a backwards-facing camera: **do not flip the rear image yourself.**

A vehicle estimated to be within 7 m, and within 3.2 m to either side, shows "Vehicle close".
- `events`: newest first. `kind` is `"tamper"`, `"motion"`, `"crash"` or `"pothole"`; other
  kinds are ignored. A pothole event also has `severity` and `position` (see Pothole detection).
  `ts` is Unix milliseconds.
- `events[].id`: **unique across reboots**. A counter that restarts at 1 after a power cycle
  makes the app think a new theft is an old one. Use the time, e.g. `"evt-<ts>"`. The app
  treats id + ts together as the event's identity.
- The board's clock may be wrong (no internet time on a hotspot). That's fine: the app times
  new events by when it hears about them. But keep `ts` in milliseconds and roughly right.

## `POST /mode`

Body: `{ "mode": "ride" }` or `{ "mode": "security" }`. Security mode arms the IMU alarm.

## `POST /alarm`

Body: `{ "active": false }` silences the alarm. `{ "active": true }` sounds it on purpose (the
app's "Sound alarm" button), without adding an event.

## `POST /say`

Body: `{ "text": "Car behind, on your left", "urgent": true }`. Say the text through the
speaker with text-to-speech (`espeak-ng`, or `piper` for a nicer voice). `urgent` lines cut off
whatever is playing; others wait their turn. Answer straight away and speak in the background.

While riding, this carries everything Trax tells the rider: warnings, turns, the AI's answers.
While parked, the owner uses it to warn whoever is at the bike.

## `POST /play`

Body: a short recording, `Content-Type: audio/m4a` (AAC), up to about 15 seconds. Play it
through the speaker straight away, cutting off anything else. This is the owner's "hold to
talk" from the alarm screen. `ffplay -nodisp -autoexit file.m4a` plays it.

## Warning on tamper

When the motion sensor trips while armed, the board says this through the speaker **by
itself**, alongside the buzzer, without waiting for the phone:

> This bike is alarmed. You are being recorded, and the owner has been alerted. Please step away from the bike.

Repeat it every 20 seconds or so while the alarm sounds. It must work with the phone out of
range, which is most of the time when a bike is parked.

## `POST /chirp`

No body. A short beep and LED flash so the owner can find the bike. Does not add an event.

## Crash detection

When the IMU sees a fall while in ride mode (a hard jolt followed by the bike lying on its
side), add an event with `"kind": "crash"`. Do not sound the alarm. The app starts a
countdown and then prepares a message to the rider's emergency contact.

## Optional: the device's own positions and warnings

A device that does its own perception (`firmware/velo_brain.py` does) can send more, and the app
uses it in place of its own estimates. See `firmware/APP_INTEGRATION.md` for the full list.

- `detections[].position`: `[x, z]` in metres, x to the right, **z ahead** (negative = behind), with
  `detections[].distanceM`. The app places the object there in the 3D view instead of estimating
  distance from the box. Detections with `group: "sign"` (signs, traffic lights) are left out.
- `alerts`: `[{id, kind, level, text, side, trackId}]`, most severe first. When the device sends
  this list (even empty), the app:
  - counts a close pass for each new `close_pass` alert, instead of its own 7 m rule
  - speaks the alert `text` for the kinds that matter while riding, one at a time, instead of
    its own "car behind" lines. Turns and the alarm are still the app's.

## Pothole detection

While in ride mode, read the IMU's vertical acceleration at 100 Hz or more. A spike more than
about 0.8 g beyond normal gravity, lasting under 0.2 s, while the bike is moving, is a pothole
or kerb. Add an event:

```json
{ "id": "bump-1731600000000", "kind": "pothole", "ts": 1731600000000,
  "severity": 1.7, "position": { "lat": 42.343, "lon": -71.0858 } }
```

- `severity`: the peak jolt beyond normal, in g. The app ignores anything under 0.8.
- `position`: the GPS fix at that moment, if there is one; otherwise the app uses the phone's.
- Wait about 2 s before reporting another, so one hole counts once.
- A jolt followed by the bike staying on its side is a crash, not a pothole.

The app pins each pothole on the ride's map. Across many bikes, the same spot felt again and
again is a pothole worth fixing.

## Pictures of security events

When a new event appears in `/state`, the app immediately fetches `/snapshot` from each camera
and keeps those pictures with the event. The picture is therefore up to a quarter of a second
after the movement. Better: have the device save the frame at the moment the sensor trips and
serve that; tell the app team and the app will use it.
