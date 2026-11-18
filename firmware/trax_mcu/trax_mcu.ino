// Trax MCU firmware (Arduino UNO Q STM32, Zephyr core): IMU + GPS + NeoPixel ring, talking to the
// Trax brain over the board's USB serial port (Bridge Monitor). Works on its own too: when parked
// it detects tampering from the IMU and turns the ring red without waiting for the brain.
//
// Wiring: MPU6050 SDA->D20 SCL->D21 (Wire); NEO-6M TX->D0 (Serial, USART1); RGBW ring DIN->D6.
//
// Brain -> MCU (one command per line):
//   PING                       -> PONG
//   MODE off|drive|park        drive: crash + pothole detection; park: arm tamper detection
//   RING off|drive|armed|motion|intruder|alarm   ring pattern (park patterns: orange = armed,
//                              amber pulse = someone near, red flash = intruder)
//   THREAT <bearing deg> <level 0-3>   drive mode: light the ring toward a hazard (0 = ahead,
//                              90 = right, 180 = behind, 270 = left); fades after 0.7 s
//   CHIRP                      quick white flash ("find my bike")
//   BRIGHT <0-255>             max brightness (default 32, ~12 %)
//   LED0 <deg> <cw 0|1>        which way LED 0 points and the ring's direction
// MCU -> brain:
//   I ax ay az gx gy gz        IMU, g and deg/s, 20 times a second
//   G fix sats lat lon kmh course hdop    GPS once a second ("-" when unknown)
//   E nudge|tamper|crash|pothole <value>  events (value: g or score)
//   H <mode> <ring> imu=<0|1> gps=<0|1> up=<s>   heartbeat every 2 s
//   OK <command> / ERR <command>

#include <Arduino_RouterBridge.h>
#include <Wire.h>

#define GPS_SERIAL Serial  // USART1 = D0/D1 on core 0.11.0-rc5 (Serial1 is the Bridge link: never use)

// ------------------------------------------------------------------ state
enum Mode { M_OFF, M_DRIVE, M_PARK };
enum Ring { R_OFF, R_DRIVE, R_ARMED, R_MOTION, R_INTRUDER, R_ALARM };
static const char* MODE_NAMES[] = {"off", "drive", "park"};
static const char* RING_NAMES[] = {"off", "drive", "armed", "motion", "intruder", "alarm"};
static Mode mode = M_OFF;
static Ring ring = R_OFF;
static uint8_t bright = 32;
static int led0Deg = 0;
static bool ringCw = true;
static float threatDeg = 0;
static int threatLevel = 0;
static unsigned long threatMs = 0, chirpMs = 0;

// ------------------------------------------------------------------ GPS
static bool rmcValid = false;
static int ggaQuality = 0, satsUsed = 0;
static double lat = NAN, lon = NAN, speedKmh = NAN, courseDeg = NAN, hdop = NAN;
static unsigned long lastGpsByte = 0;
static char gline[128];
static int glen = 0;

static int hexVal(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}
static double coord(const char* v, const char* hemi) {
  if (!*v || !*hemi) return NAN;
  double raw = atof(v);
  int deg = (int)(raw / 100);
  double d = deg + (raw - deg * 100) / 60.0;
  return (*hemi == 'S' || *hemi == 'W') ? -d : d;
}
static void parseNmea(char* s) {
  char* star = strchr(s, '*');
  if (!star || !star[1] || !star[2]) return;
  uint8_t sum = 0;
  for (char* p = s + 1; p < star; p++) sum ^= (uint8_t)*p;
  if (hexVal(star[1]) * 16 + hexVal(star[2]) != sum) return;
  *star = 0;
  char* f[24];
  int n = 0;
  f[n++] = s + 1;
  for (char* p = s + 1; *p && n < 24; p++)
    if (*p == ',') { *p = 0; f[n++] = p + 1; }
  const char* type = f[0] + 2;
  if (!strcmp(type, "RMC") && n >= 10) {
    rmcValid = f[2][0] == 'A';
    if (rmcValid) {
      lat = coord(f[3], f[4]);
      lon = coord(f[5], f[6]);
      speedKmh = *f[7] ? atof(f[7]) * 1.852 : NAN;
      courseDeg = *f[8] ? atof(f[8]) : NAN;
    }
  } else if (!strcmp(type, "GGA") && n >= 10) {
    ggaQuality = atoi(f[6]);
    satsUsed = atoi(f[7]);
    hdop = *f[8] ? atof(f[8]) : NAN;
  }
}
static bool gpsFix() { return rmcValid || ggaQuality > 0; }
static void pumpGps() {
  while (GPS_SERIAL.available()) {
    char c = GPS_SERIAL.read();
    lastGpsByte = millis();
    if (c == '$') glen = 0;
    if (c == '\r') continue;
    if (c == '\n') {
      gline[glen] = 0;
      if (glen > 6 && gline[0] == '$') parseNmea(gline);
      glen = 0;
      continue;
    }
    if (glen < (int)sizeof gline - 1) gline[glen++] = c;
  }
}

