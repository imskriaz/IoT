package com.devicebridge.android;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import java.util.Locale;
import java.util.UUID;

final class BridgeConfig {
    static final String PREFS = "iot_bridge";
    private static final String SECURE_PREFS = "iot_bridge_secure";
    private static final String TAG = "BridgeConfig";
    private static final String DEFAULT_TOPIC_PREFIX = "device";
    // SEC-08: secrets live in Keystore-backed preferences. Keystoreless
    // devices (rare, broken KEK provisioning) fall back to the legacy store
    // rather than losing the bridge configuration entirely.
    private static volatile Boolean secureAvailable;

    final boolean allowInsecureTransport;

    final String serverUrl;
    final String apiKey;
    final String installId;
    final String transportMode;
    final String brokerHost;
    final int brokerPort;
    final String brokerProtocol;
    final String username;
    final String password;
    final String deviceId;
    final String topicPrefix;
    final String encryptionKey;
    final boolean encryptIncomingSms;
    final boolean connectionConfigured;
    final boolean bridgeEnabled;

    BridgeConfig(
            String serverUrl,
            String apiKey,
            String installId,
            String transportMode,
            String brokerHost,
            int brokerPort,
            String brokerProtocol,
            String username,
            String password,
            String deviceId,
            String topicPrefix,
            String encryptionKey,
            boolean encryptIncomingSms,
            boolean connectionConfigured,
            boolean bridgeEnabled
    ) {
        this.serverUrl = normalizeServerUrl(serverUrl);
        this.apiKey = clean(apiKey);
        this.installId = clean(installId);
        this.transportMode = normalizeTransportMode(transportMode);
        this.brokerHost = normalizeBrokerHost(brokerHost);
        this.brokerPort = brokerPort > 0 ? brokerPort : 1883;
        this.brokerProtocol = normalizeBrokerProtocol(brokerProtocol);
        this.username = clean(username);
        this.password = password == null ? "" : password;
        this.deviceId = clean(deviceId);
        this.topicPrefix = normalizeTopicPrefix(topicPrefix);
        this.encryptionKey = clean(encryptionKey);
        this.encryptIncomingSms = encryptIncomingSms && !this.encryptionKey.isEmpty();
        this.connectionConfigured = connectionConfigured;
        this.bridgeEnabled = bridgeEnabled;
        this.allowInsecureTransport = false;
    }

    private BridgeConfig(
            String serverUrl,
            String apiKey,
            String installId,
            String transportMode,
            String brokerHost,
            int brokerPort,
            String brokerProtocol,
            String username,
            String password,
            String deviceId,
            String topicPrefix,
            String encryptionKey,
            boolean encryptIncomingSms,
            boolean connectionConfigured,
            boolean bridgeEnabled,
            boolean allowInsecureTransport
    ) {
        this.serverUrl = normalizeServerUrl(serverUrl);
        this.apiKey = clean(apiKey);
        this.installId = clean(installId);
        this.transportMode = normalizeTransportMode(transportMode);
        this.brokerHost = normalizeBrokerHost(brokerHost);
        this.brokerPort = brokerPort > 0 ? brokerPort : 1883;
        this.brokerProtocol = normalizeBrokerProtocol(brokerProtocol);
        this.username = clean(username);
        this.password = password == null ? "" : password;
        this.deviceId = clean(deviceId);
        this.topicPrefix = normalizeTopicPrefix(topicPrefix);
        this.encryptionKey = clean(encryptionKey);
        this.encryptIncomingSms = encryptIncomingSms && !this.encryptionKey.isEmpty();
        this.connectionConfigured = connectionConfigured;
        this.bridgeEnabled = bridgeEnabled;
        this.allowInsecureTransport = allowInsecureTransport;
    }

    static BridgeConfig load(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        migrateLegacyAutoConfig(prefs);
        migrateLegacySecrets(context, prefs);
        SharedPreferences secrets = securePrefs(context);
        String installId = ensureInstallId(prefs);
        boolean connectionConfigured = prefs.getBoolean("connection_configured", false);
        return new BridgeConfig(
                connectionConfigured ? prefs.getString("server_url", "") : "",
                connectionConfigured ? readSecret(secrets, prefs, "api_key") : "",
                installId,
                connectionConfigured ? prefs.getString("transport_mode", "auto") : "auto",
                connectionConfigured ? prefs.getString("broker_host", "") : "",
                connectionConfigured ? prefs.getInt("broker_port", 1883) : 1883,
                connectionConfigured ? prefs.getString("broker_protocol", "mqtt") : "mqtt",
                connectionConfigured ? readSecret(secrets, prefs, "username") : "",
                connectionConfigured ? readSecret(secrets, prefs, "password") : "",
                connectionConfigured ? prefs.getString("device_id", "") : "",
                prefs.getString("topic_prefix", DEFAULT_TOPIC_PREFIX),
                readSecret(secrets, prefs, "encryption_key"),
                prefs.getBoolean("encrypt_incoming_sms", false),
                connectionConfigured,
                connectionConfigured && prefs.getBoolean("bridge_enabled", false),
                prefs.getBoolean("allow_insecure_transport", false)
        );
    }

