// Velo hardware diagnostic, STM32 side (Arduino UNO Q, Zephyr core).
// Tests the MPU6050, NEO-6M GPS and NeoPixel ring together, prints PASS/WARN/FAIL lines, then
// streams live readings. Run it from the Mac with:  python3 ~/velo/hw_diag/hw_diag.py
//
// Wiring (checked against the UNO Q datasheet, JDIGITAL pin map):
//   MPU6050  VCC 3.3V bus, GND, SDA -> D20 (PB11, I2C2_SDA = Wire), SCL -> D21 (PB10, I2C2_SCL)
//   NEO-6M   VCC 3.3V bus, GND, TX -> D0 (PB7, USART1_RX = Serial on this core), RX not connected
//   NeoPixel 5V bus, GND, DIN -> D6 (PB1). RGBW, bytes in G R B W order. Kept at <= 8 % brightness.
//
// Output lines (to the Mac's USB serial port via the board's Linux side):
//   RESULT <IMU|GPS|NEOPIXEL> <PASS|WARN|FAIL> <message>   after the boot self-test, repeated every 10 s
//   NEO <colour>                                           during the ring colour test
//   LIVE key=value ...                                     5 times a second
//   NMEA <sentence>                                        the latest RMC sentence, once a second

#include <Arduino_RouterBridge.h>
#include <Wire.h>

// rc5 core: Serial = USART1 (D0/D1). Serial1 = LPUART1 is the Bridge link to Linux: never touch it.
#define GPS_SERIAL Serial
static const unsigned long GPS_BAUD = 9600;

static const int NEO_PIN = 6;
static const int NUM_LEDS = 12;
static const uint8_t TEST_LEVEL = 20;  // colour test brightness, 20/255 = 8 %
static const uint8_t LIVE_LEVEL = 10;  // live indicator, 4 %

static char resImu[200], resGps[200], resNeo[200];

static void result(char* store, const char* part, const char* status, const char* msg) {
  snprintf(store, 200, "RESULT %s %s %s", part, status, msg);
  Monitor.println(store);
}

// ------------------------------------------------------------------ GPS (NMEA parser)
static bool rmcValid = false;
static int ggaQuality = 0, fixMode = 1, satsUsed = 0, satsInView = 0, cycleSnr = 0, bestSnr = 0;
static double lat = NAN, lon = NAN, speedKmh = NAN;
static unsigned long gpsBytes = 0, gpsOk = 0, gpsBad = 0, lastByteMs = 0;
static char line[128], lastRmc[128] = "";
static int lineLen = 0;

static int hexVal(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  return -1;
}

static double coord(const char* v, const char* hemi) {
  if (!*v || !*hemi) return NAN;
  double raw = atof(v);
  int deg = (int)(raw / 100);
  double d = deg + (raw - deg * 100) / 60.0;
  return (*hemi == 'S' || *hemi == 'W') ? -d : d;
}

static void parseSentence(char* s) {
  char* star = strchr(s, '*');
  if (!star || star[1] == 0 || star[2] == 0) { gpsBad++; return; }
  uint8_t sum = 0;
  for (char* p = s + 1; p < star; p++) sum ^= (uint8_t)*p;
  if (hexVal(star[1]) * 16 + hexVal(star[2]) != sum) { gpsBad++; return; }
  gpsOk++;
  if (strstr(s, "RMC,")) strncpy(lastRmc, s, sizeof lastRmc - 1);
  *star = 0;

  char* f[24];
  int n = 0;
  f[n++] = s + 1;
  for (char* p = s + 1; *p && n < 24; p++)
    if (*p == ',') { *p = 0; f[n++] = p + 1; }
  const char* type = f[0] + 2;  // skip the talker id (GP, GN, ...)

  if (!strcmp(type, "RMC") && n >= 10) {
    rmcValid = f[2][0] == 'A';
    if (rmcValid) {
      lat = coord(f[3], f[4]);
      lon = coord(f[5], f[6]);
      speedKmh = *f[7] ? atof(f[7]) * 1.852 : NAN;
    }
  } else if (!strcmp(type, "GGA") && n >= 10) {
    ggaQuality = atoi(f[6]);
    satsUsed = atoi(f[7]);
    if (ggaQuality > 0) { lat = coord(f[2], f[3]); lon = coord(f[4], f[5]); }
  } else if (!strcmp(type, "GSA") && n >= 3) {
    fixMode = atoi(f[2]);
  } else if (!strcmp(type, "GSV") && n >= 4) {
    // $GPGSV,total,num,inview, then prn,elev,az,snr per satellite
    int total = atoi(f[1]), num = atoi(f[2]);
    satsInView = atoi(f[3]);
    if (num == 1) cycleSnr = 0;
    for (int i = 7; i < n; i += 4) {
      int snr = *f[i] ? atoi(f[i]) : 0;
      if (snr > cycleSnr) cycleSnr = snr;
    }
    if (num == total) bestSnr = cycleSnr;
  }
}