// ------------------------------------------------------------------ IMU
static TwoWire* imu = nullptr;
static uint8_t imuAddr = 0x68;
static float ax, ay, az, gx, gy, gz;
static bool imuOk = false;
static float glp[3] = {0, 0, 1};      // low-passed gravity (g)
static float armed[3] = {0, 0, 1};    // gravity direction when parked / riding started
static unsigned long armedAtMs = 0;

static bool imuWrite(uint8_t reg, uint8_t val) {
  imu->beginTransmission(imuAddr);
  imu->write(reg);
  imu->write(val);
  return imu->endTransmission() == 0;
}
static bool imuInit() {
  for (TwoWire* w : {&Wire, &Wire1})
    for (uint8_t a : {0x68, 0x69}) {
      w->beginTransmission(a);
      if (w->endTransmission() == 0) {
        imu = w;
        imuAddr = a;
        imuWrite(0x6B, 0x00);  // wake
        delay(50);
        imuWrite(0x1A, 0x02);  // ~94 Hz low-pass (keeps pothole spikes)
        imuWrite(0x1B, 0x08);  // +-500 deg/s
        imuWrite(0x1C, 0x10);  // +-8 g (crashes and potholes exceed 2 g)
        return true;
      }
    }
  return false;
}
static bool imuRead() {
  if (!imu) return false;
  uint8_t b[14];
  imu->beginTransmission(imuAddr);
  imu->write(0x3B);
  if (imu->endTransmission(false) != 0) return false;
  if (imu->requestFrom(imuAddr, (uint8_t)14) != 14) return false;
  for (int i = 0; i < 14; i++) b[i] = imu->read();
  int16_t v[7];
  for (int i = 0; i < 7; i++) v[i] = (int16_t)((b[2 * i] << 8) | b[2 * i + 1]);
  ax = v[0] / 4096.0f; ay = v[1] / 4096.0f; az = v[2] / 4096.0f;     // +-8 g
  gx = v[4] / 65.5f; gy = v[5] / 65.5f; gz = v[6] / 65.5f;           // +-500 deg/s
  return true;
}

static void sendEvent(const char* kind, float value) {
  char s[48];
  snprintf(s, sizeof s, "E %s %.2f", kind, value);
  Monitor.println(s);
}

static float angleBetween(const float* a, const float* b) {
  float na = sqrtf(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]), nb = sqrtf(b[0] * b[0] + b[1] * b[1] + b[2] * b[2]);
  if (na < 0.1f || nb < 0.1f) return 0;
  float c = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (na * nb);
  c = c > 1 ? 1 : c < -1 ? -1 : c;
  return atan2f(sqrtf(1 - c * c), c) * 57.2958f;  // acos (atan2f/sqrtf link on this core)
}

static float gbias[3] = {0, 0, 0};  // gyro offset at rest (an MPU6050 reads a few deg/s when still)
static float gacc[3] = {0, 0, 0};
static int gcount = 0;

static void arm() {
  memcpy(armed, glp, sizeof armed);
  armedAtMs = millis();
  gacc[0] = gacc[1] = gacc[2] = 0;
  gcount = 0;  // re-measure the gyro offset over the next 2 s (the bike is still when locked)
}

// median of the last n samples per axis: one-sample glitches (vibration, a bad I2C read) vanish,
// a real touch / jolt lasts many samples and survives
static float hist6[5][6];
static int histN = 0;
static float med(int axis, int n) {
  float v[5];
  int k = histN < n ? histN : n;
  for (int i = 0; i < k; i++) v[i] = hist6[(histN - 1 - i) % 5][axis];
  for (int i = 1; i < k; i++)
    for (int j = i; j > 0 && v[j] < v[j - 1]; j--) { float t = v[j]; v[j] = v[j - 1]; v[j - 1] = t; }
  return v[k / 2];
}

