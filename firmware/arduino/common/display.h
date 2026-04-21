#pragma once
// SSD1306 128×64 OLED display support.
// Enabled only when ENABLE_DISPLAY is defined (compile-time flag).
//
// Libraries required (install via Library Manager):
//   - Adafruit SSD1306  by Adafruit  (≥ 2.5)
//   - Adafruit GFX Lib  by Adafruit  (dependency)
//   - Adafruit BusIO    by Adafruit  (dependency)
//
// Uses the same I2C bus as the MAX17048G battery gauge (SDA/SCL defined in config.h).
// The SSD1306 default I2C address is 0x3C (some modules use 0x3D — check the solder
// bridge on the back of your display module).
//
// The display auto-dims after DISPLAY_DIM_MS ms of no activity, turns off after
// DISPLAY_OFF_MS ms. It wakes on any new content.

#ifdef ENABLE_DISPLAY

#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include "config.h"

// ── Configuration ─────────────────────────────────────────────────────────────
#ifndef DISPLAY_WIDTH
#  define DISPLAY_WIDTH   128
#endif
#ifndef DISPLAY_HEIGHT
#  define DISPLAY_HEIGHT  64
#endif
#ifndef DISPLAY_I2C_ADDR
#  define DISPLAY_I2C_ADDR  0x3C
#endif
#ifndef DISPLAY_RESET_PIN
#  define DISPLAY_RESET_PIN  -1   // share ESP32 reset
#endif
#ifndef DISPLAY_DIM_MS
#  define DISPLAY_DIM_MS   30000   // dim after 30 s
#endif
#ifndef DISPLAY_OFF_MS
#  define DISPLAY_OFF_MS   60000   // off after 60 s
#endif

// ── State ─────────────────────────────────────────────────────────────────────
static Adafruit_SSD1306 _oled(DISPLAY_WIDTH, DISPLAY_HEIGHT, &Wire, DISPLAY_RESET_PIN);
static bool    _displayOk        = false;
static unsigned long _displayLastActivity = 0;
static bool    _displayOn        = false;
static uint8_t _displayContrast  = 255;
static bool    _displayInverted  = false;
static bool    _displayFlipped   = false;

// ── Init ──────────────────────────────────────────────────────────────────────
inline bool displayInit() {
    _displayOk = _oled.begin(SSD1306_SWITCHCAPVCC, DISPLAY_I2C_ADDR);
    if (!_displayOk) {
        Serial.printf("[OLED] SSD1306 not found at 0x%02X — check wiring\n", DISPLAY_I2C_ADDR);
        return false;
    }
    _oled.clearDisplay();
    _oled.setTextSize(1);
    _oled.setTextColor(SSD1306_WHITE);
    _oled.setCursor(0, 0);
    _oled.print("IoT Manager");
    _oled.display();
    _displayOn = true;
    _displayLastActivity = millis();
    Serial.printf("[OLED] SSD1306 %dx%d at 0x%02X OK\n",
                  DISPLAY_WIDTH, DISPLAY_HEIGHT, DISPLAY_I2C_ADDR);
    return true;
}

// ── Wake / dim / sleep ────────────────────────────────────────────────────────
inline void _displayWake() {
    if (!_displayOk) return;
    if (!_displayOn) {
        _oled.ssd1306_command(SSD1306_DISPLAYON);
        _oled.ssd1306_command(SSD1306_SETCONTRAST);
        _oled.ssd1306_command(_displayContrast);
        _displayOn = true;
    }
    _displayLastActivity = millis();
}

// Call from loop() to manage dim/off timer.
inline void displayTick() {
    if (!_displayOk || !_displayOn) return;
    unsigned long idle = millis() - _displayLastActivity;
    if (idle >= DISPLAY_OFF_MS) {
        _oled.ssd1306_command(SSD1306_DISPLAYOFF);
        _displayOn = false;
    } else if (idle >= DISPLAY_DIM_MS) {
        _oled.ssd1306_command(SSD1306_SETCONTRAST);
        _oled.ssd1306_command(4);  // very dim
    }
}

inline bool displayAvailable() {
    return _displayOk;
}

inline void displayClear() {
    if (!_displayOk) return;
    _displayWake();
    _oled.clearDisplay();
    _oled.display();
}

inline void displaySetPower(bool on) {
    if (!_displayOk) return;
    if (on) {
        _displayWake();
        _oled.ssd1306_command(SSD1306_DISPLAYON);
        _displayOn = true;
        return;
    }
    _oled.ssd1306_command(SSD1306_DISPLAYOFF);
    _displayOn = false;
}

inline void displaySetContrast(uint8_t contrast) {
    if (!_displayOk) return;
    _displayContrast = contrast;
    if (!_displayOn) return;
    _oled.ssd1306_command(SSD1306_SETCONTRAST);
    _oled.ssd1306_command(_displayContrast);
    _displayLastActivity = millis();
}

inline void displaySetInverted(bool inverted) {
    if (!_displayOk) return;
    _displayWake();
    _displayInverted = inverted;
    _oled.invertDisplay(inverted);
    _oled.display();
}

