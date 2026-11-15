#!/bin/bash
# Compile + upload a sketch to the UNO Q's STM32 (no App Lab). Board on USB (adb) or Wi-Fi (ssh).
#   ./flash_mcu.sh gps_test      (or imu_test)
# The STM32 runs one sketch at a time: flashing one replaces the other.
set -e
cd "$(dirname "$0")"
NAME=${1:?usage: ./flash_mcu.sh <sketch folder, e.g. gps_test or imu_test>}
[ -f "$NAME/$NAME.ino" ] || { echo "no $NAME/$NAME.ino"; exit 1; }
if [ "$(adb get-state 2>/dev/null)" = "device" ]; then
  run() { adb shell "$1"; }; put() { adb push "$1" "$2" >/dev/null; }
  echo "board: USB"
else
  IP=$(python3 -c "import socket; print(socket.gethostbyname('${VELO_HOST:-uno-q.local}'))" 2>/dev/null) || {
    echo "board not found over USB or Wi-Fi"; exit 1; }
  run() { ssh -o ConnectTimeout=5 "arduino@$IP" "$1"; }; put() { scp -q "$1" "arduino@$IP:$2"; }
  echo "board: Wi-Fi $IP"
fi
run "mkdir -p ~/$NAME && rm -rf ~/$NAME/build"
for f in "$NAME"/*.ino "$NAME"/*.h "$NAME"/*.cpp; do [ -f "$f" ] && put "$f" "/home/arduino/$NAME/"; done
echo "compiling on the board..."
run "cd ~ && arduino-cli compile -b arduino:zephyr:unoq --output-dir ~/$NAME/build $NAME 2>&1 | grep -E 'error|Error|Sketch uses|serial object' || true"
run "test -f ~/$NAME/build/$NAME.ino.elf-zsk.bin" || { echo "compile failed"; exit 1; }
echo "uploading to the STM32..."
run "R=\$(ls -d ~/.arduino15/packages/arduino/tools/remoteocd/*/ | head -1); \$R/remoteocd upload -a 0x80F0000 ~/$NAME/build/$NAME.ino.elf-zsk.bin 2>&1 | grep -iE 'error|shutdown'"
echo "done: $NAME is running on the STM32"