    /** Keystore-backed preferences; null when unavailable on this device. */
    private static SharedPreferences securePrefs(Context context) {
        if (secureAvailable != null && !secureAvailable) {
            return null;
        }
        try {
            MasterKey masterKey = new MasterKey.Builder(context)
                    .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                    .build();
            SharedPreferences secure = EncryptedSharedPreferences.create(
                    context,
                    SECURE_PREFS,
                    masterKey,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            );
            secureAvailable = true;
            return secure;
        } catch (Exception error) {
            Log.w(TAG, "Encrypted preferences unavailable, using legacy store", error);
            secureAvailable = false;
            return null;
        }
    }

    private static String readSecret(SharedPreferences secure, SharedPreferences legacy, String key) {
        String value = secure == null ? "" : secure.getString(key, "");
        if (value != null && !value.isEmpty()) {
            return value;
        }
        return legacy == null ? "" : legacy.getString(key, "");
    }

    private static void writeSecret(Context context, SharedPreferences secure, SharedPreferences legacy, String key, String value) {
        String safe = value == null ? "" : value;
        if (secure != null) {
            secure.edit().putString(key, safe).apply();
        }
        // Legacy copy is kept as a migration fallback for devices where the
        // Keystore path fails intermittently; it is wiped when the secret is
        // empty so disconnection truly clears credentials.
        legacy.edit().putString(key, safe).apply();
    }

    /** One-time move of plaintext secrets into the encrypted store. */
    private static void migrateLegacySecrets(Context context, SharedPreferences prefs) {
        if (prefs.getBoolean("secrets_migrated", false)) {
            return;
        }
        try {
            SharedPreferences secure = securePrefs(context);
            if (secure == null) {
                return; // retry on next load when the Keystore recovers
            }
            SharedPreferences.Editor editor = secure.edit();
            String[] secretKeys = {"api_key", "username", "password", "encryption_key"};
            for (String key : secretKeys) {
                if (!secure.contains(key) && prefs.contains(key)) {
                    editor.putString(key, prefs.getString(key, ""));
                }
            }
            editor.apply();
            prefs.edit().putBoolean("secrets_migrated", true).apply();
        } catch (Exception error) {
            Log.w(TAG, "Secret migration deferred", error);
        }
    }

    void save(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        SharedPreferences secrets = securePrefs(context);
        prefs.edit()
                .putString("server_url", serverUrl)
                .putString("install_id", installId)
                .putString("transport_mode", transportMode)
                .putString("broker_host", brokerHost)
                .putInt("broker_port", brokerPort)
                .putString("broker_protocol", brokerProtocol)
                .putString("device_id", deviceId)
                .putString("topic_prefix", topicPrefix)
                .putBoolean("encrypt_incoming_sms", encryptIncomingSms)
                .putBoolean("connection_configured", connectionConfigured)
                .putBoolean("bridge_enabled", bridgeEnabled)
                .putBoolean("allow_insecure_transport", allowInsecureTransport)
                .apply();
        writeSecret(context, secrets, prefs, "api_key", apiKey);
        writeSecret(context, secrets, prefs, "username", username);
        writeSecret(context, secrets, prefs, "password", password);
        writeSecret(context, secrets, prefs, "encryption_key", encryptionKey);
    }

    static void clearConnection(Context context, boolean rotateInstallId) {
        try {
            SharedPreferences secure = securePrefs(context);
            if (secure != null) {
                secure.edit()
                        .remove("api_key")
                        .remove("username")
                        .remove("password")
                        .remove("encryption_key")
                        .apply();
            }
        } catch (Exception ignored) {
        }
        SharedPreferences.Editor editor = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .remove("server_url")
                .remove("api_key")
                .remove("transport_mode")
                .remove("broker_host")
                .remove("broker_port")
                .remove("broker_protocol")
                .remove("username")
                .remove("password")
                .remove("device_id")
                .remove("encryption_key")
                .remove("encrypt_incoming_sms")
                .remove("last_dashboard_url")
                .remove("env_defaults_stamp")
                .putBoolean("connection_configured", false)
                .putBoolean("bridge_enabled", false);
        if (rotateInstallId) {
            editor.putString("install_id", UUID.randomUUID().toString());
        }
        editor.apply();
    }

