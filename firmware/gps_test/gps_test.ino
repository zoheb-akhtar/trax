// NEO-6M (HW-248) GPS test for the Arduino UNO Q's STM32 (MCU) side.
//
// Wiring: GPS VCC -> 3.3V, GND -> GND, GPS TX -> D0 (RX). GPS RX not connected.
// D0 is PB7 = USART1 RX, the first hardware serial port on the header (9600 baud is the
// NEO-6M default).
//
// Output (through the board's Linux side to the Mac's USB serial port):
//   NMEA $GPRMC,...          every raw sentence, as received
//   GPS fix=1 mode=3 sats=7 view=11 lat=42.339 lon=-71.087 speed_kmh=0.4 ...   once a second
// Viewer: python3 ~/trax/gps_test/gps_view.py

#include <Arduino_RouterBridge.h>

// On this board core (arduino:zephyr 0.11.0-rc5) the serial list is <usart1, lpuart1>:
//   Serial  = USART1 = D0 (RX, PB7) / D1 (TX, PB6)   <- the GPS
//   Serial1 = LPUART1 = the STM32 <-> Linux link used by Bridge/Monitor. Never touch it.
#define GPS_SERIAL Serial

static const unsigned long GPS_BAUD = 9600;

// latest parsed state
static bool rmcValid = false;     // RMC status 'A' = valid fix
static int ggaQuality = 0;        // 0 none, 1 GPS, 2 DGPS
static int fixMode = 1;           // GSA: 1 none, 2 = 2D, 3 = 3D
static int satsUsed = 0, satsInView = 0;
static double lat = NAN, lon = NAN, altM = NAN, hdop = NAN;
static double speedKmh = NAN, courseDeg = NAN;
static char utcTime[12] = "", utcDate[8] = "";

static unsigned long bytesTotal = 0, sentencesOk = 0, sentencesBad = 0, lastByteMs = 0;

static char line[128];
static int lineLen = 0;

// Split a sentence (without checksum) into comma-separated fields, in place.
static int splitFields(char* s, char* fields[], int maxFields) {
  int n = 0;
  fields[n++] = s;
  for (char* p = s; *p && n < maxFields; p++) {
    if (*p == ',') {
      *p = 0;
      fields[n++] = p + 1;
    }
  }
  return n;
}

static int hexVal(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  return -1;
}

// "4220.3456","N" -> 42.33909 (NMEA is ddmm.mmmm / dddmm.mmmm)
static double coord(const char* v, const char* hemi) {
  if (!*v || !*hemi) return NAN;
  double raw = atof(v);
  int deg = (int)(raw / 100);
  double d = deg + (raw - deg * 100) / 60.0;
  return (*hemi == 'S' || *hemi == 'W') ? -d : d;
}

static void parseSentence(char* s) {
  // checksum: XOR of everything between '$' and '*'
  char* star = strchr(s, '*');
  if (!star || star[1] == 0 || star[2] == 0) { sentencesBad++; return; }
  uint8_t sum = 0;
  for (char* p = s + 1; p < star; p++) sum ^= (uint8_t)*p;
  int want = hexVal(star[1]) * 16 + hexVal(star[2]);
  if (want != sum) { sentencesBad++; return; }
  sentencesOk++;
  *star = 0;

  char* f[24];
  int n = splitFields(s + 1, f, 24);
  const char* type = f[0] + 2;  // skip talker id (GP, GN, ...)

  if (!strcmp(type, "RMC") && n >= 10) {
    // $GPRMC,time,status,lat,N,lon,W,speed(knots),course,date,...
    strncpy(utcTime, f[1], sizeof utcTime - 1);
    rmcValid = f[2][0] == 'A';
    if (rmcValid) {
      lat = coord(f[3], f[4]);
      lon = coord(f[5], f[6]);
      speedKmh = *f[7] ? atof(f[7]) * 1.852 : NAN;
      courseDeg = *f[8] ? atof(f[8]) : NAN;
    }
    strncpy(utcDate, f[9], sizeof utcDate - 1);
  } else if (!strcmp(type, "GGA") && n >= 10) {
    // $GPGGA,time,lat,N,lon,W,quality,sats,hdop,alt,M,...
    ggaQuality = atoi(f[6]);
    satsUsed = atoi(f[7]);
    hdop = *f[8] ? atof(f[8]) : NAN;
    altM = *f[9] ? atof(f[9]) : NAN;
    if (ggaQuality > 0) {
      lat = coord(f[2], f[3]);
      lon = coord(f[4], f[5]);
    }
  } else if (!strcmp(type, "GSA") && n >= 3) {
    fixMode = atoi(f[2]);
  } else if (!strcmp(type, "GSV") && n >= 4) {
    satsInView = atoi(f[3]);
  }
}

