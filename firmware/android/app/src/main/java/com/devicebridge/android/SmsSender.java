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
import java.util.Locale;

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

        SmsManagerSelection selection = getSmsManager(context, preferredSimSlot, preferredSubscriptionId);
        if (selection.smsManager == null) {
            return SendResult.rejected(selection.detail);
        }
        SmsManager smsManager = selection.smsManager;
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

    static String describeDetail(String detail) {
        String value = detail == null ? "" : detail.trim().toLowerCase(Locale.US);
        switch (value) {
            case "sms_permission_denied":
                return "Send SMS permission is missing.";
            case "sms_number_required":
                return "A recipient number is required.";
            case "sms_text_required":
                return "The SMS body is empty.";
            case "sms_invalid_request":
                return "The SMS request is invalid.";
            case "sms_sim_not_available":
                return "No usable SIM is available for SMS.";
            case "sms_default_sim_required":
                return "Choose a default SMS SIM or grant phone-state access so the app can route SMS.";
            case "sms_no_service":
                return "The phone is not registered on a cellular network.";
            case "sms_radio_off":
                return "Cellular radio is off.";
            case "sms_null_pdu":
                return "Android rejected the SMS payload.";
            case "sms_send_failed":
                return "Android failed to send the SMS.";
            default:
                if (value.startsWith("sms_send_failed_")) {
                    return "Android reported SMS send failure (" + value.substring("sms_send_failed_".length()) + ").";
                }
                return value.isEmpty() ? "Unknown SMS error." : value.replace('_', ' ');
        }
    }

    static String resolveSelfNumber(Context context) {
        if (context == null) {
            return "";
        }
        for (SubscriptionInfo info : activeSubscriptions(context)) {
            String number = safePhoneNumber(info == null ? null : info.getNumber());
            if (!number.isEmpty()) {
                return number;
            }
        }
        if (context.checkSelfPermission(Manifest.permission.READ_PHONE_NUMBERS) == PackageManager.PERMISSION_GRANTED
                || context.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED) {
            try {
                android.telephony.TelephonyManager telephonyManager = context.getSystemService(android.telephony.TelephonyManager.class);
                if (telephonyManager != null) {
                    String lineNumber = safePhoneNumber(telephonyManager.getLine1Number());
                    if (!lineNumber.isEmpty()) {
                        return lineNumber;
                    }
                }
            } catch (SecurityException ignored) {
                return "";
            } catch (RuntimeException ignored) {
                return "";
            }
        }
        return "";
    }

    private static SmsManagerSelection getSmsManager(Context context, Integer preferredSimSlot, Integer preferredSubscriptionId) {
        Integer subscriptionId = normalizeSubscriptionId(preferredSubscriptionId);
        if (subscriptionId == null) {
            subscriptionId = resolveSubscriptionIdForSlot(context, preferredSimSlot);
        }
        if (subscriptionId == null) {
            subscriptionId = normalizeSubscriptionId(safeDefaultSmsSubscriptionId());
        }
        if (subscriptionId == null) {
            subscriptionId = normalizeSubscriptionId(safeDefaultVoiceSubscriptionId());
        }
        if (subscriptionId == null) {
            subscriptionId = normalizeSubscriptionId(resolveFirstActiveSubscriptionId(context));
        }
        if (subscriptionId != null && Build.VERSION.SDK_INT >= 22) {
            try {
                return SmsManagerSelection.resolved(SmsManager.getSmsManagerForSubscriptionId(subscriptionId));
            } catch (RuntimeException ignored) {
            }
        }
        if (Build.VERSION.SDK_INT >= 31) {
            SmsManager manager = context.getSystemService(SmsManager.class);
            if (manager != null) {
                return SmsManagerSelection.resolved(manager);
            }
        }
        try {
            return SmsManagerSelection.resolved(SmsManager.getDefault());
        } catch (RuntimeException ignored) {
            return SmsManagerSelection.failed("sms_sim_not_available");
        }
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

    private static Integer resolveFirstActiveSubscriptionId(Context context) {
        List<SubscriptionInfo> subscriptions = activeSubscriptions(context);
        if (subscriptions.isEmpty()) {
            return null;
        }
        int defaultSmsSubscriptionId = safeDefaultSmsSubscriptionId();
        if (defaultSmsSubscriptionId >= 0) {
            for (SubscriptionInfo info : subscriptions) {
                if (info != null && info.getSubscriptionId() == defaultSmsSubscriptionId) {
                    return info.getSubscriptionId();
                }
            }
        }
        int defaultVoiceSubscriptionId = safeDefaultVoiceSubscriptionId();
        if (defaultVoiceSubscriptionId >= 0) {
            for (SubscriptionInfo info : subscriptions) {
                if (info != null && info.getSubscriptionId() == defaultVoiceSubscriptionId) {
                    return info.getSubscriptionId();
                }
            }
        }
        for (SubscriptionInfo info : subscriptions) {
            if (info != null && info.getSubscriptionId() >= 0) {
                return info.getSubscriptionId();
            }
        }
        return null;
    }

    private static List<SubscriptionInfo> activeSubscriptions(Context context) {
        List<SubscriptionInfo> subscriptions = new ArrayList<>();
        if (context == null || Build.VERSION.SDK_INT < 22) {
            return subscriptions;
        }
        if (context.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) {
            return subscriptions;
        }
        try {
            SubscriptionManager manager = context.getSystemService(SubscriptionManager.class);
            List<SubscriptionInfo> active = manager == null ? null : manager.getActiveSubscriptionInfoList();
            if (active != null) {
                subscriptions.addAll(active);
            }
        } catch (SecurityException ignored) {
            return subscriptions;
        } catch (RuntimeException ignored) {
            return subscriptions;
        }
        return subscriptions;
    }

    private static int safeDefaultSmsSubscriptionId() {
        if (Build.VERSION.SDK_INT < 22) {
            return -1;
        }
        try {
            return SubscriptionManager.getDefaultSmsSubscriptionId();
        } catch (RuntimeException ignored) {
            return -1;
        }
    }

    private static int safeDefaultVoiceSubscriptionId() {
        if (Build.VERSION.SDK_INT < 24) {
            return -1;
        }
        try {
            return SubscriptionManager.getDefaultVoiceSubscriptionId();
        } catch (RuntimeException ignored) {
            return -1;
        }
    }

    private static String safePhoneNumber(String value) {
        return value == null ? "" : value.trim();
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

    private static final class SmsManagerSelection {
        final SmsManager smsManager;
        final String detail;

        private SmsManagerSelection(SmsManager smsManager, String detail) {
            this.smsManager = smsManager;
            this.detail = detail == null || detail.trim().isEmpty() ? "sms_sim_not_available" : detail;
        }

        static SmsManagerSelection resolved(SmsManager smsManager) {
            return new SmsManagerSelection(smsManager, "sms_queued");
        }

        static SmsManagerSelection failed(String detail) {
            return new SmsManagerSelection(null, detail);
        }
    }
}


