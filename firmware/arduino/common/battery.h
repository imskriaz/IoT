#pragma once
// MAX17048G Li-ion fuel gauge (I2C addr 0x36, actual SDA/SCL come from config.h)
// Datasheet: https://datasheets.maximintegrated.com/en/ds/MAX17048-MAX17049.pdf

#include <Wire.h>
#include "config.h"

#define MAX17048_ADDR    0x36
#define MAX17048_VCELL   0x02   // 12-bit voltage, 1.25 mV/LSB (upper 12 bits of 16)
#define MAX17048_SOC     0x04   // State of charge: MSB = whole %, LSB = 1/256 %
#define MAX17048_VERSION 0x08
#define MAX17048_COMMAND 0xFE

static bool _batBusSuspended = false;

static uint16_t _batReadReg(uint8_t reg) {
    Wire.beginTransmission(MAX17048_ADDR);
    Wire.write(reg);
    if (Wire.endTransmission(false) != 0) return 0xFFFF;
    Wire.requestFrom((uint8_t)MAX17048_ADDR, (uint8_t)2);
    if (Wire.available() < 2) return 0xFFFF;
    uint16_t val = (Wire.read() << 8) | Wire.read();
    return val;
}

void batteryInit() {
    _batBusSuspended = false;
    Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
}

// Returns state-of-charge as integer percent (0–100), or -1 on I2C error
int batterySOC() {
    if (_batBusSuspended) return -1;
    uint16_t raw = _batReadReg(MAX17048_SOC);
    if (raw == 0xFFFF) return -1;
    int pct = raw >> 8;           // integer part; fractional in low byte ignored
    return constrain(pct, 0, 100);
}

// Returns cell voltage in mV (e.g. 3850), or -1 on I2C error
int batteryVoltage_mV() {
    if (_batBusSuspended) return -1;
    uint16_t raw = _batReadReg(MAX17048_VCELL);
    if (raw == 0xFFFF) return -1;
    // Upper 12 bits, each bit = 1.25 mV
    return (raw >> 4) * 125 / 100;
}

// Returns true if fuel gauge responded on the bus
bool batteryPresent() {
    if (_batBusSuspended) return false;
    Wire.beginTransmission(MAX17048_ADDR);
    return (Wire.endTransmission() == 0);
}

// ── Charging detection (voltage-trend heuristic) ──────────────────────────────
// MAX17048 cannot report charge state directly. We infer it by tracking
// cell voltage samples over time: rising trend = charging, falling = discharging.
//
// batteryTick() must be called from loop() on a fixed interval (5–10 s).
// After ≥6 samples, batteryChargingState() becomes meaningful.
//
// Returns: 1 = charging, 0 = discharging, -1 = unknown (< 6 samples or stable)

#define BAT_TREND_SAMPLES    12     // keep 12 voltage readings (covers ~1 min at 5 s)
#define BAT_TREND_THRESHOLD  15     // mV delta over half-window to call it charging/discharging
#define BAT_FULL_MV          4180   // above this → likely full, report as not-charging

static int16_t  _batVHistory[BAT_TREND_SAMPLES];   // ring buffer of mV readings
static int      _batVHistIdx   = 0;
static int      _batVHistCount = 0;
static int      _batChargingState = -1;  // cached result
void batterySetSuspended(bool suspended) {
    _batBusSuspended = suspended;
    if (_batBusSuspended) {
        Wire.end();
    } else {
        Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
    }
}

void batteryTick() {
    if (_batBusSuspended) return;
    int mv = batteryVoltage_mV();
    if (mv < 0) return;  // I2C error — skip this sample
    _batVHistory[_batVHistIdx] = (int16_t)mv;
    _batVHistIdx = (_batVHistIdx + 1) % BAT_TREND_SAMPLES;
    if (_batVHistCount < BAT_TREND_SAMPLES) _batVHistCount++;

    if (_batVHistCount < 6) { _batChargingState = -1; return; }

    // Compare average of newest half vs oldest half
    int half = _batVHistCount / 2;
    long sumNew = 0, sumOld = 0;
    for (int i = 0; i < half; i++) {
        // newest-half: most recent 'half' entries going backwards
        int ni = (_batVHistIdx - 1 - i + BAT_TREND_SAMPLES) % BAT_TREND_SAMPLES;
        // oldest-half: entries before those
        int oi = (_batVHistIdx - 1 - half - i + BAT_TREND_SAMPLES) % BAT_TREND_SAMPLES;
        sumNew += _batVHistory[ni];
        sumOld += _batVHistory[oi];
    }
    int avgNew = (int)(sumNew / half);
    int avgOld = (int)(sumOld / half);
    int delta  = avgNew - avgOld;    // positive = rising voltage = charging

    if (avgNew >= BAT_FULL_MV && delta >= 0) {
        _batChargingState = -1;  // full / maintenance charge, ambiguous
    } else if (delta >= BAT_TREND_THRESHOLD) {
        _batChargingState = 1;   // charging
    } else if (delta <= -BAT_TREND_THRESHOLD) {
        _batChargingState = 0;   // discharging
    } else {
        _batChargingState = -1;  // stable / unknown
    }
}

// Returns 1=charging, 0=discharging, -1=unknown
int batteryChargingState() { return _batChargingState; }

// Convenience bool — true only when confident charging is detected
bool batteryIsCharging() { return _batChargingState == 1; }
