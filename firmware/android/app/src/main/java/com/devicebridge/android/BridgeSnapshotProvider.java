package com.devicebridge.android;

import android.Manifest;
import android.app.Activity;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.content.pm.PackageManager;
import android.os.Build;
import android.provider.Settings;
import android.telephony.SubscriptionInfo;
import android.telephony.SubscriptionManager;
import android.telephony.TelephonyManager;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

final class BridgeSnapshotProvider {
    private static final long ACTION_DEDUPE_WINDOW_MS = 2L * 60L * 1000L;
    private static final long MESSAGE_DEDUPE_WINDOW_MS = 5_000L;

    private BridgeSnapshotProvider() {
    }

    static Map<String, Object> buildDashboardState(Activity activity) {
        BridgeConfig config = BridgeConfig.load(activity);
        BridgeRuntimeState runtime = BridgeRuntimeState.load(activity);
        boolean online = BridgeAppGate.isOnline(activity);
        boolean active = isBridgeActive(activity);
        WifiSummary wifi = captureWifiSummary(activity);
        List<Map<String, Object>> consoleEntries = buildConsoleEntries(activity);
        CallSummary call = latestCallSummary(consoleEntries);

        Map<String, Object> state = new HashMap<>();
        state.put("deviceId", safe(config.deviceId, "not set"));
        state.put("transport", config.transportDisplayLabel());
        state.put("bridgeState", online ? "Online" : (active ? "Standby" : "Stopped"));
        state.put("bridgeEnabled", config.bridgeEnabled);
        state.put("online", online);
        state.put("readinessScore", BridgeDiagnostics.readinessScore(activity));
        state.put("readinessLabel", BridgeDiagnostics.readinessLabel(activity));
        state.put("batteryLevel", readBatteryLevel(activity));
        state.put("batteryStatus", readBatteryStatus(activity));
        state.put("queueDepth", runtime.queueDepth);
        state.put("publishSuccess", runtime.publishSuccessCount);
        state.put("publishFailure", runtime.publishFailureCount);
        state.put("connectionSummary", buildConnectionSummary(activity, config, runtime));
        state.put("connectionDetail", buildFullConnectivityDetail(activity, config, runtime));
        state.put("wifiEnabled", wifi.enabled);
        state.put("wifiConnected", wifi.connected);
        state.put("wifiSsid", wifi.ssid);
        state.put("wifiIpAddress", wifi.ipAddress);
        state.put("callStatus", call.status);
        state.put("callDirection", call.direction);
        state.put("callNumber", call.number);
        state.put("callUpdatedAt", call.timestamp);
        state.put("deviceInfoSummary", buildDeviceInfoDetail(activity));
        state.put("deviceInfoDetail", buildDeviceInfoDetail(activity));
        state.put("healthSummary", buildHealthSummary(activity));
        state.put("healthDetail", buildHealthDetail(activity));
        state.put("permissionSummary", buildPermissionSummary(activity));
        state.put("permissionDetail", buildPermissionDetail(activity));
        state.put("modules", buildModules(activity, runtime, consoleEntries));
        state.put("consoleEntries", consoleEntries);
        return state;
    }

    static boolean isBridgeActive(Activity activity) {
        BridgeConfig config = BridgeConfig.load(activity);
        BridgeRuntimeState runtime = BridgeRuntimeState.load(activity);
        return BridgeAppGate.isOnline(activity)
                || BridgeAppGate.isBridgeServiceRunning(activity)
                || config.bridgeEnabled
                || "running".equalsIgnoreCase(runtime.serviceState)
                || "online".equalsIgnoreCase(runtime.serviceState);
    }

    static List<Map<String, Object>> buildConsoleEntries(Activity activity) {
        String current = BridgeEventLog.read(activity);
        List<Map<String, Object>> entries = new ArrayList<>();
        if (current == null || current.trim().isEmpty()) {
            return entries;
        }
        String[] lines = current.split("\\n");
        Map<String, Long> recentEntries = new HashMap<>();
        for (String line : lines) {
            String raw = line == null ? "" : line.trim();
            if (raw.isEmpty()) {
                continue;
            }
            String timestamp = raw.length() >= 19 && Character.isDigit(raw.charAt(0))
                    ? raw.substring(0, 19)
                    : raw.substring(0, Math.min(8, raw.length()));
            String message = raw.length() > 21 && Character.isDigit(raw.charAt(0))
                    ? raw.substring(21).trim()
                    : raw;
            ConsoleMessageParts parts = parseConsoleMessage(message);
            long lineTimestampMs = timestampMillis(timestamp);
            String semanticKey = semanticConsoleKey(message, parts);
            if (!semanticKey.isEmpty()) {
                Long previousSeenAt = recentEntries.get(semanticKey);
                long dedupeWindowMs = semanticKey.startsWith("action:")
                        ? ACTION_DEDUPE_WINDOW_MS
                        : MESSAGE_DEDUPE_WINDOW_MS;
                if (previousSeenAt != null
                        && previousSeenAt > 0L
                        && lineTimestampMs > 0L
                        && (lineTimestampMs - previousSeenAt) <= dedupeWindowMs) {
                    continue;
                }
                recentEntries.put(semanticKey, lineTimestampMs);
            }
            String level = inferConsoleLevel(parts);
            String type = inferConsoleType(parts);
            Map<String, Object> entry = new HashMap<>();
            entry.put("timestamp", timestamp);
            entry.put("level", level);
            entry.put("type", type);
            entry.put("summary", parts.summary);
            entry.put("detail", parts.detail);
            entry.put("raw", raw);
            if (!parts.source.isEmpty()) {
                entry.put("source", parts.source);
            }
            String payload = extractTaggedValue(message, "payload=");
            if (!payload.isEmpty()) {
                entry.put("payload", payload);
            }
            String response = extractTaggedValue(message, "response=");
            if (!response.isEmpty()) {
                entry.put("response", response);
            }
            entries.add(0, entry);
        }
        return entries;
    }