inline void displayToggleInvert() {
    displaySetInverted(!_displayInverted);
}

inline void displaySetFlipped(bool flipped) {
    if (!_displayOk) return;
    _displayWake();
    _displayFlipped = flipped;
    _oled.setRotation(flipped ? 2 : 0);
    _oled.display();
}

inline void displayToggleFlip() {
    displaySetFlipped(!_displayFlipped);
}

inline void displayDrawText(const char* text, int x, int y, int size, bool white = true, bool clearFirst = true) {
    if (!_displayOk) return;
    _displayWake();
    if (clearFirst) _oled.clearDisplay();
    _oled.setTextSize(size < 1 ? 1 : size);
    _oled.setTextColor(white ? SSD1306_WHITE : SSD1306_BLACK, white ? SSD1306_BLACK : SSD1306_WHITE);
    _oled.setCursor(x < 0 ? 0 : x, y < 0 ? 0 : y);
    _oled.print(text ? text : "");
    _oled.display();
}

// ── Update display with live status ──────────────────────────────────────────
// Call whenever key state changes (status publish, MQTT connect/disconnect, etc.)
// signal: 0–100   battery: 0–100 (or -1 if unknown)   ip: nullable
inline void displayUpdate(const char* deviceId, int signal, int battery,
                          const char* networkType, const char* ip,
                          bool mqttConn, bool gpsOn, unsigned long uptimeSec) {
    if (!_displayOk) return;
    _displayWake();

    _oled.clearDisplay();
    _oled.setTextSize(1);
    _oled.setTextColor(SSD1306_WHITE);

    // Row 0: device ID (truncated to 18 chars)
    _oled.setCursor(0, 0);
    char idStr[20];
    snprintf(idStr, sizeof(idStr), "%.18s", deviceId ? deviceId : "?");
    _oled.print(idStr);

    // Row 1: signal + battery
    _oled.setCursor(0, 10);
    char row1[24];
    if (battery >= 0) {
        snprintf(row1, sizeof(row1), "Sig:%3d%% Bat:%3d%%", signal, battery);
    } else {
        snprintf(row1, sizeof(row1), "Sig:%3d%% Bat: N/A", signal);
    }
    _oled.print(row1);

    // Row 2: network type + IP
    _oled.setCursor(0, 20);
    char row2[24];
    snprintf(row2, sizeof(row2), "%-4s %s",
             networkType ? networkType : "---",
             ip && ip[0] ? ip : "0.0.0.0");
    _oled.print(row2);

    // Row 3: MQTT + GPS status
    _oled.setCursor(0, 30);
    char row3[24];
    snprintf(row3, sizeof(row3), "MQTT:%s GPS:%s",
             mqttConn ? "OK " : "ERR",
             gpsOn    ? "ON " : "OFF");
    _oled.print(row3);

    // Row 4: uptime
    _oled.setCursor(0, 40);
    char row4[24];
    unsigned long h = uptimeSec / 3600;
    unsigned long m = (uptimeSec % 3600) / 60;
    unsigned long s = uptimeSec % 60;
    snprintf(row4, sizeof(row4), "Up: %02lu:%02lu:%02lu", h, m, s);
    _oled.print(row4);

    // Row 5: scrolling status bar (firmware version)
    _oled.setCursor(0, 52);
    _oled.setTextSize(1);
    _oled.print("v" FIRMWARE_VERSION);

    _oled.display();
}

// ── Show a notification / alert ───────────────────────────────────────────────
// Briefly shows a full-screen alert (2 s), then reverts to status.
// For SMS, calls, etc. Set statusCb to a function that redraws normal status.
inline void displayNotify(const char* title, const char* detail) {
    if (!_displayOk) return;
    _displayWake();

    _oled.clearDisplay();
    _oled.setTextSize(2);
    _oled.setCursor(0, 0);
    _oled.print(title);
    _oled.setTextSize(1);
    _oled.setCursor(0, 22);
    // Word-wrap detail at 21 chars per line
    char d[64];
    strncpy(d, detail ? detail : "", sizeof(d) - 1);
    d[sizeof(d) - 1] = '\0';
    _oled.print(d);
    _oled.display();
    _displayLastActivity = millis();
}

#else  // !ENABLE_DISPLAY — stub out all symbols so callers compile unconditionally

inline bool displayInit()                                                    { return false; }
inline void displayTick()                                                    {}
inline bool displayAvailable()                                               { return false; }
inline void displayClear()                                                   {}
inline void displaySetPower(bool)                                            {}
inline void displaySetContrast(uint8_t)                                      {}
inline void displaySetInverted(bool)                                         {}
inline void displayToggleInvert()                                            {}
inline void displaySetFlipped(bool)                                          {}
inline void displayToggleFlip()                                              {}
inline void displayDrawText(const char*, int, int, int, bool, bool)          {}
inline void displayUpdate(const char*, int, int, const char*, const char*,
                          bool, bool, unsigned long)                         {}
inline void displayNotify(const char*, const char*)                         {}

#endif  // ENABLE_DISPLAY
