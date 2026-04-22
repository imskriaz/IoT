package com.devicebridge.android;

import android.app.Activity;
import android.content.Intent;
import android.os.Build;

final class BridgeRecoveryActions {
    private BridgeRecoveryActions() {
    }

    static void execute(Activity activity, String action) {
        String normalized = action == null ? "" : action.trim().toLowerCase(java.util.Locale.ROOT);
        if (normalized.isEmpty()) {
            return;
        }

        switch (normalized) {
            case "permissions":
            case "onboarding":
                reopenOnboarding(activity);
                return;
            case "settings":
                activity.startActivity(new Intent(activity, SettingsActivity.class));
                return;
            case "start":
                startBridge(activity);
                BridgeEventLog.append(activity, "Recovery action executed: start bridge");
                return;
            case "restart":
                stopBridge(activity);
                startBridge(activity);
                BridgeEventLog.append(activity, "Recovery action executed: restart bridge");
                return;
            case "clear_queue":
                clearQueue(activity);
                BridgeEventLog.append(activity, "Recovery action executed: clear queue");
                return;
            case "clear_log":
                clearLog(activity);
                BridgeEventLog.append(activity, "Recovery action executed: clear log");
                return;
            case "reset_state":
                resetState(activity);
                BridgeEventLog.append(activity, "Recovery action executed: reset state");
                return;
            case "healthy":
                activity.startActivity(HomeActivity.createHomeIntent(activity));
                return;
            default:
                activity.startActivity(new Intent(activity, FeatureHubActivity.class));
        }
    }

    static void startBridge(Activity activity) {
        if (!BridgeAppGate.hasConnectionDetails(activity)) {
            BridgeConfig.load(activity).withBridgeEnabled(false).save(activity);
            BridgeEventLog.append(activity, "Bridge start blocked: onboarding required");
            BridgeRuntimeState runtime = BridgeRuntimeState.load(activity);
            BridgeRuntimeState.saveSnapshot(
                    activity,
                    "config_missing",
                    false,
                    "Open onboarding and import a QR or setup code.",
                    runtime.publishSuccessCount,
                    runtime.publishFailureCount,
                    runtime.queueDepth,
                    runtime.lastStatusPushAtMs,
                    runtime.lastQueuePollAtMs,
                    runtime.lastMessageEventAtMs,
                    runtime.lastIncomingSyncAtMs,
                    runtime.lastSendAcceptedAtMs
            );
            activity.startActivity(new Intent(activity, OnboardingActivity.class));
            activity.finish();
            return;
        }
        BridgeConfig.load(activity).withBridgeEnabled(true).save(activity);
        Intent intent = new Intent(activity, MqttBridgeService.class).setAction(MqttBridgeService.ACTION_START);
        if (Build.VERSION.SDK_INT >= 26) {
            activity.startForegroundService(intent);
        } else {
            activity.startService(intent);
        }
    }

    static void stopBridge(Activity activity) {
        BridgeConfig.load(activity).withBridgeEnabled(false).save(activity);
        BridgeRuntimeState runtime = BridgeRuntimeState.load(activity);
        BridgeRuntimeState.saveSnapshot(
                activity,
                "stopping",
                false,
                "Stopping bridge",
                runtime.publishSuccessCount,
                runtime.publishFailureCount,
                runtime.queueDepth,
                runtime.lastStatusPushAtMs,
                runtime.lastQueuePollAtMs,
                runtime.lastMessageEventAtMs,
                runtime.lastIncomingSyncAtMs,
                runtime.lastSendAcceptedAtMs
        );
        Intent intent = new Intent(activity, MqttBridgeService.class).setAction(MqttBridgeService.ACTION_STOP);
        activity.startService(intent);
    }

    static void clearQueue(Activity activity) {
        if (!BridgeAppGate.isBridgeServiceRunning(activity)) {
            BridgeRuntimeState runtime = BridgeRuntimeState.load(activity);
            BridgeRuntimeState.saveSnapshot(
                    activity,
                    runtime.serviceState,
                    runtime.mqttConnected,
                    runtime.detail,
                    runtime.publishSuccessCount,
                    runtime.publishFailureCount,
                    0,
                    runtime.lastStatusPushAtMs,
                    runtime.lastQueuePollAtMs,
                    runtime.lastMessageEventAtMs,
                    runtime.lastIncomingSyncAtMs,
                    runtime.lastSendAcceptedAtMs
            );
            BridgeEventLog.append(activity, "Queue clear skipped: bridge service not running");
            return;
        }
        MqttBridgeService.requestClearQueue(activity);
    }

    static void clearLog(Activity activity) {
        BridgeEventLog.clear(activity);
        resetRuntimeTelemetry(activity, false);
    }

    static void reopenOnboarding(Activity activity) {
        resetOnboardingState(activity);
        activity.startActivity(new Intent(activity, OnboardingActivity.class));
        activity.finish();
    }

    static void resetOnboardingState(Activity activity) {
        stopBridge(activity);
        clearQueue(activity);
        BridgeConfig.clearConnection(activity, true);
        BridgeEventLog.clear(activity);
        BridgeRuntimeState.saveSnapshot(
                activity,
                "idle",
                false,
                "Waiting for onboarding",
                0L,
                0L,
                0,
                0L,
                0L,
                0L,
                0L,
                0L
        );
        BridgeEventLog.append(activity, "Re-onboard requested. Previous connection cleared");
    }

    static void resetState(Activity activity) {
        stopBridge(activity);
        clearQueue(activity);
        BridgeEventLog.clear(activity);
        resetRuntimeTelemetry(activity, true);
        startBridge(activity);
    }

    private static void resetRuntimeTelemetry(Activity activity, boolean keepEnabled) {
        BridgeRuntimeState runtime = BridgeRuntimeState.load(activity);
        BridgeRuntimeState.saveSnapshot(
                activity,
                keepEnabled ? "starting" : runtime.serviceState,
                false,
                keepEnabled ? "Recovery reset in progress" : runtime.detail,
                0L,
                0L,
                0,
                0L,
                0L,
                0L,
                0L,
                0L
        );
    }
}


