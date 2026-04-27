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

import java.util.List;

public class FeatureHubActivity extends Activity {
    private static final int REQ_FEATURE_PERMISSIONS = 4401;

    private TextView readinessSummary;
    private TextView permissionSummary;
    private TextView advisorSummary;
    private Button advisorActionButton;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildUi();
        BridgeEventLog.append(this, "Feature hub opened");
        refreshHub();
    }

    @Override
    protected void onResume() {
        super.onResume();
        refreshHub();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_FEATURE_PERMISSIONS) {
            BridgeEventLog.append(this, "Feature hub permission request completed");
            refreshHub();
        }
    }

    private void buildUi() {
        LinearLayout root = BridgeUi.root(this);
        root.addView(BridgeUi.hero(this, "Device Bridge", "Feature Hub", ""));
        root.addView(BridgeUi.sectionSpacing(this));
        root.addView(buildTopRow());
        root.addView(BridgeUi.sectionSpacing(this));
        root.addView(buildReadinessCard());
        root.addView(BridgeUi.sectionSpacing(this));
        root.addView(buildPermissionCenterCard());
        root.addView(BridgeUi.sectionSpacing(this));
        root.addView(buildAdvisorCard());
        root.addView(BridgeUi.sectionSpacing(this));

        List<BridgeFeatureCatalog.FeatureSection> sections = BridgeFeatureCatalog.buildSections();
        for (int i = 0; i < sections.size(); i += 1) {
            root.addView(buildFeatureSection(sections.get(i)));
            if (i < sections.size() - 1) {
                root.addView(BridgeUi.sectionSpacing(this));
            }
        }

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
        Button supportButton = BridgeUi.smallButton(this, "Support", "#dc2626", Color.WHITE);
        supportButton.setOnClickListener(v -> startActivity(new Intent(this, SupportCenterActivity.class)));
        row.addView(homeButton, BridgeUi.weightedWidth());
        row.addView(BridgeUi.spacer(this));
        row.addView(menuButton, BridgeUi.weightedWidth());
        row.addView(BridgeUi.spacer(this));
        row.addView(settingsButton, BridgeUi.weightedWidth());
        row.addView(BridgeUi.spacer(this));
        row.addView(supportButton, BridgeUi.weightedWidth());
        LinearLayout.LayoutParams p = BridgeUi.fullWidth(this);
        p.bottomMargin = 0;
        card.addView(row, p);
        return card;
    }

    private LinearLayout buildReadinessCard() {
        LinearLayout card = BridgeUi.sectionCard(this, "Support Tools", "");
        readinessSummary = BridgeUi.textBlock(this, 13, true);
        card.addView(readinessSummary, BridgeUi.fullWidth(this));

        LinearLayout row = BridgeUi.horizontalRow(this);
        Button supportButton = BridgeUi.smallButton(this, "Copy Support Bundle", "#0f766e", Color.WHITE);
        supportButton.setOnClickListener(v -> copyToClipboard("Device Bridge support bundle", BridgeDiagnostics.buildSupportBundle(this), "Support bundle copied"));
        Button catalogButton = BridgeUi.smallButton(this, "Copy Feature Map", "#e2e8f0", Color.parseColor("#0f172a"));
        catalogButton.setOnClickListener(v -> copyToClipboard("Device Bridge feature map", BridgeFeatureCatalog.buildCatalogText(), "Feature map copied"));
        row.addView(supportButton, BridgeUi.weightedWidth());
        row.addView(BridgeUi.spacer(this));
        row.addView(catalogButton, BridgeUi.weightedWidth());
        card.addView(row, BridgeUi.fullWidth(this));
        return card;
    }

    private LinearLayout buildPermissionCenterCard() {
        LinearLayout card = BridgeUi.sectionCard(this, "Permission Center", "");
        permissionSummary = BridgeUi.textBlock(this, 13, true);
        card.addView(permissionSummary, BridgeUi.fullWidth(this));

        LinearLayout row = BridgeUi.horizontalRow(this);
        Button grantButton = BridgeUi.smallButton(this, "Grant Missing", "#f59e0b", Color.parseColor("#111827"));
        grantButton.setOnClickListener(v -> {
            BridgePermissionHelper.requestMissing(this, REQ_FEATURE_PERMISSIONS, true);
            refreshHub();
        });
        Button settingsButton = BridgeUi.smallButton(this, "Open App Settings", "#e2e8f0", Color.parseColor("#0f172a"));
        settingsButton.setOnClickListener(v -> {
            BridgePermissionHelper.openAppSettings(this);
            refreshHub();
        });
        row.addView(grantButton, BridgeUi.weightedWidth());
        row.addView(BridgeUi.spacer(this));
        row.addView(settingsButton, BridgeUi.weightedWidth());
        card.addView(row, BridgeUi.fullWidth(this));
        return card;
    }

    private LinearLayout buildAdvisorCard() {
        LinearLayout card = BridgeUi.sectionCard(this, "Recovery Advisor", "");
        advisorSummary = BridgeUi.textBlock(this, 13, true);
        card.addView(advisorSummary, BridgeUi.fullWidth(this));

        LinearLayout row = BridgeUi.horizontalRow(this);
        advisorActionButton = BridgeUi.smallButton(this, "Open Recovery Action", "#0d6efd", Color.WHITE);
        advisorActionButton.setOnClickListener(v -> {
            List<BridgeRecoveryAdvisor.ActionItem> actions = BridgeRecoveryAdvisor.buildActions(this);
            if (!actions.isEmpty()) {
                BridgeRecoveryActions.execute(this, actions.get(0).action);
                refreshHub();
            }
        });
        Button settingsButton = BridgeUi.smallButton(this, "Open Settings", "#e2e8f0", Color.parseColor("#0f172a"));
        settingsButton.setOnClickListener(v -> startActivity(new Intent(this, SettingsActivity.class)));
        row.addView(advisorActionButton, BridgeUi.weightedWidth());
        row.addView(BridgeUi.spacer(this));
        row.addView(settingsButton, BridgeUi.weightedWidth());
        card.addView(row, BridgeUi.fullWidth(this));
        return card;
    }

    private LinearLayout buildFeatureSection(BridgeFeatureCatalog.FeatureSection section) {
        LinearLayout card = BridgeUi.sectionCard(this, section.title, section.subtitle);
        for (BridgeFeatureCatalog.FeatureItem item : section.items) {
            LinearLayout itemView = new LinearLayout(this);
            itemView.setOrientation(LinearLayout.VERTICAL);
            itemView.setPadding(BridgeUi.dp(this, 12), BridgeUi.dp(this, 10), BridgeUi.dp(this, 12), BridgeUi.dp(this, 10));
            itemView.setBackground(BridgeUi.inputBackground(this));

            TextView title = BridgeUi.textBlock(this, 14, true);
            title.setText(item.title + "  [" + item.status + "]");
            itemView.addView(title, BridgeUi.fullWidth(this));

            TextView target = BridgeUi.textBlock(this, 12, false);
            target.setText("Dashboard: " + item.dashboardTarget);
            itemView.addView(target, BridgeUi.fullWidth(this));

            TextView detail = BridgeUi.textBlock(this, 12, false);
            detail.setText(item.detail);
            itemView.addView(detail, BridgeUi.fullWidth(this));

            card.addView(itemView, BridgeUi.fullWidth(this));
        }
        return card;
    }

    private void refreshHub() {
        if (readinessSummary == null) return;
        BridgeConfig config = BridgeConfig.load(this);
        readinessSummary.setText(
                "Readiness Score: " + BridgeDiagnostics.readinessScore(this) + "/100"
                        + "\nReadiness Label: " + BridgeDiagnostics.readinessLabel(this)
                        + "\nDashboard Access: " + config.hasDashboardAccess()
                        + "\nOperational Permissions: " + BridgeDiagnostics.hasOperationalPermissions(this)
                        + "\nConnection: " + config.transportDisplayLabel()
                        + "\nInnovation: support bundle export, feature map mirror, and recovery-first onboarding are active."
        );
        if (permissionSummary != null) {
            permissionSummary.setText(BridgePermissionHelper.buildSummary(this, true));
        }
        if (advisorSummary != null) {
            advisorSummary.setText(BridgeRecoveryAdvisor.buildAdvisorText(this));
        }
        if (advisorActionButton != null) {
            List<BridgeRecoveryAdvisor.ActionItem> actions = BridgeRecoveryAdvisor.buildActions(this);
            BridgeRecoveryAdvisor.ActionItem primary = actions.isEmpty() ? null : actions.get(0);
            advisorActionButton.setText(primary == null ? "Open Recovery Action" : primary.title);
        }
    }

    private void copyToClipboard(String label, String value, String successMessage) {
        ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard != null) {
            clipboard.setPrimaryClip(ClipData.newPlainText(label, value));
            BridgeEventLog.append(this, successMessage);
            refreshHub();
        }
    }
}


