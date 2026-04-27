package com.devicebridge.android;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

public class SmsSentReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !SmsSender.ACTION_SENT.equals(intent.getAction())) {
            return;
        }
        String actionId = intent.getStringExtra(SmsSender.EXTRA_ACTION_ID);
        String number = intent.getStringExtra(SmsSender.EXTRA_NUMBER);
        Bundle extras = getResultExtras(false);
        SmsSendTracker.markSent(context, actionId, number, getResultCode(), extras);
    }
}


