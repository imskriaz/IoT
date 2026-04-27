package com.devicebridge.android;

import android.content.Context;
import android.content.SharedPreferences;

import java.net.URI;
import java.util.Locale;
import java.util.UUID;

final class BridgeConfig {
    static final String PREFS = "iot_bridge";
    private static final String DEFAULT_TOPIC_PREFIX = "device";

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
        this.connectionConfigured = connectionConfigured;
        this.bridgeEnabled = bridgeEnabled;
    }

    static BridgeConfig load(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        migrateLegacyAutoConfig(prefs);
        String installId = ensureInstallId(prefs);
        boolean connectionConfigured = prefs.getBoolean("connection_configured", false);
        return new BridgeConfig(
                connectionConfigured ? prefs.getString("server_url", "") : "",
                connectionConfigured ? prefs.getString("api_key", "") : "",
                installId,
                connectionConfigured ? prefs.getString("transport_mode", "auto") : "auto",
                connectionConfigured ? prefs.getString("broker_host", "") : "",
                connectionConfigured ? prefs.getInt("broker_port", 1883) : 1883,
                connectionConfigured ? prefs.getString("broker_protocol", "mqtt") : "mqtt",
                connectionConfigured ? prefs.getString("username", "") : "",
                connectionConfigured ? prefs.getString("password", "") : "",
                connectionConfigured ? prefs.getString("device_id", "") : "",
                prefs.getString("topic_prefix", DEFAULT_TOPIC_PREFIX),
                connectionConfigured,
                connectionConfigured && prefs.getBoolean("bridge_enabled", false)
        );
    }

    void save(Context context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString("server_url", serverUrl)
                .putString("api_key", apiKey)
                .putString("install_id", installId)
                .putString("transport_mode", transportMode)
                .putString("broker_host", brokerHost)
                .putInt("broker_port", brokerPort)
                .putString("broker_protocol", brokerProtocol)
                .putString("username", username)
                .putString("password", password)
                .putString("device_id", deviceId)
                .putString("topic_prefix", topicPrefix)
                .putBoolean("connection_configured", connectionConfigured)
                .putBoolean("bridge_enabled", bridgeEnabled)
                .apply();
    }

    static void clearConnection(Context context, boolean rotateInstallId) {
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
                connectionConfigured,
                bridgeEnabled
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
                connectionConfigured,
                bridgeEnabled
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
                configured,
                bridgeEnabled
        );
    }

    boolean hasDashboardAccess() {
        return hasDashboardCredentials() && !hasLoopbackDashboardUrl();
    }

    boolean hasDashboardCredentials() {
        return !serverUrl.isEmpty() && !apiKey.isEmpty();
    }

    boolean hasLoopbackDashboardUrl() {
        return isLoopbackServerUrl(serverUrl);
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
            return "MQTT first";
        }
        if (usesHttpTransport()) {
            return "Dashboard HTTP";
        }
        return "Realtime MQTT";
    }

    boolean hasProvisionedMqttConfig() {
        return connectionConfigured && !brokerHost.isEmpty() && !deviceId.isEmpty();
    }

    boolean hasHttpBridgeConfig() {
        return connectionConfigured && hasDashboardAccess() && !deviceId.isEmpty();
    }

    String bootstrapUrl() {
        return serverUrl.isEmpty() ? "" : serverUrl + "/v1/android/bridge/bootstrap";
    }

    String brokerUri() {
        String host = brokerHost;
        if (host.isEmpty()) {
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

    private static boolean isLoopbackServerUrl(String value) {
        String cleaned = clean(value);
        if (cleaned.isEmpty()) {
            return false;
        }
        String host = "";
        try {
            URI uri = new URI(cleaned);
            host = clean(uri.getHost());
        } catch (Exception ignored) {
        }
        if (host.isEmpty()) {
            String withoutScheme = cleaned;
            int schemeIndex = withoutScheme.indexOf("://");
            if (schemeIndex >= 0) {
                withoutScheme = withoutScheme.substring(schemeIndex + 3);
            }
            int atIndex = withoutScheme.lastIndexOf('@');
            if (atIndex >= 0) {
                withoutScheme = withoutScheme.substring(atIndex + 1);
            }
            int slashIndex = withoutScheme.indexOf('/');
            if (slashIndex >= 0) {
                withoutScheme = withoutScheme.substring(0, slashIndex);
            }
            if (withoutScheme.startsWith("[")) {
                int closeIndex = withoutScheme.indexOf(']');
                host = closeIndex >= 0 ? withoutScheme.substring(1, closeIndex) : withoutScheme;
            } else {
                int colonIndex = withoutScheme.lastIndexOf(':');
                host = colonIndex > 0 ? withoutScheme.substring(0, colonIndex) : withoutScheme;
            }
        }
        String normalized = host.toLowerCase(Locale.ROOT);
        return "localhost".equals(normalized)
                || "0.0.0.0".equals(normalized)
                || "127.0.0.1".equals(normalized)
                || normalized.startsWith("127.")
                || "::1".equals(normalized)
                || "0:0:0:0:0:0:0:1".equals(normalized);
    }
}


