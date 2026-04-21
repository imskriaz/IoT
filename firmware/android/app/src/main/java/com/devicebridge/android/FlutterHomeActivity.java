package com.devicebridge.android;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.annotation.NonNull;

import java.util.HashMap;
import java.util.Map;

import io.flutter.embedding.android.FlutterActivity;
import io.flutter.embedding.engine.FlutterEngine;
import io.flutter.plugin.common.MethodCall;
import io.flutter.plugin.common.MethodChannel;

public class FlutterHomeActivity extends FlutterActivity {
    private static final String CHANNEL = "devicebridge/native";
    private static final String EXTRA_SETUP_TOKEN = "setup_token";
    private static final int REQ_QR_SCAN = 4811;
    private static final int REQ_CALL_PERMISSIONS = 4812;
    private static final int REQ_QR_PERMISSIONS = 4813;
    private static final int REQ_WEBCAM_PERMISSIONS = 4814;
    private static final int REQ_INTERCOM_PERMISSIONS = 4815;

    private String pendingSetupToken = "";
    private MethodChannel.Result pendingScanResult;
    private MethodChannel.Result pendingFeaturePermissionResult;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        capturePendingSetupToken(getIntent());
        if (BridgeAppGate.routeFromStartup(this)) {
            finish();
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        capturePendingSetupToken(intent);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_QR_SCAN || pendingScanResult == null) {
            return;
        }
        String scanned = data == null ? "" : data.getStringExtra(BridgeQrScannerActivity.EXTRA_SCAN_RESULT);
        pendingScanResult.success(scanned == null ? "" : scanned.trim());
        pendingScanResult = null;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_CALL_PERMISSIONS
                && requestCode != REQ_QR_PERMISSIONS
                && requestCode != REQ_WEBCAM_PERMISSIONS
                && requestCode != REQ_INTERCOM_PERMISSIONS) {
            return;
        }
        if (pendingFeaturePermissionResult == null) {
            return;
        }
        pendingFeaturePermissionResult.success(buildFlutterState());
        pendingFeaturePermissionResult = null;
    }

    @Override
    public void configureFlutterEngine(@NonNull FlutterEngine flutterEngine) {
        super.configureFlutterEngine(flutterEngine);
        new MethodChannel(flutterEngine.getDartExecutor().getBinaryMessenger(), CHANNEL)
                .setMethodCallHandler(this::handleMethodCall);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (BridgeAppGate.routeFromStartup(this)) {
            finish();
            return;
        }
        ensureBridgeOnline();
    }

    private void handleMethodCall(MethodCall call, MethodChannel.Result result) {
        switch (call.method) {
            case "getDashboardState":
                ensureBridgeOnline();
                result.success(buildFlutterState());
                return;
            case "consumePendingSetupCode":
                result.success(consumePendingSetupToken());
                return;
            case "launchQrScanner":
                if (!BridgePermissionHelper.hasQrFeature(this)) {
                    result.error("camera_permission_required", "Enable QR scanner access in Setting first.", null);
                    return;
                }
                if (pendingScanResult != null) {
                    result.error("scan_busy", "Scanner already open.", null);
                    return;
                }
                pendingScanResult = result;
                startActivityForResult(new Intent(this, BridgeQrScannerActivity.class), REQ_QR_SCAN);
                return;
            case "requestCallFeaturePermissions":
                if (BridgePermissionHelper.hasCallFeature(this)) {
                    result.success(buildFlutterState());
                    return;
                }
                if (pendingFeaturePermissionResult != null) {
                    result.error("permission_busy", "Another permission request is already running.", null);
                    return;
                }
                pendingFeaturePermissionResult = result;
                BridgePermissionHelper.requestCallFeature(this, REQ_CALL_PERMISSIONS);
                return;
            case "requestQrFeaturePermissions":
                if (BridgePermissionHelper.hasQrFeature(this)) {
                    result.success(buildFlutterState());
                    return;
                }
                if (pendingFeaturePermissionResult != null) {
                    result.error("permission_busy", "Another permission request is already running.", null);
                    return;
                }
                pendingFeaturePermissionResult = result;
                BridgePermissionHelper.requestQrFeature(this, REQ_QR_PERMISSIONS);
                return;
            case "requestWebcamFeaturePermissions":
                if (BridgePermissionHelper.hasWebcamFeature(this)) {
                    result.success(buildFlutterState());
                    return;
                }
                if (pendingFeaturePermissionResult != null) {
                    result.error("permission_busy", "Another permission request is already running.", null);
                    return;
                }
                pendingFeaturePermissionResult = result;
                BridgePermissionHelper.requestWebcamFeature(this, REQ_WEBCAM_PERMISSIONS);
                return;
            case "requestIntercomFeaturePermissions":
                if (BridgePermissionHelper.hasIntercomFeature(this)) {
                    result.success(buildFlutterState());
                    return;
                }
                if (pendingFeaturePermissionResult != null) {
                    result.error("permission_busy", "Another permission request is already running.", null);
                    return;
                }
                pendingFeaturePermissionResult = result;
                BridgePermissionHelper.requestIntercomFeature(this, REQ_INTERCOM_PERMISSIONS);
                return;
            case "importSetupCode":
                String rawCode = call.argument("code");
                if (rawCode == null || rawCode.trim().isEmpty()) {
                    result.error("missing_code", "Setup code is required.", null);
                    return;
                }
                try {
                    BridgeProvisioning.applyProvisioningPayload(this, rawCode.trim());
                    BridgeEventLog.append(this, "Setup code applied");
                    if (BridgePermissionHelper.hasCore(this) && BridgeAppGate.hasConnectionDetails(this)) {
                        BridgeRecoveryActions.startBridge(this);
                        BridgeEventLog.append(this, "Bridge started from setup import");
                    }
                    result.success(buildFlutterState());
                } catch (Exception error) {
                    result.error("invalid_code", error.getMessage(), null);
                }
                return;
            case "startBridge":
                if (!BridgeAppGate.hasConnectionDetails(this)) {
                    result.error("config_missing", "Connection setup required.", null);
                    return;
                }
                BridgeRecoveryActions.startBridge(this);
                result.success(buildFlutterState());
                return;
            case "stopBridge":
                BridgeRecoveryActions.stopBridge(this);
                result.success(buildFlutterState());
                return;
            case "restartBridge":
                BridgeRecoveryActions.stopBridge(this);
                BridgeRecoveryActions.startBridge(this);
                result.success(buildFlutterState());
                return;
            case "clearQueue":
                BridgeRecoveryActions.clearQueue(this);
                result.success(buildFlutterState());
                return;
            case "clearLog":
                BridgeRecoveryActions.clearLog(this);
                result.success(buildFlutterState());
                return;
            case "reopenOnboarding":
                BridgeRecoveryActions.resetOnboardingState(this);
                result.success(buildFlutterState());
                return;
            case "openSettings":
                startActivity(new Intent(this, SettingsActivity.class));
                result.success(true);
                return;
            case "openPermissionFlow":
                startActivity(new Intent(this, PermissionFlowActivity.class));
                result.success(true);
                return;
            case "openSystemSettings":
                startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                        .setData(Uri.parse("package:" + getPackageName())));
                result.success(true);
                return;
            case "requestDisableBatteryOptimization":
                if (isBatteryOptimizationDisabled()) {
                    result.success(buildFlutterState());
                    return;
                }
                try {
                    startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                            .setData(Uri.parse("package:" + getPackageName())));
                    result.success(buildFlutterState());
                } catch (Exception requestError) {
                    try {
                        startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                        result.success(buildFlutterState());
                    } catch (Exception fallbackError) {
                        result.error("battery_optimization_unavailable", "Unable to open battery optimization settings.", null);
                    }
                }
                return;
            default:
                result.notImplemented();
        }
    }

    private void capturePendingSetupToken(Intent intent) {
        if (intent == null) {
            return;
        }
        String direct = BridgeProvisioning.extractSetupToken(intent);
        if (direct.isEmpty()) {
            direct = intent.getStringExtra(EXTRA_SETUP_TOKEN);
        }
        if (direct != null && !direct.trim().isEmpty()) {
            pendingSetupToken = direct.trim();
        }
    }

    private String consumePendingSetupToken() {
        String current = pendingSetupToken == null ? "" : pendingSetupToken.trim();
        pendingSetupToken = "";
        return current;
    }

    private Map<String, Object> buildFlutterState() {
        Map<String, Object> state = new HashMap<>(BridgeSnapshotProvider.buildDashboardState(this));
        state.put("permissionsReady", BridgePermissionHelper.hasCore(this));
        state.put("callFeatureReady", BridgePermissionHelper.hasCallFeature(this));
        state.put("qrFeatureReady", BridgePermissionHelper.hasQrFeature(this));
        state.put("wifiFeatureReady", BridgePermissionHelper.hasWifiFeature(this));
        state.put("webcamFeatureReady", BridgePermissionHelper.hasWebcamFeature(this));
        state.put("intercomFeatureReady", BridgePermissionHelper.hasIntercomFeature(this));
        state.put("batteryOptimizationDisabled", isBatteryOptimizationDisabled());
        state.put("connectionReady", BridgeAppGate.hasConnectionDetails(this));
        state.put("needsOnboarding", !BridgeAppGate.hasConnectionDetails(this));
        state.put("hasPendingSetupCode", pendingSetupToken != null && !pendingSetupToken.trim().isEmpty());
        return state;
    }

    private void ensureBridgeOnline() {
        if (!BridgePermissionHelper.hasCore(this) || !BridgeAppGate.hasConnectionDetails(this)) {
            return;
        }
        if (!BridgeConfig.load(this).bridgeEnabled) {
            return;
        }
        if (BridgeAppGate.isOnline(this) || BridgeAppGate.isBridgeServiceRunning(this)) {
            return;
        }
        BridgeEventLog.append(this, "Auto recovery: bridge was stopped, starting service");
        BridgeRecoveryActions.startBridge(this);
    }

    private boolean isBatteryOptimizationDisabled() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            return true;
        }
        PowerManager powerManager = getSystemService(PowerManager.class);
        return powerManager != null && powerManager.isIgnoringBatteryOptimizations(getPackageName());
    }
}
