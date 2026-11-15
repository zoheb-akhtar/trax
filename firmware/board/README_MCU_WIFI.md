# Sensors over Wi-Fi (IMU, GPS, LED ring without the USB cable)

Why: on the Mac's USB power the board browns out under camera load. With the board on its own
5 V / 3 A charger there is no USB cable to the Mac, so the cameras already go over Wi-Fi
(`board.py` finds `uno-q.local`). This does the same for the STM32's sensor line.

The Mac side is done: `mcu.py` uses USB serial when the cable is in, otherwise it connects to
`uno-q.local:5010` (override with `VELO_HOST` / `VELO_MCU_PORT`).

## Board side (one time, on the board)

The STM32's `Monitor` is on the board's local port 7500. The USB bridge is:

    /usr/bin/socat file:/dev/ttyGS0,raw,echo=0,b9600,crtscts=0 tcp:127.0.0.1:7500

`velo-mcu.service` relays the same port to the network on 5010. From the Mac, with the board on USB:

    adb push board/velo-mcu.service /home/arduino/velo/
    adb shell -t 'sudo cp /home/arduino/velo/velo-mcu.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now velo-mcu'

(It asks for the board's sudo password.)

Check it, from the Mac on the same Wi-Fi as the board:

    nc uno-q.local 5010

It should print lines starting with `I ` (IMU), `G ` (GPS) and `H ` (heartbeat). Ctrl+C to stop.
Then unplug the USB cable, put the board on its charger, and start the brain: it finds the
cameras and the sensors over Wi-Fi by itself.

**If `nc` connects but prints nothing:** port 7500 may take only one client, and the USB bridge
already holds it. Free it while running on Wi-Fi:

    adb shell -t 'sudo pkill -f "socat file:/dev/ttyGS0"'

(Do this before unplugging. Plugging USB back in later and rebooting the board restores it.)
