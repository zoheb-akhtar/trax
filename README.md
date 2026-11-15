# Trax

Companion phone app for Trax, a bike-mounted device that watches the road while you ride and
guards the bike while it is parked. Built for the 300 Mass Ave Startup Hackathon (November 2026).

The app is an [Expo](https://expo.dev) (React Native) project. It runs against either a built-in
simulated device or a real one over the local network.

## Run the app

```bash
npm install
npm start
```

Then press `i` for the iOS simulator, or scan the QR code with Expo Go on a phone.

Use `npm start`, not a bare `npx expo start`: the project includes `expo-dev-client` (for a
future native build with on-device speech recognition), and with it installed Expo starts in
development-build mode, whose QR code Expo Go can't open. `npm start` passes `--go`.

On a real phone, the phone and the laptop must be on the same network. Venue Wi-Fi often
blocks devices from reaching each other; if the app can't connect, put both on a phone hotspot.

## Run the test device server

A small Python server that plays the device's part (camera pictures, detections, alarm), so the
app can be tested without hardware. See [device/README.md](device/README.md).

```bash
cd device
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python trax_server.py
```

In the app's **Device** tab, enter the address the server prints (`localhost:8000` from the iOS
simulator on the same Mac).

## Run the AI agent server

The "Ask Trax" agent and the microphone go through a small server on the laptop, which holds
the API key. See [device/README.md](device/README.md#ai-agent-proxy-agent_proxypy). It prints a
password (`trax-1234`); enter it in the app's **Device** tab on a phone. The simulator doesn't
need it.

## What's in the app

- **Ride**: speed, a 3D view of the road with nearby vehicles and cyclists, turn-by-turn on real
  streets, and a camera picture that appears when a vehicle gets close.
- **History**: past rides with stats and pictures from the front and rear cameras.
- **Security**: arm or disarm, and a full-screen alert when the bike is moved.
- **Device**: connect to a Trax, or use the simulated one.

## Where things are

| What | Where |
| --- | --- |
| Screens | `src/app/` |
| 3D ride view | `src/components/proximity-scene.tsx` |
| Device connection and simulation | `src/device/` |
| Routing, streets, parking | `src/nav/` |
| Ride recording | `src/history/` |
| What the device must send | [docs/device-api.md](docs/device-api.md) |
| Test device server | `device/trax_server.py` |

## Notes

- Search, routing, streets and parking come from free community OpenStreetMap services
  (Photon, Valhalla, Overpass). They are slow at times and are not meant for production use.
- Positions of detected objects are estimates from a single camera.

Map data © OpenStreetMap contributors.
