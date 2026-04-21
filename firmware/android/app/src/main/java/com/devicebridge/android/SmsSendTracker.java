package com.devicebridge.android;

import android.app.Activity;
import android.telephony.SmsManager;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

final class SmsSendTracker {
    private static final Map<String, State> STATES = new ConcurrentHashMap<>();

    private SmsSendTracker() {
    }

    static void register(String actionId, String number, int partCount, int timeoutMs) {
        String key = key(actionId);
        STATES.put(key, new State(actionId, number, Math.max(partCount, 1), sanitizeTimeout(timeoutMs)));
    }

    static void remove(String actionId) {
        STATES.remove(key(actionId));
    }

    static void markSent(String actionId, String number, int resultCode) {
        String key = key(actionId);
        State state = STATES.get(key);
        if (state == null) {
            state = new State(actionId, number, 1, 90000);
            STATES.put(key, state);
        }

        if (resultCode != Activity.RESULT_OK) {
            if (!state.finished) {
                state.finished = true;
                STATES.remove(key);
                MqttBridgeService.publishSentResult(actionId, state.number, state.totalParts, state.timeoutMs, false, detailFor(resultCode));
            }
            return;
        }

        state.sentParts++;
        if (state.sentParts >= state.totalParts && !state.finished) {
            state.finished = true;
            STATES.remove(key);
            MqttBridgeService.publishSentResult(actionId, state.number, state.totalParts, state.timeoutMs, true, "sms_sent");
        }
    }

    static void markDelivered(String actionId, String number) {
        MqttBridgeService.publishDelivered(actionId, number);
    }

    private static String detailFor(int resultCode) {
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
        int sentParts;
        boolean finished;

        State(String actionId, String number, int totalParts, int timeoutMs) {
            this.actionId = actionId;
            this.number = number;
            this.totalParts = totalParts;
            this.timeoutMs = timeoutMs;
        }
    }
}


