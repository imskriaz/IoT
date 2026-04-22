package com.devicebridge.android;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import java.util.ArrayList;
import java.util.List;

final class BridgePermissionHelper {
    private static final String KEY_REQUESTED_PREFIX = "permission_requested_";

    static final class PermissionItem {
        final String permission;
        final String label;
        final boolean granted;
        final boolean needsSettings;

        PermissionItem(String permission, String label, boolean granted, boolean needsSettings) {
            this.permission = permission;
            this.label = label;
            this.granted = granted;
            this.needsSettings = needsSettings;
        }
    }

    private BridgePermissionHelper() {
    }

    static List<PermissionItem> collectCore(Activity activity) {
        List<PermissionItem> items = new ArrayList<>();
        items.add(buildItem(activity, Manifest.permission.SEND_SMS, "Send SMS"));
        items.add(buildItem(activity, Manifest.permission.RECEIVE_SMS, "Receive SMS"));
        items.addAll(collectWifiFeature(activity));
        if (Build.VERSION.SDK_INT >= 33) {
            items.add(buildItem(activity, Manifest.permission.POST_NOTIFICATIONS, "Notifications"));
        }
        return items;
    }

    static List<PermissionItem> collectCallFeature(Activity activity) {
        List<PermissionItem> items = new ArrayList<>();
        items.add(buildItem(activity, Manifest.permission.CALL_PHONE, "Call and USSD"));
        items.add(buildItem(activity, Manifest.permission.ANSWER_PHONE_CALLS, "Call controls"));
        items.add(buildItem(activity, Manifest.permission.READ_PHONE_STATE, "Phone state"));
        items.add(buildItem(activity, Manifest.permission.READ_CALL_LOG, "Incoming caller ID"));
        items.add(buildItem(activity, Manifest.permission.READ_PHONE_NUMBERS, "Phone numbers"));
        return items;
    }

    static List<PermissionItem> collectQrFeature(Activity activity) {
        List<PermissionItem> items = new ArrayList<>();
        items.add(buildItem(activity, Manifest.permission.CAMERA, "Camera"));
        return items;
    }

    static List<PermissionItem> collectSmsInboxFeature(Activity activity) {
        List<PermissionItem> items = new ArrayList<>();
        items.add(buildItem(activity, Manifest.permission.READ_SMS, "SMS inbox"));
        items.add(buildItem(activity, Manifest.permission.READ_PHONE_STATE, "SIM state"));
        items.add(buildItem(activity, Manifest.permission.READ_PHONE_NUMBERS, "SIM numbers"));
        return items;
    }

    static List<PermissionItem> collectWebcamFeature(Activity activity) {
        List<PermissionItem> items = new ArrayList<>();
        items.add(buildItem(activity, Manifest.permission.CAMERA, "Webcam"));
        return items;
    }

    static List<PermissionItem> collectIntercomFeature(Activity activity) {
        List<PermissionItem> items = new ArrayList<>();
        items.add(buildItem(activity, Manifest.permission.RECORD_AUDIO, "Intercom microphone"));
        return items;
    }

