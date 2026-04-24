package com.devicebridge.android;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
public class BootReceiver extends BroadcastReceiver {
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
        context.startForegroundService(service);
    }
}


