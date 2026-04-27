package com.devicebridge.android;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.BatteryManager;
import android.os.StatFs;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

final class BridgeDiagnostics {
    private BridgeDiagnostics() {
    }

    static String buildStatusSummary(Context context, String message) {
        BridgeConfig config = BridgeConfig.load(context);
        BridgeRuntimeState runtime = BridgeRuntimeState.load(context);

        StringBuilder builder = new StringBuilder();
        if (message != null && !message.trim().isEmpty()) {
            builder.append(message.trim()).append("\n\n");
        }
        builder.append("Product: Device Bridge")
                .append("\nBridge enabled: ").append(config.bridgeEnabled)
                .append("\nService state: ").append(runtime.serviceState)
                .append("\nConnection mode: ").append(config.transportDisplayLabel())
                .append("\nTransport connected: ").append(runtime.isTransportConnected(config))
                .append("\nRealtime channel: ").append(config.hasProvisionedMqttConfig() ? "ready" : "not provisioned")
                .append("\nHTTP fallback: ").append(config.hasHttpBridgeConfig()
                        ? "ready"
                        : (config.hasLoopbackDashboardUrl() ? "skipped for localhost dashboard" : "not provisioned"))
                .append("\nServer URL: ").append(config.serverUrl.isEmpty() ? "not set" : config.serverUrl)
                .append("\nDevice ID: ").append(config.deviceId.isEmpty() ? "not set" : config.deviceId)
                .append("\nTopic prefix: ").append(config.topicPrefix.isEmpty() ? "device" : config.topicPrefix)
                .append("\nInstall ID: ").append(config.installId.isEmpty() ? "not set" : config.installId)
                .append("\nSEND_SMS: ").append(granted(context, Manifest.permission.SEND_SMS))
                .append("\nRECEIVE_SMS: ").append(granted(context, Manifest.permission.RECEIVE_SMS))
                .append("\nREAD_PHONE_STATE: ").append(granted(context, Manifest.permission.READ_PHONE_STATE))
                .append("\nCAMERA: ").append(granted(context, Manifest.permission.CAMERA))
                .append("\nPOST_NOTIFICATIONS: ").append(notificationPermissionState(context))
                .append("\nAPI key: ").append(config.apiKey.isEmpty() ? "not set" : "configured")
                .append("\nDashboard access: ").append(config.hasDashboardAccess());

        if (runtime.detail != null && !runtime.detail.isEmpty()) {
            builder.append("\nDetail: ").append(runtime.detail);
        }
        if (runtime.updatedAtMs > 0) {
            builder.append("\nLast update: ").append(formatAge(runtime.updatedAtMs));
        }
        if (runtime.publishSuccessCount > 0 || runtime.publishFailureCount > 0) {
            builder.append("\nPublish ok/fail: ")
                    .append(runtime.publishSuccessCount)
                    .append('/')
                    .append(runtime.publishFailureCount);
        }
        return builder.toString();
    }

