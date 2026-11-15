# Velo hardware diagnostic

One command checks the IMU, GPS, NeoPixel ring and both cameras all at once. It prints PASS / WARN / FAIL for each part, then shows live readings. It's kept separate from everything else: it doesn't touch `imu_test`, `gps_test`, `neopixel_*`, the camera pipeline or the app.

```
python3 ~/velo/hw_diag/hw_diag.py
```

| File | Runs on | What it does |
|---|---|---|
| `hw_diag.ino` | STM32 | Boot self-test: IMU, then GPS, then the ring's R/G/B/W colour test. After that it streams live readings. |
| `cam_check.py` | board Linux | Read-only. Pulls the running front/back camera streams at the same time, checks that both IMX219s are linked, and watches the kernel log. |
| `hw_diag.py` | Mac | Flashes or restarts the sketch, runs the camera check on the board, prints the results table, then opens the live view. |

## 0. Before powering anything: check the buses (multimeter)

Unplug USB and every power source first. Set the meter to continuity (beep) or the 200 Ω range.

**Must NOT beep (no short).** A reading that starts at a few hundred Ω and climbs is just capacitors charging, which is fine. A reading that stays under 10 Ω is a short.

| Probe | Probe | Why |
|---|---|---|
| 3.3V bus | GND bus | rail short |
| 5V bus | GND bus | rail short |
| 3.3V bus | 5V bus | 5V would back-feed the STM32 and the MPU6050, whose 3.46 V maximum would be exceeded |
| D6 / ring DIN | 5V bus | would push 5V into D6 |
| D6 | GND | |
| SDA (D20) | SCL (D21) | |
| SDA, SCL | GND, 3.3V | |
| D0 / GPS TX | 5V bus, GND | |

**Must beep (connected, under about 1 Ω):**

- Each sensor's VCC pad to its bus: MPU6050 and GPS to 3.3V, the ring's 5V pad to 5V.
- Every GND pad to the GND bus.
- MPU6050 SDA to D20 and SCL to D21.
- GPS TX to D0.
- Ring DIN to D6.
- The GPS **RX** pad goes nowhere.

**First power-up:**

1. Plug in USB and keep a finger near the boards for 30 seconds. If anything gets warm, unplug immediately.
2. Measure:
   - 3.3V bus to GND: 3.1 to 3.5 V (datasheet range for PWR_3P3V).
   - 5V bus to GND: about 4.6 to 5.0 V. The UNO Q's 5V pin sits behind a Schottky diode, so 0.3 to 0.4 V below USB is normal.

## 1. Run it (Mac terminal or the VS Code terminal)

Plug the board into the Mac by USB, then run:

```
cd ~/velo
python3 hw_diag/hw_diag.py               # full test + live view (Ctrl+C to stop)
python3 hw_diag/hw_diag.py --no-live     # table only, exit code 1 on any FAIL
python3 hw_diag/hw_diag.py --live        # just the live view
python3 hw_diag/hw_diag.py --flash       # force a recompile of the sketch
python3 hw_diag/hw_diag.py --no-cams     # skip cameras
```

- **First run:** compiles and uploads the sketch on the board, which takes about a minute.
- **Later runs:** just restart the sketch (a few seconds), so the colour test plays every time.
- **During the boot self-test:** keep the IMU still for about 5 seconds and **watch the ring**. It shows red, then green, then blue, then white on all 12 LEDs at 8 %, then turns off. The STM32 can't see the LEDs, so you have to confirm that part by eye.
- **Live view:**
  - Shake the IMU (the shake bar and peak g jump).
  - Tilt it (roll and pitch change, and the blue LED on the ring follows the tilt).
  - Move the GPS antenna toward a window or outside (best signal dB and satellites rise; outdoors you get a fix with lat/lon).
- **Stability verdict:** on exit it prints IMU read errors and GPS bad checksums. Both should be 0 while everything runs together.
- **Camera frames:** saved to `~/velo/hw_diag/out/front.jpg` and `back.jpg`.

**VS Code:** open `~/velo`, press **Cmd+Shift+P**, choose **Tasks: Run Task**, then pick one of the **Velo diag** tasks.

**Without the Mac script:**

```
./flash_mcu.sh hw_diag                                   # compile + upload over USB (adb) or Wi-Fi (ssh)
P=$(ls /dev/cu.usbmodem*); stty -f $P 9600 raw -echo; cat $P   # raw STM32 output
adb shell python3 ~/hw_diag/cam_check.py                 # camera check (or: ssh arduino@uno-q.local ...)
```

**Getting your other tests back:** the STM32 runs one sketch at a time. To switch back, run `./flash_mcu.sh imu_test` (or `gps_test`, `neopixel_anim`). Close `imu_view.py` and `gps_view.py` before running this, because only one program can read the serial port.

## What a FAIL means

| Message | Likely cause |
|---|---|
| IMU: nothing answers on D20/D21 | VCC/GND missing, SDA/SCL swapped, or a cold solder joint |
| IMU: answers on the Qwiic connector | Wired to the wrong I²C bus |
| IMU: reads fail / data frozen | Loose SDA/SCL, or the sensor isn't powered |
| GPS: no data on D0 | TX not on D0 (D1 is wrong), or no VCC/GND |
| GPS: bytes but no valid NMEA | Wrong baud rate or a noisy wire |
| GPS: no fix | Normal indoors. Outdoors the first fix takes 1 to 5 minutes; it's still a PASS |
| Ring: D6 stays LOW / HIGH | DIN shorted to GND / to a power bus. Unplug and fix |
| CAM: sensor missing on CSI n | Reseat that ribbon and reboot the board |
| CAM: running but no frames | Camera stalled. Check `journalctl -u velo-front` and look for CCI -110 |
| BOARD: hot | Above 80 °C. Add airflow before closing the enclosure |

## Board facts this relies on

These come from the UNO Q datasheet (ABX00162), JDIGITAL/JANALOG pin maps, and the installed core.

| Header pin | STM32 pin and peripheral | Sketch name |
|---|---|---|
| D0 | PB7, USART1_RX | `Serial` on core arduino:zephyr 0.11.0-rc5 (`Serial1` is the Linux Bridge link: never use it) |
| D20 / D21 | PB11 / PB10, I2C2 SDA / SCL | `Wire` (the Qwiic connector is I2C4, `Wire1`) |
| D6 | PB1, TIM3_CH4 PWM pin | Ring driven by bit-banging with timed register writes |

**Logic levels:** all JDIGITAL pins are 3.3 V logic. Most are 5 V-tolerant as inputs. D3 (PB0) and A0 to A5 in analog mode are **not** 5 V-tolerant.

**5V pin:** this is 5V_SYS, the diode-OR of USB-C (5 V up to 3 A) and the DC-in buck. It's shared with the whole board, cameras included.
- The ring at 8 % with all LEDs on draws roughly 20 to 60 mA.
- At 100 % white it can draw about 0.8 to 1 A, so keep app animations dim when on battery.

**3.3V pin:** comes from the board's 3.3 V buck (PWR_3P3V), which also feeds the STM32 and Wi-Fi. The datasheet gives no separate current limit for the header pin. The MPU6050 (about 4 mA) plus the NEO-6M (about 45 mA peak) are a light load.

**Ring data line:** the SK6812 wants a high level of at least 0.7 × 5 V = 3.5 V, and D6 drives 3.3 V. That's slightly out of spec but usually works, and it has worked here. If the LEDs ever flicker or show wrong colours on battery, add a 74AHCT125 level shifter. A 330 to 470 Ω resistor in series with DIN also protects the first LED.
