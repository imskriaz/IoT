package com.devicebridge.android;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class SmsDeliveredReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !SmsSender.ACTION_DELIVERED.equals(intent.getAction())) {
            return;
        }
        String actionId = intent.getStringExtra(SmsSender.EXTRA_ACTION_ID);
        String number = intent.getStringExtra(SmsSender.EXTRA_NUMBER);
        SmsSendTracker.markDelivered(context, actionId, number);
    }
}