    static boolean hasOperationalPermissions(Context context) {
        boolean notificationsReady = Build.VERSION.SDK_INT < 33
                || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
        return context.checkSelfPermission(Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED
                && context.checkSelfPermission(Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED
                && notificationsReady;
    }

    static String recentLog(Context context, int maxLines) {
        String current = BridgeEventLog.read(context);
        if (current == null || current.trim().isEmpty()) {
            return "No local events yet.";
        }
        String[] lines = current.split("\\n");
        if (lines.length <= maxLines) {
            return current;
        }
        StringBuilder trimmed = new StringBuilder();
        for (int i = lines.length - maxLines; i < lines.length; i += 1) {
            if (trimmed.length() > 0) {
                trimmed.append('\n');
            }
            trimmed.append(lines[i]);
        }
        return trimmed.toString();
    }

    static int readinessScore(Context context) {
        BridgeConfig config = BridgeConfig.load(context);
        BridgeRuntimeState runtime = BridgeRuntimeState.load(context);
        int score = 0;

        if (config.deviceId != null && !config.deviceId.isEmpty()) score += 20;
        if (config.hasBridgeConnectionConfig()) score += 25;
        if (hasOperationalPermissions(context)) score += 25;
        if (config.hasDashboardAccess()) score += 15;
        else if (config.hasDashboardCredentials() && config.hasProvisionedMqttConfig()) score += 8;
        if (config.bridgeEnabled) score += 5;
        if (runtime.isBridgeOnline(config) || "running".equalsIgnoreCase(runtime.serviceState)) score += 10;

        return Math.min(score, 100);
    }

    static String readinessLabel(Context context) {
        int score = readinessScore(context);
        if (score >= 85) return "Production Ready";
        if (score >= 60) return "Almost Ready";
        if (score >= 35) return "Needs Setup";
        return "Bootstrap Needed";
    }

    static String buildSupportBundle(Context context) {
        BridgeConfig config = BridgeConfig.load(context);
        StringBuilder builder = new StringBuilder();
        builder.append("Device Bridge Support Bundle")
                .append("\nReadiness Score: ").append(readinessScore(context)).append("/100")
                .append("\nReadiness Label: ").append(readinessLabel(context))
                .append("\nSession Log Path: ").append(BridgeSessionLog.path(context))
                .append("\n\nHealth Pulse\n")
                .append(buildHealthPulse(context))
                .append("\n\nPermission Watchdog\n")
                .append(buildPermissionWatchdog(context))
                .append("\n\nSafe Provisioning Summary\n")
                .append(BridgeProvisioning.buildProvisioningSummary(config))
                .append("\n\nStatus Snapshot\n")
                .append(buildStatusSummary(context, null))
                .append("\n\nRecent Event Log\n")
                .append(recentLog(context, 40))
                .append("\n\nSession Log Tail\n")
                .append(BridgeSessionLog.readTail(context, 80));
        return builder.toString();
    }

    static String buildHealthPulse(Context context) {
        BridgeConfig config = BridgeConfig.load(context);
        BridgeRuntimeState runtime = BridgeRuntimeState.load(context);
        BatterySnapshot battery = loadBatterySnapshot(context);
        StorageSnapshot storage = loadStorageSnapshot(context);

        StringBuilder builder = new StringBuilder();
        builder.append("Connection: ")
                .append(config.transportDisplayLabel())
                .append(" | Service: ").append(runtime.serviceState)
                .append(" | Connected: ").append(runtime.isBridgeOnline(config));

        builder.append("\nQueue depth: ").append(runtime.queueDepth)
                .append(" | Publish ok/fail: ").append(runtime.publishSuccessCount).append('/').append(runtime.publishFailureCount);

        builder.append("\nLast status push: ").append(formatAge(runtime.lastStatusPushAtMs))
                .append(" | Last queue poll: ").append(formatAge(runtime.lastQueuePollAtMs));

        builder.append("\nLast incoming sync: ").append(formatAge(runtime.lastIncomingSyncAtMs))
                .append(" | Last send accepted: ").append(formatAge(runtime.lastSendAcceptedAtMs));

        if (battery.level != null) {
            builder.append("\nBattery: ").append(battery.level).append('%');
            if (battery.charging != null) {
                builder.append(battery.charging ? " charging" : " on battery");
            }
        } else {
            builder.append("\nBattery: unavailable");
        }

        builder.append(" | Free storage: ").append(storage.freeLabel)
                .append(" | Health: ").append(healthLabel(context));
        return builder.toString();
    }

    static String buildPermissionWatchdog(Context context) {
        List<String> findings = buildWatchdogFindings(context);
        if (findings.isEmpty()) {
            return "No active drift detected. Permissions, connection config, and bridge runtime look stable.";
        }
        StringBuilder builder = new StringBuilder();
        for (String finding : findings) {
            if (builder.length() > 0) {
                builder.append("\n");
            }
            builder.append("- ").append(finding);
        }
        return builder.toString();
    }

    static String healthLabel(Context context) {
        List<String> findings = buildWatchdogFindings(context);
        if (findings.isEmpty()) return "Stable";
        if (findings.size() == 1) return "Watch";
        return findings.size() >= 3 ? "Degraded" : "At Risk";
    }

    static List<String> buildWatchdogFindings(Context context) {
        BridgeConfig config = BridgeConfig.load(context);
        BridgeRuntimeState runtime = BridgeRuntimeState.load(context);
        StorageSnapshot storage = loadStorageSnapshot(context);
        List<String> findings = new ArrayList<>();

        if (context.checkSelfPermission(Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) {
            findings.add("SEND_SMS is missing. Outbound dashboard SMS will fail until you grant it.");
        }
        if (context.checkSelfPermission(Manifest.permission.RECEIVE_SMS) != PackageManager.PERMISSION_GRANTED) {
            findings.add("RECEIVE_SMS is missing. Incoming SMS will not sync back to the dashboard.");
        }
        if (context.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) {
            findings.add("READ_PHONE_STATE is missing. SIM routing and subscription-aware SMS fallback are degraded.");
        }
        if (Build.VERSION.SDK_INT >= 33
                && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            findings.add("Notifications are blocked. Background bridge status and operator prompts are easier to miss.");
        }
        if (context.checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            findings.add("Camera access is missing. QR onboarding and camera-side features are unavailable.");
        }
        if (config.usesHttpTransport() && !config.hasHttpBridgeConfig()) {
            findings.add(config.hasLoopbackDashboardUrl()
                    ? "Dashboard HTTP is selected but the server URL is localhost. Use MQTT or a LAN-reachable dashboard URL from this phone."
                    : "Dashboard HTTP connection is selected but server URL, API key, or device ID is incomplete.");
        }
        if (!config.usesHttpTransport() && !config.hasProvisionedMqttConfig() && !config.usesAutoTransport()) {
            findings.add("Realtime connection is selected but broker routing details are incomplete.");
        }
        if (config.usesAutoTransport() && !config.hasBridgeConnectionConfig()) {
            findings.add("Dashboard connection details are incomplete. Import a setup code from the dashboard.");
        }
        if (config.usesAutoTransport() && config.hasLoopbackDashboardUrl() && config.hasProvisionedMqttConfig()) {
            findings.add("Dashboard URL is localhost, so Android will skip HTTP fallback and keep using MQTT.");
        }
        if (config.bridgeEnabled && !"running".equalsIgnoreCase(runtime.serviceState) && !"online".equalsIgnoreCase(runtime.serviceState)) {
            findings.add("Bridge is enabled but runtime is not healthy. Restart the bridge or reopen onboarding.");
        }
        if (runtime.queueDepth >= 25) {
            findings.add("Local publish queue is building up (" + runtime.queueDepth + "). Transport may be degraded.");
        }
        if (runtime.publishFailureCount > runtime.publishSuccessCount && runtime.publishFailureCount >= 3) {
            findings.add("Publish failures are dominating successful sends. Inspect dashboard, broker, or network reachability.");
        }
        if (storage.freeBytes >= 0 && storage.freeBytes < 512L * 1024L * 1024L) {
            findings.add("Free storage is below 512 MB. Queueing, captures, and logs may become unstable.");
        }
        return findings;
    }

    private static String granted(Context context, String permission) {
        return context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED ? "granted" : "not granted";
    }

    private static String notificationPermissionState(Context context) {
        if (Build.VERSION.SDK_INT < 33) {
            return "not required";
        }
        return granted(context, Manifest.permission.POST_NOTIFICATIONS);
    }

    private static String formatAge(long timestampMs) {
        if (timestampMs <= 0L) {
            return "never";
        }
        long ageMs = Math.max(0L, System.currentTimeMillis() - timestampMs);
        if (ageMs < 1000L) {
            return "just now";
        }
        long seconds = ageMs / 1000L;
        if (seconds < 60L) {
            return seconds + "s ago";
        }
        long minutes = seconds / 60L;
        if (minutes < 60L) {
            return minutes + "m ago";
        }
        long hours = minutes / 60L;
        if (hours < 24L) {
            return hours + "h ago";
        }
        return String.format(Locale.US, "%.1fd ago", ageMs / 86400000d);
    }

    private static BatterySnapshot loadBatterySnapshot(Context context) {
        Intent intent = context.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        if (intent == null) {
            return new BatterySnapshot(null, null);
        }
        int level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
        int scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
        Integer percent = null;
        if (level >= 0 && scale > 0) {
            percent = Math.round((level * 100f) / scale);
        }
        int status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
        Boolean charging = status == BatteryManager.BATTERY_STATUS_CHARGING
                || status == BatteryManager.BATTERY_STATUS_FULL;
        return new BatterySnapshot(percent, charging);
    }

    private static StorageSnapshot loadStorageSnapshot(Context context) {
        try {
            StatFs statFs = new StatFs(context.getFilesDir().getAbsolutePath());
            long freeBytes = statFs.getAvailableBytes();
            return new StorageSnapshot(freeBytes, bytesLabel(freeBytes));
        } catch (IllegalArgumentException error) {
            return new StorageSnapshot(-1L, "unknown");
        }
    }

    private static String bytesLabel(long bytes) {
        if (bytes < 0L) {
            return "unknown";
        }
        double gb = bytes / (1024d * 1024d * 1024d);
        if (gb >= 1d) {
            return String.format(Locale.US, "%.1f GB", gb);
        }
        double mb = bytes / (1024d * 1024d);
        return String.format(Locale.US, "%.0f MB", mb);
    }

    private static final class BatterySnapshot {
        final Integer level;
        final Boolean charging;

        BatterySnapshot(Integer level, Boolean charging) {
            this.level = level;
            this.charging = charging;
        }
    }

    private static final class StorageSnapshot {
        final long freeBytes;
        final String freeLabel;

        StorageSnapshot(long freeBytes, String freeLabel) {
            this.freeBytes = freeBytes;
            this.freeLabel = freeLabel == null ? "unknown" : freeLabel;
        }
    }
}