// 100 Hz detection
static void detect() {
  static unsigned long lastNudge = 0, lastTamper = 0, lastPothole = 0, joltMs = 0, sideSinceMs = 0;
  static int busy = 0;  // nudge samples in the recent window
  static float potPeak = 0;
  static unsigned long potStart = 0;
  unsigned long now = millis();
  float raw6[6] = {ax, ay, az, gx, gy, gz};
  memcpy(hist6[histN % 5], raw6, sizeof raw6);
  histN++;
  int mn = mode == M_PARK ? 5 : 3;  // riding: keep short pothole jolts
  float a[3] = {med(0, mn), med(1, mn), med(2, mn)};
  float mgx = med(3, mn), mgy = med(4, mn), mgz = med(5, mn);
  float amag = sqrtf(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
  // gravity low-pass (slow, so motion doesn't leak in)
  for (int i = 0; i < 3; i++) glp[i] += 0.02f * (a[i] - glp[i]);
  float dyn = sqrtf((a[0] - glp[0]) * (a[0] - glp[0]) + (a[1] - glp[1]) * (a[1] - glp[1]) +
                    (a[2] - glp[2]) * (a[2] - glp[2]));
  if (now - armedAtMs < 2000) {
    gacc[0] += mgx; gacc[1] += mgy; gacc[2] += mgz;
    gcount++;
  } else if (gcount > 20) {
    for (int i = 0; i < 3; i++) gbias[i] = gacc[i] / gcount;
    gcount = 0;
  }
  float cx = mgx - gbias[0], cy = mgy - gbias[1], cz = mgz - gbias[2];
  float gyro = sqrtf(cx * cx + cy * cy + cz * cz);

  if (mode == M_PARK && now - armedAtMs > 3000) {
    bool nudge = dyn > 0.09f || gyro > 15;
    busy = nudge ? busy + 1 : (busy > 0 ? busy - 1 : 0);
    float tilt = angleBetween(glp, armed);
    bool tamper = dyn > 0.35f || gyro > 70 || busy > 60 || tilt > 20;  // hit, lifted, rocked, tipped
    if (tamper && now - lastTamper > 5000) {
      lastTamper = now;
      sendEvent("tamper", tilt > 20 ? tilt : (dyn > 0.35f ? dyn : gyro));
      ring = R_INTRUDER;  // local reaction, even with no brain connected
    } else if (nudge && now - lastNudge > 2000 && now - lastTamper > 5000) {
      lastNudge = now;
      sendEvent("nudge", dyn > 0.06f ? dyn : gyro / 100);
    }
  }

  if (mode == M_DRIVE) {
    // pothole: vertical jolt > 0.8 g beyond gravity, under 0.2 s, while moving (if GPS knows)
    float gm = sqrtf(glp[0] * glp[0] + glp[1] * glp[1] + glp[2] * glp[2]);
    float vert = gm > 0.5f ? (a[0] * glp[0] + a[1] * glp[1] + a[2] * glp[2]) / gm - gm : 0;
    bool moving = isnan(speedKmh) || speedKmh > 5;
    if (fabsf(vert) > 0.8f) {
      if (!potStart) { potStart = now; potPeak = 0; }
      if (fabsf(vert) > potPeak) potPeak = fabsf(vert);
    } else if (potStart) {
      if (now - potStart < 200 && moving && now - lastPothole > 2000 && potPeak < 3.0f) {
        lastPothole = now;
        sendEvent("pothole", potPeak);
      }
      potStart = 0;
    }
    // crash: a hard jolt, then the bike stays on its side
    if (amag > 2.5f) joltMs = now;
    float tilt = angleBetween(glp, armed);
    if (tilt > 60) {
      if (!sideSinceMs) sideSinceMs = now;
    } else sideSinceMs = 0;
    if (joltMs && sideSinceMs && now - sideSinceMs > 2000 && sideSinceMs - joltMs < 3000) {
      sendEvent("crash", tilt);
      joltMs = 0;
      sideSinceMs = 0;
    }
  }
}

// ------------------------------------------------------------------ NeoPixel (bit-banged SK6812 RGBW)
static const int NEO_PIN = 6, NUM_LEDS = 12;
static const uint32_t GPIO_BASE = 0x42020000, GPIO_STRIDE = 0x400;
static volatile uint32_t* bsrr = nullptr;
static uint32_t pinMask = 0, cycT0h, cycT1h, cycBit;
#define DEMCR (*(volatile uint32_t*)0xE000EDFC)
#define DWT_CTRL (*(volatile uint32_t*)0xE0001000)
#define DWT_CYCCNT (*(volatile uint32_t*)0xE0001004)
static uint8_t px[NUM_LEDS * 4];

static bool neoInit() {
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
      found++;
    }
  }
  if (found != 1) { bsrr = nullptr; return false; }
  DEMCR |= (1u << 24);
  DWT_CTRL |= 1u;
  uint32_t c0 = DWT_CYCCNT;
  delay(50);
  uint32_t hz = (DWT_CYCCNT - c0) * 20u;
  cycBit = hz / 800000;
  cycT0h = hz / 3333333;
  cycT1h = hz / 1666666;
  return true;
}
static void neoShow() {
  if (!bsrr) return;
  uint32_t primask;
  __asm volatile("mrs %0, primask\n cpsid i" : "=r"(primask)::"memory");
  uint32_t t = DWT_CYCCNT;
  for (int i = 0; i < NUM_LEDS * 4; i++)
    for (uint8_t bit = 0x80; bit; bit >>= 1) {
      while (DWT_CYCCNT - t < cycBit) {}
      t = DWT_CYCCNT;
      *bsrr = pinMask;
      uint32_t hi = (px[i] & bit) ? cycT1h : cycT0h;
      while (DWT_CYCCNT - t < hi) {}
      *bsrr = pinMask << 16;
    }
  while (DWT_CYCCNT - t < cycBit) {}
  __asm volatile("msr primask, %0" ::"r"(primask) : "memory");
  delayMicroseconds(300);
}
// colour components 0-1, scaled by the brightness cap
static void setPx(int i, float r, float g, float b, float w) {
  i = ((i % NUM_LEDS) + NUM_LEDS) % NUM_LEDS;
  px[i * 4] = (uint8_t)(g * bright);
  px[i * 4 + 1] = (uint8_t)(r * bright);
  px[i * 4 + 2] = (uint8_t)(b * bright);
  px[i * 4 + 3] = (uint8_t)(w * bright);
}
static int ledFor(float deg) {
  float rel = (deg - led0Deg) / (360.0f / NUM_LEDS);
  int i = (int)floorf(rel + 0.5f);
  return ringCw ? i : -i;
}

