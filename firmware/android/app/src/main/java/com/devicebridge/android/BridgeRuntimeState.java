package com.devicebridge.android;

import android.content.Context;
import android.content.SharedPreferences;

final class BridgeRuntimeState {
    final String serviceState;
    final boolean mqttConnected;
    final String detail;
    final long updatedAtMs;
    final long publishSuccessCount;
    final long publishFailureCount;
    final int queueDepth;
    final long lastStatusPushAtMs;
    final long lastQueuePollAtMs;
    final long lastMessageEventAtMs;
    final long lastIncomingSyncAtMs;
    final long lastSendAcceptedAtMs;

    private BridgeRuntimeState(
            String serviceState,
            boolean mqttConnected,
            String detail,
            long updatedAtMs,
            long publishSuccessCount,
            long publishFailureCount,
            int queueDepth,
            long lastStatusPushAtMs,
            long lastQueuePollAtMs,
            long lastMessageEventAtMs,
            long lastIncomingSyncAtMs,
            long lastSendAcceptedAtMs
    ) {
        this.serviceState = serviceState;
        this.mqttConnected = mqttConnected;
        this.detail = detail;
        this.updatedAtMs = updatedAtMs;
        this.publishSuccessCount = publishSuccessCount;
        this.publishFailureCount = publishFailureCount;
        this.queueDepth = queueDepth;
        this.lastStatusPushAtMs = lastStatusPushAtMs;
        this.lastQueuePollAtMs = lastQueuePollAtMs;
        this.lastMessageEventAtMs = lastMessageEventAtMs;
        this.lastIncomingSyncAtMs = lastIncomingSyncAtMs;
        this.lastSendAcceptedAtMs = lastSendAcceptedAtMs;
    }

    static BridgeRuntimeState load(Context context) {
        SharedPreferences prefs = prefs(context);
        return new BridgeRuntimeState(
                prefs.getString("runtime_state", "idle"),
                prefs.getBoolean("runtime_mqtt_connected", false),
                prefs.getString("runtime_detail", ""),
                prefs.getLong("runtime_updated_at", 0L),
                prefs.getLong("runtime_publish_success_count", 0L),
                prefs.getLong("runtime_publish_failure_count", 0L),
                prefs.getInt("runtime_queue_depth", 0),
                prefs.getLong("runtime_last_status_push_at", 0L),
                prefs.getLong("runtime_last_queue_poll_at", 0L),
                prefs.getLong("runtime_last_message_event_at", 0L),
                prefs.getLong("runtime_last_incoming_sync_at", 0L),
                prefs.getLong("runtime_last_send_accepted_at", 0L)
        );
    }

    static void save(Context context, String serviceState, boolean mqttConnected, String detail) {
        BridgeRuntimeState current = load(context);
        saveSnapshot(
                context,
                serviceState,
                mqttConnected,
                detail,
                current.publishSuccessCount,
                current.publishFailureCount,
                current.queueDepth,
                current.lastStatusPushAtMs,
                current.lastQueuePollAtMs,
                current.lastMessageEventAtMs,
                current.lastIncomingSyncAtMs,
                current.lastSendAcceptedAtMs
        );
    }

    static void saveSnapshot(
            Context context,
            String serviceState,
            boolean mqttConnected,
            String detail,
            long publishSuccessCount,
            long publishFailureCount,
            int queueDepth,
            long lastStatusPushAtMs,
            long lastQueuePollAtMs,
            long lastMessageEventAtMs,
            long lastIncomingSyncAtMs,
            long lastSendAcceptedAtMs
    ) {
        prefs(context).edit()
                .putString("runtime_state", emptyIfNull(serviceState, "idle"))
                .putBoolean("runtime_mqtt_connected", mqttConnected)
                .putString("runtime_detail", emptyIfNull(detail, ""))
                .putLong("runtime_publish_success_count", Math.max(0L, publishSuccessCount))
                .putLong("runtime_publish_failure_count", Math.max(0L, publishFailureCount))
                .putInt("runtime_queue_depth", Math.max(0, queueDepth))
                .putLong("runtime_last_status_push_at", Math.max(0L, lastStatusPushAtMs))
                .putLong("runtime_last_queue_poll_at", Math.max(0L, lastQueuePollAtMs))
                .putLong("runtime_last_message_event_at", Math.max(0L, lastMessageEventAtMs))
                .putLong("runtime_last_incoming_sync_at", Math.max(0L, lastIncomingSyncAtMs))
                .putLong("runtime_last_send_accepted_at", Math.max(0L, lastSendAcceptedAtMs))
                .putLong("runtime_updated_at", System.currentTimeMillis())
                .apply();
    }

    boolean isTransportConnected(BridgeConfig config) {
        if (config != null && (config.usesHttpTransport() || config.usesAutoTransport())
                && "online".equalsIgnoreCase(serviceState)) {
            return true;
        }
        return mqttConnected;
    }

    boolean isBridgeOnline(BridgeConfig config) {
        return "online".equalsIgnoreCase(serviceState) || isTransportConnected(config);
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(BridgeConfig.PREFS, Context.MODE_PRIVATE);
    }

    private static String emptyIfNull(String value, String fallback) {
        return value == null || value.trim().isEmpty() ? fallback : value.trim();
    }
}


