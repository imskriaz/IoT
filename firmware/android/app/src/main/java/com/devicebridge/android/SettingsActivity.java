package com.devicebridge.android;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

public class SettingsActivity extends Activity {
    private static final int REQ_BRIDGE_PERMISSIONS = 4301;

    private EditText serverUrl;
    private EditText apiKey;
    private EditText deviceId;
    private EditText topicPrefix;
    private EditText host;
    private EditText port;
    private EditText protocol;
    private EditText username;
    private EditText password;
    private TextView settingsStatus;
    private TextView eventLog;
    private TextView mqttHint;
    private TextView watchdogSummary;
    private TextView healthPulseSummary;
    private TextView testLabSummary;
    private TextView permissionCenterSummary;
    private Button permissionButton;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildUi();
        loadConfig();
        BridgeEventLog.append(this, "Settings opened");
        refreshStatus("Ready");
    }

    @Override
    protected void onResume() {
        super.onResume();
        loadConfig();
        refreshStatus(null);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_BRIDGE_PERMISSIONS) {
            BridgeEventLog.append(this, "Settings permission request completed");
            if (BridgePermissionHelper.hasSmsInboxFeature(this) || BridgePermissionHelper.hasCallFeature(this)) {
                MqttBridgeService.requestSilentBulkSync(this);
            }
            refreshStatus("Permissions updated");
        }
    }

    private void buildUi() {
        LinearLayout root = BridgeUi.root(this);
        root.addView(BridgeUi.hero(this, "Device Bridge", "Settings", ""));
        root.addView(BridgeUi.sectionSpacing(this));
        root.addView(buildHealthPulseSection());
        root.addView(BridgeUi.sectionSpacing(this));
        root.addView(buildWatchdogSection());
        root.addView(BridgeUi.sectionSpacing(this));
        root.addView(buildPermissionCenterSection());
        root.addView(BridgeUi.sectionSpacing(this));
        root.addView(buildAccessSection());
        root.addView(BridgeUi.sectionSpacing(this));
        root.addView(buildTransportSection());
        root.addView(BridgeUi.sectionSpacing(this));
        root.addView(buildControlSection());
        root.addView(BridgeUi.sectionSpacing(this));
        root.addView(buildTestLabSection());
        root.addView(BridgeUi.sectionSpacing(this));
        root.addView(buildDiagnosticsSection());

        setContentView(BridgeUi.screenShell(this, root));
    }

    private LinearLayout buildChrome() {
        LinearLayout card = BridgeUi.sectionCard(this, "Navigate", "");
        LinearLayout row = BridgeUi.horizontalRow(this);
        Button homeButton = BridgeUi.smallButton(this, "Home", "#0d6efd", Color.WHITE);
        homeButton.setOnClickListener(v -> startActivity(new Intent(this, MainActivity.class)));
        Button logsButton = BridgeUi.smallButton(this, "Logs", "#e2e8f0", Color.parseColor("#0f172a"));
        logsButton.setOnClickListener(v -> startActivity(BridgeDashboardSectionActivity.createIntent(this, BridgeDashboardSectionActivity.SECTION_CONSOLE)));
        Button settingsButton = BridgeUi.smallButton(this, "Settings", "#198754", Color.WHITE);
        settingsButton.setOnClickListener(v -> refreshStatus("Settings already open"));
        Button healthButton = BridgeUi.smallButton(this, "Health", "#0f766e", Color.WHITE);
        healthButton.setOnClickListener(v -> startActivity(BridgeDashboardSectionActivity.createIntent(this, BridgeDashboardSectionActivity.SECTION_HEALTH)));
        row.addView(homeButton, BridgeUi.weightedWidth());
        row.addView(BridgeUi.spacer(this));
        row.addView(logsButton, BridgeUi.weightedWidth());
        card.addView(row, BridgeUi.fullWidth(this));

        LinearLayout secondRow = BridgeUi.horizontalRow(this);
        secondRow.addView(settingsButton, BridgeUi.weightedWidth());
        secondRow.addView(BridgeUi.spacer(this));
        secondRow.addView(healthButton, BridgeUi.weightedWidth());
        card.addView(secondRow, BridgeUi.fullWidth(this));
        return card;
    }

    private LinearLayout buildHealthPulseSection() {
        LinearLayout card = BridgeUi.sectionCard(this, "Health Pulse", "");
        healthPulseSummary = BridgeUi.textBlock(this, 13, true);
        healthPulseSummary.setTypeface(Typeface.MONOSPACE);
        card.addView(healthPulseSummary, BridgeUi.fullWidth(this));
        return card;
    }

    private LinearLayout buildWatchdogSection() {
        LinearLayout card = BridgeUi.sectionCard(this, "Permission Watchdog", "");
        watchdogSummary = BridgeUi.textBlock(this, 13, true);
        card.addView(watchdogSummary, BridgeUi.fullWidth(this));
        return card;
    }

    private LinearLayout buildPermissionCenterSection() {
        LinearLayout card = BridgeUi.sectionCard(this, "Permission Center", "");
        permissionCenterSummary = BridgeUi.textBlock(this, 13, true);
        card.addView(permissionCenterSummary, BridgeUi.fullWidth(this));

        LinearLayout row = BridgeUi.horizontalRow(this);
        Button grantButton = BridgeUi.smallButton(this, "Grant Missing", "#f59e0b", Color.parseColor("#111827"));
        grantButton.setOnClickListener(v -> {
            BridgePermissionHelper.requestMissing(this, REQ_BRIDGE_PERMISSIONS, true);
            refreshStatus("Permission request opened");
        });
        Button settingsButton = BridgeUi.smallButton(this, "Open App Settings", "#e2e8f0", Color.parseColor("#0f172a"));
        settingsButton.setOnClickListener(v -> {
            BridgePermissionHelper.openAppSettings(this);
            refreshStatus("Android app settings opened");
        });
        row.addView(grantButton, BridgeUi.weightedWidth());
        row.addView(BridgeUi.spacer(this));
        row.addView(settingsButton, BridgeUi.weightedWidth());
        card.addView(row, BridgeUi.fullWidth(this));
        return card;
    }

    private LinearLayout buildAccessSection() {
        LinearLayout card = BridgeUi.sectionCard(this, "Bridge Access", "");
        serverUrl = BridgeUi.input(this, "Device Bridge server URL");
        apiKey = BridgeUi.passwordInput(this, "Device Bridge API key");
        deviceId = BridgeUi.input(this, "Device ID");
        topicPrefix = BridgeUi.input(this, "Topic prefix");

        card.addView(BridgeUi.label(this, "Server URL"));
        card.addView(serverUrl, BridgeUi.fullWidth(this));
        card.addView(BridgeUi.label(this, "API Key"));
        card.addView(apiKey, BridgeUi.fullWidth(this));
        card.addView(BridgeUi.label(this, "Device ID"));
        card.addView(deviceId, BridgeUi.fullWidth(this));
        card.addView(BridgeUi.label(this, "Topic Prefix"));
        card.addView(topicPrefix, BridgeUi.fullWidth(this));
        return card;
    }

    private LinearLayout buildTransportSection() {
        LinearLayout card = BridgeUi.sectionCard(this, "Connection", "");
        host = BridgeUi.input(this, "Broker host");
        port = BridgeUi.input(this, "Realtime port");
        port.setInputType(InputType.TYPE_CLASS_NUMBER);
        protocol = BridgeUi.input(this, "Realtime protocol");
        username = BridgeUi.input(this, "Realtime username");
        password = BridgeUi.passwordInput(this, "Realtime password");

        mqttHint = BridgeUi.textBlock(this, 12, false);
        mqttHint.setText("Connection details are provisioned by the dashboard setup code. MQTT is preferred; dashboard HTTP is used only when MQTT is unavailable and the dashboard URL is reachable from this phone.");
        card.addView(mqttHint, BridgeUi.fullWidth(this));
        return card;
    }

    private LinearLayout buildControlSection() {
        LinearLayout card = BridgeUi.sectionCard(this, "Controls", "");

        LinearLayout firstRow = BridgeUi.horizontalRow(this);
        Button saveButton = BridgeUi.smallButton(this, "Save Settings", "#0f766e", Color.WHITE);
        saveButton.setOnClickListener(v -> {
            String error = saveConfig(BridgeConfig.load(this).bridgeEnabled);
            refreshStatus(error == null ? "Settings saved" : error);
        });
        permissionButton = BridgeUi.smallButton(this, "Grant Permissions", "#f59e0b", Color.parseColor("#111827"));
        permissionButton.setOnClickListener(v -> {
            requestBridgePermissions();
            refreshStatus("Permission request opened");
        });
        firstRow.addView(saveButton, BridgeUi.weightedWidth());
        firstRow.addView(BridgeUi.spacer(this));
        firstRow.addView(permissionButton, BridgeUi.weightedWidth());
        card.addView(firstRow, BridgeUi.fullWidth(this));

        LinearLayout secondRow = BridgeUi.horizontalRow(this);
        Button startButton = BridgeUi.smallButton(this, "Start Bridge", "#2563eb", Color.WHITE);
        startButton.setOnClickListener(v -> {
            String error = saveConfig(true);
            if (error != null) {
                refreshStatus(error);
                return;
            }
            startBridge();
            BridgeEventLog.append(this, "Bridge start requested from settings");
            refreshStatus("Start requested");
        });
        Button stopButton = BridgeUi.smallButton(this, "Stop Bridge", "#dc2626", Color.WHITE);
        stopButton.setOnClickListener(v -> {
            BridgeConfig.load(this).withBridgeEnabled(false).save(this);
            stopBridge();
            BridgeEventLog.append(this, "Bridge stop requested from settings");
            refreshStatus("Stop requested");
        });
        secondRow.addView(startButton, BridgeUi.weightedWidth());
        secondRow.addView(BridgeUi.spacer(this));
        secondRow.addView(stopButton, BridgeUi.weightedWidth());
        card.addView(secondRow, BridgeUi.fullWidth(this));

        LinearLayout thirdRow = BridgeUi.horizontalRow(this);
        Button refreshButton = BridgeUi.smallButton(this, "Refresh Status", "#e2e8f0", Color.parseColor("#0f172a"));
        refreshButton.setOnClickListener(v -> refreshStatus("Status refreshed"));
        Button copyLogsButton = BridgeUi.smallButton(this, "Copy Console", "#e2e8f0", Color.parseColor("#0f172a"));
        copyLogsButton.setOnClickListener(v -> copyConsole());
        thirdRow.addView(refreshButton, BridgeUi.weightedWidth());
        thirdRow.addView(BridgeUi.spacer(this));
        thirdRow.addView(copyLogsButton, BridgeUi.weightedWidth());
        card.addView(thirdRow, BridgeUi.fullWidth(this));

        return card;
    }

    private LinearLayout buildTestLabSection() {
        LinearLayout card = BridgeUi.sectionCard(this, "Test Lab", "");
        testLabSummary = BridgeUi.textBlock(this, 13, true);
        testLabSummary.setText("No test run yet.");
        card.addView(testLabSummary, BridgeUi.fullWidth(this));

        LinearLayout rowOne = BridgeUi.horizontalRow(this);
        Button statusButton = BridgeUi.smallButton(this, "Test Status Push", "#0d6efd", Color.WHITE);
        statusButton.setOnClickListener(v -> BridgeTestLab.runStatusPushTest(this, this::updateTestLabResult));
        Button selfSmsButton = BridgeUi.smallButton(this, "Self SMS Test", "#ea580c", Color.WHITE);
        selfSmsButton.setOnClickListener(v -> BridgeTestLab.runSelfSendTest(this, this::updateTestLabResult));
        rowOne.addView(statusButton, BridgeUi.weightedWidth());
        rowOne.addView(BridgeUi.spacer(this));
        rowOne.addView(selfSmsButton, BridgeUi.weightedWidth());
        card.addView(rowOne, BridgeUi.fullWidth(this));

        LinearLayout rowTwo = BridgeUi.horizontalRow(this);
        Button queueButton = BridgeUi.smallButton(this, "Test Queue", "#198754", Color.WHITE);
        queueButton.setOnClickListener(v -> BridgeTestLab.runQueuePickupTest(this, this::updateTestLabResult));
        Button permissionProbeButton = BridgeUi.smallButton(this, "Probe Permissions", "#111827", Color.WHITE);
        permissionProbeButton.setOnClickListener(v -> BridgeTestLab.runPermissionProbe(this, this::updateTestLabResult));
        rowTwo.addView(queueButton, BridgeUi.weightedWidth());
        rowTwo.addView(BridgeUi.spacer(this));
        rowTwo.addView(permissionProbeButton, BridgeUi.weightedWidth());
        card.addView(rowTwo, BridgeUi.fullWidth(this));

        LinearLayout rowThree = BridgeUi.horizontalRow(this);
        Button recoveryProbeButton = BridgeUi.smallButton(this, "Probe Recovery", "#e2e8f0", Color.parseColor("#0f172a"));
        recoveryProbeButton.setOnClickListener(v -> BridgeTestLab.runRecoveryProbe(this, this::updateTestLabResult));
        rowThree.addView(recoveryProbeButton, BridgeUi.fullWidth(this));
        card.addView(rowThree, BridgeUi.fullWidth(this));
        return card;
    }

    private LinearLayout buildDiagnosticsSection() {
        LinearLayout card = BridgeUi.sectionCard(this, "Diagnostics", "");
        settingsStatus = BridgeUi.textBlock(this, 13, true);
        settingsStatus.setTypeface(Typeface.MONOSPACE);
        card.addView(settingsStatus, BridgeUi.fullWidth(this));

        eventLog = BridgeUi.textBlock(this, 12, false);
        eventLog.setTypeface(Typeface.MONOSPACE);
        eventLog.setTextIsSelectable(true);
        card.addView(eventLog, BridgeUi.fullWidth(this));

        return card;
    }

    private void loadConfig() {
        BridgeConfig config = BridgeConfig.load(this);
        serverUrl.setText(config.serverUrl);
        apiKey.setText(config.apiKey);
        deviceId.setText(config.deviceId);
        topicPrefix.setText(config.topicPrefix);
        host.setText(config.brokerHost);
        port.setText(String.valueOf(config.brokerPort));
        username.setText(config.username);
        password.setText(config.password);
        protocol.setText(config.brokerProtocol);
        updateTransportHint(config.transportMode);
    }

    private String saveConfig(boolean enabled) {
        BridgeConfig current = BridgeConfig.load(this);
        String nextTransportMode = normalizeTransportMode(current.transportMode, "auto");
        String brokerValue = host.getText().toString().trim();
        boolean hasHttpAccess = !serverUrl.getText().toString().trim().isEmpty()
                && !apiKey.getText().toString().trim().isEmpty()
                && !BridgeProvisioning.firstNonEmpty(deviceId.getText().toString(), current.deviceId).isEmpty();
        if (enabled && "mqtt".equals(nextTransportMode) && brokerValue.isEmpty()) {
            return "Realtime host is required before starting.";
        }
        if (enabled && "http".equals(nextTransportMode)) {
            if (serverUrl.getText().toString().trim().isEmpty()) {
                return "Server URL is required before starting.";
            }
            if (apiKey.getText().toString().trim().isEmpty()) {
                return "API key is required before starting.";
            }
        }
        if (enabled && "auto".equals(nextTransportMode) && brokerValue.isEmpty() && !hasHttpAccess) {
            return "Dashboard setup code is required before starting.";
        }

        int parsedPort = current.brokerPort;
        try {
            parsedPort = Integer.parseInt(port.getText().toString().trim());
        } catch (NumberFormatException ignored) {
        }
        if (parsedPort <= 0) {
            parsedPort = 1883;
        }

        BridgeConfig updated = new BridgeConfig(
                serverUrl.getText().toString(),
                apiKey.getText().toString(),
                current.installId,
                nextTransportMode,
                host.getText().toString(),
                parsedPort,
                BridgeProvisioning.firstNonEmpty(protocol.getText().toString(), current.brokerProtocol),
                username.getText().toString(),
                password.getText().toString(),
                BridgeProvisioning.firstNonEmpty(deviceId.getText().toString(), current.deviceId),
                BridgeProvisioning.firstNonEmpty(topicPrefix.getText().toString(), current.topicPrefix),
                true,
                enabled
        );
        updated.save(this);
        BridgeEventLog.append(this, enabled ? "Settings saved with bridge enabled" : "Settings saved");
        updateTransportHint(updated.transportMode);
        return null;
    }

    private void refreshStatus(String message) {
        BridgeConfig config = BridgeConfig.load(this);
        if (settingsStatus != null) {
            settingsStatus.setText(BridgeDiagnostics.buildStatusSummary(this, message));
        }
        if (healthPulseSummary != null) {
            healthPulseSummary.setText(BridgeDiagnostics.buildHealthPulse(this));
        }
        if (watchdogSummary != null) {
            watchdogSummary.setText(BridgeDiagnostics.buildPermissionWatchdog(this));
        }
        if (permissionCenterSummary != null) {
            permissionCenterSummary.setText(BridgePermissionHelper.buildSummary(this, true));
        }
        if (eventLog != null) {
            eventLog.setText(BridgeDiagnostics.recentLog(this, 120));
        }
        if (permissionButton != null) {
            permissionButton.setText(BridgeDiagnostics.hasOperationalPermissions(this) ? "Permissions Ready" : "Grant Permissions");
        }
        updateTransportHint(config.transportMode);
    }

    private void updateTestLabResult(String title, String detail) {
        if (testLabSummary != null) {
            testLabSummary.setText(title + "\n" + detail);
        }
        refreshStatus(title);
    }

    private void updateTransportHint(String mode) {
        if (mqttHint == null) return;
        mqttHint.setText("Connection details are provisioned by the dashboard setup code. MQTT is preferred; dashboard HTTP is used only when MQTT is unavailable and the dashboard URL is reachable from this phone.");
    }

    private void copyConsole() {
        ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard != null) {
            clipboard.setPrimaryClip(ClipData.newPlainText("Device Bridge console", BridgeEventLog.read(this)));
            BridgeEventLog.append(this, "Console copied to clipboard");
            refreshStatus("Console copied");
        }
    }

    private String normalizeTransportMode(String value, String fallback) {
        String normalized = BridgeProvisioning.firstNonEmpty(value, fallback).toLowerCase(Locale.ROOT);
        if ("auto".equals(normalized)) return "auto";
        return "http".equals(normalized) ? "http" : "mqtt";
    }

    private void requestBridgePermissions() {
        boolean hasMissing = false;
        for (BridgePermissionHelper.PermissionItem item : BridgePermissionHelper.collect(this, true)) {
            if (!item.granted) {
                hasMissing = true;
                break;
            }
        }
        if (hasMissing) {
            BridgePermissionHelper.requestMissing(this, REQ_BRIDGE_PERMISSIONS, true);
            BridgeEventLog.append(this, "Settings permission request opened");
        }
    }

    private void startBridge() {
        Intent intent = new Intent(this, MqttBridgeService.class).setAction(MqttBridgeService.ACTION_START);
        if (Build.VERSION.SDK_INT >= 26) {
            startForegroundService(intent);
        } else {
            startService(intent);
        }
    }

    private void stopBridge() {
        Intent intent = new Intent(this, MqttBridgeService.class).setAction(MqttBridgeService.ACTION_STOP);
        startService(intent);
    }
}