static bool gpsFix() { return rmcValid || ggaQuality > 0; }

// Drain the GPS UART. Called from every wait so the receive buffer never overflows.
static void pumpGps() {
  while (GPS_SERIAL.available()) {
    char c = GPS_SERIAL.read();
    gpsBytes++;
    lastByteMs = millis();
    if (c == '$') lineLen = 0;
    if (c == '\r') continue;
    if (c == '\n') {
      line[lineLen] = 0;
      if (lineLen > 6 && line[0] == '$') parseSentence(line);
      lineLen = 0;
      continue;
    }
    if (lineLen < (int)sizeof line - 1) line[lineLen++] = c;
  }
}

static void wait(unsigned long ms) {
  unsigned long t0 = millis();
  while (millis() - t0 < ms) { pumpGps(); delay(1); }
}

// ------------------------------------------------------------------ MPU6050
static TwoWire* imuBus = nullptr;
static uint8_t imuAddr = 0, imuWho = 0;
static float ax, ay, az, gx, gy, gz, tempC;
static int16_t raw[7];
static unsigned long imuReads = 0, imuErrors = 0;

static bool present(TwoWire& w, uint8_t a) {
  w.beginTransmission(a);
  return w.endTransmission() == 0;
}

static bool imuWrite(uint8_t reg, uint8_t val) {
  imuBus->beginTransmission(imuAddr);
  imuBus->write(reg);
  imuBus->write(val);
  return imuBus->endTransmission() == 0;
}

static bool imuRead(uint8_t reg, uint8_t* buf, uint8_t n) {
  imuBus->beginTransmission(imuAddr);
  imuBus->write(reg);
  if (imuBus->endTransmission(false) != 0) return false;
  int got = imuBus->requestFrom(imuAddr, n);
  for (int i = 0; i < got && i < n; i++) buf[i] = imuBus->read();
  return got == n;
}

static bool readImu() {
  uint8_t b[14];
  imuReads++;
  if (!imuRead(0x3B, b, 14)) { imuErrors++; return false; }
  for (int i = 0; i < 7; i++) raw[i] = (int16_t)((b[2 * i] << 8) | b[2 * i + 1]);
  ax = raw[0] / 16384.0f; ay = raw[1] / 16384.0f; az = raw[2] / 16384.0f;
  tempC = raw[3] / 340.0f + 36.53f;
  gx = raw[4] / 131.0f; gy = raw[5] / 131.0f; gz = raw[6] / 131.0f;
  return true;
}

