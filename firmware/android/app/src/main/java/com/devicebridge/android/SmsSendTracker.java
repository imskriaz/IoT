package com.devicebridge.android;

import android.app.Activity;
import android.content.Context;
import android.os.Bundle;
import android.telephony.SmsManager;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

final class SmsSendTracker {
    private static final Map<String, State> STATES = new ConcurrentHashMap<>();

    private SmsSendTracker() {
    }

    static void register(String actionId, String number, int partCount, int timeoutMs) {
        pruneExpired();
        String key = key(actionId);
        STATES.put(key, new State(actionId, number, Math.max(partCount, 1), sanitizeTimeout(timeoutMs), System.currentTimeMillis()));
    }

    static void remove(String actionId) {
        STATES.remove(key(actionId));
    }

    static void markSent(Context context, String actionId, String number, int resultCode, Bundle extras) {
        pruneExpired();
        String key = key(actionId);
        State state = STATES.get(key);
        if (state == null) {
            state = new State(actionId, number, 1, 90000, System.currentTimeMillis());
            STATES.put(key, state);
        }

        if (resultCode != Activity.RESULT_OK) {
            if (!state.sendPublished) {
                state.sendPublished = true;
                STATES.remove(key);
                String detail = detailFor(resultCode, extras);
                BridgeSmsStore.updateOutgoingStatus(context, actionId, "failed");
                MqttBridgeService.publishSentResult(actionId, state.number, state.totalParts, state.timeoutMs, false, detail);
            }
            return;
        }

        state.sentParts++;
        if (state.sentParts >= state.totalParts && !state.sendPublished) {
            state.sendPublished = true;
            BridgeSmsStore.updateOutgoingStatus(context, actionId, "sent");
            MqttBridgeService.publishSentResult(actionId, state.number, state.totalParts, state.timeoutMs, true, "sms_sent");
            if (state.deliveryPublished || state.totalParts <= 0) {
                STATES.remove(key);
            }
        }
    }

    static void markDelivered(Context context, String actionId, String number) {
        pruneExpired();
        String key = key(actionId);
        State state = STATES.get(key);
        if (state == null) {
            BridgeSmsStore.updateOutgoingStatus(context, actionId, "delivered");
            MqttBridgeService.publishDelivered(actionId, number);
            return;
        }

        state.deliveredParts++;
        if (state.deliveredParts >= state.totalParts && !state.deliveryPublished) {
            state.deliveryPublished = true;
            BridgeSmsStore.updateOutgoingStatus(context, actionId, "delivered");
            MqttBridgeService.publishDelivered(actionId, state.number);
            if (state.sendPublished) {
                STATES.remove(key);
            }
        }
    }

    private static void pruneExpired() {
        long now = System.currentTimeMillis();
        STATES.entrySet().removeIf(entry -> entry.getValue() == null || entry.getValue().isExpired(now));
    }

    private static String detailFor(int resultCode, Bundle extras) {
        if (extras != null && extras.getBoolean("noDefault", false)) {
            return "sms_default_sim_required";
        }
        switch (resultCode) {
            case SmsManager.RESULT_ERROR_GENERIC_FAILURE:
                return "sms_send_failed";
            case SmsManager.RESULT_ERROR_NO_SERVICE:
                return "sms_no_service";
            case SmsManager.RESULT_ERROR_NULL_PDU:
                return "sms_null_pdu";
            case SmsManager.RESULT_ERROR_RADIO_OFF:
                return "sms_radio_off";
            default:
                return "sms_send_failed_" + resultCode;
        }
    }

    private static String key(String actionId) {
        return actionId == null || actionId.trim().isEmpty() ? "missing" : actionId.trim();
    }

    private static int sanitizeTimeout(int timeoutMs) {
        return timeoutMs > 0 ? timeoutMs : 90000;
    }

    private static final class State {
        final String actionId;
        final String number;
        final int totalParts;
        final int timeoutMs;
        final long createdAtMs;
        int sentParts;
        int deliveredParts;
        boolean sendPublished;
        boolean deliveryPublished;

        State(String actionId, String number, int totalParts, int timeoutMs, long createdAtMs) {
            this.actionId = actionId;
            this.number = number;
            this.totalParts = totalParts;
            this.timeoutMs = timeoutMs;
            this.createdAtMs = createdAtMs;
        }

        boolean isExpired(long now) {
            long maxAgeMs = Math.max(timeoutMs, 90000) + 60000L;
            return createdAtMs > 0L && now - createdAtMs > maxAgeMs;
        }
    }
}


