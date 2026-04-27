package com.devicebridge.android;

import android.content.Context;

import java.util.ArrayList;
import java.util.List;

final class BridgeRecoveryAdvisor {
    static final class ActionItem {
        final String title;
        final String description;
        final String action;

        ActionItem(String title, String description, String action) {
            this.title = title;
            this.description = description;
            this.action = action;
        }
    }

    private BridgeRecoveryAdvisor() {
    }

    static List<ActionItem> buildActions(Context context) {
        BridgeConfig config = BridgeConfig.load(context);
        BridgeRuntimeState runtime = BridgeRuntimeState.load(context);
        List<ActionItem> actions = new ArrayList<>();

        if (!BridgeDiagnostics.hasOperationalPermissions(context)) {
            actions.add(new ActionItem(
                    "Grant bridge permissions",
                    "SMS and notification permissions are still missing, so dashboard communication is incomplete.",
                    "permissions"
            ));
        }

        if (!config.hasDashboardAccess() && !config.hasProvisionedMqttConfig()) {
            actions.add(new ActionItem(
                    "Apply dashboard access",
                    "Server URL or API key is missing. Import the encoded onboarding token or complete dashboard access in Settings.",
                    "onboarding"
            ));
        }

        if (config.usesHttpTransport() && !config.hasHttpBridgeConfig()) {
            actions.add(new ActionItem(
                    "Complete dashboard fallback setup",
                    config.hasLoopbackDashboardUrl()
                            ? "Dashboard HTTP is selected but localhost is not reachable from Android. Switch to MQTT or use a LAN dashboard URL."
                            : "Dashboard HTTP is selected but the bridge does not have full server/API/device configuration yet.",
                    "settings"
            ));
        }

        if (!config.usesHttpTransport() && !config.usesAutoTransport() && !config.hasProvisionedMqttConfig()) {
            actions.add(new ActionItem(
                    "Complete realtime bridge setup",
                    "Realtime mode is selected but broker or device routing details are incomplete.",
                    "settings"
            ));
        }

        if (config.usesAutoTransport() && !config.hasBridgeConnectionConfig()) {
            actions.add(new ActionItem(
                "Import dashboard setup code",
                "MQTT-first mode needs realtime routing details or a reachable dashboard fallback before the bridge can start.",
                "onboarding"
            ));
        }

        if (!config.bridgeEnabled) {
            actions.add(new ActionItem(
                    "Start the bridge service",
                    "Configuration is present, but the foreground bridge is not enabled.",
                    "start"
            ));
        }

        if (config.bridgeEnabled && !"running".equalsIgnoreCase(runtime.serviceState)) {
            actions.add(new ActionItem(
                    "Restart bridge runtime",
                    "The bridge is enabled but runtime is not currently healthy. Restarting usually recovers dashboard watchers.",
                    "restart"
            ));
        }

        if (runtime.queueDepth >= 10) {
            actions.add(new ActionItem(
                    "Clear local queue backlog",
                    "The local bridge queue has built up to " + runtime.queueDepth + " items. Clear stale local publishes before retrying transport.",
                    "clear_queue"
            ));
        }

        if (runtime.publishFailureCount >= 5 && runtime.publishFailureCount > runtime.publishSuccessCount) {
            actions.add(new ActionItem(
                    "Reset bridge state",
                    "Publish failures are dominating successful sends. Reset queue, runtime telemetry, and restart the bridge cleanly.",
                    "reset_state"
            ));
        }

        if (actions.isEmpty()) {
            actions.add(new ActionItem(
                "Bridge looks healthy",
                "The current config, permissions, and runtime state are strong enough for regular dashboard use.",
                    "healthy"
            ));
        }

        return actions;
    }

    static String buildAdvisorText(Context context) {
        StringBuilder builder = new StringBuilder();
        for (ActionItem item : buildActions(context)) {
            if (builder.length() > 0) {
                builder.append("\n\n");
            }
            builder.append(item.title).append("\n").append(item.description);
        }
        return builder.toString();
    }
}


