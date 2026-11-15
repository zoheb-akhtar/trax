#!/bin/bash
# MPU6050 test on the UNO Q (STM32 side). Run from the Mac with the board on USB.
#   ./imu_test.sh          watch live readings (Ctrl+C to stop)
#   ./imu_test.sh flash    compile + upload imu_test.ino to the STM32 first, then watch
# The STM32 prints through the board's Linux side to the Mac's USB serial port (/dev/cu.usbmodem*).
set -e
cd "$(dirname "$0")"
if [ "$1" = "flash" ]; then
  adb shell 'mkdir -p ~/imu_test' && adb push imu_test.ino /home/arduino/imu_test/ >/dev/null
  echo "compiling on the board..."
  adb shell 'cd ~ && arduino-cli compile -b arduino:zephyr:unoq --output-dir ~/imu_test/build imu_test 2>&1 | grep -E "error|Sketch uses"'
  echo "uploading to the STM32..."
  adb shell 'R=$(ls -d ~/.arduino15/packages/arduino/tools/remoteocd/*/ | head -1); $R/remoteocd upload -a 0x80F0000 ~/imu_test/build/imu_test.ino.elf-zsk.bin 2>&1 | grep -iE "error|shutdown"'
  sleep 3
fi
PORT=$(ls /dev/cu.usbmodem* 2>/dev/null | head -1)
[ -z "$PORT" ] && { echo "No board serial port. Is the UNO Q plugged into this Mac by USB?"; exit 1; }
echo "reading $PORT  (shake/rotate the IMU; Ctrl+C to stop)"
stty -f "$PORT" 9600 raw -echo
exec cat "$PORT"
