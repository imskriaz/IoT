package com.devicebridge.android;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.List;

public class BridgeDashboardSectionActivity extends Activity {
    static final String SECTION_OVERVIEW = "overview";
    static final String SECTION_COMMUNICATION = "communication";
    static final String SECTION_HEALTH = "health";
    static final String SECTION_PERMISSIONS = "permissions";
    static final String SECTION_RECOVERY = "recovery";
    static final String SECTION_TESTS = "tests";
    static final String SECTION_CONSOLE = "console";
    static final String SECTION_WORKSPACE = "workspace";

    private static final String EXTRA_SECTION = "section";
    private static final int REQ_BRIDGE_PERMISSIONS = 4201;

    private String section;
    private TextView dynamicText;

    static Intent createIntent(Activity activity, String section) {
        return new Intent(activity, BridgeDashboardSectionActivity.class)
                .putExtra(EXTRA_SECTION, section);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        section = getIntent().getStringExtra(EXTRA_SECTION);
        if (section == null || section.trim().isEmpty()) {
            section = SECTION_OVERVIEW;
        }
        buildUi();
        BridgeEventLog.append(this, "Opened app section: " + section);
    }

    @Override
    protected void onResume() {
        super.onResume();
        refreshDynamicText();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_BRIDGE_PERMISSIONS) {
            BridgeEventLog.append(this, "Section permission request completed");
            refreshDynamicText();
        }
    }

    private void buildUi() {
        LinearLayout root = BridgeUi.root(this);
        root.addView(BridgeUi.hero(this, "Device Bridge", sectionTitle(), ""));
        root.addView(BridgeUi.sectionSpacing(this));

        if (SECTION_HEALTH.equals(section)) {
            root.addView(buildHealth());
        } else if (SECTION_TESTS.equals(section)) {
            root.addView(buildTests());
        } else if (SECTION_CONSOLE.equals(section)) {
            root.addView(buildConsole());
        } else {
            root.addView(buildOverview());
        }

        setContentView(BridgeUi.screenShell(this, root));
    }

    private LinearLayout buildSectionNav() {
        LinearLayout card = BridgeUi.sectionCard(this, "Navigate", "");
        LinearLayout rowOne = BridgeUi.horizontalRow(this);
        Button home = BridgeUi.smallButton(this, "Home", "#0d6efd", Color.WHITE);
        home.setOnClickListener(v -> startActivity(new Intent(this, MainActivity.class)));
        Button logs = BridgeUi.smallButton(this, "Logs", "#e2e8f0", Color.parseColor("#0f172a"));
        logs.setOnClickListener(v -> reopen(SECTION_CONSOLE));
        Button settings = BridgeUi.smallButton(this, "Settings", "#e2e8f0", Color.parseColor("#0f172a"));
        settings.setOnClickListener(v -> startActivity(new Intent(this, SettingsActivity.class)));
        Button health = BridgeUi.smallButton(this, "Health", "#198754", Color.WHITE);
        health.setOnClickListener(v -> reopen(SECTION_HEALTH));
        rowOne.addView(home, BridgeUi.weightedWidth());
        rowOne.addView(BridgeUi.spacer(this));
        rowOne.addView(logs, BridgeUi.weightedWidth());
        card.addView(rowOne, BridgeUi.fullWidth(this));

        LinearLayout rowTwo = BridgeUi.horizontalRow(this);
        rowTwo.addView(settings, BridgeUi.weightedWidth());
        rowTwo.addView(BridgeUi.spacer(this));
        rowTwo.addView(health, BridgeUi.weightedWidth());
        card.addView(rowTwo, BridgeUi.fullWidth(this));
        return card;
    }

    private LinearLayout buildOverview() {
        LinearLayout card = BridgeUi.sectionCard(this, "Overview", "");
        dynamicText = BridgeUi.textBlock(this, 13, true);
        dynamicText.setTypeface(Typeface.MONOSPACE);
        card.addView(dynamicText, BridgeUi.fullWidth(this));
        return card;
    }

    private LinearLayout buildHealth() {
        LinearLayout card = BridgeUi.sectionCard(this, "Health", "Health, permissions, and recovery actions in one page.");
        dynamicText = BridgeUi.textBlock(this, 13, true);
        dynamicText.setTypeface(Typeface.MONOSPACE);
        card.addView(dynamicText, BridgeUi.fullWidth(this));
        addButton(card, "Refresh Health", "#0f766e", this::refreshDynamicText);
        addButton(card, "Grant Missing", "#f59e0b", () -> {
            BridgePermissionHelper.requestMissing(this, REQ_BRIDGE_PERMISSIONS, true);
            BridgeEventLog.append(this, "Permission request opened from health section");
        });
        addButton(card, "Open App Settings", "#334155", () -> BridgePermissionHelper.openAppSettings(this));
        addButton(card, "Run Recommended Action", "#0f766e", () -> {
            List<BridgeRecoveryAdvisor.ActionItem> actions = BridgeRecoveryAdvisor.buildActions(this);
            if (!actions.isEmpty()) {
                BridgeRecoveryActions.execute(this, actions.get(0).action);
            }
        });
        addButton(card, "Start Bridge", "#2563eb", () -> BridgeRecoveryActions.startBridge(this));
        addButton(card, "Restart Bridge", "#111827", () -> {
            BridgeRecoveryActions.stopBridge(this);
            BridgeRecoveryActions.startBridge(this);
        });
        addButton(card, "Clear Queue", "#64748b", () -> BridgeRecoveryActions.clearQueue(this));
        addButton(card, "Reset State", "#dc2626", () -> BridgeRecoveryActions.resetState(this));
        addButton(card, "Open Support Center", "#dc2626", () -> startActivity(new Intent(this, SupportCenterActivity.class)));
        return card;
    }

    private LinearLayout buildTests() {
        LinearLayout card = BridgeUi.sectionCard(this, "Test Lab", "");
        dynamicText = BridgeUi.textBlock(this, 13, true);
        dynamicText.setText("No test run yet.");
        card.addView(dynamicText, BridgeUi.fullWidth(this));
        addButton(card, "Test Status Push", "#0d6efd", () -> BridgeTestLab.runStatusPushTest(this, this::showTestResult));
        addButton(card, "Self SMS Test", "#ea580c", () -> BridgeTestLab.runSelfSendTest(this, this::showTestResult));
        addButton(card, "Test Queue", "#198754", () -> BridgeTestLab.runQueuePickupTest(this, this::showTestResult));
        addButton(card, "Probe Permissions", "#111827", () -> BridgeTestLab.runPermissionProbe(this, this::showTestResult));
        addButton(card, "Probe Recovery", "#64748b", () -> BridgeTestLab.runRecoveryProbe(this, this::showTestResult));
        return card;
    }

    private LinearLayout buildConsole() {
        LinearLayout card = BridgeUi.sectionCard(this, "Console", "");
        dynamicText = BridgeUi.textBlock(this, 12, true);
        dynamicText.setTypeface(Typeface.MONOSPACE);
        dynamicText.setTextIsSelectable(true);
        card.addView(dynamicText, BridgeUi.fullWidth(this));
        addButton(card, "Copy Support Bundle", "#0d6efd", this::copySupportBundle);
        addButton(card, "Clear Log", "#dc2626", () -> {
            BridgeRecoveryActions.clearLog(this);
            refreshDynamicText();
        });
        return card;
    }

    private void refreshDynamicText() {
        if (dynamicText == null) return;
        BridgeConfig config = BridgeConfig.load(this);
        if (SECTION_HEALTH.equals(section)) {
            dynamicText.setText(
                    "Health\n" + BridgeDiagnostics.buildHealthPulse(this)
                            + "\n\nPermissions\n" + BridgePermissionHelper.buildSummary(this, true)
                            + "\n\nRecovery\n" + BridgeRecoveryAdvisor.buildAdvisorText(this)
            );
        } else if (SECTION_PERMISSIONS.equals(section)) {
            dynamicText.setText(BridgePermissionHelper.buildSummary(this, true));
        } else if (SECTION_RECOVERY.equals(section)) {
            dynamicText.setText(BridgeRecoveryAdvisor.buildAdvisorText(this));
        } else if (SECTION_CONSOLE.equals(section)) {
            dynamicText.setText(BridgeDiagnostics.recentLog(this, 20));
        } else if (!SECTION_TESTS.equals(section)) {
            dynamicText.setText(BridgeDiagnostics.buildStatusSummary(this, null));
        }
    }

    private void addButton(LinearLayout card, String title, String color, Runnable action) {
        View button = BridgeUi.menuButton(this, title, null, color);
        button.setOnClickListener(v -> {
            if (action != null) {
                action.run();
            }
        });
        card.addView(button, BridgeUi.fullWidth(this));
    }

    private void showTestResult(String title, String detail) {
        if (dynamicText != null) {
            dynamicText.setText(title + "\n" + detail);
        }
    }

    private void copySupportBundle() {
        ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard != null) {
            clipboard.setPrimaryClip(ClipData.newPlainText("Device Bridge support bundle", BridgeDiagnostics.buildSupportBundle(this)));
            BridgeEventLog.append(this, "Support bundle copied from console section");
        }
    }

    private void reopen(String nextSection) {
        startActivity(createIntent(this, nextSection));
    }

    private String sectionTitle() {
        if (SECTION_HEALTH.equals(section)) return "Health";
        if (SECTION_PERMISSIONS.equals(section)) return "Permissions";
        if (SECTION_RECOVERY.equals(section)) return "Recovery";
        if (SECTION_TESTS.equals(section)) return "Test Lab";
        if (SECTION_CONSOLE.equals(section)) return "Logs";
        return "Overview";
    }

    private static String emptyLabel(String value) {
        return value == null || value.trim().isEmpty() ? "not set" : value;
    }
}


