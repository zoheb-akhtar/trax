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

Delete all the `/debug/...` routes (`/debug/tamper`, `/debug/crash`, `/debug/car`) before using
this on the real device: anyone on the network could otherwise set off the alarm or the crash
screen.

## AI agent proxy (`agent_proxy.py`)

The "Ask Velo" agent in the app talks to Claude through this small server, so the API key
never goes into the app. It also turns your voice into text for the microphone button, using
the Whisper speech model on this machine (recordings are not sent anywhere else).

```bash
python3 -m venv device/.venv                          # once
device/.venv/bin/pip install -r device/requirements.txt   # once

export ANTHROPIC_API_KEY=...        # your key; stays in this terminal
device/.venv/bin/python device/agent_proxy.py   # listens on port 8787
```

It prints a **proxy token** such as `velo-1234`. Other devices on the network must send it, so
nobody else on the venue Wi-Fi can spend your API credit: enter it under AI agent in the app's
Device tab on a phone. The iOS simulator on the same Mac doesn't need it. The token is kept in
`device/.proxy-token` (not committed) so it stays the same across restarts; set
`VELO_PROXY_TOKEN` to choose your own. The proxy also forwards only Velo's own model requests.

It should print `API key: configured` and, a few seconds later, `Speech to text: ready`.
The first run downloads the speech model (about 150 MB). Without the speech package the agent
still works; the app offers questions to tap instead of listening.

In the app's Device tab, under "AI agent", set the server address: `localhost:8787` in the
iOS simulator, or the laptop's Wi-Fi address (printed when the proxy starts) on a real phone.
If you set a token, enter the same one there.

The proxy handles `POST /v1/messages`, `POST /v1/transcribe` and `POST /v1/watch` only, and logs the status of each request, never the
key or what was said. Each question costs roughly 1 to 2 cents.
