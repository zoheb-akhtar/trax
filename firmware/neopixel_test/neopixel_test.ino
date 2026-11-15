// Adafruit 12-LED RGBW NeoPixel ring (SK6812 RGBW) test for the Arduino UNO Q's STM32.
//
// Wiring: ring 5V -> 5V, GND -> GND, DIN -> D6. No resistor, no level shifter.
// Lights ONLY the first LED at very low brightness (8 / 255), cycling red, green, blue, white
// once a second. The other 11 LEDs are sent "off".
//
// Why bit-banged: the Adafruit_NeoPixel library doesn't support the UNO Q's Zephyr core, and
// digitalWrite() is far too slow for the 800 kHz NeoPixel signal. This writes the pin's GPIO
// register directly and times every bit with the Cortex-M33 cycle counter (interrupts off for
// ~0.4 ms per frame).
//
// To be safe with core versions that map D6 differently, the sketch finds D6's GPIO port/bit
// at startup by toggling D6 and seeing which output register bit changes.

#include <Arduino_RouterBridge.h>

static const int PIN = 6;
static const int NUM_LEDS = 12;
static const uint8_t LEVEL = 8;  // brightness 0-255: 8 is very dim (~3%)

// STM32U585 GPIO ports A..I (non-secure aliases), ODR at +0x14, BSRR at +0x18
static const uint32_t GPIO_BASE = 0x42020000, GPIO_STRIDE = 0x400;
static volatile uint32_t* bsrr = nullptr;
static uint32_t mask = 0;

// Cortex-M33 cycle counter
#define DEMCR (*(volatile uint32_t*)0xE000EDFC)
#define DWT_CTRL (*(volatile uint32_t*)0xE0001000)
#define DWT_CYCCNT (*(volatile uint32_t*)0xE0001004)

static uint32_t cyc_t0h, cyc_t1h, cyc_bit;  // timings in CPU cycles

static bool findPin() {
  pinMode(PIN, OUTPUT);
  uint32_t low[9], high[9];
  digitalWrite(PIN, LOW);
  delay(2);
  for (int p = 0; p < 9; p++) low[p] = *(volatile uint32_t*)(GPIO_BASE + p * GPIO_STRIDE + 0x14);
  digitalWrite(PIN, HIGH);
  delay(2);
  for (int p = 0; p < 9; p++) high[p] = *(volatile uint32_t*)(GPIO_BASE + p * GPIO_STRIDE + 0x14);
  digitalWrite(PIN, LOW);
  int found = 0;
  for (int p = 0; p < 9; p++) {
    uint32_t diff = low[p] ^ high[p];
    if (diff && !(diff & (diff - 1))) {  // exactly one bit changed in this port
      bsrr = (volatile uint32_t*)(GPIO_BASE + p * GPIO_STRIDE + 0x18);
      mask = diff;
      found++;
      char s[60];
      snprintf(s, sizeof s, "D6 = GPIO%c pin %d", 'A' + p, 31 - __builtin_clz(diff));
      Monitor.println(s);
    }
  }
  return found == 1;
}

static uint32_t measureCpuHz() {
  DEMCR |= (1u << 24);  // enable trace (needed for the cycle counter)
  DWT_CTRL |= 1u;       // start the cycle counter
  uint32_t c0 = DWT_CYCCNT;
  delay(100);
  return (DWT_CYCCNT - c0) * 10u;
}

// SK6812: bit period 1.25 us; "0" = 0.3 us high, "1" = 0.6 us high
static void sendPixels(const uint8_t* bytes, int n) {
  uint32_t primask;
  __asm volatile("mrs %0, primask\n cpsid i" : "=r"(primask)::"memory");
  uint32_t t = DWT_CYCCNT;
  for (int i = 0; i < n; i++) {
    for (uint8_t bit = 0x80; bit; bit >>= 1) {
      while (DWT_CYCCNT - t < cyc_bit) {}
      t = DWT_CYCCNT;
      *bsrr = mask;  // high
      uint32_t hi = (bytes[i] & bit) ? cyc_t1h : cyc_t0h;
      while (DWT_CYCCNT - t < hi) {}
      *bsrr = mask << 16;  // low
    }
  }
  while (DWT_CYCCNT - t < cyc_bit) {}
  __asm volatile("msr primask, %0" ::"r"(primask) : "memory");
  delayMicroseconds(300);  // latch (reset) time: > 80 us low
}

// first LED = (r, g, b, w), the other 11 off. RGBW NeoPixels take bytes in G, R, B, W order.
static void show(uint8_t r, uint8_t g, uint8_t b, uint8_t w) {
  uint8_t buf[NUM_LEDS * 4] = {0};
  buf[0] = g;
  buf[1] = r;
  buf[2] = b;
  buf[3] = w;
  sendPixels(buf, sizeof buf);
}

void setup() {
  Bridge.begin();
  Monitor.begin();
  delay(1500);
  Monitor.println("\n=== NeoPixel RGBW ring test: first LED only, brightness 8/255 ===");

  if (!findPin()) {
    Monitor.println("Could not identify D6's GPIO register. Not driving the ring.");
    while (true) delay(1000);
  }
  uint32_t hz = measureCpuHz();
  cyc_bit = hz / 800000;           // 1.25 us
  cyc_t0h = hz / 3333333;          // 0.30 us
  cyc_t1h = hz / 1666666;          // 0.60 us
  char s[80];
  snprintf(s, sizeof s, "CPU %lu MHz; bit %lu cycles, 0-high %lu, 1-high %lu",
           (unsigned long)(hz / 1000000), (unsigned long)cyc_bit, (unsigned long)cyc_t0h,
           (unsigned long)cyc_t1h);
  Monitor.println(s);

  show(0, 0, 0, 0);  // clear all 12 (a ring can power up showing random colours)
  delay(10);
  show(0, 0, 0, 0);
}

void loop() {
  static const char* names[] = {"RED", "GREEN", "BLUE", "WHITE"};
  static int step = 0;
  uint8_t r = step == 0 ? LEVEL : 0, g = step == 1 ? LEVEL : 0, b = step == 2 ? LEVEL : 0,
          w = step == 3 ? LEVEL : 0;
  show(r, g, b, w);
  Monitor.print("LED 0 should be: ");
  Monitor.println(names[step]);
  step = (step + 1) % 4;
  delay(1000);
}
