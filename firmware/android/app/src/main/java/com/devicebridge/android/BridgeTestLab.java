package com.devicebridge.android;

import android.app.Activity;
import android.Manifest;
import android.content.pm.PackageManager;

import org.json.JSONException;
import org.json.JSONObject;

final class BridgeTestLab {
    interface Callback {
        void onComplete(String title, String detail);
    }

    private BridgeTestLab() {
    }

    static void runStatusPushTest(Activity activity, Callback callback) {
        new Thread(() -> {
            BridgeConfig config = BridgeConfig.load(activity);
            BridgeRuntimeState runtime = BridgeRuntimeState.load(activity);
            String detail;

            boolean shouldUseHttp = config.usesHttpTransport()
                    || (config.usesAutoTransport() && !config.hasProvisionedMqttConfig() && config.hasHttpBridgeConfig());
            if (shouldUseHttp) {
                if (!config.hasHttpBridgeConfig()) {
                    detail = "Dashboard status push blocked. Server URL, API key, or device ID is missing.";
                } else {
                    JSONObject payload = new JSONObject();
                    try {
                        payload.put("type", "status");
                        payload.put("device_id", config.deviceId);
                        payload.put("bridge", "android_sms");
                        payload.put("transport_mode", config.transportMode);
                        payload.put("status", "lab");
                        payload.put("active_path", "http");
                        payload.put("source", "android_test_lab");
                        payload.put("timestamp", System.currentTimeMillis());
                    } catch (JSONException ignored) {
                    }
                    BridgeHttpClient.Result result = BridgeHttpClient.postStatus(config, payload);
                    detail = result.success
                            ? "Dashboard status push succeeded. Dashboard auth and device status endpoint responded."
                            : "Dashboard status push failed: " + result.detail;
                }
            } else if (!config.hasProvisionedMqttConfig()) {
                detail = "Realtime status push blocked. Broker host or device routing details are incomplete.";
            } else {
                MqttBridgeService.requestImmediateStatusPush(activity);
                detail = runtime.isTransportConnected(config)
                        ? "Realtime status push queued through the running bridge."
                        : "Bridge start/status request sent. If realtime is reachable the next heartbeat will publish status.";
            }

            BridgeEventLog.append(activity, "Test Lab status push: " + detail);
            finish(activity, callback, "Status Push Test", detail);
        }).start();
    }

    static void runQueuePickupTest(Activity activity, Callback callback) {
        new Thread(() -> {
            BridgeConfig config = BridgeConfig.load(activity);
            BridgeRuntimeState runtime = BridgeRuntimeState.load(activity);
            String detail;

            if (!config.usesHttpTransport() && !(config.usesAutoTransport() && !config.hasProvisionedMqttConfig() && config.hasHttpBridgeConfig())) {
                detail = "Queue pickup needs dashboard fallback details. Local queue depth is " + runtime.queueDepth + ".";
            } else if (!config.hasHttpBridgeConfig()) {
                detail = "Queue pickup blocked. Complete server URL, API key, and device ID first.";
            } else {
                try {
                    int count = BridgeHttpClient.fetchOutstandingMessages(config).size();
                    detail = "Dashboard queue pickup responded. Outstanding dashboard messages: " + count + ".";
                } catch (Exception error) {
                    detail = "Dashboard queue pickup failed: " + error.getMessage();
                }
            }

            BridgeEventLog.append(activity, "Test Lab queue pickup: " + detail);
            finish(activity, callback, "Queue Pickup Test", detail);
        }).start();
    }

    static void runSelfSendTest(Activity activity, Callback callback) {
        new Thread(() -> {
            if (activity.checkSelfPermission(Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) {
                finish(activity, callback, "Self SMS Test", "Self-send blocked. " + SmsSender.describeDetail("sms_permission_denied"));
                return;
            }

            String selfNumber = SmsSender.resolveSelfNumber(activity);
            if (selfNumber.isEmpty()) {
                String detail = "Self-send needs the phone's own number. Grant phone-state/phone-number access or store the SIM line number on the device.";
                BridgeEventLog.append(activity, "Test Lab self SMS blocked: no self number");
                finish(activity, callback, "Self SMS Test", detail);
                return;
            }

            long now = System.currentTimeMillis();
            String actionId = "self_test_" + now;
            String body = "Device Bridge self-test " + now;
            SmsSender.SendResult result = SmsSender.send(activity, actionId, selfNumber, body, 90000, null, null);
            if (!result.accepted) {
                String detail = "Self-send rejected: " + SmsSender.describeDetail(result.detail);
                BridgeEventLog.append(activity, "Test Lab self SMS rejected: " + result.detail);
                finish(activity, callback, "Self SMS Test", detail);
                return;
            }

            BridgeSmsStore.recordOutgoing(activity, actionId, selfNumber, body, now, "self_test");
            String detail = "Self-send queued to " + selfNumber + ". Wait for sent/delivered callbacks and the inbound copy to confirm the full SMS loop.";
            BridgeEventLog.append(activity, "Test Lab self SMS queued to " + selfNumber);
            finish(activity, callback, "Self SMS Test", detail);
        }).start();
    }

    static void runPermissionProbe(Activity activity, Callback callback) {
        String detail = BridgeDiagnostics.buildPermissionWatchdog(activity);
        BridgeEventLog.append(activity, "Test Lab permission probe opened");
        finish(activity, callback, "Permission Probe", detail);
    }

    static void runRecoveryProbe(Activity activity, Callback callback) {
        String detail = BridgeRecoveryAdvisor.buildAdvisorText(activity);
        BridgeEventLog.append(activity, "Test Lab recovery probe opened");
        finish(activity, callback, "Recovery Probe", detail);
    }

    private static void finish(Activity activity, Callback callback, String title, String detail) {
        activity.runOnUiThread(() -> callback.onComplete(title, detail));
    }
}