    private static long timestampMillis(String timestamp) {
        if (timestamp == null || timestamp.trim().isEmpty()) {
            return 0L;
        }
        try {
            java.util.Date parsed = new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US)
                    .parse(timestamp.trim());
            return parsed == null ? 0L : parsed.getTime();
        } catch (Exception ignored) {
            return 0L;
        }
    }

    private static String semanticConsoleKey(String message, ConsoleMessageParts parts) {
        String actionId = extractActionId(message);
        if (!actionId.isEmpty()) {
            return "action:" + actionId;
        }
        if (parts == null) {
            return "";
        }
        return (parts.source + "|" + parts.summary + "|" + parts.detail)
                .trim()
                .replaceAll("\\s+", " ")
                .toLowerCase(Locale.US);
    }

    private static String extractActionId(String message) {
        if (message == null || message.trim().isEmpty()) {
            return "";
        }
        java.util.regex.Matcher matcher = java.util.regex.Pattern.compile(
                        "(?:^|[\\s,{])(?:action_id|messageId)[\"\\s:=]+([A-Za-z0-9._:-]+)",
                        java.util.regex.Pattern.CASE_INSENSITIVE)
                .matcher(message);
        if (matcher.find()) {
            return stringValue(matcher.group(1)).trim();
        }
        return "";
    }

    private static List<Map<String, Object>> buildModules(
            Activity activity,
            BridgeRuntimeState runtime,
            List<Map<String, Object>> consoleEntries
    ) {
        List<Map<String, Object>> items = new ArrayList<>();
        boolean smsReady = activity.checkSelfPermission(Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED
                && activity.checkSelfPermission(Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED;
        boolean callReady = activity.checkSelfPermission(Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED;
        boolean ussdReady = Build.VERSION.SDK_INT >= 26 && callReady;
        boolean queueHealthy = runtime.queueDepth <= 3 && runtime.publishFailureCount <= runtime.publishSuccessCount + 1;
        CallSummary call = latestCallSummary(consoleEntries);

        items.add(module("sms", "SMS", smsReady ? "Ready" : "Blocked",
                "Send " + formatAge(runtime.lastSendAcceptedAtMs),
                "Recv " + formatAge(runtime.lastIncomingSyncAtMs),
                "SMS lane\nready          = " + smsReady
                        + "\nlast_send      = " + formatAge(runtime.lastSendAcceptedAtMs)
                        + "\nlast_receive   = " + formatAge(runtime.lastIncomingSyncAtMs)
                        + "\nrecent_events\n" + filterConsoleEntries(
                        consoleEntries,
                        listOf("sms"),
                        "send_sms",
                        "incoming sms",
                        "outgoing sms")));

        items.add(module("call", "Call", callReady ? "Live" : "Blocked",
                call.primaryLabel(runtime.lastMessageEventAtMs),
                callReady ? call.secondaryLabel() : "Grant CALL_PHONE",
                "Call lane\nready          = " + callReady
                        + "\nlast_status    = " + safe(call.status, "idle")
                        + "\ndirection      = " + safe(call.direction, "unknown")
                        + "\nnumber         = " + safe(call.number, "unknown")
                        + "\nupdated_at     = " + safe(call.timestamp, "unknown")
                        + "\nlast_event     = " + formatAge(runtime.lastMessageEventAtMs)
                        + "\nrecent_events\n" + filterConsoleEntries(
                        consoleEntries,
                        listOf("call"),
                        "make_call",
                        "answer-call",
                        "end-call",
                        "reject-call",
                        "incoming call",
                        "outgoing call",
                        "ring")));

        items.add(module("ussd", "USSD", ussdReady ? "Ready" : "Limited",
                "Lane " + (ussdReady ? "interactive" : "permission"),
                ussdReady ? "Responses in console" : "Grant CALL_PHONE",
                "USSD lane\nready          = " + ussdReady
                        + "\nrecent_events\n" + filterConsoleEntries(
                        consoleEntries,
                        listOf("ussd"),
                        "ussd")));

        items.add(module("queue", "Queue", queueHealthy ? "Stable" : "Watch",
                "Depth " + runtime.queueDepth,
                "TX " + runtime.publishSuccessCount + "/" + runtime.publishFailureCount,
                "Queue lane\nqueue_depth     = " + runtime.queueDepth
                        + "\npublish_ok      = " + runtime.publishSuccessCount
                        + "\npublish_fail    = " + runtime.publishFailureCount
                        + "\nlast_queue_poll = " + formatAge(runtime.lastQueuePollAtMs)
                        + "\nrecent_events\n" + filterConsoleEntries(
                        consoleEntries,
                        listOf("queue"),
                        "queued while offline",
                        "publish failed",
                        "publish sent",
                        "pending publish",
                        "connect failed",
                        "connection lost",
                        "reconnect",
                        "subscribe failed")));

        return items;
    }

    private static Map<String, Object> module(String key, String title, String state, String primary, String secondary, String detail) {
        Map<String, Object> item = new HashMap<>();
        item.put("key", key);
        item.put("title", title);
        item.put("state", state);
        item.put("primary", primary);
        item.put("secondary", secondary);
        item.put("detail", detail);
        return item;
    }

    private static String buildConnectionSummary(Activity activity, BridgeConfig config, BridgeRuntimeState runtime) {
        WifiSummary wifi = captureWifiSummary(activity);
        String realtimeTarget = safe(config.brokerUri(), "not set");
        String fallbackTarget = safe(config.serverUrl, "not set");
        return "device_id      = " + safe(config.deviceId, "not set")
                + "\nconnection     = " + config.transportDisplayLabel()
                + "\nrealtime       = " + realtimeTarget
                + "\nfallback       = " + fallbackTarget
                + "\nservice_state  = " + safe(runtime.serviceState, "idle")
                + "\nconnected      = " + runtime.isBridgeOnline(config)
                + "\nbridge_enabled = " + config.bridgeEnabled
                + "\nqueue_depth    = " + runtime.queueDepth
                + "\nlast_status    = " + formatAge(runtime.lastStatusPushAtMs)
                + "\nlast_update    = " + formatAge(runtime.updatedAtMs)
                + "\npublish_ok     = " + runtime.publishSuccessCount
                + "\npublish_fail   = " + runtime.publishFailureCount
                + "\nwifi_enabled   = " + wifi.enabled
                + "\nwifi_connected = " + wifi.connected
                + "\nwifi_ssid      = " + safe(wifi.ssid, wifi.connected ? "unavailable" : "disconnected")
                + "\nwifi_ip        = " + safe(wifi.ipAddress, wifi.connected ? "unavailable" : "disconnected")
                + "\ndetail         = " + safe(runtime.detail, "no extra detail");
    }

    private static String buildFullConnectivityDetail(Activity activity, BridgeConfig config, BridgeRuntimeState runtime) {
        return buildConnectionSummary(activity, config, runtime)
                + "\n\nProvisioning\n"
                + sanitizeProvisioningSummary(BridgeProvisioning.buildProvisioningSummary(config))
                + "\n\nStatus Snapshot\n"
                + BridgeDiagnostics.buildStatusSummary(activity, null);
    }

    private static String buildDeviceInfoDetail(Activity activity) {
        BridgeConfig config = BridgeConfig.load(activity);
        StringBuilder builder = new StringBuilder();
        builder.append("manufacturer   = ").append(Build.MANUFACTURER)
                .append("\nmodel          = ").append(Build.MODEL)
                .append("\ndevice         = ").append(Build.DEVICE)
                .append("\nandroid        = ").append(Build.VERSION.RELEASE)
                .append(" (sdk ").append(Build.VERSION.SDK_INT).append(')')
                .append("\nandroid_id     = ").append(safe(readAndroidId(activity), "unavailable"))
                .append("\ninstall_id     = ").append(safe(config.installId, "unavailable"))
                .append("\nhardware_id    = ").append(buildHardwareIdSummary(activity));

        if (activity.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) {
            builder.append("\n\nphone_state    = permission required");
            return builder.toString();
        }

        try {
            TelephonyManager telephony = (TelephonyManager) activity.getSystemService(Activity.TELEPHONY_SERVICE);
            if (telephony == null) {
                builder.append("\n\ntelephony      = unavailable");
                return builder.toString();
            }
            Map<Integer, SubscriptionInfo> subscriptionsBySlot = new HashMap<>();
            if (Build.VERSION.SDK_INT >= 22) {
                try {
                    SubscriptionManager subscriptionManager = activity.getSystemService(SubscriptionManager.class);
                    if (subscriptionManager != null) {
                        List<SubscriptionInfo> subscriptions = subscriptionManager.getActiveSubscriptionInfoList();
                        if (subscriptions != null) {
                            for (SubscriptionInfo info : subscriptions) {
                                if (info != null) {
                                    subscriptionsBySlot.put(Math.max(0, info.getSimSlotIndex()), info);
                                }
                            }
                        }
                    }
                } catch (SecurityException ignored) {
                } catch (RuntimeException ignored) {
                }
            }
            int slotCount = inferSimSlotCount(telephony);
            builder.append("\n\noperator       = ").append(safe(telephony.getNetworkOperatorName(), "unknown"))
                    .append("\nphone_type     = ").append(phoneTypeLabel(telephony.getPhoneType()))
                    .append("\nsim_state      = ").append(simStateLabel(telephony.getSimState()))
                    .append("\nnetwork_type   = ").append(networkTypeLabel(telephony.getDataNetworkType()))
                    .append("\ncountry_iso    = ").append(safe(telephony.getNetworkCountryIso(), "unknown"))
                    .append("\nsim_slots      = ").append(slotCount);

            for (int slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
                SubscriptionInfo info = subscriptionsBySlot.get(slotIndex);
                String slotKey = "slot_" + (slotIndex + 1);
                builder.append("\nslot_").append(slotIndex + 1).append("        = ")
                        .append(simStateLabel(readSimState(telephony, slotIndex)));
                if (info != null) {
                    builder.append("\n").append(slotKey).append("_label   = ")
                            .append(safeCharSequence(info.getDisplayName(), "SIM " + (slotIndex + 1)))
                            .append("\n").append(slotKey).append("_carrier = ")
                            .append(safeCharSequence(info.getCarrierName(), "unknown"));
                    String number = resolveSubscriptionNumber(info, telephony);
                    if (!number.isEmpty()) {
                        builder.append("\n").append(slotKey).append("_number  = ").append(number);
                    }
                    builder.append("\n").append(slotKey).append("_sub_id   = ").append(info.getSubscriptionId());
                } else {
                    String number = slotIndex == 0 ? safeLine1Number(telephony) : "";
                    if (!number.isEmpty()) {
                        builder.append("\n").append(slotKey).append("_number  = ").append(number);
                    }
                }
            }
        } catch (SecurityException error) {
            builder.append("\n\ntelephony      = blocked by Android security settings");
        }
        return builder.toString();
    }

    private static String buildHealthSummary(Activity activity) {
        String health = BridgeDiagnostics.buildHealthPulse(activity);
        String watchdog = BridgeDiagnostics.buildPermissionWatchdog(activity);
        return "health_label   = " + BridgeDiagnostics.healthLabel(activity)
                + "\nreadiness      = " + BridgeDiagnostics.readinessLabel(activity)
                + "\n\n" + trimLines(health, 6)
                + "\n\nwatchdog\n" + trimLines(watchdog, 4);
    }

    private static String buildHealthDetail(Activity activity) {
        return "Health Pulse\n"
                + BridgeDiagnostics.buildHealthPulse(activity)
                + "\n\nWatchdog\n"
                + BridgeDiagnostics.buildPermissionWatchdog(activity);
    }

    private static String buildPermissionSummary(Activity activity) {
        return BridgePermissionHelper.buildSummary(activity, true)
                + "\n\nwatchdog\n"
                + trimLines(BridgeDiagnostics.buildPermissionWatchdog(activity), 4);
    }

    private static String buildPermissionDetail(Activity activity) {
        StringBuilder builder = new StringBuilder();
        builder.append("Permissions\n").append(BridgePermissionHelper.buildSummary(activity, true));
        List<BridgePermissionHelper.PermissionItem> items = BridgePermissionHelper.collect(activity, true);
        if (!items.isEmpty()) {
            builder.append("\n\nPurpose map");
            for (BridgePermissionHelper.PermissionItem item : items) {
                builder.append("\n- ").append(item.label)
                        .append(": ").append(BridgePermissionHelper.purposeFor(item.permission));
            }
        }
        builder.append("\n\nWatchdog\n").append(BridgeDiagnostics.buildPermissionWatchdog(activity));
        return builder.toString();
    }

    private static String sanitizeProvisioningSummary(String value) {
        if (value == null || value.trim().isEmpty()) {
            return "No provisioning summary available.";
        }
        return value
                .replaceAll("(?i)(API Key:\\s*)(.+)", "$1configured")
                .replaceAll("(?i)(MQTT Password:\\s*)(.+)", "$1configured");
    }

    private static String trimLines(String value, int maxLines) {
        if (value == null || value.trim().isEmpty()) {
            return "No detail available.";
        }
        String[] lines = value.split("\\n");
        if (lines.length <= maxLines) {
            return value;
        }
        StringBuilder builder = new StringBuilder();
        for (int i = 0; i < maxLines; i += 1) {
            if (builder.length() > 0) {
                builder.append('\n');
            }
            builder.append(lines[i]);
        }
        builder.append("\n...");
        return builder.toString();
    }

    private static List<String> listOf(String... items) {
        List<String> values = new ArrayList<>();
        if (items == null) {
            return values;
        }
        for (String item : items) {
            if (item != null && !item.trim().isEmpty()) {
                values.add(item.trim().toLowerCase(Locale.US));
            }
        }
        return values;
    }

    private static String filterConsoleEntries(
            List<Map<String, Object>> entries,
            List<String> types,
            String... keywords
    ) {
        if (entries == null || entries.isEmpty()) {
            return "No local events yet.";
        }
        List<String> matches = new ArrayList<>();
        for (int i = entries.size() - 1; i >= 0; i -= 1) {
            Map<String, Object> entry = entries.get(i);
            String normalizedType = stringValue(entry.get("type")).toLowerCase(Locale.US);
            String normalizedSource = stringValue(entry.get("source")).toLowerCase(Locale.US);
            String normalizedText = (
                    normalizedSource
                            + " "
                            + stringValue(entry.get("summary"))
                            + " "
                            + stringValue(entry.get("detail"))
                            + " "
                            + stringValue(entry.get("raw"))
            ).toLowerCase(Locale.US);
            boolean typeMatch = types != null
                    && (types.contains(normalizedType) || types.contains(normalizedSource));
            boolean keywordMatch = false;
            if (!typeMatch && keywords != null) {
                for (String keyword : keywords) {
                    if (keyword != null && !keyword.trim().isEmpty()
                            && normalizedText.contains(keyword.trim().toLowerCase(Locale.US))) {
                        keywordMatch = true;
                        break;
                    }
                }
            }
            if (typeMatch || keywordMatch) {
                String raw = stringValue(entry.get("raw"));
                matches.add(raw.isEmpty() ? normalizedText.trim() : raw);
            }
        }
        if (matches.isEmpty()) {
            return "No matching events yet.";
        }
        StringBuilder builder = new StringBuilder();
        int start = Math.max(0, matches.size() - 14);
        for (int i = start; i < matches.size(); i += 1) {
            if (builder.length() > 0) {
                builder.append('\n');
            }
            builder.append(matches.get(i));
        }
        return builder.toString();
    }

    private static CallSummary latestCallSummary(List<Map<String, Object>> entries) {
        if (entries == null || entries.isEmpty()) {
            return CallSummary.empty();
        }
        for (Map<String, Object> entry : entries) {
            if (entry == null) {
                continue;
            }
            String type = stringValue(entry.get("type")).toLowerCase(Locale.US);
            String source = stringValue(entry.get("source")).toLowerCase(Locale.US);
            if (!"call".equals(type) && !"call".equals(source)) {
                continue;
            }
            String summary = stringValue(entry.get("summary"));
            String detail = stringValue(entry.get("detail"));
            String summaryLower = summary.toLowerCase(Locale.US);
            String detailLower = detail.toLowerCase(Locale.US);
            String text = (summary + " " + detail).toLowerCase(Locale.US);
            String status = "";
            if (text.contains("ringing")) {
                status = "ringing";
            } else if (text.contains("answered")) {
                status = "answered";
            } else if (text.contains("connected")) {
                status = "connected";
            } else if (text.contains("missed")) {
                status = "missed";
            } else if (text.contains("ended")) {
                status = "ended";
            } else if (text.contains("dialing") || text.contains("started")) {
                status = "dialing";
            } else if (text.contains("reject")) {
                status = "rejected";
            }

            String direction = "";
            if (text.contains("(incoming)") || text.contains(" incoming")) {
                direction = "incoming";
            } else if (text.contains("(outgoing)") || text.contains(" outgoing")) {
                direction = "outgoing";
            }

            String number = "";
            int summaryMarker = summaryLower.indexOf(" for ");
            int detailMarker = detailLower.indexOf(" for ");
            if (summaryMarker >= 0 && summaryMarker + 5 < summary.length()) {
                number = summary.substring(summaryMarker + 5).trim();
            } else if (detailMarker >= 0 && detailMarker + 5 < detail.length()) {
                number = detail.substring(detailMarker + 5).trim();
            }
            return new CallSummary(
                    status,
                    direction,
                    number,
                    stringValue(entry.get("timestamp"))
            );
        }
        return CallSummary.empty();
    }

    private static String inferConsoleLevel(ConsoleMessageParts parts) {
        String normalized = parts == null ? "" : parts.normalizedText;
        if (normalized.contains("failed")
                || normalized.contains("error")
                || normalized.contains("rejected")
                || normalized.contains("denied")
                || normalized.contains("blocked")) {
            return "error";
        }
        if (normalized.contains("lost")
                || normalized.contains("reconnect")
                || normalized.contains("queued while offline")
                || normalized.contains("warning")
                || normalized.contains("stale")) {
            return "warn";
        }
        return "info";
    }

    private static String inferConsoleType(ConsoleMessageParts parts) {
        if (parts == null) {
            return "system";
        }
        if ("telemetry".equals(parts.source)) {
            return "telemetry";
        }
        if ("sms".equals(parts.source)
                || "ussd".equals(parts.source)
                || "internet".equals(parts.source)
                || "call".equals(parts.source)
                || "mqtt".equals(parts.source)
                || "http".equals(parts.source)
                || "queue".equals(parts.source)
                || "setup".equals(parts.source)
                || "system".equals(parts.source)) {
            return parts.source;
        }
        String normalized = parts.normalizedText;
        if (normalized.contains("/status")
                || normalized.contains("status push")
                || normalized.contains("telemetry")
                || normalized.contains("health pulse")) {
            return "telemetry";
        }
        if (normalized.contains("ussd")) {
            return "ussd";
        }
        if (normalized.contains("internet")
                || normalized.contains("data mode")
                || normalized.contains("hotspot")
                || normalized.contains("network session")) {
            return "internet";
        }
        if (normalized.contains("send_sms")
                || normalized.contains("sms")
                || normalized.contains("message")) {
            return "sms";
        }
        if (normalized.contains("make_call")
                || normalized.contains("call")
                || normalized.contains("dial")
                || normalized.contains("ring")) {
            return "call";
        }
        if (normalized.contains("mqtt")) {
            return "mqtt";
        }
        if (normalized.contains("http")) {
            return "http";
        }
        if (normalized.contains("queue") || normalized.contains("publish")) {
            return "queue";
        }
        if (normalized.contains("setup") || normalized.contains("onboard")) {
            return "setup";
        }
        return "system";
    }

    private static String extractTaggedValue(String message, String marker) {
        if (message == null || marker == null || marker.isEmpty()) {
            return "";
        }
        int start = message.indexOf(marker);
        if (start < 0) {
            return "";
        }
        start += marker.length();
        int nextPayload = message.indexOf(" payload=", start);
        int nextResponse = message.indexOf(" response=", start);
        int end = message.length();
        if (nextPayload >= 0) {
            end = Math.min(end, nextPayload);
        }
        if (nextResponse >= 0) {
            end = Math.min(end, nextResponse);
        }
        return message.substring(start, Math.max(start, end)).trim();
    }

    private static ConsoleMessageParts parseConsoleMessage(String message) {
        String text = message == null ? "" : message.trim();
        int payload = text.indexOf(" payload=");
        int response = text.indexOf(" response=");
        int meta = -1;
        if (payload >= 0 && response >= 0) {
            meta = Math.min(payload, response);
        } else if (payload >= 0) {
            meta = payload;
        } else if (response >= 0) {
            meta = response;
        }
        if (meta > 0) {
            text = text.substring(0, meta).trim();
        }
        String source = "";
        int sourceSeparator = text.indexOf(':');
        if (sourceSeparator > 0 && sourceSeparator < 24) {
            String candidate = text.substring(0, sourceSeparator).trim().toLowerCase(Locale.US);
            if (candidate.matches("[a-z][a-z0-9_-]{1,23}")) {
                source = candidate;
                text = text.substring(sourceSeparator + 1).trim();
            }
        }
        int separator = text.indexOf("::");
        if (separator > 0) {
            return new ConsoleMessageParts(
                    source,
                    text.substring(0, separator).trim(),
                    text.substring(separator + 2).trim()
            );
        }
        int colon = text.indexOf(':');
        if (colon > 0 && colon < 42) {
            return new ConsoleMessageParts(
                    source,
                    text.substring(0, colon).trim(),
                    text.substring(colon + 1).trim()
            );
        }
        return new ConsoleMessageParts(source, text, text);
    }

    private static Integer readBatteryLevel(Activity activity) {
        String pulse = BridgeDiagnostics.buildHealthPulse(activity);
        int marker = pulse.indexOf("Battery: ");
        if (marker < 0) {
            return null;
        }
        int start = marker + "Battery: ".length();
        int end = pulse.indexOf('%', start);
        if (end <= start) {
            return null;
        }
        try {
            return Integer.parseInt(pulse.substring(start, end).trim());
        } catch (NumberFormatException ignored) {
            return null;
        }
    }

    private static String readBatteryStatus(Activity activity) {
        String pulse = BridgeDiagnostics.buildHealthPulse(activity);
        int marker = pulse.indexOf("Battery: ");
        if (marker < 0) {
            return "Unknown";
        }
        int start = marker + "Battery: ".length();
        int end = pulse.indexOf('\n', start);
        String line = (end > start ? pulse.substring(start, end) : pulse.substring(start)).trim().toLowerCase(Locale.US);
        if (line.contains("charging")) {
            return "Charging";
        }
        if (line.contains("on battery")) {
            return "On battery";
        }
        return "Unknown";
    }

    private static String buildHardwareIdSummary(Activity activity) {
        String androidId = readAndroidId(activity);
        String installId = BridgeConfig.load(activity).installId;
        if (androidId != null && !androidId.trim().isEmpty()) {
            return "Android ID " + androidId.trim();
        }
        if (installId != null && !installId.trim().isEmpty()) {
            return "Install ID " + installId.trim();
        }
        return "Unavailable";
    }

    private static String readAndroidId(Activity activity) {
        try {
            return Settings.Secure.getString(activity.getContentResolver(), Settings.Secure.ANDROID_ID);
        } catch (RuntimeException ignored) {
            return "";
        }
    }

    private static int inferSimSlotCount(TelephonyManager telephony) {
        if (telephony == null) {
            return 0;
        }
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                int count = telephony.getActiveModemCount();
                if (count > 0) {
                    return count;
                }
            }
        } catch (RuntimeException ignored) {
        }
        try {
            if (Build.VERSION.SDK_INT >= 23) {
                int count = telephony.getPhoneCount();
                if (count > 0) {
                    return count;
                }
            }
        } catch (RuntimeException ignored) {
        }
        return 1;
    }

    private static int readSimState(TelephonyManager telephony, int slotIndex) {
        if (telephony == null) {
            return TelephonyManager.SIM_STATE_UNKNOWN;
        }
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                return telephony.getSimState(slotIndex);
            }
        } catch (RuntimeException ignored) {
        }
        try {
            return telephony.getSimState();
        } catch (RuntimeException ignored) {
            return TelephonyManager.SIM_STATE_UNKNOWN;
        }
    }

    private static String phoneTypeLabel(int type) {
        if (type == TelephonyManager.PHONE_TYPE_GSM) return "gsm";
        if (type == TelephonyManager.PHONE_TYPE_CDMA) return "cdma";
        if (type == TelephonyManager.PHONE_TYPE_SIP) return "sip";
        return "none";
    }

    private static String networkTypeLabel(int type) {
        switch (type) {
            case TelephonyManager.NETWORK_TYPE_LTE:
                return "lte";
            case TelephonyManager.NETWORK_TYPE_NR:
                return "5g";
            case TelephonyManager.NETWORK_TYPE_HSPA:
            case TelephonyManager.NETWORK_TYPE_HSPAP:
                return "hspa";
            case TelephonyManager.NETWORK_TYPE_EDGE:
                return "edge";
            case TelephonyManager.NETWORK_TYPE_GPRS:
                return "gprs";
            case TelephonyManager.NETWORK_TYPE_UMTS:
                return "umts";
            default:
                return type <= 0 ? "unknown" : ("type_" + type);
        }
    }

    private static String simStateLabel(int state) {
        if (state == TelephonyManager.SIM_STATE_READY) return "ready";
        if (state == TelephonyManager.SIM_STATE_ABSENT) return "absent";
        if (state == TelephonyManager.SIM_STATE_PIN_REQUIRED) return "pin required";
        if (state == TelephonyManager.SIM_STATE_PUK_REQUIRED) return "puk required";
        if (state == TelephonyManager.SIM_STATE_NETWORK_LOCKED) return "network locked";
        return "unknown";
    }

    private static WifiSummary captureWifiSummary(Activity activity) {
        ConnectivityManager connectivityManager = activity.getSystemService(ConnectivityManager.class);
        WifiManager wifiManager = activity.getApplicationContext().getSystemService(WifiManager.class);
        Network activeNetwork = connectivityManager == null ? null : connectivityManager.getActiveNetwork();
        NetworkCapabilities capabilities = (connectivityManager == null || activeNetwork == null)
                ? null
                : connectivityManager.getNetworkCapabilities(activeNetwork);
        LinkProperties linkProperties = (connectivityManager == null || activeNetwork == null)
                ? null
                : connectivityManager.getLinkProperties(activeNetwork);

        boolean wifiTransport = capabilities != null && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI);
        boolean wifiEnabled = wifiManager != null && wifiManager.isWifiEnabled();
        boolean permissionReady = hasWifiDetailPermission(activity);
        WifiInfo wifiInfo = null;

        if (permissionReady && Build.VERSION.SDK_INT >= 29 && capabilities != null) {
            Object transportInfo = capabilities.getTransportInfo();
            if (transportInfo instanceof WifiInfo) {
                wifiInfo = (WifiInfo) transportInfo;
            }
        }
        if (wifiInfo == null && permissionReady && wifiManager != null) {
            try {
                wifiInfo = wifiManager.getConnectionInfo();
            } catch (SecurityException ignored) {
                wifiInfo = null;
            } catch (RuntimeException ignored) {
                wifiInfo = null;
            }
        }

        String ssid = wifiInfo == null ? "" : normalizeWifiSsid(wifiInfo.getSSID());
        boolean connected = wifiTransport
                || !ssid.isEmpty()
                || (wifiInfo != null && wifiInfo.getNetworkId() != -1);
        String ipAddress = wifiTransport ? firstIpv4Address(linkProperties) : "";
        return new WifiSummary(wifiEnabled, connected, ssid, ipAddress);
    }

    private static boolean hasWifiDetailPermission(Activity activity) {
        if (Build.VERSION.SDK_INT >= 33) {
            return activity.checkSelfPermission(Manifest.permission.NEARBY_WIFI_DEVICES)
                    == PackageManager.PERMISSION_GRANTED;
        }
        return activity.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    private static String normalizeWifiSsid(String ssid) {
        if (ssid == null) {
            return "";
        }
        String cleaned = ssid.trim();
        if (cleaned.startsWith("\"") && cleaned.endsWith("\"") && cleaned.length() >= 2) {
            cleaned = cleaned.substring(1, cleaned.length() - 1);
        }
        if ("<unknown ssid>".equalsIgnoreCase(cleaned)) {
            return "";
        }
        return cleaned;
    }

    private static String firstIpv4Address(LinkProperties properties) {
        if (properties == null) {
            return "";
        }
        List<LinkAddress> addresses = properties.getLinkAddresses();
        if (addresses == null) {
            return "";
        }
        for (LinkAddress address : addresses) {
            if (address == null || address.getAddress() == null) {
                continue;
            }
            String hostAddress = address.getAddress().getHostAddress();
            if (hostAddress != null && hostAddress.indexOf(':') < 0) {
                return hostAddress;
            }
        }
        return "";
    }

    private static String formatAge(long timestampMs) {
        if (timestampMs <= 0L) {
            return "never";
        }
        long ageMs = Math.max(0L, System.currentTimeMillis() - timestampMs);
        if (ageMs < 1000L) return "just now";
        long seconds = ageMs / 1000L;
        if (seconds < 60L) return seconds + "s ago";
        long minutes = seconds / 60L;
        if (minutes < 60L) return minutes + "m ago";
        long hours = minutes / 60L;
        if (hours < 24L) return hours + "h ago";
        return String.format(Locale.US, "%.1fd ago", ageMs / 86400000d);
    }

    private static String resolveSubscriptionNumber(SubscriptionInfo info, TelephonyManager telephony) {
        if (info != null && Build.VERSION.SDK_INT >= 22) {
            try {
                CharSequence number = info.getNumber();
                if (number != null && !number.toString().trim().isEmpty()) {
                    return number.toString().trim();
                }
            } catch (RuntimeException ignored) {
            }
        }
        if (info != null && telephony != null && Build.VERSION.SDK_INT >= 24) {
            try {
                TelephonyManager subscriptionTelephony = telephony.createForSubscriptionId(info.getSubscriptionId());
                String fallback = safeLine1Number(subscriptionTelephony);
                if (!fallback.isEmpty()) {
                    return fallback;
                }
            } catch (RuntimeException ignored) {
            }
        }
        return "";
    }

    private static String safeLine1Number(TelephonyManager telephony) {
        if (telephony == null) {
            return "";
        }
        try {
            String value = telephony.getLine1Number();
            return value == null ? "" : value.trim();
        } catch (SecurityException ignored) {
            return "";
        } catch (RuntimeException ignored) {
            return "";
        }
    }

    private static String safeCharSequence(CharSequence value, String fallback) {
        return value == null || value.toString().trim().isEmpty() ? fallback : value.toString().trim();
    }

    private static String safe(String value, String fallback) {
        return value == null || value.trim().isEmpty() ? fallback : value.trim();
    }

    private static String stringValue(Object value) {
        if (value == null) {
            return "";
        }
        String text = String.valueOf(value).trim();
        return "null".equalsIgnoreCase(text) ? "" : text;
    }

    private static final class ConsoleMessageParts {
        final String source;
        final String summary;
        final String detail;
        final String normalizedText;

        ConsoleMessageParts(String source, String summary, String detail) {
            this.source = source == null ? "" : source.trim().toLowerCase(Locale.US);
            this.summary = summary == null ? "" : summary.trim();
            this.detail = detail == null ? "" : detail.trim();
            this.normalizedText = (
                    this.source
                            + " "
                            + this.summary
                            + " "
                            + this.detail
            ).trim().toLowerCase(Locale.US);
        }
    }

    private static final class CallSummary {
        final String status;
        final String direction;
        final String number;
        final String timestamp;

        CallSummary(String status, String direction, String number, String timestamp) {
            this.status = status == null ? "" : status.trim().toLowerCase(Locale.US);
            this.direction = direction == null ? "" : direction.trim().toLowerCase(Locale.US);
            this.number = number == null ? "" : number.trim();
            this.timestamp = timestamp == null ? "" : timestamp.trim();
        }

        static CallSummary empty() {
            return new CallSummary("", "", "", "");
        }

        String primaryLabel(long fallbackTimestampMs) {
            if (!status.isEmpty()) {
                return status.substring(0, 1).toUpperCase(Locale.US) + status.substring(1);
            }
            return "Events " + formatAge(fallbackTimestampMs);
        }

        String secondaryLabel() {
            StringBuilder builder = new StringBuilder();
            if (!direction.isEmpty()) {
                builder.append(direction.substring(0, 1).toUpperCase(Locale.US))
                        .append(direction.substring(1));
            }
            if (!number.isEmpty()) {
                if (builder.length() > 0) {
                    builder.append(" ");
                }
                builder.append(number);
            }
            if (builder.length() == 0) {
                builder.append("Calls + state");
            }
            return builder.toString();
        }
    }

    private static final class WifiSummary {
        final boolean enabled;
        final boolean connected;
        final String ssid;
        final String ipAddress;

        WifiSummary(boolean enabled, boolean connected, String ssid, String ipAddress) {
            this.enabled = enabled;
            this.connected = connected;
            this.ssid = ssid == null ? "" : ssid;
            this.ipAddress = ipAddress == null ? "" : ipAddress;
        }
    }
}
