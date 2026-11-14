# Velo device server (starter)

A small Python program that plays the device's part for the phone app, with
made-up data. It runs on a laptop now and on the Arduino UNO Q's Linux side
later. The API it serves is described in [../docs/device-api.md](../docs/device-api.md).

## Run it

```bash
cd device
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python velo_server.py
```

It prints the address to type into the app's **Device** tab. From the iOS
simulator on the same Mac, use `localhost:8000`.

Press **Enter** in its terminal to pretend someone moved the bike.

## Making it real

Replace the three marked places in `velo_server.py`, one at a time. The app
keeps working at each step.

1. `read_frame()`: return the real camera picture as a JPEG.
2. `Device.detect()`: return the vision model's detections.
3. `Device.arm()` / `Device.silence()`: message the microcontroller. Call
   `DEVICE.tamper()` when it reports the bike was moved.

Delete the `/debug/tamper` route before using it on the real device.
