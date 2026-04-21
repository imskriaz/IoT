#pragma once
// WS2812B NeoPixel status LED (GPIO38, 1 pixel)

#include <Adafruit_NeoPixel.h>
#include "config.h"

Adafruit_NeoPixel _strip(RGB_COUNT, RGB_PIN, NEO_GRB + NEO_KHZ800);

// ── LED states ────────────────────────────────────────────────────────────────
// Each state maps to a colour or animation pattern (see ledTick).
//
//  State                Colour/Pattern            Event
//  LED_OFF              off                       user disabled or deep sleep
//  LED_SETUP_MODE       yellow slow pulse         onboarding AP/config mode
//  LED_CONNECTING       amber pulse               booting, waiting for LTE/data
//  LED_NETWORK_READY    aqua solid                LTE/data ready, waiting for MQTT
//  LED_WEAK_SIGNAL      violet/amber pulse        connected but weak signal
//  LED_TASK_PENDING     ice-blue pulse            queued command/event work pending
//  LED_CONNECTED        emerald solid             MQTT connected, idle
//  LED_BUSY             royal blue solid          outgoing call or active task
//  LED_CALL_RINGING     blue fast blink           incoming call
//  LED_LOW_BATTERY      amber-red blink           battery critically low
//  LED_CHARGING         mint pulse                battery charging
//  LED_SMS_RECEIVED     purple 1-s flash          incoming SMS
//  LED_SMS_SENT         cool-white quick flash    outgoing SMS accepted by modem
//  LED_SMS_DELIVERED    mint flash                delivery report received
//  LED_GPS_FIX          cyan 0.5-s flash          GPS location published
//  LED_OTA              cyan slow pulse           OTA download/flash in progress
//  LED_OTA_SUCCESS      green flash               OTA finished successfully
//  LED_OTA_FAILED       orange-red flash          OTA failed
//  LED_STORAGE_ERROR    orange flash              SD/storage operation failed
//  LED_NO_SIGNAL        red solid                 LTE registration/signal problem
//  LED_FACTORY_RESET    red/yellow alternate      factory reset in progress
//  LED_ERROR            red fast blink            fatal error (e.g. modem absent)

enum LedState {
    LED_OFF,
    LED_SETUP_MODE,
    LED_CONNECTING,
    LED_NETWORK_READY,
    LED_WEAK_SIGNAL,
    LED_TASK_PENDING,
    LED_CONNECTED,
    LED_BUSY,
    LED_CALL_RINGING,
    LED_LOW_BATTERY,
    LED_CHARGING,
    LED_SMS_RECEIVED,
    LED_SMS_SENT,
    LED_SMS_DELIVERED,
    LED_GPS_FIX,
    LED_OTA,
    LED_OTA_SUCCESS,
    LED_OTA_FAILED,
    LED_STORAGE_ERROR,
    LED_NO_SIGNAL,
    LED_FACTORY_RESET,
    LED_ERROR
};

static LedState      _ledState      = LED_OFF;
static LedState      _ledPrevState  = LED_CONNECTED;  // restored after flash events
static unsigned long _ledBlinkMs    = 0;
static bool          _ledBlinkOn    = false;
static unsigned long _ledFlashEnd   = 0;  // time when flash event auto-reverts
static bool          _ledEnabled    = true;

static bool ledIsFlashState(LedState state) {
    switch (state) {
        case LED_SMS_RECEIVED:
        case LED_SMS_SENT:
        case LED_SMS_DELIVERED:
        case LED_GPS_FIX:
        case LED_OTA_SUCCESS:
        case LED_OTA_FAILED:
        case LED_STORAGE_ERROR:
            return true;
        default:
            return false;
    }
}

static LedState _ledFlashBaseState() {
    if (ledIsFlashState(_ledState)) {
        return _ledPrevState;
    }
    return _ledState;
}

LedState ledGetState() { return _ledState; }

// ── Raw colour set ────────────────────────────────────────────────────────────
void ledSet(uint8_t r, uint8_t g, uint8_t b) {
    if (!_ledEnabled) { _strip.clear(); _strip.show(); return; }
    _strip.setPixelColor(0, _strip.Color(r, g, b));
    _strip.show();
}

void ledInit() {
    _strip.begin();
    _strip.setBrightness(40);  // ~16% — visible but not blinding
    _strip.clear();
    _strip.show();
}

// ── Enable / disable ─────────────────────────────────────────────────────────
void ledSetEnabled(bool en) {
    _ledEnabled = en;
    if (!en) { _strip.clear(); _strip.show(); }
    else ledSet(0, 0, 0);  // re-apply current state on next ledTick call
}
bool ledIsEnabled() { return _ledEnabled; }

