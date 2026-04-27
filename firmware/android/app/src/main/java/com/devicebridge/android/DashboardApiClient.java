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
import java.net.URLEncoder;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;

final class DashboardApiClient {
    private static final int CONNECT_TIMEOUT_MS = 12000;
    private static final int READ_TIMEOUT_MS = 18000;

    private DashboardApiClient() {
    }

    static List<Map<String, Object>> fetchDevices(BridgeConfig config) throws Exception {
        JSONObject body = request(config, "GET", "/api/devices", null);
        JSONArray rows = body.optJSONArray("devices");
        List<Map<String, Object>> devices = new ArrayList<>();
        if (rows == null) {
            return devices;
        }
        for (int i = 0; i < rows.length(); i += 1) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null) continue;
            String id = row.optString("id", "").trim();
            if (id.isEmpty()) continue;
            Map<String, Object> item = new HashMap<>();
            item.put("id", id);
            item.put("name", firstNonEmpty(row.optString("name", ""), id));
            item.put("type", firstNonEmpty(row.optString("deviceType", ""), row.optString("type", "")));
            item.put("online", row.optBoolean("online", "online".equalsIgnoreCase(row.optString("status", ""))));
            item.put("status", row.optString("status", ""));
            devices.add(item);
        }
        return devices;
    }

    static List<Map<String, Object>> fetchSims(BridgeConfig config, String deviceId) throws Exception {
        JSONObject body = request(config, "GET", "/api/devices/" + encodePath(deviceId) + "/sims", null);
        JSONArray rows = body.optJSONArray("simSlots");
        if (rows == null) {
            rows = body.optJSONArray("sims");
        }
        List<Map<String, Object>> sims = new ArrayList<>();
        if (rows == null) {
            return sims;
        }
        for (int i = 0; i < rows.length(); i += 1) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null) continue;
            int slot = firstInt(row, -1, "slotIndex", "slot_index", "sim_slot", "slot");
            if (slot < 0) continue;
            Map<String, Object> item = new HashMap<>();
            item.put("slot", slot);
            item.put("label", firstNonEmpty(
                    row.optString("displayName", ""),
                    row.optString("display_name", ""),
                    row.optString("label", ""),
                    "SIM " + (slot + 1)
            ));
            item.put("carrier", firstNonEmpty(row.optString("carrierName", ""), row.optString("carrier_name", ""), row.optString("operator", "")));
            item.put("number", firstNonEmpty(row.optString("number", ""), row.optString("phoneNumber", ""), row.optString("phone_number", "")));
            sims.add(item);
        }
        return sims;
    }

    static List<Map<String, Object>> fetchSmsConversations(BridgeConfig config, String deviceId, int simSlot) throws Exception {
        String path = "/api/sms/conversations?deviceId=" + encodeQuery(deviceId) + "&limit=200" + simQuery(simSlot);
        JSONObject body = request(config, "GET", path, null);
        JSONArray rows = body.optJSONArray("data");
        List<Map<String, Object>> threads = new ArrayList<>();
        if (rows == null) {
            return threads;
        }
        for (int i = 0; i < rows.length(); i += 1) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null) continue;
            String number = firstNonEmpty(row.optString("thread_number", ""), row.optString("from_number", ""), row.optString("to_number", ""));
            String conversationId = row.optString("conversation_id", "").trim();
            String key = conversationId.isEmpty() || "null".equalsIgnoreCase(conversationId)
                    ? "addr:" + normalizePhoneKey(number)
                    : "conversation:" + conversationId;
            Map<String, Object> item = new HashMap<>();
            item.put("threadKey", key);
            item.put("conversationId", conversationId);
            item.put("address", number);
            item.put("title", firstNonEmpty(row.optString("display_from", ""), row.optString("title", ""), number));
            item.put("preview", compact(row.optString("message", "")));
            item.put("timestamp", parseTimestampMillis(row.opt("timestamp")));
            item.put("unreadCount", Math.max(0, row.optInt("unread_count", row.optInt("unreadCount", 0))));
            item.put("hasLocalDraft", false);
            threads.add(item);
        }
        return threads;
    }

    static List<Map<String, Object>> fetchSmsThread(BridgeConfig config, String deviceId, Map<String, Object> thread, int simSlot) throws Exception {
        String conversationId = value(thread.get("conversationId"));
        String number = value(thread.get("address"));
        String path = "/api/sms/thread?deviceId=" + encodeQuery(deviceId) + "&limit=300" + simQuery(simSlot);
        if (!conversationId.isEmpty() && !"null".equalsIgnoreCase(conversationId)) {
            path += "&conversationId=" + encodeQuery(conversationId);
        } else {
            path += "&number=" + encodeQuery(number);
        }
        JSONObject body = request(config, "GET", path, null);
        JSONArray rows = body.optJSONArray("data");
        List<Map<String, Object>> messages = new ArrayList<>();
        if (rows == null) {
            return messages;
        }
        String threadKey = value(thread.get("threadKey"));
        for (int i = 0; i < rows.length(); i += 1) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null) continue;
            boolean outgoing = "outgoing".equalsIgnoreCase(row.optString("type", ""));
            String address = outgoing
                    ? firstNonEmpty(row.optString("to_number", ""), row.optString("from_number", ""))
                    : firstNonEmpty(row.optString("from_number", ""), row.optString("to_number", ""));
            Map<String, Object> item = new HashMap<>();
            item.put("id", row.optString("id", ""));
            item.put("threadKey", threadKey);
            item.put("address", address);
            item.put("body", row.optString("message", ""));
            item.put("timestamp", parseTimestampMillis(row.opt("timestamp")));
            item.put("outgoing", outgoing);
            item.put("read", row.optBoolean("read", outgoing));
            item.put("status", row.optString("status", outgoing ? "sent" : "received"));
            item.put("localOnly", false);
            item.put("source", firstNonEmpty(row.optString("source", ""), "dashboard"));
            item.put("actionId", firstNonEmpty(row.optString("external_id", ""), row.optString("id", "")));
            messages.add(item);
        }
        return messages;
    }

    static List<Map<String, Object>> fetchRecentCalls(BridgeConfig config, String deviceId, int simSlot, int limit) throws Exception {
        String path = "/api/calls/recent?deviceId=" + encodeQuery(deviceId) + "&limit=" + Math.max(1, limit) + simQuery(simSlot);
        JSONObject body = request(config, "GET", path, null);
        JSONArray rows = body.optJSONArray("data");
        List<Map<String, Object>> calls = new ArrayList<>();
        if (rows == null) {
            return calls;
        }
        for (int i = 0; i < rows.length(); i += 1) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null) continue;
            Map<String, Object> item = new HashMap<>();
            item.put("name", firstNonEmpty(row.optString("contact_name", ""), row.optString("name", "")));
            item.put("number", row.optString("phone_number", ""));
            item.put("type", callType(row.optString("type", ""), row.optString("status", "")));
            item.put("date", parseTimestampMillis(firstNonEmpty(row.optString("start_time", ""), row.optString("timestamp", ""))));
            item.put("durationSeconds", Math.max(0L, row.optLong("duration", 0L)));
            calls.add(item);
        }
        return calls;
    }

    static List<Map<String, String>> fetchContacts(BridgeConfig config, String query, int limit) throws Exception {
        String path = "/api/contacts?limit=" + Math.max(1, limit);
        if (query != null && !query.trim().isEmpty()) {
            path += "&search=" + encodeQuery(query.trim());
        }
        JSONObject body = request(config, "GET", path, null);
        JSONArray rows = body.optJSONArray("data");
        List<Map<String, String>> contacts = new ArrayList<>();
        if (rows == null) {
            return contacts;
        }
        for (int i = 0; i < rows.length(); i += 1) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null) continue;
            String number = firstNonEmpty(row.optString("phone_number", ""), row.optString("number", ""));
            if (number.isEmpty()) continue;
            String name = firstNonEmpty(row.optString("name", ""), number);
            Map<String, String> item = new HashMap<>();
            item.put("name", name);
            item.put("number", number);
            contacts.add(item);
        }
        return contacts;
    }

    static void sendSms(BridgeConfig config, String deviceId, int simSlot, List<String> recipients, String message) throws Exception {
        JSONObject payload = new JSONObject();
        JSONArray target = new JSONArray();
        for (String recipient : recipients) {
            if (recipient != null && !recipient.trim().isEmpty()) {
                target.put(recipient.trim());
            }
        }
        payload.put("deviceId", deviceId);
        payload.put("recipients", target);
        payload.put("message", message);
        if (simSlot >= 0) {
            payload.put("simSlot", simSlot);
        }
        request(config, "POST", "/api/sms/send", payload);
    }

    static void dialCall(BridgeConfig config, String deviceId, int simSlot, String number) throws Exception {
        JSONObject payload = new JSONObject();
        payload.put("deviceId", deviceId);
        payload.put("number", number);
        if (simSlot >= 0) {
            payload.put("simSlot", simSlot);
        }
        request(config, "POST", "/api/calls/dial", payload);
    }

    static void markAllSmsRead(BridgeConfig config, String deviceId, int simSlot) throws Exception {
        JSONObject payload = new JSONObject();
        payload.put("deviceId", deviceId);
        if (simSlot >= 0) {
            payload.put("simSlot", simSlot);
        }
        request(config, "POST", "/api/sms/mark-all-read", payload);
    }

    private static JSONObject request(BridgeConfig config, String method, String path, JSONObject payload) throws Exception {
        if (config == null || !config.hasDashboardAccess()) {
            throw new IllegalStateException(config != null && config.hasLoopbackDashboardUrl()
                    ? "Dashboard HTTP skipped because the configured URL is localhost on Android"
                    : "Dashboard access is not configured");
        }
        HttpURLConnection connection = null;
        try {
            URL url = new URL(config.serverUrl + path);
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod(method);
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("X-API-Key", config.apiKey);
            if (!config.deviceId.isEmpty()) {
                connection.setRequestProperty("X-Device-Id", config.deviceId);
            }
            connection.setDoInput(true);
            if (payload != null) {
                connection.setDoOutput(true);
                try (OutputStream outputStream = connection.getOutputStream();
                     BufferedWriter writer = new BufferedWriter(new OutputStreamWriter(outputStream, StandardCharsets.UTF_8))) {
                    writer.write(payload.toString());
                }
            }
            int status = connection.getResponseCode();
            String text = readBody(status >= 200 && status < 400 ? connection.getInputStream() : connection.getErrorStream());
            JSONObject body = parseJson(text);
            if (status >= 200 && status < 300) {
                return body;
            }
            throw new IllegalStateException(body.optString("message", "HTTP " + status));
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private static String readBody(InputStream stream) throws Exception {
        if (stream == null) {
            return "";
        }
        StringBuilder builder = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                builder.append(line);
            }
        }
        return builder.toString();
    }

    private static JSONObject parseJson(String text) {
        try {
            return new JSONObject(text == null || text.trim().isEmpty() ? "{}" : text);
        } catch (JSONException ignored) {
            return new JSONObject();
        }
    }

    static long parseTimestampMillis(Object raw) {
        if (raw instanceof Number) {
            long value = ((Number) raw).longValue();
            return value > 100000000000L ? value : value * 1000L;
        }
        String text = raw == null ? "" : String.valueOf(raw).trim();
        if (text.isEmpty() || "null".equalsIgnoreCase(text)) {
            return 0L;
        }
        if (text.matches("^\\d+$")) {
            try {
                long value = Long.parseLong(text);
                return value > 100000000000L ? value : value * 1000L;
            } catch (NumberFormatException ignored) {
            }
        }
        String[] patterns = new String[]{
                "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
                "yyyy-MM-dd'T'HH:mm:ss'Z'",
                "yyyy-MM-dd HH:mm:ss"
        };
        for (String pattern : patterns) {
            try {
                SimpleDateFormat format = new SimpleDateFormat(pattern, Locale.US);
                if (pattern.endsWith("'Z'")) {
                    format.setTimeZone(TimeZone.getTimeZone("UTC"));
                }
                java.util.Date parsed = format.parse(text);
                if (parsed != null) {
                    return parsed.getTime();
                }
            } catch (Exception ignored) {
            }
        }
        return 0L;
    }

    private static String simQuery(int simSlot) {
        return simSlot >= 0 ? "&simSlot=" + simSlot : "";
    }

    private static String encodeQuery(String value) {
        try {
            return URLEncoder.encode(value == null ? "" : value, "UTF-8");
        } catch (Exception ignored) {
            return "";
        }
    }

    private static String encodePath(String value) {
        return encodeQuery(value).replace("+", "%20");
    }

    private static String value(Object raw) {
        if (raw == null) return "";
        String text = String.valueOf(raw).trim();
        return "null".equalsIgnoreCase(text) ? "" : text;
    }

    private static String firstNonEmpty(String... values) {
        if (values == null) return "";
        for (String value : values) {
            if (value != null && !value.trim().isEmpty() && !"null".equalsIgnoreCase(value.trim())) {
                return value.trim();
            }
        }
        return "";
    }

    private static int firstInt(JSONObject row, int fallback, String... keys) {
        if (row == null || keys == null) return fallback;
        for (String key : keys) {
            if (row.has(key) && !row.isNull(key)) {
                int value = row.optInt(key, fallback);
                if (value >= 0) return value;
            }
        }
        return fallback;
    }

    private static String compact(String value) {
        String clean = value == null ? "" : value.trim().replaceAll("\\s+", " ");
        return clean.length() <= 72 ? clean : clean.substring(0, 69).trim() + "...";
    }

    private static String normalizePhoneKey(String number) {
        String clean = number == null ? "" : number.replaceAll("[^0-9+]", "");
        return clean.isEmpty() ? "unknown" : clean;
    }

    private static int callType(String type, String status) {
        String cleanType = type == null ? "" : type.toLowerCase(Locale.US);
        String cleanStatus = status == null ? "" : status.toLowerCase(Locale.US);
        if (cleanStatus.contains("miss")) return android.provider.CallLog.Calls.MISSED_TYPE;
        if (cleanStatus.contains("reject")) return android.provider.CallLog.Calls.REJECTED_TYPE;
        if ("incoming".equals(cleanType)) return android.provider.CallLog.Calls.INCOMING_TYPE;
        if ("outgoing".equals(cleanType)) return android.provider.CallLog.Calls.OUTGOING_TYPE;
        return android.provider.CallLog.Calls.OUTGOING_TYPE;
    }
}
