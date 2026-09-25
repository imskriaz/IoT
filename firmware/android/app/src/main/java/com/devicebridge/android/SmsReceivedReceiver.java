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
            // AND-05: prefer the modem SCTS timestamp (when the message was
            // actually sent). Receive-time is only the fallback for PDUs that
            // carry no service-center timestamp.
            long timestamp = -1L;
            SmsMultipartInfo multipartInfo = null;
            for (SmsMessage message : messages) {
                if (message == null) {
                    continue;
                }
                if (from.isEmpty() && message.getOriginatingAddress() != null) {
                    from = message.getOriginatingAddress();
                }
                if (multipartInfo == null) {
                    multipartInfo = SmsMultipartInfo.fromMessage(message);
                }
                body.append(message.getMessageBody() == null ? "" : message.getMessageBody());
                long serviceCenterTs = message.getTimestampMillis();
                if (serviceCenterTs > 0L && serviceCenterTs > timestamp) {
                    timestamp = serviceCenterTs;
                }
            }
            if (timestamp <= 0L) {
                timestamp = System.currentTimeMillis();
            }

            int slot = intent.getIntExtra("android.telephony.extra.SLOT_INDEX", -1);
            BridgeSmsStore.recordIncoming(context, from, body.toString(), timestamp);
            MqttBridgeService.publishIncomingFromReceiver(context, from, body.toString(), timestamp, slot, multipartInfo);
        } catch (RuntimeException error) {
            Log.e(TAG, "Failed to process inbound SMS", error);
        }
    }
}