static void renderRing() {
  unsigned long now = millis();
  memset(px, 0, sizeof px);
  float t = now / 1000.0f;
  if (now - chirpMs < 600) {
    if (((now - chirpMs) / 150) % 2 == 0)
      for (int i = 0; i < NUM_LEDS; i++) setPx(i, 0, 0, 0, 1);
    neoShow();
    return;
  }
  switch (ring) {
    case R_OFF:
      break;
    case R_DRIVE: {
      setPx(ledFor(0), 0, 0, 0, 0.15f);  // dim white marker straight ahead: system alive
      if (threatLevel > 0 && now - threatMs < 700) {
        float r = threatLevel >= 2 ? 1 : 0, g = threatLevel == 2 ? 0.45f : (threatLevel == 1 ? 0.25f : 0),
              b = threatLevel == 1 ? 1 : 0;
        bool on = threatLevel < 3 || ((now / 120) % 2 == 0);  // danger flashes
        int c = ledFor(threatDeg);
        int spread = threatLevel >= 3 ? 2 : 1;
        if (on)
          for (int k = -spread; k <= spread; k++) {
            float f = k == 0 ? 1 : 0.4f;
            setPx(c + k, r * f, g * f, b * f, 0);
          }
      }
      break;
    }
    case R_ARMED: {  // orange, slow breathing
      float ph = (now % 3000) / 3000.0f;  // triangle wave (this core lacks sinf / fmodf)
      float k = 0.25f + 0.35f * (ph < 0.5f ? ph * 2 : 2 - ph * 2);
      for (int i = 0; i < NUM_LEDS; i++) setPx(i, k, k * 0.32f, 0, 0);
      break;
    }
    case R_MOTION: {  // amber spinner: someone is near
      int head = (int)(t * 10) % NUM_LEDS;
      for (int i = 0; i < NUM_LEDS; i++) setPx(i, 0.25f, 0.1f, 0, 0);
      for (int k = 0; k < 3; k++) setPx(head - k, 1.0f - 0.3f * k, (1.0f - 0.3f * k) * 0.5f, 0, 0);
      break;
    }
    case R_INTRUDER:
    case R_ALARM: {  // red flashing (alarm: faster, with white strobe)
      bool on = ((now / (ring == R_ALARM ? 90 : 160)) % 2) == 0;
      for (int i = 0; i < NUM_LEDS; i++)
        if (on) setPx(i, 1, 0, 0, ring == R_ALARM && i % 3 == 0 ? 0.6f : 0);
      break;
    }
  }
  neoShow();
}

// ------------------------------------------------------------------ commands
static char cmd[64];
static int clen = 0;

