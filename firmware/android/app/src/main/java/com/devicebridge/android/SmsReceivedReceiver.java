package com.devicebridge.android;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.provider.Telephony;
import android.telephony.SmsMessage;
import android.util.Log;

public class SmsReceivedReceiver extends BroadcastReceiver {
    private static final String TAG = "DeviceBridgeSmsRx";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !Telephony.Sms.Intents.SMS_RECEIVED_ACTION.equals(intent.getAction())) {
            return;
        }

        try {
            SmsMessage[] messages = Telephony.Sms.Intents.getMessagesFromIntent(intent);
            if (messages == null || messages.length == 0) {
                return;
            }

            StringBuilder body = new StringBuilder();
            String from = "";
            long timestamp = System.currentTimeMillis();
            for (SmsMessage message : messages) {
                if (message == null) {
                    continue;
                }
                if (from.isEmpty() && message.getOriginatingAddress() != null) {
                    from = message.getOriginatingAddress();
                }
                body.append(message.getMessageBody() == null ? "" : message.getMessageBody());
                timestamp = Math.max(timestamp, message.getTimestampMillis());
            }

            int slot = intent.getIntExtra("android.telephony.extra.SLOT_INDEX", -1);
            BridgeSmsStore.recordIncoming(context, from, body.toString(), timestamp);
            MqttBridgeService.publishIncomingFromReceiver(context, from, body.toString(), timestamp, slot);
        } catch (RuntimeException error) {
            Log.e(TAG, "Failed to process inbound SMS", error);
        }
    }
}


