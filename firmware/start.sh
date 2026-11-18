#!/bin/bash
# Trax cameras on the UNO Q: front (CAM0), back (CAM1), seat (USB webcam on the hub).
# They start by themselves when the board powers on (systemd: trax-front, trax-back, trax-seat)
# and restart themselves if they crash. This script pushes the latest uno_q_camera.py + services,
# restarts them, and checks all three. It reaches the board over USB (adb) if it's plugged in
# directly, otherwise over Wi-Fi (phone hotspot, uno-q.local).
#   ./start.sh          front 30 fps + back 15 fps (safe on the Mac's USB power)
#   ./start.sh --full   back camera at 30 fps too (needs a 5V/3A supply, or the board browns out)
# Then:  source .venv/bin/activate && python trax_brain.py --show
set -e
cd "$(dirname "$0")"
BACK_FPS=15
[ "$1" = "--full" ] && BACK_FPS=30
HOST=${TRAX_HOST:-uno-q.local}
# the board's sudo password (user `arduino`): export BOARD_PASSWORD=... before running (ask the owner)
[ -n "$BOARD_PASSWORD" ] || { echo "set BOARD_PASSWORD (the board's sudo password) first"; exit 1; }
SUDO="echo '$BOARD_PASSWORD' | sudo -S -p ''"
FILES="uno_q_camera.py board/trax-front.service board/trax-back.service board/trax-seat.service"

if [ "$(adb get-state 2>/dev/null)" = "device" ]; then
  echo "board: USB (adb)"
  run() { adb shell "$1"; }
  adb push $FILES /tmp/ >/dev/null
  for p in 0 1 2; do adb forward tcp:505$((p + 5)) tcp:500$p >/dev/null; done
  BASE="localhost"; PORTS="5055 5056 5057"
else
  IP=$(python3 -c "import socket; print(socket.gethostbyname('$HOST'))" 2>/dev/null) || {
    echo "board not found over USB or Wi-Fi ($HOST)."
    echo "Is this Mac on the same hotspot as the board? Is the board powered?"; exit 1; }
  echo "board: Wi-Fi $IP"
  SSH="ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new arduino@$IP"
  run() { $SSH "$1"; }
  scp -q -o StrictHostKeyChecking=accept-new $FILES "arduino@$IP:/tmp/"
  BASE="$IP"; PORTS="5000 5001 5002"
fi

run "cp /tmp/uno_q_camera.py ~/trax/ && echo BACK_FPS=$BACK_FPS > ~/trax/back.env && sync && \
  $SUDO cp /tmp/trax-front.service /tmp/trax-back.service /tmp/trax-seat.service /etc/systemd/system/ && \
  $SUDO systemctl daemon-reload && $SUDO systemctl restart trax-front trax-back trax-seat"
echo "$BASE" > .board   # trax_brain.py / mac_preview.py read this to find the cameras

echo "waiting for the cameras..."
for port in $PORTS; do
  for _ in $(seq 1 25); do curl -sf -m 2 -o /dev/null "http://$BASE:$port/snapshot.jpg" && break; sleep 1; done
done
set -- front back seat
for port in $PORTS; do
  code=$(curl -s -m 3 -o /dev/null -w "%{http_code}" "http://$BASE:$port/snapshot.jpg" || true)
  case "$code" in
    200) echo "$1: ok   http://$BASE:$port/stream" ;;
    503) echo "$1: no picture yet$([ "$1" = seat ] && echo ' (is the webcam plugged into the hub?)')" ;;
    *)   echo "$1: not up (logs: journalctl -u trax-$1)" ;;
  esac
  shift
done
