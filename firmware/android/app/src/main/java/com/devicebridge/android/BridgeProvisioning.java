package com.devicebridge.android;

import android.content.Context;
import android.content.Intent;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Locale;
import java.util.zip.Inflater;

final class BridgeProvisioning {
    // AND-03 provisioning input bounds: setup codes are small JSON documents;
    // anything larger is rejected before decode/inflate.
    private static final int MAX_CODE_LENGTH = 12 * 1024;
    private static final int MAX_COMPRESSED_BYTES = 8 * 1024;
    private static final int MAX_DECOMPRESSED_BYTES = 64 * 1024;

    private BridgeProvisioning() {
    }

    /** AND-03: decode and describe an imported setup code WITHOUT saving it.
     * Shown to the user for explicit confirmation before anything is applied. */
    static String describeProvisioningPayload(String rawPayload) throws JSONException {
        String trimmed = rawPayload == null ? "" : rawPayload.trim();
        if (trimmed.isEmpty()) {
            throw new IllegalArgumentException("Missing setup code");
        }
        String jsonText = decodeProvisioningText(trimmed);
        JSONObject json = new JSONObject(jsonText);
        StringBuilder summary = new StringBuilder();
        String deviceId = firstNonEmpty(json.optString("di", ""), nestedString(json, "device", "id"), "");
        summary.append("Device: ").append(deviceId.isEmpty() ? "(not set)" : deviceId);
        String transport = firstNonEmpty(json.optString("tm", ""), nestedString(json, "transport", "mode"), "auto");
        summary.append("\nTransport: ").append(normalizeTransportMode(transport, "auto"));
        String host = firstNonEmpty(json.optString("mh", ""), nestedString(json, "mqtt", "host"), "");
        if (!host.isEmpty()) {
            summary.append("\nBroker: ").append(host);
        }
        String serverUrl = firstNonEmpty(json.optString("su", ""), "");
        if (!serverUrl.isEmpty()) {
            String masked = serverUrl;
            int schemeIndex = masked.indexOf("://");
            if (schemeIndex > 0) {
                masked = masked.substring(0, schemeIndex + 3) + "…";
            }
            summary.append("\nServer: ").append(masked);
        }
        boolean encrypts = firstNonEmpty(json.optString("ek", "").isEmpty() ? "" : "1", "").length() > 0
                || nestedString(json, "sms", "encryption_key").length() > 0;
        if (encrypts) {
            summary.append("\nSMS encryption: enabled");
        }
        return summary.toString();
    }

    static BridgeConfig applyProvisioningPayload(Context context, String rawPayload) throws JSONException {
        String trimmed = rawPayload == null ? "" : rawPayload.trim();
        if (trimmed.isEmpty()) {
            throw new IllegalArgumentException("Missing setup code");
        }

        String jsonText = decodeProvisioningText(trimmed);
        JSONObject json = new JSONObject(jsonText);
        BridgeConfig current = BridgeConfig.load(context);
        String nextTransportMode = normalizeTransportMode(
                firstNonEmpty(
                        json.optString("tm", ""),
                        nestedString(json, "transport", "mode"),
                        ""
                ),
                "auto"
        );

        String nextHost = firstNonEmpty(
                json.optString("mh", ""),
                nestedString(json, "mqtt", "host"),
                nestedString(json, "mqtt", "ip"),
                ""
        );
        int nextPort = firstPositive(
                json.optInt("mp", 0),
                nestedInt(json, "mqtt", "port"),
                0
        );
        String nextProtocol = firstNonEmpty(
                json.optString("ml", ""),
                nestedString(json, "mqtt", "protocol"),
                inferBrokerProtocol(nextHost)
        );
        String nextUsername = firstNonEmpty(
                json.optString("mu", ""),
                nestedString(json, "mqtt", "username"),
                ""
        );
        String nextPassword = firstNonEmpty(
                json.optString("mw", ""),
                nestedString(json, "mqtt", "password"),
                ""
        );
        String nextDeviceId = firstNonEmpty(
                json.optString("di", ""),
                nestedString(json, "device", "id"),
                ""
        );
        String nextTopicPrefix = firstNonEmpty(
                json.optString("tp", ""),
                nestedString(json, "device", "topic_prefix"),
                ""
        );
        String nextServerUrl = firstNonEmpty(json.optString("su", ""));
        String nextApiKey = firstNonEmpty(json.optString("ak", ""));
        String nextEncryptionKey = firstNonEmpty(
                json.optString("ek", ""),
                nestedString(json, "sms", "encryption_key"),
                nestedString(json, "encryption", "key"),
                current.encryptionKey
        );
        boolean nextEncryptIncomingSms = json.has("er")
                ? json.optBoolean("er", false)
                : (json.optJSONObject("sms") != null
                    ? json.optJSONObject("sms").optBoolean("encrypt_received", current.encryptIncomingSms)
                    : current.encryptIncomingSms);
        boolean hasHttp = !nextServerUrl.isEmpty() && !nextApiKey.isEmpty();
        boolean hasMqtt = !nextHost.isEmpty();
        if (hasHttp && hasMqtt) {
            nextTransportMode = "auto";
        }

        if (nextDeviceId.isEmpty()) {
            throw new IllegalArgumentException("Setup code is missing device ID.");
        }
        if ("mqtt".equals(nextTransportMode) && !hasMqtt) {
            throw new IllegalArgumentException("Setup code is missing primary connection details.");
        }
        if ("http".equals(nextTransportMode)) {
            if (nextServerUrl.isEmpty()) {
                throw new IllegalArgumentException("Setup code is missing server URL.");
            }
            if (nextApiKey.isEmpty()) {
                throw new IllegalArgumentException("Setup code is missing API key.");
            }
        } else if ("auto".equals(nextTransportMode) && !hasMqtt && !hasHttp) {
            throw new IllegalArgumentException("Setup code is missing dashboard connection details.");
        }

        BridgeConfig updated = new BridgeConfig(
                nextServerUrl,
                nextApiKey,
                current.installId,
                nextTransportMode,
                nextHost,
                nextPort,
                nextProtocol,
                nextUsername,
                nextPassword,
                nextDeviceId,
                nextTopicPrefix,
                nextEncryptionKey,
                nextEncryptIncomingSms,
                true,
                current.bridgeEnabled
        );
        updated.save(context);
        BridgeEventLog.append(context, "Secure setup code imported");
        return updated;
    }