static void imuTest() {
  char msg[180];
  Wire.begin();
  Wire1.begin();
  for (uint8_t a : {0x68, 0x69})
    if (!imuBus && present(Wire, a)) { imuBus = &Wire; imuAddr = a; }
  pumpGps();

  if (!imuBus) {
    bool onQwiic = present(Wire1, 0x68) || present(Wire1, 0x69);
    char others[60] = "";
    int nOthers = 0;
    for (uint8_t a = 0x08; a < 0x78 && nOthers < 8; a++) {
      if (present(Wire, a)) {
        snprintf(others + strlen(others), sizeof others - strlen(others), " 0x%02X", a);
        nOthers++;
      }
      pumpGps();
    }
    if (onQwiic)
      result(resImu, "IMU", "FAIL", "MPU6050 answers on the Qwiic connector, not on D20/D21: move SDA to D20 and SCL to D21");
    else if (nOthers) {
      snprintf(msg, sizeof msg, "no MPU6050 at 0x68/0x69 on D20/D21, but other I2C addresses answer:%s (AD0 pin or a different chip?)", others);
      result(resImu, "IMU", "FAIL", msg);
    } else
      result(resImu, "IMU", "FAIL", "nothing answers on D20 (SDA) / D21 (SCL). Check VCC on the 3.3V bus, GND, SDA->D20, SCL->D21 (swapped SDA/SCL looks exactly like this), and the solder joints");
    return;
  }

  imuRead(0x75, &imuWho, 1);
  imuWrite(0x6B, 0x00);  // wake up (it powers up asleep)
  wait(100);
  imuWrite(0x1A, 0x03);  // ~44 Hz low-pass
  imuWrite(0x1B, 0x00);  // +-250 deg/s
  imuWrite(0x1C, 0x00);  // +-2 g
  wait(50);

  int ok = 0, fails = 0;
  bool changed = false;
  int16_t first[7] = {0};
  float sumMag = 0, sumGyro = 0, sumT = 0;
  for (int i = 0; i < 25; i++) {
    if (readImu()) {
      if (ok == 0) memcpy(first, raw, sizeof first);
      else if (memcmp(first, raw, sizeof first)) changed = true;
      ok++;
      sumMag += sqrtf(ax * ax + ay * ay + az * az);
      sumGyro += sqrtf(gx * gx + gy * gy + gz * gz);
      sumT += tempC;
    } else fails++;
    wait(10);
  }
  imuErrors = 0;  // live error count starts after the self-test
  imuReads = 0;

  const char* chip = imuWho == 0x68 ? "" : " (clone chip: fine)";
  if (ok == 0) {
    snprintf(msg, sizeof msg, "MPU6050 found at 0x%02X but every data read fails: loose SDA/SCL wire or a cracked solder joint", imuAddr);
    result(resImu, "IMU", "FAIL", msg);
    return;
  }
  float mag = sumMag / ok, gyro = sumGyro / ok, t = sumT / ok;
  snprintf(msg, sizeof msg, "0x%02X on D20/D21, WHO_AM_I 0x%02X%s, |a| %.2f g, gyro %.1f deg/s, %.1f C, %d/25 reads OK",
           imuAddr, imuWho, chip, mag, gyro, t, ok);
  if (!changed)
    result(resImu, "IMU", "FAIL", "data frozen (25 identical samples): the sensor isn't waking up, check VCC and GND");
  else if (mag < 0.6f || mag > 1.4f) {
    char m2[200];
    snprintf(m2, sizeof m2, "acceleration %.2f g at rest, should be ~1.00 g (keep it still for the first 5 s; if it was still, the sensor is faulty). %s", mag, msg);
    result(resImu, "IMU", "FAIL", m2);
  } else if (fails > 0) {
    char m2[200];
    snprintf(m2, sizeof m2, "%d of 25 reads failed: intermittent I2C, reflow SDA/SCL/GND joints. %s", fails, msg);
    result(resImu, "IMU", "WARN", m2);
  } else if (mag < 0.8f || mag > 1.2f || gyro > 15 || t < -10 || t > 70)
    result(resImu, "IMU", "WARN", msg);  // probably moved during the test
  else
    result(resImu, "IMU", "PASS", msg);
}

// ------------------------------------------------------------------ GPS self-test
static void gpsTest() {
  char msg[180];
  unsigned long b0 = gpsBytes, ok0 = gpsOk, bad0 = gpsBad;
  wait(2500);  // the NEO-6M sends a burst of sentences once a second
  unsigned long db = gpsBytes - b0, dok = gpsOk - ok0, dbad = gpsBad - bad0;
  if (db == 0) {
    result(resGps, "GPS", "FAIL", "no data on D0 for 2.5 s. Check GPS TX -> D0 (not D1), VCC on the 3.3V bus, GND. The GPS RX pin stays unconnected");
    return;
  }
  if (dok == 0) {
    snprintf(msg, sizeof msg, "%lu bytes arrived but no valid NMEA sentence: wrong baud rate (NEO-6M default is 9600) or a noisy TX wire", db);
    result(resGps, "GPS", "FAIL", msg);
    return;
  }
  const char* fix = gpsFix() ? (fixMode == 3 ? "3D fix" : "2D fix") : "no fix yet (normal indoors)";
  snprintf(msg, sizeof msg, "%lu NMEA sentences in 2.5 s (%lu bad), %d satellites in view, best signal %d dB, %s",
           dok, dbad, satsInView, bestSnr, fix);
  result(resGps, "GPS", dbad * 10 > dok ? "WARN" : "PASS", msg);
}

// ------------------------------------------------------------------ NeoPixel (bit-banged SK6812)
static const uint32_t GPIO_BASE = 0x42020000, GPIO_STRIDE = 0x400;  // STM32U585 GPIOA..GPIOI
static volatile uint32_t* bsrr = nullptr;
static uint32_t pinMask = 0;
#define DEMCR (*(volatile uint32_t*)0xE000EDFC)
#define DWT_CTRL (*(volatile uint32_t*)0xE0001000)
#define DWT_CYCCNT (*(volatile uint32_t*)0xE0001004)
static uint32_t cycT0h, cycT1h, cycBit;
static bool neoOk = false;
static char neoPinName[16] = "?";