// ── State machine ─────────────────────────────────────────────────────────────
void ledSetState(LedState state) {
    _ledState = state;
    if (!_ledEnabled) return;
    switch (state) {
        case LED_OFF:             ledSet(0,   0,   0);   break;
        case LED_NETWORK_READY:   ledSet(0,   180, 210); break;  // aqua
        case LED_CONNECTED:       ledSet(0,   220, 70);  break;  // emerald
        case LED_BUSY:            ledSet(40,  90,  255); break;  // royal blue
        case LED_NO_SIGNAL:       ledSet(220, 0,   0);   break;  // red
        // animated states handled in ledTick:
        case LED_SETUP_MODE:
        case LED_CONNECTING:
        case LED_WEAK_SIGNAL:
        case LED_TASK_PENDING:
        case LED_CALL_RINGING:
        case LED_LOW_BATTERY:
        case LED_CHARGING:
        case LED_OTA:
        case LED_FACTORY_RESET:
        case LED_ERROR:
            _ledBlinkMs = 0;
            _ledBlinkOn = false;
            break;
        // flash events — show colour immediately, auto-revert in ledTick
        case LED_SMS_RECEIVED:
            _ledPrevState = _ledFlashBaseState();
            ledSet(180, 0, 180);  // purple
            _ledFlashEnd = millis() + 1000;
            break;
        case LED_SMS_SENT:
            _ledPrevState = _ledFlashBaseState();
            ledSet(180, 180, 255);  // cool white
            _ledFlashEnd = millis() + 250;
            break;
        case LED_SMS_DELIVERED:
            _ledPrevState = _ledFlashBaseState();
            ledSet(0, 255, 120);  // mint
            _ledFlashEnd = millis() + 700;
            break;
        case LED_GPS_FIX:
            _ledPrevState = _ledFlashBaseState();
            ledSet(0, 200, 180);  // teal/cyan
            _ledFlashEnd = millis() + 500;
            break;
        case LED_OTA_SUCCESS:
            _ledPrevState = _ledFlashBaseState();
            ledSet(0, 255, 60);
            _ledFlashEnd = millis() + 900;
            break;
        case LED_OTA_FAILED:
            _ledPrevState = _ledFlashBaseState();
            ledSet(255, 60, 0);
            _ledFlashEnd = millis() + 1200;
            break;
        case LED_STORAGE_ERROR:
            _ledPrevState = _ledFlashBaseState();
            ledSet(255, 110, 0);
            _ledFlashEnd = millis() + 1000;
            break;
    }
}

// ── Tick — call from loop() ───────────────────────────────────────────────────
void ledTick() {
    if (!_ledEnabled) return;

    unsigned long now = millis();

    // Auto-revert flash events (SMS, GPS fix)
    if (ledIsFlashState(_ledState) && now >= _ledFlashEnd) {
        ledSetState(_ledPrevState);
        return;
    }

    // Animated states
    switch (_ledState) {
        case LED_SETUP_MODE:
            if (now - _ledBlinkMs >= 700) {
                _ledBlinkMs = now;
                _ledBlinkOn = !_ledBlinkOn;
                _ledBlinkOn ? ledSet(255, 180, 0) : ledSet(40, 20, 0);
            }
            break;

        case LED_CONNECTING:
            if (now - _ledBlinkMs >= 450) {
                _ledBlinkMs = now;
                _ledBlinkOn = !_ledBlinkOn;
                _ledBlinkOn ? ledSet(255, 140, 0) : ledSet(60, 20, 0);
            }
            break;

        case LED_WEAK_SIGNAL:
            if (now - _ledBlinkMs >= 350) {
                _ledBlinkMs = now;
                _ledBlinkOn = !_ledBlinkOn;
                _ledBlinkOn ? ledSet(150, 0, 180) : ledSet(255, 90, 0);
            }
            break;

        case LED_TASK_PENDING:
            if (now - _ledBlinkMs >= 250) {
                _ledBlinkMs = now;
                _ledBlinkOn = !_ledBlinkOn;
                _ledBlinkOn ? ledSet(120, 210, 255) : ledSet(0, 25, 60);
            }
            break;

        case LED_LOW_BATTERY:
            if (now - _ledBlinkMs >= 600) {
                _ledBlinkMs = now;
                _ledBlinkOn = !_ledBlinkOn;
                _ledBlinkOn ? ledSet(255, 80, 0) : ledSet(80, 0, 0);
            }
            break;

        case LED_CHARGING:
            if (now - _ledBlinkMs >= 500) {
                _ledBlinkMs = now;
                _ledBlinkOn = !_ledBlinkOn;
                _ledBlinkOn ? ledSet(0, 255, 140) : ledSet(0, 60, 30);
            }
            break;

        case LED_ERROR:
            if (now - _ledBlinkMs >= 300) {
                _ledBlinkMs = now;
                _ledBlinkOn = !_ledBlinkOn;
                _ledBlinkOn ? ledSet(255, 0, 0) : ledSet(0, 0, 0);
            }
            break;

        case LED_CALL_RINGING:
            // Fast blue blink — 150 ms on/off
            if (now - _ledBlinkMs >= 150) {
                _ledBlinkMs = now;
                _ledBlinkOn = !_ledBlinkOn;
                _ledBlinkOn ? ledSet(0, 0, 255) : ledSet(0, 0, 0);
            }
            break;

        case LED_OTA:
            // Slow cyan pulse — 600 ms on/off
            if (now - _ledBlinkMs >= 600) {
                _ledBlinkMs = now;
                _ledBlinkOn = !_ledBlinkOn;
                _ledBlinkOn ? ledSet(0, 200, 200) : ledSet(0, 50, 50);
            }
            break;

        case LED_FACTORY_RESET:
            if (now - _ledBlinkMs >= 150) {
                _ledBlinkMs = now;
                _ledBlinkOn = !_ledBlinkOn;
                _ledBlinkOn ? ledSet(255, 0, 0) : ledSet(255, 180, 0);
            }
            break;

        default:
            break;
    }
}
