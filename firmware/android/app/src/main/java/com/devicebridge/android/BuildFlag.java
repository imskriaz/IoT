package com.devicebridge.android;

/**
 * Build-variant transport flags (SEC-08).
 *
 * Cleartext HTTP / plaintext MQTT is permitted only in debug builds (local
 * LAN development); release builds require TLS for both dashboard and broker
 * traffic, matching the network security config.
 */
final class BuildFlag {
    /** True when cleartext transport is allowed for this build variant. */
    static final boolean ALLOW_CLEARTEXT = BuildConfig.DEBUG;

    private BuildFlag() {
    }
}
