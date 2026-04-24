package com.devicebridge.android;

import android.app.ActivityManager;
import android.app.Activity;
import android.content.Intent;

import java.util.List;

final class BridgeAppGate {
    private BridgeAppGate() {
    }

    static boolean routeFromStartup(Activity activity) {
        normalizeRuntimeState(activity);
        return false;
    }

    static boolean hasConnectionDetails(Activity activity) {
        BridgeConfig config = BridgeConfig.load(activity);
        return config.hasBridgeConnectionConfig();
    }

    static boolean isOnline(Activity activity) {
        BridgeConfig config = BridgeConfig.load(activity);
        BridgeRuntimeState runtime = BridgeRuntimeState.load(activity);
        if (!isBridgeServiceRunning(activity)) {
            return false;
        }
        return runtime.isBridgeOnline(config);
    }

    private static void normalizeRuntimeState(Activity activity) {
        if (isBridgeServiceRunning(activity)) {
            return;
        }

        BridgeConfig config = BridgeConfig.load(activity);
        BridgeRuntimeState runtime = BridgeRuntimeState.load(activity);
        if (!runtime.isBridgeOnline(config)) {
            return;
        }
        BridgeRuntimeState.saveSnapshot(
                activity,
                config.bridgeEnabled ? "stopped" : "offline",
                false,
                config.bridgeEnabled ? "Bridge idle until restarted" : "Bridge disabled",
                runtime.publishSuccessCount,
                runtime.publishFailureCount,
                runtime.queueDepth,
                runtime.lastStatusPushAtMs,
                runtime.lastQueuePollAtMs,
                runtime.lastMessageEventAtMs,
                runtime.lastIncomingSyncAtMs,
                runtime.lastSendAcceptedAtMs
        );
    }

    static boolean isBridgeServiceRunning(Activity activity) {
        ActivityManager activityManager = activity.getSystemService(ActivityManager.class);
        if (activityManager == null) {
            return false;
        }
        List<ActivityManager.RunningServiceInfo> services = activityManager.getRunningServices(Integer.MAX_VALUE);
        if (services == null) {
            return false;
        }
        String expectedName = MqttBridgeService.class.getName();
        for (ActivityManager.RunningServiceInfo service : services) {
            if (service != null && service.service != null && expectedName.equals(service.service.getClassName())) {
                return true;
            }
        }
        return false;
    }
}


