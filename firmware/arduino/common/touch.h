#pragma once
// Capacitive touch monitor for ESP32-S3
// Uses ESP32-S3 built-in touch sensors (GPIO 1–14 capable of touch sensing).
//
// ESP32-S3 touch works differently from classic ESP32:
//   - touchRead(pin) returns a raw count (higher = less touched, inverted from classic)
//   - A "touched" event fires when raw value DROPS below the threshold
//   - Typical untouched baseline: 50,000–80,000 counts
//   - Typical touched value:       5,000–20,000 counts
//   - Default threshold: 40,000 (adjust via touchInit / touchSetThreshold)
//
// Usage:
//   1. touchInit(pins, count, threshold) in setup()
//   2. Call touchTick() from loop() — returns true if any event fired
//   3. Read events with touchDrainEvent(&evt)
//   4. Publish topic: device/{id}/touch/event  { pin, value, touched }

#include <Arduino.h>
#include "config.h"

// Generic ESP32-S3 touch-capable defaults.
// Actual board exposure varies by revision and attached peripherals.
#define TOUCH_DEFAULT_PINS   { 1, 2, 3, 4, 5, 6, 7 }
#define TOUCH_MAX_PINS       12
#define TOUCH_DEFAULT_THRESH 40000UL   // tune per board; lower = less sensitive
#define TOUCH_DEBOUNCE_MS    120UL     // ignore state flip within this window

struct TouchEvent {
    int      pin;
    uint32_t value;
    bool     touched;    // true=press, false=release
};

// ── State ─────────────────────────────────────────────────────────────────────
static int      _touchPins[TOUCH_MAX_PINS];
static int      _touchPinCount    = 0;
static uint32_t _touchThreshold   = TOUCH_DEFAULT_THRESH;
static bool     _touchState[TOUCH_MAX_PINS];          // current state (true = pressed)
static unsigned long _touchLastChangeMs[TOUCH_MAX_PINS]; // debounce timestamps

// Small event FIFO
#define TOUCH_EVT_BUF 8
static TouchEvent _touchEvtBuf[TOUCH_EVT_BUF];
static int        _touchEvtHead = 0, _touchEvtTail = 0;
static bool       _touchInitialized = false;

static inline bool _touchEvtEmpty() { return _touchEvtHead == _touchEvtTail; }
static inline void _touchEvtPush(const TouchEvent& e) {
    int next = (_touchEvtTail + 1) % TOUCH_EVT_BUF;
    if (next == _touchEvtHead) return; // full — drop oldest? just skip
    _touchEvtBuf[_touchEvtTail] = e;
    _touchEvtTail = next;
}
static inline bool _touchEvtPop(TouchEvent& e) {
    if (_touchEvtEmpty()) return false;
    e = _touchEvtBuf[_touchEvtHead];
    _touchEvtHead = (_touchEvtHead + 1) % TOUCH_EVT_BUF;
    return true;
}

// ── Public API ────────────────────────────────────────────────────────────────

// Call in setup(). pins = array of GPIO numbers, count = how many, threshold = raw count
// Pass threshold = 0 to keep the default TOUCH_DEFAULT_THRESH.
void touchInit(const int* pins, int count, uint32_t threshold = 0) {
    _touchPinCount = min(count, TOUCH_MAX_PINS);
    _touchThreshold = threshold > 0 ? threshold : TOUCH_DEFAULT_THRESH;
    for (int i = 0; i < _touchPinCount; i++) {
        _touchPins[i]           = pins[i];
        _touchState[i]          = false;
        _touchLastChangeMs[i]   = 0;
        // Read baseline (discard first reading — often unstable after init)
        touchRead(pins[i]);
        delay(10);
        touchRead(pins[i]);
    }
    _touchEvtHead = _touchEvtTail = 0;
    _touchInitialized = true;
    Serial.printf("[TOUCH] Init: %d pins, threshold=%lu\n", _touchPinCount, _touchThreshold);
}

// Update threshold at runtime (for calibration command)
void touchSetThreshold(uint32_t threshold) {
    _touchThreshold = threshold;
}

// Returns true if any touch-state changed this tick (event enqueued).
// Call from loop().
bool touchTick() {
    if (!_touchInitialized || _touchPinCount == 0) return false;
    bool anyChange = false;
    unsigned long now = millis();
    for (int i = 0; i < _touchPinCount; i++) {
        uint32_t val = touchRead(_touchPins[i]);
        bool pressed = (val < _touchThreshold);
        if (pressed != _touchState[i]) {
            if (now - _touchLastChangeMs[i] >= TOUCH_DEBOUNCE_MS) {
                _touchState[i]        = pressed;
                _touchLastChangeMs[i] = now;
                TouchEvent evt = { _touchPins[i], val, pressed };
                _touchEvtPush(evt);
                anyChange = true;
                Serial.printf("[TOUCH] pin=%d val=%lu %s\n",
                    _touchPins[i], (unsigned long)val, pressed ? "PRESS" : "RELEASE");
            }
        }
    }
    return anyChange;
}

// Drain next event from FIFO. Returns false when empty.
bool touchDrainEvent(TouchEvent& out) {
    return _touchEvtPop(out);
}

// Read raw value for a specific pin (for diagnostics / threshold calibration)
uint32_t touchReadRaw(int pin) {
    return touchRead(pin);
}

// Returns true if any monitored pin is currently pressed
bool touchAnyPressed() {
    for (int i = 0; i < _touchPinCount; i++) {
        if (_touchState[i]) return true;
    }
    return false;
}

// Return current state of a specific pin
bool touchIsPinPressed(int pin) {
    for (int i = 0; i < _touchPinCount; i++) {
        if (_touchPins[i] == pin) return _touchState[i];
    }
    return false;
}

bool touchIsInitialized() { return _touchInitialized; }
int  touchPinCount()       { return _touchPinCount; }
