package com.devicebridge.android;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.concurrent.ScheduledExecutorService;

final class BridgeHttpHandler {
    private final MqttBridgeService service;
    private final ScheduledExecutorService executor;

    BridgeHttpHandler(MqttBridgeService service, ScheduledExecutorService executor) {
        this.service = service;
        this.executor = executor;
    }

    BridgeHttpClient.Result connect(BridgeConfig config, JSONObject payload) {
        return BridgeHttpClient.postStatus(config, payload);
    }

    void postStatusAsync(JSONObject payload) {
        executor.execute(() -> {
            BridgeHttpClient.Result result = BridgeHttpClient.postStatus(service.currentConfig(), payload);
            if (!result.success) {
                service.recordHttpFailure("HTTP status push failed", result.detail);
                return;
            }
            service.recordHttpStatusSuccess();
        });
    }

    void postIncomingSmsAsync(JSONObject payload) {
        executor.execute(() -> {
            BridgeHttpClient.Result result = BridgeHttpClient.postIncomingSms(service.currentConfig(), payload);
            if (!result.success) {
                service.recordHttpFailure("HTTP incoming SMS push failed", result.detail);
                return;
            }
            service.recordHttpIncomingSmsSuccess();
        });
    }

    void postMessageEventAsync(String actionId, String eventName, String detail, String number) {
        executor.execute(() -> {
            JSONObject payload = new JSONObject();
            try {
                payload.put("event_name", eventName);
                payload.put("detail", detail == null ? "" : detail);
                payload.put("reason", detail == null ? "" : detail);
                payload.put("number", number == null ? "" : number);
                payload.put("timestamp", System.currentTimeMillis());
            } catch (JSONException ignored) {
            }

            BridgeHttpClient.Result result = BridgeHttpClient.postMessageEvent(service.currentConfig(), actionId, payload);
            if (!result.success) {
                service.recordHttpFailure("HTTP message event failed: " + eventName, result.detail);
                return;
            }
            service.recordHttpMessageEventSuccess();
        });
    }

    void pollOutstandingMessages() {
        BridgeConfig config = service.currentConfig();
        if ((!config.usesHttpTransport() && !config.usesAutoTransport()) || service.isStopRequested() || !config.bridgeEnabled) {
            return;
        }

        try {
            service.recordHttpQueuePollStart();
            for (BridgeHttpClient.OutstandingMessage message : BridgeHttpClient.fetchOutstandingMessages(config)) {
                if (message.id.isEmpty()) {
                    continue;
                }
                service.logBridgeEvent("HTTP send request received for " + message.to);
                SmsSender.SendResult result = service.sendHttpOutstandingMessage(message);
                if (!result.accepted) {
                    postMessageEventAsync(message.id, "FAILED", result.detail, message.to);
                    service.logBridgeEvent("HTTP send request failed: " + result.detail);
                }
            }
        } catch (Exception error) {
            service.recordHttpFailure("HTTP queue poll failed", error == null ? "" : error.getMessage());
        }
    }
}