    static List<PermissionItem> collectWifiFeature(Activity activity) {
        List<PermissionItem> items = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 33) {
            items.add(buildItem(activity, Manifest.permission.NEARBY_WIFI_DEVICES, "Wi-Fi scan"));
        } else {
            items.add(buildItem(activity, Manifest.permission.ACCESS_FINE_LOCATION, "Wi-Fi scan"));
        }
        return items;
    }

    static List<PermissionItem> collect(Activity activity, boolean includeCamera) {
        List<PermissionItem> items = new ArrayList<>();
        items.addAll(collectCore(activity));
        items.addAll(collectSmsInboxFeature(activity));
        items.addAll(collectCallFeature(activity));
        if (includeCamera) {
            items.addAll(collectQrFeature(activity));
        }
        return items;
    }

    static String buildSummary(Activity activity, boolean includeCamera) {
        StringBuilder builder = new StringBuilder();
        List<PermissionItem> items = collect(activity, includeCamera);
        boolean allGranted = true;
        for (PermissionItem item : items) {
            if (!item.granted) {
                allGranted = false;
            }
        }
        builder.append("Ready: ").append(allGranted);
        for (PermissionItem item : items) {
            builder.append("\n")
                    .append(item.label)
                    .append(": ")
                    .append(item.granted ? "granted" : (item.needsSettings ? "open app settings" : "request needed"));
        }
        return builder.toString();
    }

    static boolean hasAll(Activity activity, boolean includeCamera) {
        for (PermissionItem item : collect(activity, includeCamera)) {
            if (!item.granted) {
                return false;
            }
        }
        return true;
    }

    static PermissionItem firstMissing(Activity activity, boolean includeCamera) {
        for (PermissionItem item : collect(activity, includeCamera)) {
            if (!item.granted) {
                return item;
            }
        }
        return null;
    }

    static boolean hasCore(Activity activity) {
        for (PermissionItem item : collectCore(activity)) {
            if (!item.granted) {
                return false;
            }
        }
        return true;
    }

    static PermissionItem firstMissingCore(Activity activity) {
        for (PermissionItem item : collectCore(activity)) {
            if (!item.granted) {
                return item;
            }
        }
        return null;
    }

    static boolean hasCallFeature(Activity activity) {
        for (PermissionItem item : collectCallFeature(activity)) {
            if (!item.granted) {
                return false;
            }
        }
        return true;
    }

    static boolean hasQrFeature(Activity activity) {
        for (PermissionItem item : collectQrFeature(activity)) {
            if (!item.granted) {
                return false;
            }
        }
        return true;
    }

    static boolean hasWifiFeature(Activity activity) {
        for (PermissionItem item : collectWifiFeature(activity)) {
            if (!item.granted) {
                return false;
            }
        }
        return true;
    }

    static boolean hasSmsInboxFeature(Activity activity) {
        for (PermissionItem item : collectSmsInboxFeature(activity)) {
            if (!item.granted) {
                return false;
            }
        }
        return true;
    }

    static boolean hasWebcamFeature(Activity activity) {
        for (PermissionItem item : collectWebcamFeature(activity)) {
            if (!item.granted) {
                return false;
            }
        }
        return true;
    }

    static boolean hasIntercomFeature(Activity activity) {
        for (PermissionItem item : collectIntercomFeature(activity)) {
            if (!item.granted) {
                return false;
            }
        }
        return true;
    }

    static String purposeFor(String permission) {
        if (Manifest.permission.SEND_SMS.equals(permission)) {
            return "Send dashboard SMS commands through this phone.";
        }
        if (Manifest.permission.RECEIVE_SMS.equals(permission)) {
            return "Sync inbound SMS back to the dashboard.";
        }
        if (Manifest.permission.READ_SMS.equals(permission)) {
            return "Read local SMS threads so the app can show threaded conversations.";
        }
        if (Manifest.permission.CALL_PHONE.equals(permission)) {
            return "Run call and USSD actions from dashboard commands.";
        }
        if (Manifest.permission.ANSWER_PHONE_CALLS.equals(permission)) {
            return "Answer, reject, and end live calls from dashboard commands.";
        }
        if (Manifest.permission.READ_PHONE_STATE.equals(permission)) {
            return "Read SIM, network, signal, and phone state for device health.";
        }
        if (Manifest.permission.READ_CALL_LOG.equals(permission)) {
            return "Expose incoming caller numbers to the app during live calls.";
        }
        if (Manifest.permission.READ_PHONE_NUMBERS.equals(permission)) {
            return "Show SIM line numbers when Android exposes them.";
        }
        if (Manifest.permission.NEARBY_WIFI_DEVICES.equals(permission)
                || Manifest.permission.ACCESS_FINE_LOCATION.equals(permission)) {
            return "Read Wi-Fi SSID and scan nearby Wi-Fi networks for the dashboard.";
        }
        if (Manifest.permission.CAMERA.equals(permission)) {
            return "Scan onboarding QR codes and enable webcam-style camera features.";
        }
        if (Manifest.permission.RECORD_AUDIO.equals(permission)) {
            return "Enable intercom-style microphone capture from dashboard features.";
        }
        if (Manifest.permission.POST_NOTIFICATIONS.equals(permission)) {
            return "Keep bridge status visible while the service runs.";
        }
        return "Required for Device Bridge operation.";
    }

    static void requestMissingCore(Activity activity, int requestCode) {
        requestMissingItems(activity, requestCode, collectCore(activity));
    }

    static void requestCallFeature(Activity activity, int requestCode) {
        requestMissingItems(activity, requestCode, collectCallFeature(activity));
    }

    static void requestQrFeature(Activity activity, int requestCode) {
        requestMissingItems(activity, requestCode, collectQrFeature(activity));
    }

    static void requestSmsInboxFeature(Activity activity, int requestCode) {
        requestMissingItems(activity, requestCode, collectSmsInboxFeature(activity));
    }

    static void requestWebcamFeature(Activity activity, int requestCode) {
        requestMissingItems(activity, requestCode, collectWebcamFeature(activity));
    }

    static void requestIntercomFeature(Activity activity, int requestCode) {
        requestMissingItems(activity, requestCode, collectIntercomFeature(activity));
    }

    static void requestMissing(Activity activity, int requestCode, boolean includeCamera) {
        requestMissingItems(activity, requestCode, collect(activity, includeCamera));
    }

    private static void requestMissingItems(Activity activity, int requestCode, List<PermissionItem> items) {
        List<String> missing = new ArrayList<>();
        for (PermissionItem item : items) {
            if (!item.granted) {
                missing.add(item.permission);
            }
        }
        if (!missing.isEmpty()) {
            markRequested(activity, missing.toArray(new String[0]));
            activity.requestPermissions(missing.toArray(new String[0]), requestCode);
        }
    }

    static void markRequested(Activity activity, String... permissions) {
        if (activity == null || permissions == null || permissions.length == 0) {
            return;
        }
        SharedPreferences.Editor editor = prefs(activity).edit();
        for (String permission : permissions) {
            if (permission == null || permission.trim().isEmpty()) {
                continue;
            }
            editor.putBoolean(KEY_REQUESTED_PREFIX + permission.trim(), true);
        }
        editor.apply();
    }

    static void openAppSettings(Activity activity) {
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        intent.setData(Uri.parse("package:" + activity.getPackageName()));
        activity.startActivity(intent);
    }

    private static PermissionItem buildItem(Activity activity, String permission, String label) {
        boolean granted = activity.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
        boolean wasRequested = prefs(activity).getBoolean(KEY_REQUESTED_PREFIX + permission, false);
        boolean needsSettings = !granted && wasRequested && !activity.shouldShowRequestPermissionRationale(permission);
        return new PermissionItem(permission, label, granted, needsSettings);
    }

    private static SharedPreferences prefs(Activity activity) {
        return activity.getSharedPreferences(BridgeConfig.PREFS, Activity.MODE_PRIVATE);
    }
}