static void handle(char* c) {
  char* arg = strchr(c, ' ');
  if (arg) *arg++ = 0;
  bool ok = true;
  if (!strcmp(c, "PING")) {
    Monitor.println("PONG");
    return;
  } else if (!strcmp(c, "MODE") && arg) {
    if (!strcmp(arg, "drive")) { mode = M_DRIVE; ring = R_DRIVE; arm(); }
    else if (!strcmp(arg, "park")) { mode = M_PARK; ring = R_ARMED; arm(); }
    else if (!strcmp(arg, "off")) { mode = M_OFF; ring = R_OFF; }
    else ok = false;
  } else if (!strcmp(c, "RING") && arg) {
    ok = false;
    for (int i = 0; i < 6; i++)
      if (!strcmp(arg, RING_NAMES[i])) { ring = (Ring)i; ok = true; }
  } else if (!strcmp(c, "THREAT") && arg) {
    threatDeg = atof(arg);
    char* lv = strchr(arg, ' ');
    threatLevel = lv ? atoi(lv + 1) : 0;
    threatMs = millis();
    return;  // frequent: no ack
  } else if (!strcmp(c, "CHIRP")) {
    chirpMs = millis();
  } else if (!strcmp(c, "BRIGHT") && arg) {
    int b = atoi(arg);
    bright = b < 0 ? 0 : b > 255 ? 255 : b;
  } else if (!strcmp(c, "LED0") && arg) {
    led0Deg = atoi(arg);
    char* cw = strchr(arg, ' ');
    ringCw = cw ? atoi(cw + 1) != 0 : true;
  } else ok = false;
  char s[80];
  snprintf(s, sizeof s, "%s %s%s%s", ok ? "OK" : "ERR", c, arg ? " " : "", arg ? arg : "");
  Monitor.println(s);
}

static void pollCommands() {
  while (Monitor.available()) {
    int ch = Monitor.read();
    if (ch < 0) break;
    if (ch == '\r') continue;
    if (ch == '\n') {
      cmd[clen] = 0;
      if (clen) handle(cmd);
      clen = 0;
    } else if (clen < (int)sizeof cmd - 1) cmd[clen++] = (char)ch;
  }
}

// ------------------------------------------------------------------ main
void setup() {
  Bridge.begin();
  Monitor.begin();
  delay(1200);
  neoInit();
  memset(px, 0, sizeof px);
  neoShow();
  GPS_SERIAL.begin(9600);
  Wire.begin();
  Wire1.begin();
  imuOk = imuInit();
  for (int i = 0; i < 50 && imuOk; i++) {  // settle the gravity estimate
    if (imuRead()) for (int k = 0; k < 3; k++) glp[k] += 0.1f * ((k == 0 ? ax : k == 1 ? ay : az) - glp[k]);
    delay(10);
  }
  arm();
  Monitor.println("TRAX MCU ready");
}

void loop() {
  static unsigned long lastImu = 0, lastI = 0, lastG = 0, lastH = 0, lastRing = 0, lastCmd = 0, lastRetry = 0;
  static unsigned long imuFails = 0;
  pumpGps();
  unsigned long now = millis();

  if (now - lastImu >= 10) {  // 100 Hz
    lastImu = now;
    if (imu && imuRead()) {
      imuOk = true;
      imuFails = 0;
      detect();
    } else if (imu && ++imuFails > 20) imuOk = false;
  }
  if (!imu && now - lastRetry > 3000) {  // sensor unplugged at boot: keep looking
    lastRetry = now;
    imuOk = imuInit();
  }
  if (now - lastI >= 50 && imuOk) {
    lastI = now;
    char s[80];
    snprintf(s, sizeof s, "I %.3f %.3f %.3f %.1f %.1f %.1f", ax, ay, az, gx, gy, gz);
    Monitor.println(s);
  }
  if (now - lastG >= 1000) {
    lastG = now;
    char s[120];
    if (gpsFix())
      snprintf(s, sizeof s, "G 1 %d %.6f %.6f %.1f %.0f %.1f", satsUsed, lat, lon, isnan(speedKmh) ? 0.0 : speedKmh,
               isnan(courseDeg) ? 0.0 : courseDeg, isnan(hdop) ? 99.0 : hdop);
    else
      snprintf(s, sizeof s, "G 0 %d - - - - -", satsUsed);
    Monitor.println(s);
  }
  if (now - lastH >= 2000) {
    lastH = now;
    char s[80];
    snprintf(s, sizeof s, "H %s %s imu=%d gps=%d up=%lu", MODE_NAMES[mode], RING_NAMES[ring], imuOk ? 1 : 0,
             now - lastGpsByte < 3000 ? 1 : 0, now / 1000);
    Monitor.println(s);
  }
  if (now - lastRing >= 20) {  // 50 Hz animation
    lastRing = now;
    renderRing();
  }
  if (now - lastCmd >= 25) {
    lastCmd = now;
    pollCommands();
  }
}