    static String extractSetupToken(Intent intent) {
        if (intent == null) {
            return "";
        }
        String directExtra = firstNonEmpty(
                intent.getStringExtra("setup_token"),
                intent.getStringExtra(Intent.EXTRA_TEXT)
        );
        if (!directExtra.isEmpty()) {
            return directExtra;
        }
        String data = intent.getDataString();
        if (data == null || data.trim().isEmpty()) {
            return "";
        }
        int schemeIndex = data.indexOf(':');
        if (schemeIndex > 0 && schemeIndex + 1 < data.length()) {
            return data.substring(schemeIndex + 1).trim();
        }
        return data.trim();
    }

    static String buildProvisioningSummary(BridgeConfig config) {
        return "Device ID: " + nonEmpty(config.deviceId);
    }

    // Package-visible for pure-JVM unit tests of the AND-03 bounds.
    static String decodeProvisioningText(String raw) {
        String normalized = raw.trim();
        int schemeIndex = normalized.indexOf(':');
        if (schemeIndex > 0) {
            normalized = normalized.substring(schemeIndex + 1).trim();
        }
        if (normalized.isEmpty()) {
            throw new IllegalArgumentException("Missing setup code");
        }
        // AND-03: bound the imported payload. A `k:` deep link previously
        // allowed unbounded compressed input (zip-bomb risk on the UI thread).
        if (normalized.length() > MAX_CODE_LENGTH) {
            throw new IllegalArgumentException("Setup code too large");
        }
        // java.util.Base64 (minSdk 26): URL-safe alphabet, padding optional —
        // same acceptance as the previous android.util flags.
        byte[] decoded;
        try {
            decoded = Base64.getUrlDecoder().decode(normalized);
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException("Invalid setup code.", error);
        }
        if (decoded.length > MAX_COMPRESSED_BYTES) {
            throw new IllegalArgumentException("Setup code too large");
        }
        return inflateRaw(decoded);
    }

    private static String inflateRaw(byte[] compressed) {
        Inflater inflater = new Inflater(true);
        inflater.setInput(compressed);
        ByteArrayOutputStream output = new ByteArrayOutputStream(Math.max(256, compressed.length * 2));
        byte[] buffer = new byte[256];
        try {
            while (!inflater.finished()) {
                int count = inflater.inflate(buffer);
                if (count > 0) {
                    output.write(buffer, 0, count);
                    // AND-03: hard cap on decompressed size.
                    if (output.size() > MAX_DECOMPRESSED_BYTES) {
                        throw new IllegalArgumentException("Setup code too large");
                    }
                    continue;
                }
                if (inflater.needsInput()) {
                    break;
                }
                throw new IllegalArgumentException("Invalid setup code.");
            }
            return output.toString(StandardCharsets.UTF_8.name());
        } catch (IllegalArgumentException error) {
            throw error;
        } catch (Exception error) {
            throw new IllegalArgumentException("Invalid setup code.", error);
        } finally {
            inflater.end();
            try {
                output.close();
            } catch (Exception ignored) {
            }
        }
    }

    private static String normalizeTransportMode(String value, String fallback) {
        String normalized = firstNonEmpty(value, fallback).toLowerCase(Locale.ROOT);
        if ("auto".equals(normalized)) return "auto";
        return "http".equals(normalized) ? "http" : "mqtt";
    }

    private static String inferBrokerProtocol(String host) {
        String normalized = firstNonEmpty(host).toLowerCase(Locale.ROOT);
        return normalized.startsWith("mqtts://") || normalized.startsWith("ssl://") ? "mqtts" : "mqtt";
    }

    private static String nestedString(JSONObject json, String objectKey, String valueKey) {
        JSONObject nested = json.optJSONObject(objectKey);
        return nested == null ? "" : nested.optString(valueKey, "");
    }

    private static int nestedInt(JSONObject json, String objectKey, String valueKey) {
        JSONObject nested = json.optJSONObject(objectKey);
        return nested == null ? 0 : nested.optInt(valueKey, 0);
    }

    private static int firstPositive(int... values) {
        for (int value : values) {
            if (value > 0) {
                return value;
            }
        }
        return 1883;
    }

    static String firstNonEmpty(String... values) {
        for (String value : values) {
            if (value != null && !value.trim().isEmpty()) {
                return value.trim();
            }
        }
        return "";
    }

    private static String nonEmpty(String value) {
        return firstNonEmpty(value, "not set");
    }
}