// Find D6's GPIO port and bit by toggling it and watching which output register bit changes.
static bool findPin() {
  pinMode(NEO_PIN, OUTPUT);
  uint32_t low[9], high[9];
  digitalWrite(NEO_PIN, LOW);
  delay(2);
  for (int p = 0; p < 9; p++) low[p] = *(volatile uint32_t*)(GPIO_BASE + p * GPIO_STRIDE + 0x14);
  digitalWrite(NEO_PIN, HIGH);
  delay(2);
  for (int p = 0; p < 9; p++) high[p] = *(volatile uint32_t*)(GPIO_BASE + p * GPIO_STRIDE + 0x14);
  digitalWrite(NEO_PIN, LOW);
  int found = 0;
  for (int p = 0; p < 9; p++) {
    uint32_t diff = low[p] ^ high[p];
    if (diff && !(diff & (diff - 1))) {
      bsrr = (volatile uint32_t*)(GPIO_BASE + p * GPIO_STRIDE + 0x18);
      pinMask = diff;
      snprintf(neoPinName, sizeof neoPinName, "P%c%d", 'A' + p, 31 - __builtin_clz(diff));
      found++;
    }
  }
  return found == 1;
}

static void neoInit() {
  DEMCR |= (1u << 24);
  DWT_CTRL |= 1u;
  uint32_t c0 = DWT_CYCCNT;
  delay(100);
  uint32_t hz = (DWT_CYCCNT - c0) * 10u;
  cycBit = hz / 800000;   // 1.25 us
  cycT0h = hz / 3333333;  // 0.30 us
  cycT1h = hz / 1666666;  // 0.60 us
}

static void sendPixels(const uint8_t* bytes, int n) {
  uint32_t primask;
  __asm volatile("mrs %0, primask\n cpsid i" : "=r"(primask)::"memory");
  uint32_t t = DWT_CYCCNT;
  for (int i = 0; i < n; i++) {
    for (uint8_t bit = 0x80; bit; bit >>= 1) {
      while (DWT_CYCCNT - t < cycBit) {}
      t = DWT_CYCCNT;
      *bsrr = pinMask;
      uint32_t hi = (bytes[i] & bit) ? cycT1h : cycT0h;
      while (DWT_CYCCNT - t < hi) {}
      *bsrr = pinMask << 16;
    }
  }
  while (DWT_CYCCNT - t < cycBit) {}
  __asm volatile("msr primask, %0" ::"r"(primask) : "memory");
  delayMicroseconds(300);  // latch
}

static uint8_t ring[NUM_LEDS * 4];

static void ringClear() { memset(ring, 0, sizeof ring); }
static void ringSet(int i, uint8_t r, uint8_t g, uint8_t b, uint8_t w) {
  ring[i * 4] = g; ring[i * 4 + 1] = r; ring[i * 4 + 2] = b; ring[i * 4 + 3] = w;
}
static void ringShow() { if (bsrr) sendPixels(ring, sizeof ring); }

static void neoTest() {
  if (!bsrr) {
    result(resNeo, "NEOPIXEL", "FAIL", "could not identify D6's GPIO register (core mapping changed?), ring not driven");
    return;
  }
  // Is the pin free to move? IDR (+0x10 from ODR's +0x14, i.e. bsrr - 2) is the real pin level.
  volatile uint32_t* idr = bsrr - 2;
  *bsrr = pinMask;
  delayMicroseconds(20);
  bool hi = *idr & pinMask;
  *bsrr = pinMask << 16;
  delayMicroseconds(20);
  bool lo = *idr & pinMask;
  if (!hi) {
    result(resNeo, "NEOPIXEL", "FAIL", "D6 stays LOW when driven high: DIN is shorted to GND (look for a solder bridge)");
    return;
  }
  if (lo) {
    result(resNeo, "NEOPIXEL", "FAIL", "D6 stays HIGH when driven low: DIN is shorted to the 5V or 3.3V bus. Unplug and fix before running again");
    return;
  }

  static const char* names[] = {"RED", "GREEN", "BLUE", "WHITE"};
  for (int c = 0; c < 4; c++) {
    ringClear();
    for (int i = 0; i < NUM_LEDS; i++)
      ringSet(i, c == 0 ? TEST_LEVEL : 0, c == 1 ? TEST_LEVEL : 0, c == 2 ? TEST_LEVEL : 0, c == 3 ? TEST_LEVEL : 0);
    ringShow();
    Monitor.print("NEO ");
    Monitor.println(names[c]);
    wait(1200);
  }
  ringClear();
  ringShow();
  wait(10);
  ringShow();
  Monitor.println("NEO OFF");
  neoOk = true;
  char msg[180];
  snprintf(msg, sizeof msg, "D6 (%s) drives cleanly and the data was sent. Confirm by eye: red, green, blue, white on all 12 LEDs, then all off", neoPinName);
  result(resNeo, "NEOPIXEL", "PASS", msg);
}

