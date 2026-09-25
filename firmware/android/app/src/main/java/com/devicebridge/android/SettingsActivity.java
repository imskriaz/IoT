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
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

public class SettingsActivity extends Activity {
    private static final int REQ_BRIDGE_PERMISSIONS = 4301;

    private TextView connectionSummary;
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
        LinearLayout card = BridgeUi.sectionCard(this, "Dashboard Connection", "");
        connectionSummary = BridgeUi.textBlock(this, 13, true);
        connectionSummary.setTypeface(Typeface.MONOSPACE);
        mqttHint = BridgeUi.textBlock(this, 12, false);
        mqttHint.setText("Connection details are managed by the dashboard setup code. Scan the QR again when dashboard settings change.");
        card.addView(connectionSummary, BridgeUi.fullWidth(this));
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
        updateConnectionSummary(config);
    }

    private String saveConfig(boolean enabled) {
        BridgeConfig current = BridgeConfig.load(this);
        if (enabled && !current.hasBridgeConnectionConfig()) {
            return "Dashboard setup code is required before starting.";
        }
        BridgeConfig updated = current.withBridgeEnabled(enabled);
        updated.save(this);
        BridgeEventLog.append(this, enabled ? "Settings saved with bridge enabled" : "Settings saved");
        updateConnectionSummary(updated);
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
        updateConnectionSummary(config);
    }

    private void updateTestLabResult(String title, String detail) {
        if (testLabSummary != null) {
            testLabSummary.setText(title + "\n" + detail);
        }
        refreshStatus(title);
    }

    private void updateConnectionSummary(BridgeConfig config) {
        if (connectionSummary != null) {
            connectionSummary.setText("Device ID: " + (config.deviceId.isEmpty() ? "not set" : config.deviceId)
                    + "\nConnection: " + config.transportDisplayLabel()
                    + "\nDashboard access: " + (config.hasDashboardAccess() ? "ready" : "not provisioned")
                    + "\nDevice link: " + (config.hasBridgeConnectionConfig() ? "ready" : "not provisioned")
                    + "\nAPI key: " + (config.apiKey.isEmpty() ? "not set" : "configured"));
        }
        if (mqttHint == null) return;
        mqttHint.setText("Connection details are managed by the dashboard setup code. Scan the QR again when dashboard settings change.");
    }

    private void copyConsole() {
        ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard != null) {
            clipboard.setPrimaryClip(ClipData.newPlainText("Device Bridge console", BridgeEventLog.read(this)));
            BridgeEventLog.append(this, "Console copied to clipboard");
            refreshStatus("Console copied");
        }
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


