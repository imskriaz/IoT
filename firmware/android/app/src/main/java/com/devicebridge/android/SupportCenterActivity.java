package com.devicebridge.android;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

public class SupportCenterActivity extends Activity {
    private static final int REQ_SUPPORT_PERMISSIONS = 4501;

    private TextView permissionSummary;
    private TextView recoverySummary;
    private TextView testLabSummary;
    private TextView supportSummary;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildUi();
        BridgeEventLog.append(this, "Support center opened");
        refreshSupport(null);
    }

    @Override
    protected void onResume() {
        super.onResume();
        refreshSupport(null);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_SUPPORT_PERMISSIONS) {
            BridgeEventLog.append(this, "Support center permission request completed");
            refreshSupport("Permissions updated");
        }
    }

    private void buildUi() {
        LinearLayout root = BridgeUi.root(this);
        root.addView(BridgeUi.hero(this, "Device Bridge", "Support Center", ""));
        root.addView(BridgeUi.sectionSpacing(this));
        root.addView(buildTopRow());
        root.addView(BridgeUi.sectionSpacing(this));
        root.addView(buildPermissionCard());
        root.addView(BridgeUi.sectionSpacing(this));
        root.addView(buildRecoveryCard());
        root.addView(BridgeUi.sectionSpacing(this));
        root.addView(buildTestLabCard());
        root.addView(BridgeUi.sectionSpacing(this));
        root.addView(buildSupportToolsCard());
        setContentView(BridgeUi.screenShell(this, root));
    }

    private LinearLayout buildTopRow() {
        LinearLayout card = BridgeUi.sectionCard(this, "Navigate", "");
        LinearLayout row = BridgeUi.horizontalRow(this);
        Button homeButton = BridgeUi.smallButton(this, "Home", "#0d6efd", Color.WHITE);
        homeButton.setOnClickListener(v -> startActivity(new Intent(this, MainActivity.class)));
        Button menuButton = BridgeUi.smallButton(this, "Menu", "#e2e8f0", Color.parseColor("#0f172a"));
        menuButton.setOnClickListener(v -> BridgeNavigation.showMenu(this, v));
        Button settingsButton = BridgeUi.smallButton(this, "Settings", "#198754", Color.WHITE);
        settingsButton.setOnClickListener(v -> startActivity(new Intent(this, SettingsActivity.class)));
        row.addView(homeButton, BridgeUi.weightedWidth());
        row.addView(BridgeUi.spacer(this));
        row.addView(menuButton, BridgeUi.weightedWidth());
        row.addView(BridgeUi.spacer(this));
        row.addView(settingsButton, BridgeUi.weightedWidth());
        LinearLayout.LayoutParams p = BridgeUi.fullWidth(this);
        p.bottomMargin = 0;
        card.addView(row, p);
        return card;
    }

    private LinearLayout buildPermissionCard() {
        LinearLayout card = BridgeUi.sectionCard(this, "Permission Center", "");
        permissionSummary = BridgeUi.textBlock(this, 13, true);
        card.addView(permissionSummary, BridgeUi.fullWidth(this));

        LinearLayout row = BridgeUi.horizontalRow(this);
        Button grantButton = BridgeUi.smallButton(this, "Grant Missing", "#f59e0b", Color.parseColor("#111827"));
        grantButton.setOnClickListener(v -> {
            BridgePermissionHelper.requestMissing(this, REQ_SUPPORT_PERMISSIONS, true);
            refreshSupport("Permission request opened");
        });
        Button appSettingsButton = BridgeUi.smallButton(this, "Open App Settings", "#e2e8f0", Color.parseColor("#0f172a"));
        appSettingsButton.setOnClickListener(v -> {
            BridgePermissionHelper.openAppSettings(this);
            refreshSupport("Android app settings opened");
        });
        row.addView(grantButton, BridgeUi.weightedWidth());
        row.addView(BridgeUi.spacer(this));
        row.addView(appSettingsButton, BridgeUi.weightedWidth());
        card.addView(row, BridgeUi.fullWidth(this));
        return card;
    }

    private LinearLayout buildRecoveryCard() {
        LinearLayout card = BridgeUi.sectionCard(this, "Recovery", "");
        recoverySummary = BridgeUi.textBlock(this, 13, true);
        card.addView(recoverySummary, BridgeUi.fullWidth(this));

        LinearLayout rowOne = BridgeUi.horizontalRow(this);
        Button startButton = BridgeUi.smallButton(this, "Start Bridge", "#2563eb", Color.WHITE);
        startButton.setOnClickListener(v -> {
            BridgeRecoveryActions.startBridge(this);
            refreshSupport("Bridge start requested");
        });
        Button restartButton = BridgeUi.smallButton(this, "Restart", "#198754", Color.WHITE);
        restartButton.setOnClickListener(v -> {
            BridgeRecoveryActions.execute(this, "restart");
            refreshSupport("Bridge restart requested");
        });
        rowOne.addView(startButton, BridgeUi.weightedWidth());
        rowOne.addView(BridgeUi.spacer(this));
        rowOne.addView(restartButton, BridgeUi.weightedWidth());
        card.addView(rowOne, BridgeUi.fullWidth(this));

        LinearLayout rowTwo = BridgeUi.horizontalRow(this);
        Button clearQueueButton = BridgeUi.smallButton(this, "Clear Queue", "#111827", Color.WHITE);
        clearQueueButton.setOnClickListener(v -> {
            BridgeRecoveryActions.clearQueue(this);
            refreshSupport("Local queue cleared");
        });
        Button resetStateButton = BridgeUi.smallButton(this, "Reset State", "#dc2626", Color.WHITE);
        resetStateButton.setOnClickListener(v -> {
            BridgeRecoveryActions.resetState(this);
            refreshSupport("Recovery reset started");
        });
        rowTwo.addView(clearQueueButton, BridgeUi.weightedWidth());
        rowTwo.addView(BridgeUi.spacer(this));
        rowTwo.addView(resetStateButton, BridgeUi.weightedWidth());
        card.addView(rowTwo, BridgeUi.fullWidth(this));
        return card;
    }

    private LinearLayout buildTestLabCard() {
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
        Button permissionButton = BridgeUi.smallButton(this, "Probe Permissions", "#111827", Color.WHITE);
        permissionButton.setOnClickListener(v -> BridgeTestLab.runPermissionProbe(this, this::updateTestLabResult));
        rowTwo.addView(queueButton, BridgeUi.weightedWidth());
        rowTwo.addView(BridgeUi.spacer(this));
        rowTwo.addView(permissionButton, BridgeUi.weightedWidth());
        card.addView(rowTwo, BridgeUi.fullWidth(this));

        LinearLayout rowThree = BridgeUi.horizontalRow(this);
        Button recoveryButton = BridgeUi.smallButton(this, "Probe Recovery", "#e2e8f0", Color.parseColor("#0f172a"));
        recoveryButton.setOnClickListener(v -> BridgeTestLab.runRecoveryProbe(this, this::updateTestLabResult));
        rowThree.addView(recoveryButton, BridgeUi.fullWidth(this));
        card.addView(rowThree, BridgeUi.fullWidth(this));
        return card;
    }

    private LinearLayout buildSupportToolsCard() {
        LinearLayout card = BridgeUi.sectionCard(this, "Support Tools", "");
        supportSummary = BridgeUi.textBlock(this, 13, true);
        card.addView(supportSummary, BridgeUi.fullWidth(this));

        LinearLayout row = BridgeUi.horizontalRow(this);
        Button bundleButton = BridgeUi.smallButton(this, "Copy Support Bundle", "#0f766e", Color.WHITE);
        bundleButton.setOnClickListener(v -> {
            copyToClipboard("Device Bridge support bundle", BridgeDiagnostics.buildSupportBundle(this));
            refreshSupport("Support bundle copied");
        });
        Button logButton = BridgeUi.smallButton(this, "Copy Local Log", "#e2e8f0", Color.parseColor("#0f172a"));
        logButton.setOnClickListener(v -> {
            copyToClipboard("Device Bridge local log", BridgeEventLog.read(this));
            refreshSupport("Local log copied");
        });
        row.addView(bundleButton, BridgeUi.weightedWidth());
        row.addView(BridgeUi.spacer(this));
        row.addView(logButton, BridgeUi.weightedWidth());
        card.addView(row, BridgeUi.fullWidth(this));
        return card;
    }

    private void refreshSupport(String message) {
        BridgeConfig config = BridgeConfig.load(this);
        if (permissionSummary != null) {
            String prefix = message == null || message.trim().isEmpty() ? "" : message.trim() + "\n\n";
            permissionSummary.setText(prefix + BridgePermissionHelper.buildSummary(this, true));
        }
        if (recoverySummary != null) {
            recoverySummary.setText(BridgeRecoveryAdvisor.buildAdvisorText(this));
        }
        if (testLabSummary != null && (message == null || message.trim().isEmpty())) {
            testLabSummary.setText("No test run yet.");
        }
        if (supportSummary != null) {
            supportSummary.setText(
                    "Readiness: " + BridgeDiagnostics.readinessLabel(this)
                            + "\nHealth: " + BridgeDiagnostics.healthLabel(this)
                            + "\nRecent events:\n" + BridgeDiagnostics.recentLog(this, 6)
            );
        }
    }

    private void updateTestLabResult(String title, String detail) {
        if (testLabSummary != null) {
            testLabSummary.setText(title + "\n" + detail);
        }
        refreshSupport(title);
    }

    private void copyToClipboard(String label, String value) {
        ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard != null) {
            clipboard.setPrimaryClip(ClipData.newPlainText(label, value == null ? "" : value));
            BridgeEventLog.append(this, label + " copied");
        }
    }
}


