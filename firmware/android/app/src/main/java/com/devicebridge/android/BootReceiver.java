package com.devicebridge.android;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

public class BootReceiver extends BroadcastReceiver {
    private static final String TAG = "DeviceBridgeBoot";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
            return;
        }
        BridgeConfig config = BridgeConfig.load(context);
        if (!config.bridgeEnabled) {
            return;
        }
        if (!config.hasBridgeConnectionConfig()) {
            BridgeEventLog.append(context, "Boot start skipped: onboarding required");
            return;
        }

        Intent service = new Intent(context, MqttBridgeService.class).setAction(MqttBridgeService.ACTION_START);
        try {
            // remoteMessaging is an exempted foreground-service type for
            // BOOT_COMPLETED delivery; the guard still catches OEM-specific
            // background-start restrictions instead of crashing the boot path.
            context.startForegroundService(service);
        } catch (RuntimeException error) {
            Log.w(TAG, "Boot start deferred by the OS", error);
            BridgeEventLog.append(context, "Boot start deferred: " + (error.getMessage() == null ? "restricted" : error.getMessage()));
        }
    }
}