// Live indicator: green LED 0 = level, blue LED = tilt direction, all white = shake, red = IMU lost.
static void ringIndicator(bool imuGood, float peak) {
  static int lastKey = -99;
  int key;
  if (!imuGood) key = -2;
  else if (peak > 1.6f) key = -3;
  else {
    float tilt = atan2f(sqrtf(ax * ax + ay * ay), fabsf(az)) * 57.2958f;
    if (tilt < 6) key = -1;
    else key = ((int)floorf(atan2f(ay, ax) / 6.28318f * NUM_LEDS + 0.5f) + NUM_LEDS) % NUM_LEDS;
  }
  if (key == lastKey) return;
  lastKey = key;
  ringClear();
  if (key == -2) ringSet(0, LIVE_LEVEL, 0, 0, 0);
  else if (key == -3) for (int i = 0; i < NUM_LEDS; i++) ringSet(i, 0, 0, 0, LIVE_LEVEL);
  else if (key == -1) ringSet(0, 0, LIVE_LEVEL, 0, 0);
  else ringSet(key, 0, 0, LIVE_LEVEL, 0);
  ringShow();
}

// ------------------------------------------------------------------ main
void setup() {
  Bridge.begin();
  Monitor.begin();
  delay(1500);
  Monitor.println("\n=== Velo hardware diagnostic: IMU + GPS + NeoPixel ===");
  if (findPin()) {
    neoInit();
    ringClear();
    ringShow();  // a ring can power up showing random colours
  }
  GPS_SERIAL.begin(GPS_BAUD);
  wait(200);
  imuTest();
  gpsTest();
  neoTest();
  Monitor.println("SELFTEST DONE");
}

static void fmtNum(char* out, size_t n, const char* key, double v, int digits) {
  if (isnan(v)) snprintf(out, n, " %s=-", key);
  else snprintf(out, n, " %s=%.*f", key, digits, v);
}

void loop() {
  static unsigned long lastImu = 0, lastLive = 0, lastNmea = 0, lastRes = 0;
  static bool imuGood = false;
  static float peak = 0;
  pumpGps();
  unsigned long now = millis();

  if (imuBus && now - lastImu >= 50) {
    lastImu = now;
    imuGood = readImu();
    if (imuGood) {
      float m = sqrtf(ax * ax + ay * ay + az * az);
      if (m > peak) peak = m;
    }
  }
  if (neoOk && now - lastLive >= 200) ringIndicator(imuBus && imuGood, peak);

  if (now - lastLive >= 200) {
    lastLive = now;
    char s[400], a[40], b[40], c[40];
    bool fix = gpsFix();
    fmtNum(a, sizeof a, "lat", fix ? lat : NAN, 6);
    fmtNum(b, sizeof b, "lon", fix ? lon : NAN, 6);
    fmtNum(c, sizeof c, "spd", fix ? speedKmh : NAN, 1);
    snprintf(s, sizeof s,
             "LIVE imu=%d ax=%.2f ay=%.2f az=%.2f gx=%.1f gy=%.1f gz=%.1f t=%.1f peak=%.2f ierr=%lu iread=%lu"
             " fix=%d mode=%d sats=%d view=%d snr=%d%s%s%s gb=%lu gok=%lu gbad=%lu age=%lu neo=%d up=%lu",
             imuBus && imuGood ? 1 : 0, ax, ay, az, gx, gy, gz, tempC, peak, imuErrors, imuReads,
             fix ? 1 : 0, fixMode, satsUsed, satsInView, bestSnr, a, b, c, gpsBytes, gpsOk, gpsBad,
             lastByteMs ? now - lastByteMs : 999999UL, neoOk ? 1 : 0, now / 1000);
    Monitor.println(s);
    peak = 0;
  }
  if (now - lastNmea >= 1000) {
    lastNmea = now;
    if (*lastRmc) { Monitor.print("NMEA "); Monitor.println(lastRmc); }
  }
  if (now - lastRes >= 10000) {  // repeat the results for a viewer that started late
    lastRes = now;
    Monitor.println(resImu);
    Monitor.println(resGps);
    Monitor.println(resNeo);
  }
}