    BridgeConfig withBridgeEnabled(boolean enabled) {
        return new BridgeConfig(
                serverUrl,
                apiKey,
                installId,
                transportMode,
                brokerHost,
                brokerPort,
                brokerProtocol,
                username,
                password,
                deviceId,
                topicPrefix,
                encryptionKey,
                encryptIncomingSms,
                connectionConfigured,
                enabled
        );
    }

    BridgeConfig withDashboardAccess(String nextServerUrl, String nextApiKey) {
        return new BridgeConfig(
                nextServerUrl,
                nextApiKey,
                installId,
                transportMode,
                brokerHost,
                brokerPort,
                brokerProtocol,
                username,
                password,
                deviceId,
                topicPrefix,
                encryptionKey,
                encryptIncomingSms,
                connectionConfigured,
                bridgeEnabled,
                allowInsecureTransport
        );
    }

    BridgeConfig withProvisionedMqtt(
            String nextBrokerHost,
            int nextBrokerPort,
            String nextBrokerProtocol,
            String nextUsername,
            String nextPassword,
            String nextDeviceId,
            String nextTopicPrefix
    ) {
        return new BridgeConfig(
                serverUrl,
                apiKey,
                installId,
                transportMode,
                nextBrokerHost,
                nextBrokerPort,
                nextBrokerProtocol,
                nextUsername,
                nextPassword,
                nextDeviceId,
                nextTopicPrefix,
                encryptionKey,
                encryptIncomingSms,
                connectionConfigured,
                bridgeEnabled,
                allowInsecureTransport
        );
    }

    BridgeConfig withEncryption(String nextEncryptionKey, boolean nextEncryptIncomingSms) {
        return new BridgeConfig(
                serverUrl,
                apiKey,
                installId,
                transportMode,
                brokerHost,
                brokerPort,
                brokerProtocol,
                username,
                password,
                deviceId,
                topicPrefix,
                nextEncryptionKey,
                nextEncryptIncomingSms,
                connectionConfigured,
                bridgeEnabled,
                allowInsecureTransport
        );
    }

    BridgeConfig withConnectionConfigured(boolean configured) {
        return new BridgeConfig(
                serverUrl,
                apiKey,
                installId,
                transportMode,
                brokerHost,
                brokerPort,
                brokerProtocol,
                username,
                password,
                deviceId,
                topicPrefix,
                encryptionKey,
                encryptIncomingSms,
                configured,
                bridgeEnabled,
                allowInsecureTransport
        );
    }

    boolean hasDashboardAccess() {
        return !serverUrl.isEmpty() && !apiKey.isEmpty();
    }

    boolean usesHttpTransport() {
        return "http".equals(transportMode);
    }

    boolean usesAutoTransport() {
        return "auto".equals(transportMode);
    }

    boolean hasBridgeConnectionConfig() {
        if (usesHttpTransport()) {
            return hasHttpBridgeConfig();
        }
        if (usesAutoTransport()) {
            return hasProvisionedMqttConfig() || hasHttpBridgeConfig();
        }
        return hasProvisionedMqttConfig();
    }

    String transportDisplayLabel() {
        if (usesAutoTransport()) {
            return "Smart dashboard link";
        }
        if (usesHttpTransport()) {
            return "Dashboard link";
        }
        return "Dashboard link";
    }

    boolean hasProvisionedMqttConfig() {
        return connectionConfigured && !brokerHost.isEmpty() && !deviceId.isEmpty();
    }

    /** True when the configured transport is TLS or plaintext was opted into. */
    boolean transportSecurityOk() {
        if (usesHttpTransport() || usesAutoTransport()) {
            return allowInsecureTransport || !serverUrl.toLowerCase(Locale.ROOT).startsWith("http://");
        }
        return "mqtts".equals(brokerProtocol) || allowInsecureTransport;
    }

    boolean hasHttpBridgeConfig() {
        return connectionConfigured && !serverUrl.isEmpty() && !apiKey.isEmpty() && !deviceId.isEmpty();
    }

    String bootstrapUrl() {
        return serverUrl.isEmpty() ? "" : serverUrl + "/v1/android/bridge/bootstrap";
    }

