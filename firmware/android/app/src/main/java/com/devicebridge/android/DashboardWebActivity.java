package com.devicebridge.android;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

public class DashboardWebActivity extends Activity {
    private static final String PREF_LAST_DASHBOARD_URL = "last_dashboard_url";
    private static final String EXTRA_DASHBOARD_PATH = "dashboard_path";
    private static final String EXTRA_DEVICE_ID = "device";
    static final String PATH_LOGIN = "/auth/login";
    static final String PATH_DEVICE_HOME = "/dashboard";
    static final String PATH_SMS = "/sms";
    static final String PATH_CALLS = "/calls";
    static final String PATH_USSD = "/ussd";
    static final String PATH_CONTACTS = "/contacts";
    static final String PATH_DEVICES = "/devices";
    static final String PATH_DEVICE_SETTINGS = "/devices/settings";
    static final String PATH_DEVICE_ABOUT = "/devices/about";
    static final String PATH_DEVICE_QUEUE = "/devices/queue";
    static final String PATH_DEVICE_CAPABILITIES = "/devices/capabilities";
    static final String PATH_PACKAGES = "/admin/packages";

    private WebView webView;
    private ProgressBar progressBar;
    private TextView locationText;
    private TextView helperText;
    private TextView deviceText;
    private TextView scopeText;
    private TextView supportText;
    private Button backButton;
    private Button forwardButton;
    private String dashboardUrl = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildUi();
        BridgeEventLog.append(this, "Dashboard web opened");
        loadDashboard();
    }

    @Override
    protected void onResume() {
        super.onResume();
        dashboardUrl = resolveDashboardUrl();
        updateChrome();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    private void buildUi() {
        LinearLayout root = BridgeUi.root(this);
        root.addView(BridgeUi.hero(this, "Device Bridge", "Dashboard", ""));
        root.addView(BridgeUi.sectionSpacing(this));
        root.addView(buildChrome());
        root.addView(BridgeUi.sectionSpacing(this));
        root.addView(buildWebCard());
        setContentView(BridgeUi.screenShell(this, root));
    }

    private View buildChrome() {
        LinearLayout card = BridgeUi.sectionCard(this, "Navigate", "");
        LinearLayout navRow = BridgeUi.horizontalRow(this);
        Button homeButton = BridgeUi.smallButton(this, "Home", "#0d6efd", Color.WHITE);
        homeButton.setOnClickListener(v -> startActivity(new Intent(this, MainActivity.class)));
        Button menuButton = BridgeUi.smallButton(this, "Menu", "#e2e8f0", Color.parseColor("#0f172a"));
        menuButton.setOnClickListener(v -> BridgeNavigation.showMenu(this, v));
        Button settingsButton = BridgeUi.smallButton(this, "Settings", "#198754", Color.WHITE);
        settingsButton.setOnClickListener(v -> startActivity(new Intent(this, SettingsActivity.class)));
        Button supportButton = BridgeUi.smallButton(this, "Support", "#dc2626", Color.WHITE);
        supportButton.setOnClickListener(v -> startActivity(new Intent(this, SupportCenterActivity.class)));
        navRow.addView(homeButton, BridgeUi.weightedWidth());
        navRow.addView(BridgeUi.spacer(this));
        navRow.addView(menuButton, BridgeUi.weightedWidth());
        navRow.addView(BridgeUi.spacer(this));
        navRow.addView(settingsButton, BridgeUi.weightedWidth());
        navRow.addView(BridgeUi.spacer(this));
        navRow.addView(supportButton, BridgeUi.weightedWidth());
        card.addView(navRow, BridgeUi.fullWidth(this));

        LinearLayout webRow = BridgeUi.horizontalRow(this);
        backButton = BridgeUi.smallButton(this, "Back", "#e2e8f0", Color.parseColor("#0f172a"));
        backButton.setOnClickListener(v -> {
            if (webView != null && webView.canGoBack()) {
                webView.goBack();
            }
        });
        forwardButton = BridgeUi.smallButton(this, "Forward", "#e2e8f0", Color.parseColor("#0f172a"));
        forwardButton.setOnClickListener(v -> {
            if (webView != null && webView.canGoForward()) {
                webView.goForward();
            }
        });
        Button reloadButton = BridgeUi.smallButton(this, "Reload", "#111827", Color.WHITE);
        reloadButton.setOnClickListener(v -> {
            if (webView != null) {
                webView.reload();
            } else {
                loadDashboard();
            }
        });
        webRow.addView(backButton, BridgeUi.weightedWidth());
        webRow.addView(BridgeUi.spacer(this));
        webRow.addView(forwardButton, BridgeUi.weightedWidth());
        webRow.addView(BridgeUi.spacer(this));
        webRow.addView(reloadButton, BridgeUi.weightedWidth());
        card.addView(webRow, BridgeUi.fullWidth(this));

        TextView deviceSectionLabel = BridgeUi.textBlock(this, 12, true);
        deviceSectionLabel.setText("Current device workspace");
        card.addView(deviceSectionLabel, BridgeUi.fullWidth(this));

        LinearLayout shortcutRow = BridgeUi.horizontalRow(this);
        Button loginButton = BridgeUi.smallButton(this, "Login", "#0f766e", Color.WHITE);
        loginButton.setOnClickListener(v -> loadDashboardPath(PATH_LOGIN));
        Button dashboardButton = BridgeUi.smallButton(this, "Device Home", "#0d6efd", Color.WHITE);
        dashboardButton.setOnClickListener(v -> loadDashboardPath(PATH_DEVICE_HOME));
        Button smsButton = BridgeUi.smallButton(this, "SMS", "#198754", Color.WHITE);
        smsButton.setOnClickListener(v -> loadDashboardPath(PATH_SMS));
        Button settingsButtonWeb = BridgeUi.smallButton(this, "Settings", "#111827", Color.WHITE);
        settingsButtonWeb.setOnClickListener(v -> loadDashboardPath(PATH_DEVICE_SETTINGS));
        shortcutRow.addView(dashboardButton, BridgeUi.weightedWidth());
        shortcutRow.addView(BridgeUi.spacer(this));
        shortcutRow.addView(smsButton, BridgeUi.weightedWidth());
        shortcutRow.addView(BridgeUi.spacer(this));
        shortcutRow.addView(settingsButtonWeb, BridgeUi.weightedWidth());
        card.addView(shortcutRow, BridgeUi.fullWidth(this));

        LinearLayout shortcutRowTwo = BridgeUi.horizontalRow(this);
        Button aboutButton = BridgeUi.smallButton(this, "About", "#e2e8f0", Color.parseColor("#0f172a"));
        aboutButton.setOnClickListener(v -> loadDashboardPath(PATH_DEVICE_ABOUT));
        Button queueButton = BridgeUi.smallButton(this, "Queue", "#e2e8f0", Color.parseColor("#0f172a"));
        queueButton.setOnClickListener(v -> loadDashboardPath(PATH_DEVICE_QUEUE));
        Button capabilitiesButton = BridgeUi.smallButton(this, "Capabilities", "#e2e8f0", Color.parseColor("#0f172a"));
        capabilitiesButton.setOnClickListener(v -> loadDashboardPath(PATH_DEVICE_CAPABILITIES));
        shortcutRowTwo.addView(aboutButton, BridgeUi.weightedWidth());
        shortcutRowTwo.addView(BridgeUi.spacer(this));
        shortcutRowTwo.addView(queueButton, BridgeUi.weightedWidth());
        shortcutRowTwo.addView(BridgeUi.spacer(this));
        shortcutRowTwo.addView(capabilitiesButton, BridgeUi.weightedWidth());
        card.addView(shortcutRowTwo, BridgeUi.fullWidth(this));

        TextView platformSectionLabel = BridgeUi.textBlock(this, 12, true);
        platformSectionLabel.setText("Platform pages");
        card.addView(platformSectionLabel, BridgeUi.fullWidth(this));

        LinearLayout shortcutRowThree = BridgeUi.horizontalRow(this);
        Button loginButtonPlatform = BridgeUi.smallButton(this, "Login", "#0f766e", Color.WHITE);
        loginButtonPlatform.setOnClickListener(v -> loadDashboardPath(PATH_LOGIN));
        Button devicesButton = BridgeUi.smallButton(this, "Device List", "#e2e8f0", Color.parseColor("#0f172a"));
        devicesButton.setOnClickListener(v -> loadDashboardPath(PATH_DEVICES));
        Button packagesButton = BridgeUi.smallButton(this, "Packages", "#e2e8f0", Color.parseColor("#0f172a"));
        packagesButton.setOnClickListener(v -> loadDashboardPath(PATH_PACKAGES));
        shortcutRowThree.addView(loginButtonPlatform, BridgeUi.weightedWidth());
        shortcutRowThree.addView(BridgeUi.spacer(this));
        shortcutRowThree.addView(devicesButton, BridgeUi.weightedWidth());
        shortcutRowThree.addView(BridgeUi.spacer(this));
        shortcutRowThree.addView(packagesButton, BridgeUi.weightedWidth());
        card.addView(shortcutRowThree, BridgeUi.fullWidth(this));

        LinearLayout externalRow = BridgeUi.horizontalRow(this);
        Button openExternalButton = BridgeUi.smallButton(this, "Open In Browser", "#0f766e", Color.WHITE);
        openExternalButton.setOnClickListener(v -> openExternalDashboard());
        Button resetSessionButton = BridgeUi.smallButton(this, "Reset Web Session", "#dc2626", Color.WHITE);
        resetSessionButton.setOnClickListener(v -> resetDashboardSession());
        externalRow.addView(openExternalButton, BridgeUi.weightedWidth());
        externalRow.addView(BridgeUi.spacer(this));
        externalRow.addView(resetSessionButton, BridgeUi.weightedWidth());
        card.addView(externalRow, BridgeUi.fullWidth(this));

        TextView androidSupportLabel = BridgeUi.textBlock(this, 12, true);
        androidSupportLabel.setText("Android support");
        card.addView(androidSupportLabel, BridgeUi.fullWidth(this));

        LinearLayout androidSupportRow = BridgeUi.horizontalRow(this);
        Button appSettingsButton = BridgeUi.smallButton(this, "App Settings", "#e2e8f0", Color.parseColor("#0f172a"));
        appSettingsButton.setOnClickListener(v -> BridgePermissionHelper.openAppSettings(this));
        Button onboardingButton = BridgeUi.smallButton(this, "Onboarding", "#e2e8f0", Color.parseColor("#0f172a"));
        onboardingButton.setOnClickListener(v -> startActivity(new Intent(this, OnboardingActivity.class)));
        androidSupportRow.addView(appSettingsButton, BridgeUi.weightedWidth());
        androidSupportRow.addView(BridgeUi.spacer(this));
        androidSupportRow.addView(onboardingButton, BridgeUi.weightedWidth());
        card.addView(androidSupportRow, BridgeUi.fullWidth(this));

        supportText = BridgeUi.textBlock(this, 12, false);
        card.addView(supportText, BridgeUi.fullWidth(this));
        scopeText = BridgeUi.textBlock(this, 12, false);
        card.addView(scopeText, BridgeUi.fullWidth(this));
        deviceText = BridgeUi.textBlock(this, 12, false);
        card.addView(deviceText, BridgeUi.fullWidth(this));
        locationText = BridgeUi.textBlock(this, 12, false);
        card.addView(locationText, BridgeUi.fullWidth(this));
        return card;
    }

    private View buildWebCard() {
        LinearLayout card = BridgeUi.sectionCard(this, "Browser", "");

        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);
        progressBar.setProgress(0);
        card.addView(progressBar, BridgeUi.fullWidth(this));

        helperText = BridgeUi.textBlock(this, 12, false);
        helperText.setText("Loading dashboard wrapper...");
        card.addView(helperText, BridgeUi.fullWidth(this));

        webView = new WebView(this);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                BridgeUi.dp(this, 560)
        );
        webView.setLayoutParams(params);
        configureWebView(webView);
        card.addView(webView);
        return card;
    }

    private void configureWebView(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setSupportZoom(true);
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, true);

        view.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                persistCurrentUrl(url);
                updateChrome();
            }
        });

        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                if (progressBar != null) {
                    progressBar.setProgress(newProgress);
                }
                updateChrome();
            }
        });
    }

    private void loadDashboard() {
        dashboardUrl = resolveDashboardUrl();
        if (dashboardUrl.isEmpty()) {
            if (helperText != null) {
                helperText.setText("Dashboard URL is not configured yet. Set the server URL in Settings or import a setup code first.");
            }
            if (locationText != null) {
                locationText.setText("Location: not configured");
            }
            if (webView != null) {
                webView.loadData(
                        "<html><body style='font-family:sans-serif;padding:24px;background:#eef3f8;color:#0f172a;'><h3>Dashboard URL Missing</h3><p>Open Settings and set the Device Bridge server URL, then return here.</p></body></html>",
                        "text/html",
                        "utf-8"
                );
            }
            updateChrome();
            return;
        }

        if (helperText != null) {
            helperText.setText("The dashboard is running inside the app wrapper.");
        }
        if (webView != null) {
            webView.loadUrl(resolveStartupUrl());
        }
        updateChrome();
    }

    private void loadDashboardPath(String path) {
        String target = buildDashboardPathUrl(path);
        if (target.isEmpty()) {
            loadDashboard();
            return;
        }
        if (webView != null) {
            webView.loadUrl(target);
        }
    }

    private void updateChrome() {
        BridgeConfig config = BridgeConfig.load(this);
        if (supportText != null) {
            supportText.setText(
                    "Dashboard access: " + config.hasDashboardAccess()
                            + "\nPermission center:\n" + BridgePermissionHelper.buildSummary(this, true)
            );
        }
        if (scopeText != null) {
            String transportLabel = "http".equals(config.transportMode) ? "HTTP API" : "MQTT";
            String serverUrl = resolveBaseServerUrl();
            scopeText.setText("Scope: " + transportLabel + " | " + (serverUrl.isEmpty() ? "server missing" : serverUrl));
        }
        if (deviceText != null) {
            String deviceId = resolveCurrentDeviceId();
            deviceText.setText("Device: " + (deviceId.isEmpty() ? "not configured" : deviceId));
        }
        if (locationText != null) {
            String current = webView != null ? webView.getUrl() : "";
            String normalizedCurrent = normalizeDashboardUrlForCurrentDevice(current);
            locationText.setText("Location: " + (normalizedCurrent.isEmpty() ? dashboardUrl : normalizedCurrent));
        }
        if (backButton != null) {
            backButton.setEnabled(webView != null && webView.canGoBack());
        }
        if (forwardButton != null) {
            forwardButton.setEnabled(webView != null && webView.canGoForward());
        }
    }

    private void openExternalDashboard() {
        String url = resolveStartupUrl();
        if (url.isEmpty()) {
            BridgeEventLog.append(this, "Dashboard browser open skipped: missing URL");
            return;
        }
        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
    }

    private void resetDashboardSession() {
        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.removeAllCookies(null);
        cookieManager.flush();
        prefs().edit().remove(PREF_LAST_DASHBOARD_URL).apply();
        BridgeEventLog.append(this, "Dashboard web session cleared");
        if (helperText != null) {
            helperText.setText("Dashboard cookies and remembered location were cleared. Login again if needed.");
        }
        loadDashboardPath(PATH_LOGIN);
    }

    private String resolveStartupUrl() {
        String requested = String.valueOf(getIntent() == null ? "" : getIntent().getStringExtra(EXTRA_DASHBOARD_PATH)).trim();
        if (!requested.isEmpty()) {
            return buildDashboardPathUrl(requested);
        }
        String remembered = loadRememberedUrl();
        return remembered.isEmpty() ? dashboardUrl : normalizeDashboardUrlForCurrentDevice(remembered);
    }

    private String buildDashboardPathUrl(String path) {
        String base = resolveBaseServerUrl();
        String normalizedPath = String.valueOf(path == null ? "" : path).trim();
        if (base.isEmpty()) {
            return "";
        }
        if (normalizedPath.isEmpty()) {
            return resolveDashboardUrl();
        }
        if (!normalizedPath.startsWith("/")) {
            normalizedPath = "/" + normalizedPath;
        }
        return normalizeDashboardUrlForCurrentDevice(base + normalizedPath);
    }

    private String resolveBaseServerUrl() {
        BridgeConfig config = BridgeConfig.load(this);
        String base = String.valueOf(config.serverUrl == null ? "" : config.serverUrl).trim();
        if (base.endsWith("/")) {
            return base.substring(0, base.length() - 1);
        }
        return base;
    }

    private void persistCurrentUrl(String url) {
        String candidate = normalizeDashboardUrlForCurrentDevice(url);
        String base = resolveBaseServerUrl();
        if (candidate.isEmpty() || base.isEmpty() || !candidate.startsWith(base)) {
            return;
        }
        prefs().edit().putString(PREF_LAST_DASHBOARD_URL, candidate).apply();
    }

    private String loadRememberedUrl() {
        String base = resolveBaseServerUrl();
        String remembered = prefs().getString(PREF_LAST_DASHBOARD_URL, "");
        if (remembered == null || remembered.trim().isEmpty()) {
            return "";
        }
        remembered = remembered.trim();
        remembered = normalizeDashboardUrlForCurrentDevice(remembered);
        return remembered.startsWith(base) ? remembered : "";
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(BridgeConfig.PREFS, MODE_PRIVATE);
    }

    private String resolveDashboardUrl() {
        String base = resolveBaseServerUrl();
        if (base.isEmpty()) {
            return "";
        }
        if (base.endsWith("/dashboard")) {
            return normalizeDashboardUrlForCurrentDevice(base);
        }
        if (base.endsWith("/")) {
            return normalizeDashboardUrlForCurrentDevice(base + "dashboard");
        }
        return normalizeDashboardUrlForCurrentDevice(base + "/dashboard");
    }

    private String normalizeDashboardUrlForCurrentDevice(String url) {
        String candidate = String.valueOf(url == null ? "" : url).trim();
        if (candidate.isEmpty()) {
            return "";
        }

        Uri parsed = null;
        String pathOnly = candidate;
        try {
            parsed = Uri.parse(candidate);
            pathOnly = parsed.getPath();
        } catch (Exception ignored) {
            pathOnly = candidate;
        }

        if (!isDeviceScopedPath(pathOnly)) {
            return candidate;
        }

        String deviceId = resolveCurrentDeviceId();
        if (deviceId.isEmpty()) {
            return candidate;
        }

        if (parsed == null) {
            char separator = candidate.contains("?") ? '&' : '?';
            return candidate.contains("device=")
                    ? candidate.replaceAll("([?&])device=[^&]*", "$1" + EXTRA_DEVICE_ID + "=" + Uri.encode(deviceId))
                    : candidate + separator + EXTRA_DEVICE_ID + "=" + Uri.encode(deviceId);
        }

        Uri.Builder builder = parsed.buildUpon().clearQuery();
        boolean replaced = false;
        for (String name : parsed.getQueryParameterNames()) {
            if (EXTRA_DEVICE_ID.equals(name)) {
                builder.appendQueryParameter(name, deviceId);
                replaced = true;
                continue;
            }
            for (String value : parsed.getQueryParameters(name)) {
                builder.appendQueryParameter(name, value);
            }
        }
        if (!replaced) {
            builder.appendQueryParameter(EXTRA_DEVICE_ID, deviceId);
        }
        return builder.build().toString();
    }

    private String resolveCurrentDeviceId() {
        return String.valueOf(BridgeConfig.load(this).deviceId == null ? "" : BridgeConfig.load(this).deviceId).trim();
    }

    private boolean isDeviceScopedPath(String path) {
        String normalized = String.valueOf(path == null ? "" : path).trim();
        return normalized.startsWith("/dashboard")
                || normalized.startsWith("/sms")
                || normalized.startsWith("/calls")
                || normalized.startsWith("/contacts")
                || normalized.startsWith("/ussd")
                || normalized.startsWith("/modem")
                || normalized.startsWith("/devices/settings")
                || normalized.startsWith("/devices/about")
                || normalized.startsWith("/devices/queue")
                || normalized.startsWith("/devices/capabilities")
                || normalized.startsWith("/devices")
                || normalized.startsWith("/automation")
                || normalized.startsWith("/test");
    }

    static Intent createIntent(Activity activity, String dashboardPath) {
        Intent intent = new Intent(activity, DashboardWebActivity.class);
        if (dashboardPath != null && !dashboardPath.trim().isEmpty()) {
            intent.putExtra(EXTRA_DASHBOARD_PATH, dashboardPath.trim());
        }
        return intent;
    }

    static Intent createDeviceHomeIntent(Activity activity) {
        return createIntent(activity, PATH_DEVICE_HOME);
    }

    static Intent createSmsIntent(Activity activity) {
        return createIntent(activity, PATH_SMS);
    }

    static Intent createCallsIntent(Activity activity) {
        return createIntent(activity, PATH_CALLS);
    }

    static Intent createUssdIntent(Activity activity) {
        return createIntent(activity, PATH_USSD);
    }

    static Intent createContactsIntent(Activity activity) {
        return createIntent(activity, PATH_CONTACTS);
    }

    static Intent createDeviceSettingsIntent(Activity activity) {
        return createIntent(activity, PATH_DEVICE_SETTINGS);
    }

    static Intent createDeviceCapabilitiesIntent(Activity activity) {
        return createIntent(activity, PATH_DEVICE_CAPABILITIES);
    }

    static Intent createDeviceQueueIntent(Activity activity) {
        return createIntent(activity, PATH_DEVICE_QUEUE);
    }

    static Intent createLoginIntent(Activity activity) {
        return createIntent(activity, PATH_LOGIN);
    }

    static Intent createDevicesIntent(Activity activity) {
        return createIntent(activity, PATH_DEVICES);
    }

    static Intent createPackagesIntent(Activity activity) {
        return createIntent(activity, PATH_PACKAGES);
    }
}


