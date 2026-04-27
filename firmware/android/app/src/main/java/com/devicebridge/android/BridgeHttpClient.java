package com.devicebridge.android;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

final class BridgeHttpClient {
    private static final int CONNECT_TIMEOUT_MS = 15000;
    private static final int READ_TIMEOUT_MS = 20000;

    private BridgeHttpClient() {
    }

    static Result postStatus(BridgeConfig config, JSONObject payload) {
        return requestJson(config, "POST", "/v1/android/bridge/status", payload);
    }

    static Result postIncomingSms(BridgeConfig config, JSONObject payload) {
        return requestJson(config, "POST", "/v1/android/bridge/messages/receive", payload);
    }

    static Result postMessageEvent(BridgeConfig config, String messageId, JSONObject payload) {
        return requestJson(config, "POST", "/v1/android/bridge/messages/" + encodePath(messageId) + "/events", payload);
    }

    static List<OutstandingMessage> fetchOutstandingMessages(BridgeConfig config) throws Exception {
        Result result = requestJson(config, "GET", "/v1/android/bridge/messages/outstanding?device_id=" + encodeQuery(config.deviceId), null);
        if (!result.success) {
            throw new IllegalStateException(result.detail);
        }

        JSONObject body = result.body;
        JSONArray messages = body == null ? null : body.optJSONArray("messages");
        List<OutstandingMessage> items = new ArrayList<>();
        if (messages == null) {
            return items;
        }

        for (int i = 0; i < messages.length(); i++) {
            JSONObject row = messages.optJSONObject(i);
            if (row == null) {
                continue;
            }
            items.add(new OutstandingMessage(
                    row.optString("id", ""),
                    row.optString("to", ""),
                    row.optString("content", ""),
                    row.optInt("timeout_ms", 90000),
                    row.has("sim_slot") && !row.isNull("sim_slot") ? row.optInt("sim_slot") : null,
                    row.has("subscription_id") && !row.isNull("subscription_id") ? row.optInt("subscription_id") : null
            ));
        }
        return items;
    }

    private static Result requestJson(BridgeConfig config, String method, String path, JSONObject payload) {
        HttpURLConnection connection = null;
        try {
            if (!config.hasHttpBridgeConfig()) {
                return Result.failure(config.hasLoopbackDashboardUrl()
                        ? "HTTP bridge skipped because dashboard URL is localhost on Android"
                        : "HTTP bridge config is incomplete");
            }

            URL url = new URL(config.serverUrl + path);
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod(method);
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("X-API-Key", config.apiKey);
            connection.setRequestProperty("X-Device-Id", config.deviceId);
            connection.setDoInput(true);

            if (payload != null) {
                connection.setDoOutput(true);
                try (OutputStream outputStream = connection.getOutputStream();
                     BufferedWriter writer = new BufferedWriter(new OutputStreamWriter(outputStream, StandardCharsets.UTF_8))) {
                    writer.write(payload.toString());
                }
            }

            int status = connection.getResponseCode();
            String responseText = readBody(status >= 200 && status < 400
                    ? connection.getInputStream()
                    : connection.getErrorStream());
            JSONObject responseJson = parseJson(responseText);
            if (status >= 200 && status < 300) {
                return Result.success(responseJson);
            }
            return Result.failure(responseJson == null ? ("HTTP " + status) : responseJson.optString("message", "HTTP " + status), responseJson);
        } catch (Exception error) {
            return Result.failure(error.getMessage());
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private static String readBody(InputStream inputStream) throws Exception {
        if (inputStream == null) {
            return "";
        }
        StringBuilder builder = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(inputStream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                builder.append(line);
            }
        }
        return builder.toString();
    }

    private static JSONObject parseJson(String text) {
        if (text == null || text.trim().isEmpty()) {
            return new JSONObject();
        }
        try {
            return new JSONObject(text);
        } catch (JSONException ignored) {
            return new JSONObject();
        }
    }

    private static String encodeQuery(String value) {
        return value == null ? "" : value.replace(" ", "%20");
    }

    private static String encodePath(String value) {
        return encodeQuery(value).replace("/", "%2F");
    }

    static final class Result {
        final boolean success;
        final String detail;
        final JSONObject body;

        private Result(boolean success, String detail, JSONObject body) {
            this.success = success;
            this.detail = detail == null ? "" : detail;
            this.body = body;
        }

        static Result success(JSONObject body) {
            return new Result(true, "", body);
        }

        static Result failure(String detail) {
            return new Result(false, detail, null);
        }

        static Result failure(String detail, JSONObject body) {
            return new Result(false, detail, body);
        }
    }

    static final class OutstandingMessage {
        final String id;
        final String to;
        final String content;
        final int timeoutMs;
        final Integer simSlot;
        final Integer subscriptionId;

        OutstandingMessage(String id, String to, String content, int timeoutMs, Integer simSlot, Integer subscriptionId) {
            this.id = id;
            this.to = to;
            this.content = content;
            this.timeoutMs = timeoutMs > 0 ? timeoutMs : 90000;
            this.simSlot = simSlot != null && simSlot >= 0 ? simSlot : null;
            this.subscriptionId = subscriptionId != null && subscriptionId >= 0 ? subscriptionId : null;
        }
    }
}