    String brokerUri() {
        String host = brokerHost;
        if (host.isEmpty()) {
            return "";
        }
        // SEC-08: plaintext MQTT requires the explicit insecure-transport
        // opt-in (Settings > Developer). mqtts is always allowed.
        if (!allowInsecureTransport && !"mqtts".equals(brokerProtocol)) {
            return "";
        }

        if (host.matches("^[a-zA-Z][a-zA-Z0-9+.-]*://.*")) {
            String normalized = normalizeMqttScheme(host);
            return hasExplicitPort(normalized) ? normalized : normalized + ":" + brokerPort;
        }
        if (hasExplicitPort(host)) {
            return normalizeMqttScheme(defaultProtocolPrefix() + host);
        }
        return normalizeMqttScheme(defaultProtocolPrefix() + host) + ":" + brokerPort;
    }

    String topic(String suffix) {
        return topicPrefix + "/" + deviceId + "/" + suffix;
    }

    private static String ensureInstallId(SharedPreferences prefs) {
        String installId = prefs.getString("install_id", "");
        if (installId == null || installId.trim().isEmpty()) {
            installId = UUID.randomUUID().toString();
            prefs.edit().putString("install_id", installId).apply();
        }
        return installId;
    }

    private static void migrateLegacyAutoConfig(SharedPreferences prefs) {
        if (prefs.contains("connection_configured")) {
            return;
        }
        String legacyStamp = clean(prefs.getString("env_defaults_stamp", ""));
        if (legacyStamp.isEmpty()) {
            return;
        }
        prefs.edit()
                .remove("server_url")
                .remove("api_key")
                .remove("transport_mode")
                .remove("broker_host")
                .remove("broker_port")
                .remove("broker_protocol")
                .remove("username")
                .remove("password")
                .remove("device_id")
                .remove("env_defaults_stamp")
                .putBoolean("connection_configured", false)
                .putBoolean("bridge_enabled", false)
                .apply();
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }

    private static String normalizeServerUrl(String value) {
        return clean(value).replaceAll("/+$", "");
    }

    private static String normalizeTopicPrefix(String value) {
        String cleaned = clean(value)
                .replace('\\', '/')
                .replaceAll("^/+", "")
                .replaceAll("/+$", "")
                .replaceAll("/+", "/");
        return cleaned.isEmpty() ? "device" : cleaned;
    }

    private static String normalizeBrokerHost(String value) {
        String cleaned = clean(value).replaceAll("/+$", "");
        if (cleaned.startsWith("mqtt://")) {
            cleaned = cleaned.substring("mqtt://".length());
        } else if (cleaned.startsWith("mqtts://")) {
            cleaned = cleaned.substring("mqtts://".length());
        } else if (cleaned.startsWith("tcp://")) {
            cleaned = cleaned.substring("tcp://".length());
        } else if (cleaned.startsWith("ssl://")) {
            cleaned = cleaned.substring("ssl://".length());
        }
        return cleaned.replaceAll("^/+", "").replaceAll("/+$", "");
    }

    private static String normalizeBrokerProtocol(String value) {
        String protocol = clean(value).toLowerCase(Locale.ROOT);
        return "mqtts".equals(protocol) ? "mqtts" : "mqtt";
    }

    private static String normalizeTransportMode(String value) {
        String mode = clean(value).toLowerCase(Locale.ROOT);
        if ("http".equals(mode)) return "http";
        if ("mqtt".equals(mode)) return "mqtt";
        return "auto";
    }

    private String defaultProtocolPrefix() {
        return "mqtts".equals(brokerProtocol) ? "ssl://" : "tcp://";
    }

    private static boolean hasExplicitPort(String value) {
        String cleaned = clean(value);
        int schemeIndex = cleaned.indexOf("://");
        if (schemeIndex >= 0) {
            cleaned = cleaned.substring(schemeIndex + 3);
        }
        int slashIndex = cleaned.indexOf('/');
        if (slashIndex >= 0) {
            cleaned = cleaned.substring(0, slashIndex);
        }
        int atIndex = cleaned.lastIndexOf('@');
        if (atIndex >= 0) {
            cleaned = cleaned.substring(atIndex + 1);
        }
        if (cleaned.startsWith("[")) {
            int closeIndex = cleaned.indexOf(']');
            return closeIndex >= 0
                    && cleaned.length() > closeIndex + 2
                    && cleaned.charAt(closeIndex + 1) == ':'
                    && cleaned.substring(closeIndex + 2).matches("\\d+");
        }
        int colonIndex = cleaned.lastIndexOf(':');
        return colonIndex > 0
                && colonIndex == cleaned.indexOf(':')
                && cleaned.substring(colonIndex + 1).matches("\\d+");
    }

    private static String normalizeMqttScheme(String value) {
        if (value.startsWith("mqtt://")) {
            return "tcp://" + value.substring("mqtt://".length());
        }
        if (value.startsWith("mqtts://")) {
            return "ssl://" + value.substring("mqtts://".length());
        }
        return value;
    }
}


