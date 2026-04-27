package com.devicebridge.android;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.List;

public class PermissionFlowActivity extends Activity {
    private static final int REQ_SINGLE_PERMISSION = 4601;
    private static final long AUTO_ROUTE_DELAY_MS = 500L;
    private static final long AUTO_PERMISSION_DELAY_MS = 300L;

    private TextView headline;
    private TextView detail;
    private TextView progressSummary;
    private TextView permissionList;
    private Button grantButton;
    private Button settingsButton;
    private Button continueButton;
    private boolean autoPrompted;
    private boolean autoRouting;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildUi();
        BridgeEventLog.append(this, "Permission flow opened");
        render();
        grantButton.postDelayed(() -> {
            if (!autoPrompted) {
                autoPrompted = true;
                requestNextPermission();
            }
        }, 450);
    }

    @Override
    protected void onResume() {
        super.onResume();
        render();
        maybeAutoRequestNext();
        maybeAutoAdvance();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_SINGLE_PERMISSION) {
            BridgeEventLog.append(this, "Permission flow permission result received");
            if (BridgePermissionHelper.hasSmsInboxFeature(this) || BridgePermissionHelper.hasCallFeature(this)) {
                MqttBridgeService.requestSilentBulkSync(this);
            }
            render();
            if (BridgePermissionHelper.hasCore(this)) {
                routeNext();
                return;
            }
            maybeAutoRequestNext();
        }
    }

    private void buildUi() {
        LinearLayout root = BridgeUi.root(this);
        root.addView(BridgeUi.hero(
                this,
                "Device Bridge",
                "Permissions",
                "Grant the required access once. The app will continue automatically when everything is ready."
        ));
        root.addView(BridgeUi.sectionSpacing(this));
        root.addView(buildActiveCard());
        root.addView(BridgeUi.sectionSpacing(this));
        root.addView(buildListCard());
        root.addView(BridgeUi.sectionSpacing(this));
        root.addView(buildActionsCard());
        setContentView(BridgeUi.screenShellNoNav(this, root));
    }

    private LinearLayout buildActiveCard() {
        LinearLayout card = BridgeUi.sectionCard(this, "Next Access", "");
        progressSummary = BridgeUi.textBlock(this, 12, false);
        progressSummary.setTypeface(Typeface.DEFAULT_BOLD);
        headline = BridgeUi.textBlock(this, 15, true);
        headline.setTypeface(Typeface.DEFAULT_BOLD);
        detail = BridgeUi.textBlock(this, 12, false);
        card.addView(progressSummary, BridgeUi.fullWidth(this));
        card.addView(headline, BridgeUi.fullWidth(this));
        card.addView(detail, BridgeUi.fullWidth(this));
        return card;
    }

    private LinearLayout buildListCard() {
        LinearLayout card = BridgeUi.sectionCard(this, "Checklist", "");
        permissionList = BridgeUi.textBlock(this, 12, true);
        permissionList.setTypeface(Typeface.MONOSPACE);
        card.addView(permissionList, BridgeUi.fullWidth(this));
        return card;
    }

    private LinearLayout buildActionsCard() {
        LinearLayout card = BridgeUi.sectionCard(this, "Actions", "");

        LinearLayout row = BridgeUi.horizontalRow(this);
        grantButton = BridgeUi.smallButton(this, "Grant Next", "#0d6efd", Color.WHITE);
        grantButton.setOnClickListener(v -> requestNextPermission());
        settingsButton = BridgeUi.smallButton(this, "App Settings", "#e2e8f0", Color.parseColor("#0f172a"));
        settingsButton.setOnClickListener(v -> BridgePermissionHelper.openAppSettings(this));
        row.addView(grantButton, BridgeUi.weightedWidth());
        row.addView(BridgeUi.spacer(this));
        row.addView(settingsButton, BridgeUi.weightedWidth());
        card.addView(row, BridgeUi.fullWidth(this));

        continueButton = BridgeUi.smallButton(this, "Continue", "#198754", Color.WHITE);
        continueButton.setOnClickListener(v -> routeNext());
        card.addView(continueButton, BridgeUi.fullWidth(this));
        return card;
    }

    private void render() {
        BridgePermissionHelper.PermissionItem missing = BridgePermissionHelper.firstMissingCore(this);
        List<BridgePermissionHelper.PermissionItem> items = BridgePermissionHelper.collectCore(this);
        int grantedCount = 0;
        int settingsCount = 0;
        for (BridgePermissionHelper.PermissionItem item : items) {
            if (item.granted) {
                grantedCount += 1;
            } else if (item.needsSettings) {
                settingsCount += 1;
            }
        }

        progressSummary.setText(grantedCount + " of " + items.size() + " required permissions ready"
                + (settingsCount > 0 ? " - " + settingsCount + " needs App Settings" : ""));

        if (missing == null) {
            headline.setText("All access ready");
            detail.setText("Everything needed is granted. Continue to the bridge dashboard.");
            grantButton.setEnabled(false);
            grantButton.setText("Ready");
            settingsButton.setEnabled(false);
            continueButton.setVisibility(Button.VISIBLE);
            continueButton.setEnabled(true);
        } else {
            headline.setText(missing.label);
            detail.setText(BridgePermissionHelper.purposeFor(missing.permission)
                    + (missing.needsSettings ? "\n\nAndroid is blocking the prompt. Open App Settings and allow it there." : ""));
            grantButton.setEnabled(!missing.needsSettings);
            grantButton.setText(missing.needsSettings ? "Use App Settings" : "Grant " + missing.label);
            settingsButton.setEnabled(true);
            continueButton.setVisibility(Button.VISIBLE);
            continueButton.setEnabled(false);
        }

        StringBuilder builder = new StringBuilder();
        for (BridgePermissionHelper.PermissionItem item : items) {
            if (builder.length() > 0) {
                builder.append('\n');
            }
            builder.append(item.granted ? "[ok] " : "[--] ")
                    .append(item.label)
                    .append(" - ")
                    .append(item.granted ? "granted" : (item.needsSettings ? "settings required" : "pending"));
        }
        permissionList.setText(builder.toString());
    }

    private void maybeAutoAdvance() {
        if (autoRouting || !BridgePermissionHelper.hasCore(this)) {
            return;
        }
        autoRouting = true;
        permissionList.postDelayed(this::routeNext, AUTO_ROUTE_DELAY_MS);
    }

    private void maybeAutoRequestNext() {
        BridgePermissionHelper.PermissionItem missing = BridgePermissionHelper.firstMissingCore(this);
        if (missing == null || missing.needsSettings || autoRouting) {
            return;
        }
        permissionList.postDelayed(this::requestNextPermission, AUTO_PERMISSION_DELAY_MS);
    }

    private void requestNextPermission() {
        BridgePermissionHelper.PermissionItem missing = BridgePermissionHelper.firstMissingCore(this);
        if (missing == null) {
            routeNext();
            return;
        }
        if (missing.needsSettings) {
            render();
            return;
        }
        BridgePermissionHelper.markRequested(this, missing.permission);
        requestPermissions(new String[] { missing.permission }, REQ_SINGLE_PERMISSION);
    }

    private void routeNext() {
        startActivity(new Intent(this, MainActivity.class));
        finish();
    }
}


