package com.devicebridge.android;

import android.Manifest;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.telephony.SmsManager;
import android.telephony.SubscriptionInfo;
import android.telephony.SubscriptionManager;

import java.util.ArrayList;
import java.util.List;

final class SmsSender {
    static final String ACTION_SENT = "com.devicebridge.android.SMS_SENT";
    static final String ACTION_DELIVERED = "com.devicebridge.android.SMS_DELIVERED";
    static final String EXTRA_ACTION_ID = "action_id";
    static final String EXTRA_NUMBER = "number";
    static final String EXTRA_PART = "part";
    static final String EXTRA_TOTAL = "total";

    private SmsSender() {
    }

    static SendResult send(Context context, String actionId, String number, String text, int timeoutMs, Integer preferredSimSlot, Integer preferredSubscriptionId) {
        String cleanNumber = number == null ? "" : number.trim();
        String cleanText = text == null ? "" : text;
        if (cleanNumber.isEmpty()) {
            return SendResult.rejected("sms_number_required");
        }
        if (cleanText.isEmpty()) {
            return SendResult.rejected("sms_text_required");
        }
        if (context.checkSelfPermission(Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) {
            return SendResult.rejected("sms_permission_denied");
        }

        SmsManager smsManager = getSmsManager(context, preferredSimSlot, preferredSubscriptionId);
        if (smsManager == null) {
            return SendResult.rejected("sms_sim_not_available");
        }
        ArrayList<String> parts = smsManager.divideMessage(cleanText);
        if (parts == null || parts.isEmpty()) {
            parts = new ArrayList<>();
            parts.add(cleanText);
        }

        SmsSendTracker.register(actionId, cleanNumber, parts.size(), timeoutMs);

        ArrayList<PendingIntent> sentIntents = new ArrayList<>();
        ArrayList<PendingIntent> deliveredIntents = new ArrayList<>();
        for (int i = 0; i < parts.size(); i++) {
            sentIntents.add(pendingBroadcast(context, SmsSentReceiver.class, ACTION_SENT, actionId, cleanNumber, i, parts.size()));
            deliveredIntents.add(pendingBroadcast(context, SmsDeliveredReceiver.class, ACTION_DELIVERED, actionId, cleanNumber, i, parts.size()));
        }

        try {
            if (parts.size() == 1) {
                smsManager.sendTextMessage(cleanNumber, null, cleanText, sentIntents.get(0), deliveredIntents.get(0));
            } else {
                smsManager.sendMultipartTextMessage(cleanNumber, null, parts, sentIntents, deliveredIntents);
            }
            return SendResult.accepted(parts.size());
        } catch (IllegalArgumentException error) {
            SmsSendTracker.remove(actionId);
            return SendResult.rejected("sms_invalid_request");
        } catch (SecurityException error) {
            SmsSendTracker.remove(actionId);
            return SendResult.rejected("sms_permission_denied");
        } catch (RuntimeException error) {
            SmsSendTracker.remove(actionId);
            return SendResult.rejected("sms_send_failed");
        }
    }

    private static SmsManager getSmsManager(Context context, Integer preferredSimSlot, Integer preferredSubscriptionId) {
        Integer subscriptionId = normalizeSubscriptionId(preferredSubscriptionId);
        if (subscriptionId == null) {
            subscriptionId = resolveSubscriptionIdForSlot(context, preferredSimSlot);
        }
        if (subscriptionId != null && Build.VERSION.SDK_INT >= 22) {
            try {
                return SmsManager.getSmsManagerForSubscriptionId(subscriptionId);
            } catch (RuntimeException ignored) {
            }
        }
        if (Build.VERSION.SDK_INT >= 31) {
            SmsManager manager = context.getSystemService(SmsManager.class);
            if (manager != null) {
                return manager;
            }
        }
        return SmsManager.getDefault();
    }

    private static Integer normalizeSubscriptionId(Integer preferredSubscriptionId) {
        if (preferredSubscriptionId == null) {
            return null;
        }
        int value = preferredSubscriptionId;
        return value >= 0 ? value : null;
    }

    private static Integer resolveSubscriptionIdForSlot(Context context, Integer preferredSimSlot) {
        if (preferredSimSlot == null || preferredSimSlot < 0 || Build.VERSION.SDK_INT < 22) {
            return null;
        }
        if (context.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) {
            return null;
        }

        try {
            SubscriptionManager manager = context.getSystemService(SubscriptionManager.class);
            if (manager == null) {
                return null;
            }
            List<SubscriptionInfo> subscriptions = manager.getActiveSubscriptionInfoList();
            if (subscriptions == null) {
                return null;
            }
            for (SubscriptionInfo info : subscriptions) {
                if (info != null && info.getSimSlotIndex() == preferredSimSlot) {
                    return info.getSubscriptionId();
                }
            }
        } catch (SecurityException ignored) {
            return null;
        } catch (RuntimeException ignored) {
            return null;
        }
        return null;
    }

    private static PendingIntent pendingBroadcast(
            Context context,
            Class<?> receiver,
            String action,
            String actionId,
            String number,
            int part,
            int total
    ) {
        Intent intent = new Intent(context, receiver)
                .setAction(action)
                .putExtra(EXTRA_ACTION_ID, actionId)
                .putExtra(EXTRA_NUMBER, number)
                .putExtra(EXTRA_PART, part)
                .putExtra(EXTRA_TOTAL, total);
        int requestCode = Math.abs((action + ":" + actionId + ":" + part).hashCode());
        return PendingIntent.getBroadcast(
                context,
                requestCode,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | MqttBridgeService.immutableFlag()
        );
    }

    static final class SendResult {
        final boolean accepted;
        final int partCount;
        final String detail;

        private SendResult(boolean accepted, int partCount, String detail) {
            this.accepted = accepted;
            this.partCount = partCount;
            this.detail = detail;
        }

        static SendResult accepted(int partCount) {
            return new SendResult(true, partCount, "sms_queued");
        }

        static SendResult rejected(String detail) {
            return new SendResult(false, 0, detail);
        }
    }
}


