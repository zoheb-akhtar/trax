// MPU6050 (HW-123) test for the Arduino UNO Q's STM32 (MCU) side.
//
// The UNO-style header SDA/SCL pins belong to the STM32, not to Linux:
//   Wire  = I2C2: header SDA (PB11) / SCL (PB10), i.e. the pins next to AREF
//   Wire1 = I2C4: the Qwiic connector
// This sketch checks both for an MPU6050 at 0x68 (AD0 low) or 0x69 (AD0 high), then prints
// accelerometer (g), gyroscope (deg/s) and temperature (C) 10 times a second.
// Output goes through the board's Linux side (Bridge Monitor) to the Mac's USB serial port.

#include <Arduino_RouterBridge.h>
#include <Wire.h>

static TwoWire* bus = nullptr;
static const char* busName = "";
static uint8_t addr = 0;
static uint8_t who = 0;
static const char* HEADER = "  ax     ay     az   (g)  |    gx      gy      gz  (deg/s) | temp C";

static bool present(TwoWire& w, uint8_t a) {
  w.beginTransmission(a);
  return w.endTransmission() == 0;
}

static bool writeReg(uint8_t reg, uint8_t val) {
  bus->beginTransmission(addr);
  bus->write(reg);
  bus->write(val);
  return bus->endTransmission() == 0;
}

static int readRegs(uint8_t reg, uint8_t* buf, uint8_t n) {
  bus->beginTransmission(addr);
  bus->write(reg);
  if (bus->endTransmission(false) != 0) return 0;
  int got = bus->requestFrom(addr, n);
  for (int i = 0; i < got && i < n; i++) buf[i] = bus->read();
  return got;
}

static void scan(TwoWire& w, const char* name) {
  Monitor.print("I2C scan on ");
  Monitor.print(name);
  Monitor.print(":");
  int found = 0;
  for (uint8_t a = 0x08; a < 0x78; a++) {
    if (present(w, a)) {
      Monitor.print(" 0x");
      if (a < 16) Monitor.print("0");
      Monitor.print(a, HEX);
      found++;
    }
  }
  Monitor.println(found ? "" : " nothing");
}

static bool findSensor() {
  TwoWire* buses[] = {&Wire, &Wire1};
  const char* names[] = {"Wire (header SDA/SCL)", "Wire1 (Qwiic)"};
  for (int b = 0; b < 2; b++) {
    scan(*buses[b], names[b]);
    for (uint8_t a : {0x68, 0x69}) {
      if (present(*buses[b], a)) {
        bus = buses[b];
        busName = names[b];
        addr = a;
        return true;
      }
    }
  }
  return false;
}

void setup() {
  Bridge.begin();
  Monitor.begin();
  delay(1500);
  Wire.begin();
  Wire1.begin();
  Monitor.println("\n=== MPU6050 test ===");

  while (!findSensor()) {
    Monitor.println("No MPU6050 at 0x68/0x69. Check: VCC->3.3V, GND->GND, SDA->SDA, SCL->SCL. Retrying...");
    delay(2000);
  }

  readRegs(0x75, &who, 1);  // WHO_AM_I: 0x68 on a genuine MPU6050 (clones may say 0x70/0x72/0x98)
  Monitor.print("FOUND MPU6050 at 0x");
  Monitor.print(addr, HEX);
  Monitor.print(" on ");
  Monitor.print(busName);
  Monitor.print(", WHO_AM_I = 0x");
  Monitor.println(who, HEX);

  writeReg(0x6B, 0x00);  // PWR_MGMT_1: wake up (it boots asleep)
  delay(100);
  writeReg(0x1A, 0x03);  // CONFIG: ~44 Hz low-pass filter
  writeReg(0x1B, 0x00);  // GYRO_CONFIG: +-250 deg/s  (131 LSB per deg/s)
  writeReg(0x1C, 0x00);  // ACCEL_CONFIG: +-2 g       (16384 LSB per g)
}

static void status() {
  char s[100];
  snprintf(s, sizeof s, "-- MPU6050 detected at 0x%02X on %s, WHO_AM_I = 0x%02X --", addr, busName, who);
  Monitor.println(s);
  Monitor.println(HEADER);
}

void loop() {
  static int n = 0;
  if (n++ % 50 == 0) status();  // every 5 s, so it's visible whenever you start watching
  uint8_t b[14];
  if (readRegs(0x3B, b, 14) != 14) {
    Monitor.println("read failed (loose wire?)");
    delay(500);
    return;
  }
  int16_t v[7];
  for (int i = 0; i < 7; i++) v[i] = (int16_t)((b[2 * i] << 8) | b[2 * i + 1]);
  float ax = v[0] / 16384.0, ay = v[1] / 16384.0, az = v[2] / 16384.0;
  float t = v[3] / 340.0 + 36.53;
  float gx = v[4] / 131.0, gy = v[5] / 131.0, gz = v[6] / 131.0;

  char line[120];
  snprintf(line, sizeof line, "%+6.2f %+6.2f %+6.2f       | %+7.1f %+7.1f %+7.1f         | %5.1f",
           ax, ay, az, gx, gy, gz, t);
  Monitor.println(line);
  delay(100);
}