static void printNum(const char* key, double v, int digits) {
  Monitor.print(key);
  if (isnan(v)) Monitor.print("-");
  else Monitor.print(v, digits);
}

static void printStatus() {
  bool fix = rmcValid || ggaQuality > 0;
  Monitor.print("GPS fix=");
  Monitor.print(fix ? 1 : 0);
  Monitor.print(" mode=");
  Monitor.print(fixMode);
  Monitor.print(" sats=");
  Monitor.print(satsUsed);
  Monitor.print(" view=");
  Monitor.print(satsInView);
  printNum(" lat=", fix ? lat : NAN, 6);
  printNum(" lon=", fix ? lon : NAN, 6);
  printNum(" speed_kmh=", fix ? speedKmh : NAN, 1);
  printNum(" course=", fix ? courseDeg : NAN, 0);
  printNum(" alt_m=", fix ? altM : NAN, 1);
  printNum(" hdop=", hdop, 1);
  Monitor.print(" utc=");
  Monitor.print(*utcTime ? utcTime : "-");
  Monitor.print(" date=");
  Monitor.print(*utcDate ? utcDate : "-");
  Monitor.print(" bytes=");
  Monitor.print(bytesTotal);
  Monitor.print(" ok=");
  Monitor.print(sentencesOk);
  Monitor.print(" bad=");
  Monitor.println(sentencesBad);

  if (bytesTotal == 0 || millis() - lastByteMs > 3000) {
    Monitor.println("GPS-HINT no data on D0: check GPS TX -> D0, VCC 3.3V, GND (the NEO-6M LED blinks once a second only after a fix)");
  } else if (sentencesOk == 0 && sentencesBad > 3) {
    Monitor.println("GPS-HINT data arrives but every checksum fails: wrong baud rate? (NEO-6M default is 9600)");
  } else if (!fix) {
    Monitor.println("GPS-HINT receiving NMEA, no fix yet: needs open sky, first fix can take 1-5 min (much longer indoors)");
  }
}

void setup() {
  Bridge.begin();
  Monitor.begin();
  GPS_SERIAL.begin(GPS_BAUD);
  delay(1500);
  Monitor.println("\n=== NEO-6M GPS test: D0 (USART1 RX) @ 9600 ===");
}

void loop() {
  while (GPS_SERIAL.available()) {
    char c = GPS_SERIAL.read();
    bytesTotal++;
    lastByteMs = millis();
    if (c == '$') lineLen = 0;  // start of a sentence: resync
    if (c == '\r') continue;
    if (c == '\n') {
      line[lineLen] = 0;
      if (lineLen > 6 && line[0] == '$') {
        Monitor.print("NMEA ");
        Monitor.println(line);
        parseSentence(line);  // modifies line, so print first
      }
      lineLen = 0;
      continue;
    }
    if (lineLen < (int)sizeof line - 1) line[lineLen++] = c;
  }

  static unsigned long lastStatus = 0;
  if (millis() - lastStatus >= 1000) {
    lastStatus = millis();
    printStatus();
  }
}
