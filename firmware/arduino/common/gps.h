#pragma once
// GNSS management for A7670E via AT+CGNSSINFO
// Converts DDMM.MMMM NMEA format to decimal degrees.

#include <Arduino.h>
#include "modem.h"

struct GpsData {
    double  lat;        // decimal degrees, negative = South
    double  lon;        // decimal degrees, negative = West
    float   altitude;   // metres
    float   speed;      // km/h
    float   hdop;
    int     satellites;
    bool    valid;
    char    date[16];      // date from module e.g. "240326"
    char    timestamp[24]; // UTC from module e.g. "040512.0"
};

static bool _gnssPowered = false;
static unsigned long _gnssLastPowerChangeMs = 0;

// Convert NMEA DDMM.MMMM to decimal degrees
static double _nmeaToDecimal(const char* val) {
    double raw = atof(val);
    int deg = (int)(raw / 100);
    double minutes = raw - (deg * 100.0);
    return deg + (minutes / 60.0);
}

// Power GNSS on or off
bool gpsSetPower(bool on) {
    if (on) {
        if (_gnssPowered) return true;
        const unsigned long now = millis();
        const unsigned long cooldownMs = 1500;
        if (_gnssLastPowerChangeMs > 0 && (now - _gnssLastPowerChangeMs) < cooldownMs) {
            delay(cooldownMs - (now - _gnssLastPowerChangeMs));
        }
        bool ok = false;
        for (int attempt = 0; attempt < 3 && !ok; attempt++) {
            _atFlushRx(100);
            ok = atCmd("AT+CGNSSPWR=1", 10000);
            if (!ok) delay(1500);
        }
        if (!ok) return false;
        atCmd("AT+CGNSSMODE=3", 5000); // GPS + BeiDou + GLONASS
        delay(200);
        _gnssPowered = true;
        _gnssLastPowerChangeMs = millis();
    } else {
        if (!_gnssPowered) return true;
        bool ok = false;
        for (int attempt = 0; attempt < 2 && !ok; attempt++) {
            _atFlushRx(100);
            ok = atCmd("AT+CGNSSPWR=0", 5000);
            if (!ok) delay(500);
        }
        if (!ok) return false;
        delay(200);
        _gnssPowered = false;
        _gnssLastPowerChangeMs = millis();
    }
    return true;
}

bool gpsIsPowered() { return _gnssPowered; }

// Query current fix. Returns true if data is valid (satellites > 0).
// +CGNSSINFO: <mode>,<GPS_sats>,<GLON_sats>,<BEI_sats>,<lat>,<N/S>,<lon>,<E/W>,<date>,<UTC>,<alt>,<speed>,<course>,<PDOP>,<HDOP>,<VDOP>
bool gpsGetFix(GpsData& out) {
    char resp[256];
    if (!atCmdResp("AT+CGNSSINFO", resp, sizeof(resp), 3000)) {
        out.valid = false;
        return false;
    }

    // Expect prefix "+CGNSSINFO: ..."
    char* p = strstr(resp, "+CGNSSINFO:");
    if (!p) { out.valid = false; return false; }
    p += 12; // skip "+CGNSSINFO: "
    if (*p == ' ') p++;

    // Parse comma-separated fields
    char fields[16][32];
    int fi = 0;
    char* tok = strtok(p, ",");
    while (tok && fi < 16) {
        strncpy(fields[fi++], tok, 31);
        tok = strtok(nullptr, ",");
    }
    if (fi < 11) { out.valid = false; return false; }

    // fields[0]=mode, [1]=GPS sats, [2]=GLON sats, [3]=BEI sats
    // [4]=lat, [5]=N/S, [6]=lon, [7]=E/W
    // [8]=date, [9]=UTC, [10]=alt, [11]=speed, [12]=course
    // [14]=HDOP
    int sats = atoi(fields[1]) + atoi(fields[2]) + atoi(fields[3]);
    if (sats == 0 || strlen(fields[4]) == 0) {
        out.valid = false;
        return false;
    }

    out.lat = _nmeaToDecimal(fields[4]);
    if (fields[5][0] == 'S') out.lat = -out.lat;

    out.lon = _nmeaToDecimal(fields[6]);
    if (fields[7][0] == 'W') out.lon = -out.lon;

    out.altitude  = atof(fields[10]);
    out.speed     = atof(fields[11]);
    out.satellites = sats;
    out.hdop      = (fi > 14) ? atof(fields[14]) : 0.0f;
    out.valid     = true;

    out.date[0] = '\0';
    out.timestamp[0] = '\0';
    if (fi > 8) {
        strncpy(out.date, fields[8], sizeof(out.date) - 1);
        out.date[sizeof(out.date) - 1] = '\0';
    }
    if (fi > 9) {
        strncpy(out.timestamp, fields[9], sizeof(out.timestamp) - 1);
        out.timestamp[sizeof(out.timestamp) - 1] = '\0';
    }

    return true;
}

