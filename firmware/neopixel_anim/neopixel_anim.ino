// Adafruit 12-LED RGBW NeoPixel ring (SK6812) animation test for the Arduino UNO Q's STM32.
// Wiring: 5V -> 5V, GND -> GND, DIN -> D6.
//
// Tests every LED in every colour, kept dim (max 24/255) so the board's USB power is safe:
//   1. "loading" spinner: a comet with a fading tail goes round 3 times
//   2. progress bar: the ring fills LED by LED, then clears
// in red, then green, then blue, then white, and repeats.
// Driver is the same as neopixel_test.ino (D6 found at startup, cycle-counted bit timing).

#include <Arduino_RouterBridge.h>

static const int PIN = 6;
static const int NUM_LEDS = 12;
static const uint8_t MAX_LEVEL = 24;  // brightest any channel gets (of 255): keeps the ring ~25 mA total

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


static uint8_t frame[NUM_LEDS * 4];  // G, R, B, W per LED

static void setLed(int i, const uint8_t c[4], float level) {  // c = R, G, B, W on/off, level 0-1
  uint8_t v = (uint8_t)(MAX_LEVEL * level + 0.5f);
  frame[i * 4 + 0] = c[1] ? v : 0;
  frame[i * 4 + 1] = c[0] ? v : 0;
  frame[i * 4 + 2] = c[2] ? v : 0;
  frame[i * 4 + 3] = c[3] ? v : 0;
}

static void clearFrame() { memset(frame, 0, sizeof frame); }

static const uint8_t COLOURS[4][4] = {{1, 0, 0, 0}, {0, 1, 0, 0}, {0, 0, 1, 0}, {0, 0, 0, 1}};
static const char* NAMES[4] = {"RED", "GREEN", "BLUE", "WHITE"};

static void spinner(const uint8_t c[4]) {
  const int TAIL = 5, STEPS_PER_LED = 4;  // sub-steps make the motion smooth
  for (int s = 0; s < 3 * NUM_LEDS * STEPS_PER_LED; s++) {
    float head = (float)s / STEPS_PER_LED;
    clearFrame();
    for (int i = 0; i < NUM_LEDS; i++) {
      float behind = head - i;
      while (behind < 0) behind += NUM_LEDS;  // distance behind the head, round the ring
      if (behind < TAIL) {
        float l = 1.0f - behind / TAIL;
        setLed(i, c, l * l);  // squared: a nicer fade
      }
    }
    sendPixels(frame, sizeof frame);
    delay(16);
  }
}

static void progress(const uint8_t c[4]) {
  clearFrame();
  for (int i = 0; i < NUM_LEDS; i++) {
    for (int f = 1; f <= 6; f++) {  // fade each LED in
      setLed(i, c, f / 6.0f);
      sendPixels(frame, sizeof frame);
      delay(20);
    }
    delay(60);
  }
  delay(400);
  for (int f = 10; f >= 0; f--) {  // fade the full ring out
    for (int i = 0; i < NUM_LEDS; i++) setLed(i, c, f / 10.0f);
    sendPixels(frame, sizeof frame);
    delay(30);
  }
  delay(200);
}

void setup() {
  Bridge.begin();
  Monitor.begin();
  delay(1500);
  Monitor.println("\n=== NeoPixel ring animation: spinner + progress bar, all 12 LEDs ===");
  if (!findPin()) {
    Monitor.println("Could not identify D6's GPIO register. Not driving the ring.");
    while (true) delay(1000);
  }
  uint32_t hz = measureCpuHz();
  cyc_bit = hz / 800000;
  cyc_t0h = hz / 3333333;
  cyc_t1h = hz / 1666666;
  clearFrame();
  sendPixels(frame, sizeof frame);
}

void loop() {
  for (int c = 0; c < 4; c++) {
    Monitor.print("spinner + progress: ");
    Monitor.println(NAMES[c]);
    spinner(COLOURS[c]);
    progress(COLOURS[c]);
  }
}
