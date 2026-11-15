# Sensors over Wi-Fi (IMU, GPS, LED ring without the USB cable)

Why: on the Mac's USB power the board browns out under camera load. With the board on its own
5 V / 3 A charger there is no USB cable to the Mac, so the cameras already go over Wi-Fi
(`board.py` finds `uno-q.local`). This does the same for the STM32's sensor line.

The Mac side is done: `mcu.py` uses USB serial when the cable is in, otherwise it connects to
`uno-q.local:5010` (override with `VELO_HOST` / `VELO_MCU_PORT`).

## Board side (one time, on the board)

Today the STM32's `Monitor` reaches the Mac like this:

    STM32 Monitor -> arduino-router -> socat <-> /dev/ttyGS0 (USB gadget) -> Mac

We need the same stream on TCP port 5010 instead of `/dev/ttyGS0`.

1. On the board, find the existing bridge:

       ps -eo args | grep [s]ocat

   It looks like `socat <ROUTER-SIDE> /dev/ttyGS0` (or the other way round). Copy the part that
   is **not** `/dev/ttyGS0`, e.g. `PTY,link=/tmp/...` or `UNIX-CONNECT:/var/run/...`.

2. Put that into `velo-mcu.service` in place of `ROUTER-SIDE`, then install it:

       sudo cp velo-mcu.service /etc/systemd/system/
       sudo systemctl daemon-reload
       sudo systemctl enable --now velo-mcu

3. From the Mac, on the same Wi-Fi: `nc uno-q.local 5010` should print lines starting with
   `I ` (IMU), `G ` (GPS) and `H ` (heartbeat). Then start the brain without the USB cable.

Only one program can hold the router side at once. If the USB bridge (`socat ... /dev/ttyGS0`)
and this service fight over it, stop the USB one while running on Wi-Fi.