// ── GNSS start modes ──────────────────────────────────────────────────────────
// Hot start  (RST=2): reuse almanac + ephemeris — fastest fix, valid if < 2 h stale
// Warm start (RST=1): reuse almanac, discard ephemeris — moderate fix time
// Cold start (RST=0): discard all data — slowest but most reliable after long power-off
// Call one of these before polling gpsGetFix() to improve TTFF.

bool gpsHotStart() {
    if (!_gnssPowered) return false;
    return atCmd("AT+CGNSSRST=2", 8000);
}

bool gpsWarmStart() {
    if (!_gnssPowered) return false;
    return atCmd("AT+CGNSSRST=1", 8000);
}

bool gpsColdStart() {
    // Power-cycle then restart — full almanac re-acquire
    gpsSetPower(false);
    delay(1500);
    if (!gpsSetPower(true)) return false;
    delay(500);
    return atCmd("AT+CGNSSRST=0", 8000);
}

// ── Assisted GPS (network-based time/location assist) ────────────────────────
// Requires active data connection. Dramatically reduces TTFF when first used.
// Send AT+CAGPSAUTO=1 once — module downloads AGPS data automatically.
bool gpsSetAgps(bool enable) {
    char cmd[32];
    snprintf(cmd, sizeof(cmd), "AT+CAGPSAUTO=%d", enable ? 1 : 0);
    return atCmd(cmd, 12000);
}

// Trigger one immediate AGPS download (manual, non-auto mode)
bool gpsFetchAgps() {
    return atCmd("AT+CAGPS", 30000);
}

// ── Force fix with timeout ────────────────────────────────────────────────────
// Poll every pollMs until we get a valid fix or timeoutMs elapses.
// Returns true and fills `out` on success, false on timeout.
// Call gpsWarmStart() or gpsHotStart() before this for faster acquisition.
bool gpsWaitForFix(GpsData& out, unsigned long timeoutMs, unsigned long pollMs = 2000) {
    if (!_gnssPowered) {
        if (!gpsSetPower(true)) return false;
        delay(500);
    }
    unsigned long t0 = millis();
    while (millis() - t0 < timeoutMs) {
        if (gpsGetFix(out) && out.valid) return true;
        unsigned long remaining = timeoutMs - (millis() - t0);
        delay((unsigned long)min((unsigned long)pollMs, remaining));
    }
    out.valid = false;
    return false;
}

// ── GNSS info helper ──────────────────────────────────────────────────────────
// Returns the number of tracked satellites without requiring a valid fix.
// Useful for diagnostics ("searching…" vs "no antenna").
int gpsGetSatelliteCount() {
    char resp[256];
    if (!atCmdResp("AT+CGNSSINFO", resp, sizeof(resp), 3000)) return -1;
    char* p = strstr(resp, "+CGNSSINFO:");
    if (!p) return 0;
    p += 12;
    if (*p == ' ') p++;
    char fields[8][32];
    int fi = 0;
    char* tok = strtok(p, ",");
    while (tok && fi < 8) { strncpy(fields[fi++], tok, 31); tok = strtok(nullptr, ","); }
    if (fi < 4) return 0;
    return atoi(fields[1]) + atoi(fields[2]) + atoi(fields[3]);
}
