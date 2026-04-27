package com.devicebridge.android;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DatePickerDialog;
import android.app.Dialog;
import android.app.TimePickerDialog;
import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.CallLog;
import android.provider.Settings;
import android.provider.ContactsContract;
import android.telephony.SubscriptionInfo;
import android.telephony.SubscriptionManager;
import android.text.Editable;
import android.text.InputType;
import android.text.TextUtils;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.inputmethod.InputMethodManager;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.content.ContextCompat;

import com.google.zxing.BarcodeFormat;
import com.journeyapps.barcodescanner.BarcodeCallback;
import com.journeyapps.barcodescanner.BarcodeResult;
import com.journeyapps.barcodescanner.DecoratedBarcodeView;
import com.journeyapps.barcodescanner.DefaultDecoderFactory;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Calendar;
import java.util.Collections;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

public class HomeActivity extends Activity {
    private static final String EXTRA_SETUP_TOKEN = "setup_token";
    private static final String EXTRA_START_TAB = "start_tab";
    private static final int TAB_HOME = 0;
    private static final int TAB_SMS = 1;
    private static final int TAB_CONTACTS = 2;
    private static final int TAB_PHONE = 3;
    private static final int[] TAB_NAV_ORDER = new int[]{TAB_HOME, TAB_SMS, TAB_PHONE, TAB_CONTACTS};
    private static final int REQ_QR_SCAN = 4811;
    private static final int REQ_CORE_PERMISSIONS = 4821;
    private static final int REQ_CALL_PERMISSIONS = 4812;
    private static final int REQ_QR_PERMISSIONS = 4813;
    private static final int REQ_WEBCAM_PERMISSIONS = 4814;
    private static final int REQ_INTERCOM_PERMISSIONS = 4815;
    private static final int REQ_SMS_INBOX_PERMISSIONS = 4816;
    private static final int REQ_CONTACTS_PERMISSION = 4817;
    private static final int REQ_SMS_TEMPLATE_FILE = 4818;

    private static final long IDLE_REFRESH_MS = 18_000L;
    private static final long CALL_REFRESH_MS = 4_000L;
    private static final long SMS_REFRESH_MS = 45_000L;
    private static final long SETUP_POLL_MS = 900L;

    private interface ValueCallback {
        void onValue(String value);
    }

    private interface ContactCallback {
        void onContact(String name, String number);
    }

    private interface ViewFactory {
        View create();
    }

    private interface StringFactory {
        String get();
    }

    private static final class InsightTab {
        final String label;
        final ViewFactory factory;

        InsightTab(String label, ViewFactory factory) {
            this.label = label;
            this.factory = factory;
        }
    }

    private static final class InsightBar {
        final String label;
        final int value;
        final String color;

        InsightBar(String label, int value, String color) {
            this.label = label;
            this.value = value;
            this.color = color;
        }
    }

    private static final class ContactInfo {
        final String name;
        final String number;
        final String avatar;
        final boolean matched;

        ContactInfo(String name, String number, String avatar, boolean matched) {
            this.name = name == null ? "" : name;
            this.number = number == null ? "" : number;
            this.avatar = avatar == null || avatar.trim().isEmpty() ? "?" : avatar;
            this.matched = matched;
        }
    }

    private static final class RecentCallItem {
        final String name;
        final String number;
        final int type;
        final long date;
        final long durationSeconds;

        RecentCallItem(String name, String number, int type, long date, long durationSeconds) {
            this.name = name == null ? "" : name;
            this.number = number == null ? "" : number;
            this.type = type;
            this.date = date;
            this.durationSeconds = durationSeconds;
        }
    }

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable refreshRunnable = new Runnable() {
        @Override
        public void run() {
            loadState(true);
            scheduleRefresh();
        }
    };
    private final Runnable setupPollRunnable = new Runnable() {
        @Override
        public void run() {
            setupPollAttempts += 1;
            loadState(true);
            if (boolValue(state.get("online"))) {
                connectingFromSetup = false;
                showSetupSurface = false;
                setupStatus = "";
                rebuild();
                maybePromptBatteryOptimization();
                return;
            }
            if (setupPollAttempts >= 18) {
                connectingFromSetup = false;
                showSetupSurface = true;
                setupStatus = "Still connecting. Check signal and retry.";
                rebuild();
                return;
            }
            handler.postDelayed(this, SETUP_POLL_MS);
        }
    };

    private final BroadcastReceiver bridgeEventReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent != null && BridgeAppEvents.ACTION_STATE_CHANGED.equals(intent.getAction())) {
                handler.removeCallbacks(refreshRunnable);
                handler.postDelayed(() -> loadState(true), 280L);
            }
        }
    };

    private Map<String, Object> state = new HashMap<>();
    private List<Map<String, Object>> smsThreads = new ArrayList<>();
    private List<Map<String, Object>> smsMessages = new ArrayList<>();
    private List<Map<String, Object>> dashboardDevices = new ArrayList<>();
    private List<Map<String, Object>> dashboardSims = new ArrayList<>();
    private List<Map<String, Object>> dashboardCallLog = new ArrayList<>();
    private List<Map<String, String>> dashboardContacts = new ArrayList<>();
    private List<Map<String, String>> deviceContacts = new ArrayList<>();
    private Map<String, Object> selectedSmsThread;
    private final Map<String, ContactInfo> smsContactCache = new HashMap<>();
    private final Set<String> selectedSmsThreadKeys = new HashSet<>();
    private DecoratedBarcodeView setupBarcodeView;
    private String pendingSetupToken = "";
    private String setupStatus = "";
    private String setupProgress = "Preparing bridge...";
    private String consoleQuery = "";
    private String consoleLevelFilter = "all";
    private String consoleCategoryFilter = "all";
    private String smsSearchQuery = "";
    private String selectedCommunicationDeviceId = "";
    private String selectedCommunicationDeviceName = "";
    private String lastContactQuery = "";
    private String lastDeviceContactQuery = "";
    private String newSmsContactQuery = "";
    private String newSmsRecipientName = "";
    private String newSmsRecipientNumber = "";
    private final List<ContactInfo> newSmsRecipients = new ArrayList<>();
    private String smsTemplateImportTargetNumber = "";
    private int selectedTabIndex = 0;
    private int selectedSmsSimSlot = -1;
    private int selectedCommunicationSimSlot = -1;
    private int setupPollAttempts = 0;
    private long lastBackPressMs;
    private float touchStartX;
    private float touchStartY;
    private long touchStartAt;
    private boolean touchStartedInHorizontalScroll;
    private boolean showSetupSurface;
    private boolean connectingFromSetup;
    private boolean busy;
    private boolean smsLoading;
    private boolean devicesLoading;
    private boolean callLogLoading;
    private boolean contactsLoading;
    private boolean deviceContactsLoading;
    private boolean deviceContactsLoaded;
    private boolean smsSending;
    private boolean smsBulkMode;
    private boolean composingNewSms;
    private boolean newSmsContactSearchFocused;
    private boolean reopenNewConversationAfterContactsPermission;
    private boolean checkedPendingSetupCode;
    private boolean batteryPromptShown;
    private boolean eventReceiverRegistered;
    private boolean localQueueProcessing;
    private boolean pendingLauncherSelfSmsTest;
    private boolean smsConversationScrollToBottomOnNextBuild;
    private boolean setupScanDelivered;
    private int smsConversationScrollY;
    private final Map<String, Long> guardedActionTimes = new HashMap<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        capturePendingSetupToken(getIntent());
        applyRequestedTab(getIntent());
        captureLauncherSelfSmsTest(getIntent());
        loadState(false);
        consumePendingSetupCodeIfNeeded(false);
        rebuild();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        capturePendingSetupToken(intent);
        applyRequestedTab(intent);
        captureLauncherSelfSmsTest(intent);
        consumePendingSetupCodeIfNeeded(true);
    }

    @Override
    protected void onResume() {
        super.onResume();
        registerBridgeEventReceiverIfNeeded();
        if (setupBarcodeView != null) {
            setupBarcodeView.resume();
        }
        loadState(true);
        maybeRunLauncherSelfSmsTest();
        scheduleRefresh();
    }

    @Override
    protected void onPause() {
        handler.removeCallbacks(refreshRunnable);
        if (setupBarcodeView != null) {
            setupBarcodeView.pause();
        }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacks(refreshRunnable);
        handler.removeCallbacks(setupPollRunnable);
        stopSetupScanner();
        unregisterBridgeEventReceiverIfNeeded();
        super.onDestroy();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_SMS_TEMPLATE_FILE) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                importSmsTemplateFile(data.getData());
            }
            return;
        }
        if (requestCode != REQ_QR_SCAN) {
            return;
        }
        String scanned = data == null ? "" : data.getStringExtra(BridgeQrScannerActivity.EXTRA_SCAN_RESULT);
        String normalized = safe(scanned).trim();
        if (normalized.isEmpty()) {
            showSetupSurface = true;
            setupStatus = "QR scan cancelled.";
            rebuild();
            return;
        }
        importSetupCode(normalized, "Importing QR setup...", true);
    }

    @Override
    public void onBackPressed() {
        handleBackNavigation();
    }

    private void handleBackNavigation() {
        boolean needsOnboarding = boolValue(state.get("needsOnboarding"));
        if (showSetupSurface && !needsOnboarding) {
            showSetupSurface = false;
            lastBackPressMs = 0L;
            rebuild();
            return;
        }
        if (composingNewSms) {
            composingNewSms = false;
            clearNewSmsDraft();
            lastBackPressMs = 0L;
            rebuild();
            return;
        }
        if (selectedSmsThread != null) {
            selectedSmsThread = null;
            smsMessages = new ArrayList<>();
            lastBackPressMs = 0L;
            rebuild();
            return;
        }
        if (selectedTabIndex != TAB_HOME) {
            lastBackPressMs = 0L;
            selectTab(TAB_HOME);
            return;
        }
        long now = System.currentTimeMillis();
        if (now - lastBackPressMs < 1600L) {
            finish();
            return;
        }
        lastBackPressMs = now;
        showSnack("Press back again to exit");
    }

    private void captureLauncherSelfSmsTest(Intent intent) {
        if (intent == null) {
            return;
        }
        if (intent.getBooleanExtra(MainActivity.EXTRA_RUN_SELF_SMS_TEST, false)) {
            pendingLauncherSelfSmsTest = true;
            intent.removeExtra(MainActivity.EXTRA_RUN_SELF_SMS_TEST);
        }
    }

    private void maybeRunLauncherSelfSmsTest() {
        if (!pendingLauncherSelfSmsTest) {
            return;
        }
        pendingLauncherSelfSmsTest = false;
        BridgeTestLab.runSelfSendTest(this, (title, detail) -> {
            BridgeEventLog.append(this, title + ": " + detail);
            showSnack(title + ": " + detail);
            loadState(true);
        });
    }

    @Override
    public boolean dispatchTouchEvent(MotionEvent event) {
        if (event != null) {
            if (event.getAction() == MotionEvent.ACTION_DOWN) {
                touchStartX = event.getX();
                touchStartY = event.getY();
                touchStartAt = System.currentTimeMillis();
                touchStartedInHorizontalScroll = isTouchInsideHorizontalScroll(getWindow().getDecorView(), (int) event.getRawX(), (int) event.getRawY());
            } else if (event.getAction() == MotionEvent.ACTION_UP) {
                if (!touchStartedInHorizontalScroll && handleHorizontalSwipe(event.getX() - touchStartX, event.getY() - touchStartY, System.currentTimeMillis() - touchStartAt)) {
                    return true;
                }
                touchStartedInHorizontalScroll = false;
            } else if (event.getAction() == MotionEvent.ACTION_CANCEL) {
                touchStartedInHorizontalScroll = false;
            }
        }
        return super.dispatchTouchEvent(event);
    }

    private boolean isTouchInsideHorizontalScroll(View view, int rawX, int rawY) {
        if (view == null || view.getVisibility() != View.VISIBLE) {
            return false;
        }
        Rect bounds = new Rect();
        if (!view.getGlobalVisibleRect(bounds) || !bounds.contains(rawX, rawY)) {
            return false;
        }
        if (view instanceof HorizontalScrollView) {
            return true;
        }
        if (!(view instanceof ViewGroup)) {
            return false;
        }
        ViewGroup group = (ViewGroup) view;
        for (int i = group.getChildCount() - 1; i >= 0; i -= 1) {
            if (isTouchInsideHorizontalScroll(group.getChildAt(i), rawX, rawY)) {
                return true;
            }
        }
        return false;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        loadState(true);
        boolean shouldSyncDeviceHistory = false;
        if (requestCode == REQ_CORE_PERMISSIONS && BridgePermissionHelper.hasCore(this)) {
            shouldSyncDeviceHistory = true;
        }
        if (requestCode == REQ_QR_PERMISSIONS && BridgePermissionHelper.hasQrFeature(this)) {
            setupScanDelivered = false;
            showSetupSurface = true;
            rebuild();
            return;
        }
        if (requestCode == REQ_SMS_INBOX_PERMISSIONS && BridgePermissionHelper.hasSmsInboxFeature(this)) {
            loadSmsThreads();
            selectedTabIndex = 1;
            shouldSyncDeviceHistory = true;
        }
        if (requestCode == REQ_CALL_PERMISSIONS && BridgePermissionHelper.hasCallFeature(this)) {
            shouldSyncDeviceHistory = true;
        }
        if (requestCode == REQ_CONTACTS_PERMISSION && hasContactsPermission()) {
            smsContactCache.clear();
            loadDeviceContacts(lastContactQuery, false);
            if (reopenNewConversationAfterContactsPermission) {
                reopenNewConversationAfterContactsPermission = false;
                composingNewSms = true;
                if (shouldSyncDeviceHistory) {
                    MqttBridgeService.requestSilentBulkSync(this);
                }
                rebuild();
                return;
            }
            if (shouldSyncDeviceHistory) {
                MqttBridgeService.requestSilentBulkSync(this);
            }
            rebuild();
            return;
        }
        if (shouldSyncDeviceHistory) {
            MqttBridgeService.requestSilentBulkSync(this);
        }
        rebuild();
    }

    private void loadState(boolean rebuildAfter) {
        if (!BridgeAppGate.routeFromStartup(this)) {
            ensureBridgeOnline();
        }
        state = buildNativeState();
        ensureSelectedCommunicationDevice();
        loadDeviceInventory(false);
        if (selectedTabIndex == TAB_SMS && selectedSmsThread == null) {
            loadSmsThreads();
        } else if (selectedTabIndex == TAB_SMS && selectedSmsThread != null) {
            loadSmsMessages(stringValue(selectedSmsThread.get("threadKey")));
        } else if (selectedTabIndex == TAB_PHONE) {
            loadDashboardCallLog(false);
        } else if (selectedTabIndex == TAB_CONTACTS) {
            loadDeviceContacts(lastContactQuery, false);
            loadDashboardContacts(lastContactQuery, false);
        }
        if (rebuildAfter) {
            rebuild();
        }
    }

    private Map<String, Object> buildNativeState() {
        Map<String, Object> next = new HashMap<>(BridgeSnapshotProvider.buildDashboardState(this));
        next.put("permissionsReady", BridgePermissionHelper.hasCore(this));
        next.put("callFeatureReady", BridgePermissionHelper.hasCallFeature(this));
        next.put("qrFeatureReady", BridgePermissionHelper.hasQrFeature(this));
        next.put("wifiFeatureReady", BridgePermissionHelper.hasWifiFeature(this));
        next.put("webcamFeatureReady", BridgePermissionHelper.hasWebcamFeature(this));
        next.put("intercomFeatureReady", BridgePermissionHelper.hasIntercomFeature(this));
        next.put("smsInboxReady", BridgePermissionHelper.hasSmsInboxFeature(this));
        next.put("batteryOptimizationDisabled", isBatteryOptimizationDisabled());
        next.put("connectionReady", BridgeAppGate.hasConnectionDetails(this));
        next.put("needsOnboarding", !BridgeAppGate.hasConnectionDetails(this));
        next.put("hasPendingSetupCode", !pendingSetupToken.trim().isEmpty());
        return next;
    }

    private void rebuild() {
        stopSetupScanner();
        setContentView(buildMainScreen());
    }

    private View buildMainScreen() {
        FrameLayout frame = new FrameLayout(this);
        frame.setBackgroundColor(color("#f2f5fa"));

        LinearLayout shell = new LinearLayout(this);
        shell.setOrientation(LinearLayout.VERTICAL);
        shell.setBackgroundColor(color("#f2f5fa"));

        if (selectedTabIndex == TAB_HOME) {
            LinearLayout topWrap = rootLayout(12, 8, 12, 0);
            topWrap.addView(pinnedTopBar(), fullWidth(8));
            shell.addView(topWrap);
            ScrollView scroll = new ScrollView(this);
            LinearLayout root = rootLayout(12, 0, 12, 16);
            scroll.addView(root);
            root.addView(overviewPanel(), fullWidth(12));
            root.addView(consoleCard(), fullWidth(0));
            shell.addView(scroll, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    0,
                    1f
            ));
        } else if (selectedTabIndex == TAB_SMS) {
            shell.addView(smsWorkspace(), new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    0,
                    1f
            ));
        } else if (selectedTabIndex == TAB_CONTACTS) {
            shell.addView(contactsWorkspace(), new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    0,
                    1f
            ));
        } else {
            shell.addView(phoneWorkspace(), new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    0,
                    1f
            ));
        }
        if (!(selectedTabIndex == TAB_SMS && (selectedSmsThread != null || composingNewSms))) {
            shell.addView(bottomNavigation(), new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
            ));
        }
        frame.addView(shell);
        if (showSetupSurface || boolValue(state.get("needsOnboarding"))) {
            frame.addView(buildSetupOverlay(), overlayParams());
        }
        if (busy || smsSending) {
            frame.addView(busyBar(smsSending ? "Sending..." : "Working..."), busyBarParams());
        }
        return frame;
    }

    private View buildSetupOverlay() {
        FrameLayout shade = new FrameLayout(this);
        shade.setBackgroundColor(Color.argb(120, 15, 23, 42));
        shade.setClickable(true);
        shade.setFocusable(true);

        LinearLayout sheet = card(16, 24);
        sheet.setBackground(roundRect("#ffffff", "#ffffff", 24));

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        copy.addView(text("Onboard Device", 18, "#0f172a", true));
        copy.addView(text("Scan the dashboard QR to connect this phone.", 12, "#64748b", false));
        header.addView(copy, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        if (!boolValue(state.get("needsOnboarding")) && !connectingFromSetup) {
            header.addView(iconAction(R.drawable.ic_db_close, "#f8fafc", "#0f172a", () -> {
                showSetupSurface = false;
                rebuild();
            }));
        }
        sheet.addView(header, fullWidth(12));

        if (!setupStatus.trim().isEmpty()) {
            sheet.addView(statusBanner(setupStatus), fullWidth(10));
        }

        if (connectingFromSetup) {
            sheet.addView(setupProgressCard());
        } else if (BridgePermissionHelper.hasQrFeature(this)) {
            sheet.addView(setupScannerCard(), fullWidth(10));
            sheet.addView(labelIconButton("Manual setup", R.drawable.ic_db_key, "#f8fafc", "#0f172a", this::showPasteCodeDialog), fullWidth(0));
        } else {
            LinearLayout qr = new LinearLayout(this);
            qr.setOrientation(LinearLayout.VERTICAL);
            qr.setGravity(Gravity.CENTER);
            qr.setPadding(dp(18), dp(18), dp(18), dp(18));
            qr.setBackground(softTint("#0b5ed7", 22));
            qr.setClickable(true);
            qr.setFocusable(true);
            qr.setOnClickListener(v -> runGuarded("setup:scan-qr", this::openQrScannerFlow));
            qr.addView(iconTile(R.drawable.ic_db_qr, "#0b5ed7", 82, 24, 44), fixed(82, 82, 0));
            TextView scan = text("Scan QR", 19, "#0f172a", true);
            scan.setGravity(Gravity.CENTER);
            qr.addView(scan, fullWidth(4));
            TextView hint = text(boolValue(state.get("qrFeatureReady")) ? "Camera ready" : "Camera permission opens next", 12, "#475569", false);
            hint.setGravity(Gravity.CENTER);
            qr.addView(hint);
            sheet.addView(qr, fullWidth(10));

            sheet.addView(labelIconButton("Manual setup", R.drawable.ic_db_key, "#f8fafc", "#0f172a", this::showPasteCodeDialog), fullWidth(0));
        }

        shade.addView(sheet, centeredModalParams());
        return shade;
    }

    private View setupScannerCard() {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(10), dp(10), dp(10), dp(10));
        card.setBackground(roundRect("#0f172a", "#1e293b", 22));

        setupBarcodeView = new DecoratedBarcodeView(this);
        setupBarcodeView.getBarcodeView().setDecoderFactory(new DefaultDecoderFactory(Collections.singletonList(BarcodeFormat.QR_CODE)));
        setupBarcodeView.setStatusText("Scanning for Device Bridge QR");
        setupBarcodeView.decodeContinuous(setupBarcodeCallback);
        setupBarcodeView.resume();
        card.addView(setupBarcodeView, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(300)));

        TextView hint = text("Point the camera at the dashboard QR.", 12, "#cbd5e1", false);
        hint.setGravity(Gravity.CENTER);
        hint.setPadding(0, dp(8), 0, 0);
        card.addView(hint, fullWidth(0));
        return card;
    }

    private final BarcodeCallback setupBarcodeCallback = new BarcodeCallback() {
        @Override
        public void barcodeResult(BarcodeResult result) {
            if (setupScanDelivered || result == null || result.getText() == null || result.getText().trim().isEmpty()) {
                return;
            }
            setupScanDelivered = true;
            if (setupBarcodeView != null) {
                setupBarcodeView.pause();
            }
            runOnUiThread(() -> importSetupCode(result.getText().trim(), "Importing QR setup...", true));
        }
    };

    private void stopSetupScanner() {
        if (setupBarcodeView != null) {
            try {
                setupBarcodeView.pause();
            } catch (RuntimeException ignored) {
            }
            setupBarcodeView = null;
        }
    }

    private FrameLayout.LayoutParams overlayParams() {
        return new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
    }

    private FrameLayout.LayoutParams centeredModalParams() {
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER
        );
        params.leftMargin = dp(18);
        params.rightMargin = dp(18);
        return params;
    }

    private View statusBanner(String message) {
        LinearLayout banner = new LinearLayout(this);
        banner.setOrientation(LinearLayout.HORIZONTAL);
        banner.setGravity(Gravity.CENTER_VERTICAL);
        banner.setPadding(dp(14), dp(12), dp(14), dp(12));
        banner.setBackground(roundRect("#fffbeb", "#fde68a", 18));
        TextView icon = text("i", 15, "#b45309", true);
        icon.setGravity(Gravity.CENTER);
        banner.addView(icon, fixed(24, 24, 10));
        banner.addView(text(message, 12, "#92400e", true), new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        return banner;
    }

    private View setupProgressCard() {
        LinearLayout card = card(16, 22);
        card.setBackground(roundRect("#0f172a", "#1e293b", 22));

        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        View dot = new View(this);
        dot.setBackground(roundRect("#60a5fa", "#60a5fa", 999));
        row.addView(dot, fixed(12, 12, 10));
        row.addView(text("Connecting", 16, "#ffffff", true));
        card.addView(row, fullWidth(12));
        card.addView(text(setupProgress, 13, "#e2e8f0", false), fullWidth(12));
        ProgressBar progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setIndeterminate(true);
        card.addView(progress, fullWidth(12));
        String device = stringValue(state.get("deviceId"));
        String target = connectionTarget();
        TextView mono = text(
                "device   = " + (device.isEmpty() ? "pending" : device)
                        + "\ntarget   = " + (target.isEmpty() ? "resolving" : target)
                        + "\nnext     = open dashboard",
                12,
                "#cbd5e1",
                false
        );
        mono.setTypeface(Typeface.MONOSPACE);
        card.addView(mono);
        return card;
    }

    private View pinnedTopBar() {
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(dp(12), dp(9), dp(9), dp(9));
        bar.setBackground(roundRect("#ffffff", "#e2e8f0", 18));

        LinearLayout textCol = new LinearLayout(this);
        textCol.setOrientation(LinearLayout.VERTICAL);
        textCol.addView(text("Device Bridge", 15, "#0f172a", true));
        textCol.addView(text(stringValue(state.get("deviceId"), "Unconfigured device"), 11, "#64748b", false));
        bar.addView(textCol, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        bar.addView(labelIconButton("Menu", R.drawable.ic_db_tune, "#0f172a", "#ffffff", this::showSettingsSheet));
        return bar;
    }

    private View overviewPanel() {
        boolean online = boolValue(state.get("online"));
        String bridgeState = stringValue(state.get("bridgeState"), "Stopped");
        int readinessScore = intValue(state.get("readinessScore"));
        int batteryLevel = state.get("batteryLevel") == null ? -1 : intValue(state.get("batteryLevel"));
        String batteryStatus = stringValue(state.get("batteryStatus"), "Unknown");
        int queueDepth = intValue(state.get("queueDepth"));
        int publishSuccess = intValue(state.get("publishSuccess"));
        int publishFailure = intValue(state.get("publishFailure"));
        int total = Math.max(0, queueDepth + publishSuccess + publishFailure);
        int successRate = total <= 0 ? 0 : Math.round((publishSuccess * 100f) / total);

        LinearLayout panel = card(12, 22);
        panel.setBackground(gradient("#ffffff", "#f7faff", 22, "#e2e8f0"));

        LinearLayout status = new LinearLayout(this);
        status.setOrientation(LinearLayout.HORIZONTAL);
        status.setGravity(Gravity.CENTER_VERTICAL);
        status.setPadding(dp(12), dp(11), dp(12), dp(10));
        status.setBackground(roundRect("#f8fafc", "#e2e8f0", 18));
        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        String connectionStatus = connectionStatusLabel(online, bridgeState);
        copy.addView(text(connectionStatus, 15, "#0f172a", true));
        status.addView(copy, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        status.addView(pill(connectionStatus, connectionStatusBg(connectionStatus), connectionStatusFg(connectionStatus)));
        panel.addView(status, fullWidth(10));

        String callStatus = stringValue(state.get("callStatus"));
        if (!callStatus.isEmpty()) {
            panel.addView(callCard(callStatus), fullWidth(10));
        }

        LinearLayout metrics = new LinearLayout(this);
        metrics.setOrientation(LinearLayout.HORIZONTAL);
        metrics.addView(overviewMiniStat(
                R.drawable.ic_db_devices,
                "Connectivity",
                connectionStatus,
                "",
                connectionStatusAccent(connectionStatus),
                () -> showConnectivityDialog()
        ), weighted(8));
        metrics.addView(overviewMiniStat(
                R.drawable.ic_db_sync,
                "Queue",
                total <= 0 ? "No action backlog" : successRate + "% success",
                total <= 0 ? "Waiting for dashboard actions" : publishSuccess + " sent / " + queueDepth + " pending / " + publishFailure + " failed",
                publishFailure > 0 ? "#dc2626" : queueDepth > 0 ? "#f59e0b" : "#16a34a",
                () -> showQueueDialog()
        ), weighted(0));
        panel.addView(metrics, fullWidth(8));

        View divider = new View(this);
        divider.setBackgroundColor(color("#e2e8f0"));
        panel.addView(divider, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1)));
        panel.addView(quickActionStrip(), fullWidth(0));
        return panel;
    }

    private View callCard(String status) {
        String normalized = status.toLowerCase(Locale.US);
        String accent = normalized.contains("ring") ? "#f59e0b" : normalized.contains("miss") ? "#64748b" : "#0f766e";
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.HORIZONTAL);
        card.setGravity(Gravity.CENTER_VERTICAL);
        card.setPadding(dp(10), dp(9), dp(10), dp(9));
        card.setBackground(softTint(accent, 16));
        card.addView(iconTile(R.drawable.ic_db_call, accent, 30, 10, 16), fixed(30, 30, 8));
        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        copy.addView(text("Call - " + capitalize(status), 12, "#0f172a", true));
        String hint = joinNonEmpty(capitalize(stringValue(state.get("callDirection"))), stringValue(state.get("callNumber")));
        if (!hint.isEmpty()) {
            copy.addView(text(hint, 11, "#64748b", false));
        }
        card.addView(copy, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        return card;
    }

    private View overviewMiniStat(int iconRes, String label, String value, String hint, String accent, Runnable onTap) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(10), dp(10), dp(10), dp(10));
        box.setBackground(softTint(accent, 18));
        box.setClickable(true);
        box.setFocusable(true);
        box.setOnClickListener(v -> runGuarded("overview:" + label, onTap));
        LinearLayout top = new LinearLayout(this);
        top.setGravity(Gravity.CENTER_VERTICAL);
        top.addView(iconTile(iconRes, accent, 26, 10, 14), fixed(26, 26, 6));
        top.addView(text(label, 10, "#475569", true), new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        top.addView(iconChip(R.drawable.ic_db_open, "#f8fafc", "#64748b", 24, 11));
        box.addView(top, fullWidth(7));
        box.addView(text(value, 13, "#0f172a", true), fullWidth(5));
        box.addView(progressTrack(accent), fullWidth(6));
        if (!safe(hint).trim().isEmpty()) {
            box.addView(text(hint, 10, "#64748b", false));
        }
        return box;
    }

    private String connectionStatusLabel(boolean online, String bridgeState) {
        if (online) {
            return "Connected";
        }
        String normalized = safe(bridgeState).toLowerCase(Locale.US);
        if (normalized.contains("connect")
                || normalized.contains("start")
                || normalized.contains("retry")
                || normalized.contains("reconnect")) {
            return "Connecting";
        }
        return "Disconnected";
    }

    private String connectionStatusAccent(String status) {
        if ("Connected".equals(status)) return "#16a34a";
        if ("Connecting".equals(status)) return "#f59e0b";
        return "#dc2626";
    }

    private String connectionStatusBg(String status) {
        if ("Connected".equals(status)) return "#dcfce7";
        if ("Connecting".equals(status)) return "#fff7ed";
        return "#fee2e2";
    }

    private String connectionStatusFg(String status) {
        if ("Connected".equals(status)) return "#166534";
        if ("Connecting".equals(status)) return "#9a3412";
        return "#991b1b";
    }

    private View quickActionStrip() {
        HorizontalScrollView scroll = new HorizontalScrollView(this);
        scroll.setHorizontalScrollBarEnabled(false);
        LinearLayout strip = new LinearLayout(this);
        strip.setOrientation(LinearLayout.HORIZONTAL);
        strip.setPadding(dp(6), dp(4), dp(6), dp(4));
        strip.setBackground(roundRect("#f8fafc", "#e2e8f0", 16));
        boolean running = bridgeRunning();
        boolean needsOnboarding = boolValue(state.get("needsOnboarding"));
        if (needsOnboarding) {
            strip.addView(darkAction("Scan QR", R.drawable.ic_db_qr, this::openQrScannerFlow), wrapRight(10));
            strip.addView(darkAction("Paste code", R.drawable.ic_db_key, this::showPasteCodeDialog), wrapRight(10));
        }
        strip.addView(darkAction(running ? "Stop" : "Start", running ? R.drawable.ic_db_pause : R.drawable.ic_db_play, () -> {
            if (running) {
                runBridgeAction("stopBridge");
            } else {
                runBridgeAction("startBridge");
            }
        }), wrapRight(10));
        strip.addView(darkAction("Reset", R.drawable.ic_db_restart, this::confirmResetOnboarding));
        scroll.addView(strip);
        return scroll;
    }

    private View consoleCard() {
        LinkedHashMap<String, String> typeOptions = consoleTypeOptions();
        if (!typeOptions.containsKey(consoleCategoryFilter)) {
            consoleCategoryFilter = "all";
        }
        LinearLayout card = card(12, 20);
        card.setPadding(dp(8), dp(8), dp(8), dp(8));
        card.setBackground(roundRect("#0b1220", "#172033", 16));

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.addView(singleLineText("Operations Console", 14, "#ffffff", true), new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        header.addView(consoleUtility(R.drawable.ic_db_copy, () -> copyText(joinConsole(filteredConsoleEntries()))), wrapRight(4));
        header.addView(consoleUtility(R.drawable.ic_db_clean, this::confirmClearConsole));
        card.addView(header, fullWidth(4));

        EditText search = input("Search SMS, call, USSD");
        search.setText(consoleQuery);
        search.setSingleLine(true);
        search.setTextColor(color("#ffffff"));
        search.setHintTextColor(color("#94a3b8"));
        search.setBackground(roundRect("#111827", "#111827", 11));
        search.setPadding(dp(7), 0, dp(7), 0);
        search.setOnEditorActionListener((v, actionId, event) -> {
            consoleQuery = v.getText().toString();
            rebuild();
            return false;
        });
        search.setOnFocusChangeListener((v, hasFocus) -> {
            if (!hasFocus) {
                consoleQuery = ((EditText) v).getText().toString();
                rebuild();
            }
        });
        card.addView(search, fullWidth(5));

        LinearLayout filters = new LinearLayout(this);
        filters.setOrientation(LinearLayout.HORIZONTAL);
        filters.addView(consoleSelect("Type", consoleCategoryFilter, typeOptions, "#0f766e", value -> {
            consoleCategoryFilter = value;
            rebuild();
        }), weighted(6));
        filters.addView(consoleSelect("Level", consoleLevelFilter, consoleLevelOptions(), "#1d4ed8", value -> {
            consoleLevelFilter = value;
            rebuild();
        }), weighted(0));
        card.addView(filters, fullWidth(5));

        LinearLayout entries = new LinearLayout(this);
        entries.setOrientation(LinearLayout.VERTICAL);
        entries.setPadding(dp(3), dp(3), dp(3), dp(3));
        entries.setBackground(roundRect("#111827", "#111827", 14));
        List<Map<String, Object>> filtered = filteredConsoleEntries();
        if (filtered.isEmpty()) {
            TextView empty = singleLineText("No matching device events.", 11, "#94a3b8", false);
            empty.setGravity(Gravity.CENTER);
            entries.addView(empty, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(156)));
        } else {
            for (Map<String, Object> entry : filtered) {
                entries.addView(consoleRow(entry), fullWidth(4));
            }
        }
        ScrollView entryScroll = new ScrollView(this);
        entryScroll.setFillViewport(false);
        entryScroll.setOverScrollMode(View.OVER_SCROLL_IF_CONTENT_SCROLLS);
        entryScroll.addView(entries);
        card.addView(entryScroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(260)));
        return card;
    }

    private View smsWorkspace() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        boolean inThread = selectedSmsThread != null || composingNewSms;
        root.setPadding(inThread ? 0 : dp(12), inThread ? 0 : dp(8), inThread ? 0 : dp(12), inThread ? 0 : dp(10));
        root.setBackgroundColor(color(inThread ? "#ffffff" : "#f2f2f7"));
        if (!BridgePermissionHelper.hasSmsInboxFeature(this)) {
            root.addView(smsHeader("SMS", "Phone messages", "Allow", R.drawable.ic_db_sms, this::requestSmsInboxAccess), fullWidth(14));
            root.addView(smsPermissionCard(), new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        } else if (composingNewSms) {
            root.addView(newConversationScreen(), new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        } else if (selectedSmsThread == null) {
            root.addView(smsListHeader(), fullWidth(12));
            root.addView(smsSearchField(), fullWidth(12));
            if (smsBulkMode) {
                root.addView(smsBulkActions(), fullWidth(8));
            }
            root.addView(smsThreadList(), new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        } else {
            root.addView(smsConversation(), new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        }
        return root;
    }

    private View smsHeader(String title, String subtitle, String actionLabel, int actionIcon, Runnable actionTap) {
        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(dp(16), dp(14), dp(16), dp(14));
        header.setBackground(roundRect("#ffffff", "#e2e8f0", 24));
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        copy.addView(text(title, 22, "#0f172a", true));
        copy.addView(text(subtitle, 12, "#64748b", false));
        row.addView(copy, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        row.addView(labelIconButton(actionLabel, actionIcon, "#0b5ed7", "#ffffff", actionTap));
        header.addView(row);
        return header;
    }

    private View smsListHeader() {
        LinearLayout shell = new LinearLayout(this);
        shell.setOrientation(LinearLayout.VERTICAL);
        shell.setBackgroundColor(color("#f2f2f7"));

        LinearLayout top = new LinearLayout(this);
        top.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        copy.addView(text("Messages", 30, "#111111", true));
        copy.addView(singleLineText(communicationHeaderTitle("SMS"), 12, "#64748b", false));
        top.addView(copy, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        top.addView(iconAction(R.drawable.ic_db_devices, "#ffffff", "#0a84ff", this::showCommunicationDeviceSheet), fixed(38, 38, 8));
        top.addView(iconAction(R.drawable.ic_db_add, "#0a84ff", "#ffffff", this::openNewConversationScreen), fixed(38, 38, 0));
        shell.addView(top, fullWidth(4));

        return shell;
    }

    private View smsPermissionCard() {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setGravity(Gravity.CENTER);
        card.setPadding(dp(18), dp(18), dp(18), dp(18));
        card.setBackground(roundRect("#ffffff", "#e2e8f0", 24));
        card.addView(iconTile(R.drawable.ic_db_sms, "#0b5ed7", 64, 20, 30), fixed(64, 64, 0));
        TextView title = text("Allow SMS access", 20, "#0f172a", true);
        title.setGravity(Gravity.CENTER);
        card.addView(title, fullWidth(8));
        TextView detail = text("The app reads this phone's SMS inbox locally, then syncs with dashboard data when connected.", 13, "#64748b", false);
        detail.setGravity(Gravity.CENTER);
        card.addView(detail, fullWidth(16));
        card.addView(labelIconButton("Allow SMS", R.drawable.ic_db_sms, "#0b5ed7", "#ffffff", this::requestSmsInboxAccess));
        return card;
    }

    private View smsSearchField() {
        LinearLayout shell = new LinearLayout(this);
        shell.setOrientation(LinearLayout.HORIZONTAL);
        shell.setGravity(Gravity.CENTER_VERTICAL);
        shell.setPadding(dp(12), 0, dp(12), 0);
        shell.setBackground(roundRect("#e9e9eb", "#e9e9eb", 14));
        shell.addView(tintedIcon(R.drawable.ic_db_search, "#8e8e93", 18), fixed(18, 18, 8));
        EditText search = input("Search conversations");
        search.setText(smsSearchQuery);
        search.setSingleLine(true);
        search.setBackgroundColor(Color.TRANSPARENT);
        search.setPadding(0, 0, 0, 0);
        search.setHintTextColor(color("#8e8e93"));
        search.setTextColor(color("#111111"));
        search.setOnEditorActionListener((v, actionId, event) -> {
            smsSearchQuery = v.getText().toString();
            rebuild();
            return false;
        });
        search.setOnFocusChangeListener((v, hasFocus) -> {
            if (!hasFocus) {
                smsSearchQuery = ((EditText) v).getText().toString();
                rebuild();
            }
        });
        shell.addView(search, new LinearLayout.LayoutParams(0, dp(42), 1f));
        return shell;
    }

    private View smsThreadList() {
        FrameLayout frame = new FrameLayout(this);
        ScrollView scroll = new ScrollView(this);
        LinearLayout list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        list.setPadding(0, 0, 0, dp(82));
        List<Map<String, Object>> visible = visibleSmsThreads();
        if (visible.isEmpty()) {
            list.addView(smsEmptyState("No conversations found", "Incoming and outgoing SMS threads from this phone will appear here."));
        } else {
            for (Map<String, Object> thread : visible) {
                list.addView(threadRow(thread), fullWidth(4));
            }
        }
        scroll.addView(list);
        frame.addView(scroll);
        return frame;
    }

    private View smsBulkActions() {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(8), dp(6), dp(8), dp(6));
        row.setBackground(roundRect("#ffffff", "#e5e5ea", 18));
        int unread = 0;
        for (Map<String, Object> thread : smsThreads) {
            unread += intValue(thread.get("unreadCount"));
        }
        String summary = smsBulkMode
                ? selectedSmsThreadKeys.size() + " selected"
                : smsThreads.size() + " chats" + (unread > 0 ? " - " + unread + " unread" : "");
        row.addView(text(summary, 12, "#475569", true), new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        if (!smsBulkMode) {
            row.addView(labelIconButton("Select", R.drawable.ic_db_tune, "#ffffff", "#0a84ff", () -> {
                smsBulkMode = true;
                selectedSmsThreadKeys.clear();
                rebuild();
            }));
            return row;
        }
        row.addView(labelIconButton("Cancel", R.drawable.ic_db_close, "#ffffff", "#0a84ff", () -> {
            smsBulkMode = false;
            selectedSmsThreadKeys.clear();
            rebuild();
        }), wrapRight(6));
        row.addView(labelIconButton(allVisibleSmsSelected() ? "Clear" : "All", R.drawable.ic_db_sms, "#ffffff", "#0a84ff", () -> {
            if (allVisibleSmsSelected()) {
                selectedSmsThreadKeys.clear();
            } else {
                selectAllVisibleSmsThreads();
            }
            rebuild();
        }), wrapRight(6));
        row.addView(labelIconButton("Read", R.drawable.ic_db_clean, "#ffffff", "#34c759", this::markSelectedSmsThreadsRead), wrapRight(6));
        row.addView(labelIconButton("Delete", R.drawable.ic_db_restart, "#ffffff", "#ff3b30", this::confirmDeleteSelectedSmsThreads));
        return row;
    }

    private View threadRow(Map<String, Object> thread) {
        ContactInfo contact = contactForThread(thread);
        String threadKey = threadKey(thread);
        boolean selected = selectedSmsThreadKeys.contains(threadKey);
        boolean unreadThread = intValue(thread.get("unreadCount")) > 0;
        boolean systemThread = isSystemSmsThread(thread);
        String displayName = systemThread ? systemThreadTrueTitle(thread, contact) : contact.name;
        String previewText = systemThread
                ? systemThreadListSubtitle()
                : stringValue(thread.get("preview"), "No message body");
        LinearLayout group = new LinearLayout(this);
        group.setOrientation(LinearLayout.VERTICAL);

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(4), dp(8), dp(4), dp(8));
        row.setBackgroundColor(color(selected ? "#eef5ff" : "#ffffff"));
        row.setClickable(true);
        row.setFocusable(true);
        row.setOnClickListener(v -> runGuarded("thread:" + threadKey, () -> {
            if (smsBulkMode) {
                smsBulkMode = false;
                selectedSmsThreadKeys.clear();
                rebuild();
            } else {
                openSmsThread(thread);
            }
        }));
        View avatar = smsAvatar(smsBulkMode && selected ? "OK" : contact.avatar, unreadThread || selected);
        avatar.setOnClickListener(v -> runGuarded("thread-avatar:" + threadKey, () -> {
            if (smsBulkMode) {
                toggleSmsThreadSelection(thread);
            } else {
                showContactInfoSheet(contact, thread);
            }
        }));
        avatar.setOnLongClickListener(v -> {
            smsBulkMode = true;
            selectedSmsThreadKeys.clear();
            selectedSmsThreadKeys.add(threadKey);
            rebuild();
            return true;
        });
        if (systemThread && !selected) {
            avatar = smsAvatar("SM", unreadThread);
        }
        row.addView(avatar, fixed(40, 40, 10));
        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        LinearLayout titleRow = new LinearLayout(this);
        titleRow.setGravity(Gravity.CENTER_VERTICAL);
        titleRow.addView(singleLineText(displayName, 15, "#111111", true), new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        titleRow.addView(text(formatSmsTimestamp(thread.get("timestamp")), 11, "#8e8e93", false));
        copy.addView(titleRow, fullWidth(2));
        copy.addView(singleLineText(previewText, 12, "#636366", false));
        row.addView(copy, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        int unread = intValue(thread.get("unreadCount"));
        if (unread > 0) {
            row.addView(pill(String.valueOf(unread), "#0a84ff", "#ffffff"));
        }
        group.addView(row);
        View divider = new View(this);
        divider.setBackgroundColor(color("#e5e5ea"));
        group.addView(divider, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1)));
        return group;
    }

    private View smsConversation() {
        LinearLayout screen = new LinearLayout(this);
        screen.setOrientation(LinearLayout.VERTICAL);
        screen.setBackgroundColor(color("#ffffff"));
        screen.addView(smsConversationHeader(), fullWidth(0));
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        LinearLayout messages = new LinearLayout(this);
        messages.setOrientation(LinearLayout.VERTICAL);
        messages.setGravity(Gravity.BOTTOM);
        messages.setPadding(dp(12), dp(12), dp(12), dp(12));
        if (smsMessages.isEmpty()) {
            messages.addView(smsEmptyState("No messages in this thread", "Send a message to start the conversation."));
        } else {
            for (Map<String, Object> message : smsMessages) {
                messages.addView(messageBubble(message), fullWidth(7));
            }
        }
        scroll.addView(messages);
        screen.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        scroll.setOnScrollChangeListener((v, scrollX, scrollY, oldScrollX, oldScrollY) -> smsConversationScrollY = scrollY);
        scroll.post(() -> {
            if (smsConversationScrollToBottomOnNextBuild) {
                scroll.fullScroll(View.FOCUS_DOWN);
                smsConversationScrollToBottomOnNextBuild = false;
                return;
            }
            if (smsConversationScrollY > 0) {
                scroll.scrollTo(0, smsConversationScrollY);
            }
        });

        if (isSystemSmsThread(selectedSmsThread)) {
            screen.addView(systemThreadNotice());
        } else {
            screen.addView(smsComposerBar(stringValue(selectedSmsThread.get("address"))));
        }
        return screen;
    }

    private View smsComposerBar(String number) {
        LinearLayout shell = new LinearLayout(this);
        shell.setOrientation(LinearLayout.VERTICAL);
        shell.setBackground(roundRect("#ffffff", "#ffffff", 0));
        LinearLayout composerShell = new LinearLayout(this);
        composerShell.setOrientation(LinearLayout.HORIZONTAL);
        composerShell.setGravity(Gravity.BOTTOM);
        composerShell.setPadding(dp(10), dp(8), dp(10), dp(8));
        EditText composer = input("Write SMS");
        composerShell.addView(iconAction(R.drawable.ic_db_add, "#f8fafc", "#64748b", () -> showSmsAttachmentSheet(composer)), fixed(38, 38, 8));
        composer.setMinLines(1);
        composer.setMaxLines(4);
        composer.setSingleLine(false);
        composer.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        composer.setBackgroundColor(Color.TRANSPARENT);
        LinearLayout inputWrap = new LinearLayout(this);
        inputWrap.setGravity(Gravity.CENTER_VERTICAL);
        inputWrap.setPadding(dp(10), 0, dp(8), 0);
        inputWrap.setBackground(roundRect("#ffffff", "#dbe3ef", 18));
        inputWrap.addView(composer, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        inputWrap.addView(smsSendAction(() -> number, composer, () -> sendSmsFromComposer(composer.getText().toString(), number)), fixed(46, 46, 0));
        composerShell.addView(inputWrap, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        shell.addView(composerShell);
        return shell;
    }

    private View systemThreadNotice() {
        LinearLayout notice = new LinearLayout(this);
        notice.setOrientation(LinearLayout.VERTICAL);
        notice.setGravity(Gravity.CENTER);
        notice.setPadding(dp(16), dp(8), dp(16), dp(10));
        notice.setBackground(roundRect("#ffffff", "#ffffff", 0));
        TextView title = text(systemThreadTrueTitle(selectedSmsThread, contactForThread(selectedSmsThread)), 13, "#475569", true);
        title.setGravity(Gravity.CENTER);
        notice.addView(title);
        TextView detail = singleLineText("No reply available for alerts and sender IDs.", 11, "#64748b", false);
        detail.setGravity(Gravity.CENTER);
        notice.addView(detail);
        return notice;
    }

    private View smsSendAction(StringFactory targetNumber, EditText composer, Runnable sendAction) {
        FrameLayout button = new FrameLayout(this);
        button.setMinimumWidth(dp(42));
        button.setMinimumHeight(dp(42));
        button.setBackground(roundRect(smsSending ? "#cbd5e1" : "#0a84ff", smsSending ? "#cbd5e1" : "#0a84ff", 999));
        button.setClickable(true);
        button.setFocusable(true);
        button.setOnClickListener(v -> runGuarded("sms-send", sendAction));
        button.setOnLongClickListener(v -> {
            String number = targetNumber == null ? currentComposerNumber() : targetNumber.get();
            showSmsSendOptionsSheet(number, composer);
            return true;
        });
        button.addView(tintedIcon(R.drawable.ic_db_send, "#ffffff", 18), new FrameLayout.LayoutParams(dp(18), dp(18), Gravity.CENTER));
        TextView badge = text(smsSimBadgeLabel(), 7, "#0a84ff", true);
        badge.setGravity(Gravity.CENTER);
        badge.setPadding(dp(3), 0, dp(3), 0);
        badge.setBackground(roundRect("#ffffff", "#bfdbfe", 999));
        FrameLayout.LayoutParams badgeParams = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(14), Gravity.TOP | Gravity.END);
        badgeParams.topMargin = dp(1);
        badgeParams.setMarginEnd(dp(1));
        button.addView(badge, badgeParams);
        return button;
    }

    private String smsSimBadgeLabel() {
        int slot = activeCommunicationSimSlot();
        return slot >= 0 ? "S" + (slot + 1) : "SIM";
    }

    private void showSmsSendOptionsSheet(String number, EditText composer) {
        Dialog dialog = createBottomSheetDialog();
        LinearLayout sheet = new LinearLayout(this);
        sheet.setOrientation(LinearLayout.VERTICAL);
        sheet.setPadding(dp(14), dp(14), dp(14), dp(14));
        sheet.setBackground(roundRect("#ffffff", "#ffffff", 24));
        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.addView(iconTile(R.drawable.ic_db_send, "#0b5ed7", 42, 14, 22), fixed(42, 42, 10));
        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        copy.addView(text("Send options", 18, "#0f172a", true));
        copy.addView(text("Choose SIM or schedule this SMS.", 12, "#64748b", false));
        header.addView(copy, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        header.addView(iconAction(R.drawable.ic_db_close, "#f8fafc", "#0f172a", dialog::dismiss));
        sheet.addView(header, fullWidth(12));

        sheet.addView(attachmentRow(R.drawable.ic_db_devices, "Device and SIM", communicationHeaderTitle("SMS"), "#0b5ed7", () -> {
            dialog.dismiss();
            showCommunicationDeviceSheet();
        }), fullWidth(6));
        sheet.addView(attachmentRow(R.drawable.ic_db_sms, "Default SIM", "Let dashboard/device choose the send route.", selectedCommunicationSimSlot < 0 ? "#0b5ed7" : "#475569", () -> {
            selectedCommunicationSimSlot = -1;
            selectedSmsSimSlot = -1;
            dialog.dismiss();
            rebuild();
        }), fullWidth(6));
        for (Map<String, Object> sim : dashboardSims) {
            int slot = intValue(sim.get("slot"));
            boolean active = slot == selectedCommunicationSimSlot;
            String label = firstNonEmptyValue(stringValue(sim.get("label")), "SIM " + (slot + 1));
            String detail = firstNonEmptyValue(stringValue(sim.get("number")), stringValue(sim.get("carrier")), "Send through SIM " + (slot + 1));
            sheet.addView(attachmentRow(R.drawable.ic_db_sms,
                    (active ? "Use " : "Switch to ") + label,
                    detail,
                    active ? "#0b5ed7" : "#475569",
                    () -> {
                        selectedCommunicationSimSlot = slot;
                        selectedSmsSimSlot = slot;
                        handleSmsSimChanged(number);
                        dialog.dismiss();
                        showSnack("SIM " + (slot + 1) + " selected.");
                    }), fullWidth(6));
        }
        showFixedBottomSheetDialog(dialog, sheet);
    }

    private View messageBubble(Map<String, Object> message) {
        boolean outgoing = boolValue(message.get("outgoing"));
        String source = stringValue(message.get("source"), outgoing ? "phone" : "device");
        boolean dashboard = source.toLowerCase(Locale.US).contains("dashboard");
        LinearLayout outer = new LinearLayout(this);
        outer.setGravity(outgoing ? Gravity.END : Gravity.START);
        LinearLayout bubble = new LinearLayout(this);
        bubble.setOrientation(LinearLayout.VERTICAL);
        bubble.setPadding(dp(14), dp(10), dp(14), dp(10));
        String fill = dashboard ? "#e5f3ff" : outgoing ? "#0a84ff" : "#e9e9eb";
        String stroke = fill;
        bubble.setBackground(roundRect(fill, stroke, 22));
        bubble.setOnLongClickListener(v -> {
            showSmsMessageActions(message);
            return true;
        });
        bubble.addView(text(stringValue(message.get("body"), ""), 15, outgoing ? "#ffffff" : "#111111", false));
        LinearLayout meta = new LinearLayout(this);
        meta.setGravity(Gravity.CENTER_VERTICAL | (outgoing ? Gravity.END : Gravity.START));
        TextView time = text(formatSmsTimestamp(message.get("timestamp")), 10, outgoing ? "#dbeafe" : "#8e8e93", false);
        meta.addView(time);
        String badge = messageSourceBadge(source);
        if (!badge.isEmpty()) {
            TextView badgeView = text(badge, 9, dashboard ? "#0369a1" : outgoing ? "#dbeafe" : "#636366", true);
            badgeView.setGravity(Gravity.CENTER);
            badgeView.setPadding(dp(5), dp(2), dp(5), dp(2));
            badgeView.setBackground(roundRect(dashboard ? "#bae6fd" : outgoing ? "#3b9cff" : "#d1d1d6", dashboard ? "#7dd3fc" : outgoing ? "#3b9cff" : "#d1d1d6", 999));
            meta.addView(badgeView, wrapLeft(6));
        }
        bubble.addView(meta);
        outer.addView(bubble, new LinearLayout.LayoutParams((int) (getResources().getDisplayMetrics().widthPixels * 0.78f), ViewGroup.LayoutParams.WRAP_CONTENT));
        return outer;
    }

    private View smsConversationHeader() {
        ContactInfo contact = contactForThread(selectedSmsThread);
        boolean systemThread = isSystemSmsThread(selectedSmsThread);
        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(dp(8), dp(10), dp(12), dp(10));
        header.setBackgroundColor(color("#ffffff"));
        header.addView(iconAction(R.drawable.ic_db_back, "#ffffff", "#0a84ff", () -> {
            selectedSmsThread = null;
            smsMessages = new ArrayList<>();
            smsConversationScrollY = 0;
            smsConversationScrollToBottomOnNextBuild = false;
            rebuild();
        }), fixed(42, 42, 6));
        View avatar = smsAvatar(contact.avatar, false);
        avatar.setOnClickListener(v -> runGuarded("contact-info", () -> showContactInfoSheet(contact, selectedSmsThread)));
        header.addView(avatar, fixed(42, 42, 10));
        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        copy.addView(singleLineText(systemThread ? systemThreadTrueTitle(selectedSmsThread, contact) : contact.name.isEmpty() ? "Conversation" : contact.name, 17, "#111111", true));
        copy.addView(singleLineText(systemThread ? "No reply available" : joinNonEmpty(contact.number.isEmpty() ? "Text Message" : contact.number, activeCommunicationDeviceName()), 12, "#8e8e93", false));
        header.addView(copy, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        header.addView(iconAction(R.drawable.ic_db_devices, "#ffffff", "#0a84ff", this::showCommunicationDeviceSheet), fixed(42, 42, 6));
        if (!systemThread && !safe(contact.number).trim().isEmpty()) {
            header.addView(iconAction(R.drawable.ic_db_call, "#ffffff", "#34c759", () -> showDialerSheet(contact.number, contact.name)), fixed(42, 42, 6));
        }
        header.addView(iconAction(R.drawable.ic_db_more_vert, "#ffffff", "#0a84ff", this::showSmsThreadMenu), fixed(42, 42, 0));
        return header;
    }

    private View newConversationScreen() {
        LinearLayout screen = new LinearLayout(this);
        screen.setOrientation(LinearLayout.VERTICAL);
        screen.setBackgroundColor(color("#f2f2f7"));

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(dp(8), dp(10), dp(12), dp(8));
        header.addView(chipButton("Cancel", "#f2f2f7", "#0a84ff"), wrapRight(8));
        ((Button) header.getChildAt(0)).setOnClickListener(v -> runGuarded("new-message-cancel", () -> {
            composingNewSms = false;
            clearNewSmsDraft();
            rebuild();
        }));
        LinearLayout title = new LinearLayout(this);
        title.setOrientation(LinearLayout.VERTICAL);
        title.addView(text("New Message", 18, "#111111", true));
        title.addView(singleLineText(communicationHeaderTitle("SMS"), 11, "#64748b", false));
        header.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        header.addView(iconAction(R.drawable.ic_db_devices, "#ffffff", "#0a84ff", this::showCommunicationDeviceSheet), fixed(38, 38, 8));
        header.addView(iconAction(R.drawable.ic_db_person, "#ffffff", "#0a84ff", () -> {
            showContactPickerSheet("Select recipient", (name, phone) -> {
                addNewSmsRecipient(name, phone);
                newSmsContactQuery = "";
                newSmsContactSearchFocused = false;
                rebuild();
            });
        }), fixed(38, 38, 0));
        screen.addView(header, fullWidth(0));

        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(14), dp(8), dp(14), dp(12));
        content.addView(communicationActionRow(
                communicationShortcut("Contacts", "", R.drawable.ic_db_person, "#34c759", () -> {
                    showContactPickerSheet("Select recipient", (name, phone) -> {
                        addNewSmsRecipient(name, phone);
                        newSmsContactQuery = "";
                        newSmsContactSearchFocused = false;
                        rebuild();
                    });
                }),
                communicationShortcut("Phone", "", R.drawable.ic_db_call, "#0a84ff", () -> showDialerSheet(primaryNewSmsRecipientNumber(newSmsContactQuery), primaryNewSmsRecipientLabel(newSmsContactQuery)))
        ), fullWidth(8));
        content.addView(newSmsRecipientsPanel(), fullWidth(8));

        EditText contactSearch = input("Name or phone number");
        contactSearch.setSingleLine(true);
        contactSearch.setText(newSmsContactQuery);
        contactSearch.setBackground(roundRect("#e9e9eb", "#e9e9eb", 14));
        contactSearch.setHintTextColor(color("#8e8e93"));
        content.addView(contactSearch, fullWidth(8));

        LinearLayout contactsBox = new LinearLayout(this);
        contactsBox.setOrientation(LinearLayout.VERTICAL);
        contactsBox.setPadding(dp(6), dp(6), dp(6), dp(6));
        contactsBox.setBackground(roundRect("#ffffff", "#e5e5ea", 18));
        final ContactCallback[] chooseRef = new ContactCallback[1];
        ContactCallback choose = (name, phone) -> {
            addNewSmsRecipient(name, phone);
            newSmsContactQuery = "";
            newSmsContactSearchFocused = false;
            rebuild();
        };
        chooseRef[0] = choose;
        renderNewSmsRecipientMatches(contactsBox, newSmsContactQuery, choose);
        contactSearch.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {
            }

            @Override
            public void onTextChanged(CharSequence s, int start, int before, int count) {
                newSmsContactQuery = s.toString();
                renderNewSmsRecipientMatches(contactsBox, newSmsContactQuery, choose);
            }

            @Override
            public void afterTextChanged(Editable s) {
            }
        });
        ScrollView contactsScroll = new ScrollView(this);
        contactsScroll.addView(contactsBox);
        contactsScroll.setVisibility(newSmsContactSearchFocused ? View.VISIBLE : View.GONE);
        contactSearch.setOnFocusChangeListener((v, hasFocus) -> {
            newSmsContactSearchFocused = hasFocus;
            contactsScroll.setVisibility(hasFocus ? View.VISIBLE : View.GONE);
        });
        content.addView(contactsScroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        screen.addView(content, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        LinearLayout composerArea = new LinearLayout(this);
        composerArea.setOrientation(LinearLayout.VERTICAL);
        composerArea.setBackground(roundRect("#ffffff", "#ffffff", 0));
        LinearLayout composerShell = new LinearLayout(this);
        composerShell.setOrientation(LinearLayout.HORIZONTAL);
        composerShell.setGravity(Gravity.BOTTOM);
        composerShell.setPadding(dp(10), dp(8), dp(10), dp(8));
        EditText message = input("Text message");
        message.setMinLines(1);
        message.setMaxLines(4);
        message.setSingleLine(false);
        message.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        message.setBackgroundColor(Color.TRANSPARENT);
        composerShell.addView(iconAction(R.drawable.ic_db_add, "#ffffff", "#8e8e93", () -> {
            newSmsRecipientNumber = primaryNewSmsRecipientNumber(contactSearch.getText().toString());
            showSmsAttachmentSheet(message);
        }), fixed(38, 38, 8));
        LinearLayout inputWrap = new LinearLayout(this);
        inputWrap.setGravity(Gravity.CENTER_VERTICAL);
        inputWrap.setPadding(dp(10), 0, dp(8), 0);
        inputWrap.setBackground(roundRect("#ffffff", "#d1d1d6", 18));
        inputWrap.addView(message, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        inputWrap.addView(smsSendAction(() -> {
            newSmsRecipientNumber = primaryNewSmsRecipientNumber(contactSearch.getText().toString());
            return newSmsRecipientNumber;
        }, message, () -> {
            sendSmsFromComposerToRecipients(message.getText().toString(), resolveNewSmsRecipients(contactSearch.getText().toString()));
        }), fixed(46, 46, 0));
        composerShell.addView(inputWrap, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        composerArea.addView(composerShell);
        screen.addView(composerArea);
        return screen;
    }

    private void openNewConversationScreen() {
        selectedSmsThread = null;
        smsMessages = new ArrayList<>();
        smsBulkMode = false;
        selectedSmsThreadKeys.clear();
        composingNewSms = true;
        clearNewSmsDraft();
        rebuild();
    }

    private void clearNewSmsDraft() {
        newSmsContactQuery = "";
        newSmsRecipientName = "";
        newSmsRecipientNumber = "";
        newSmsContactSearchFocused = false;
        newSmsRecipients.clear();
    }

    private void addNewSmsRecipient(String name, String number) {
        String cleanNumber = safe(number).trim();
        if (cleanNumber.isEmpty()) {
            return;
        }
        String key = contactCacheKey(cleanNumber);
        for (ContactInfo recipient : newSmsRecipients) {
            if (key.equals(contactCacheKey(recipient.number))) {
                return;
            }
        }
        String cleanName = safe(name).trim();
        String label = firstNonEmptyValue(cleanName, cleanNumber);
        newSmsRecipients.add(new ContactInfo(label, cleanNumber, avatarLabel(label), true));
        newSmsRecipientName = cleanName;
        newSmsRecipientNumber = cleanNumber;
    }

    private void removeNewSmsRecipient(String number) {
        String target = contactCacheKey(number);
        for (int i = newSmsRecipients.size() - 1; i >= 0; i -= 1) {
            if (target.equals(contactCacheKey(newSmsRecipients.get(i).number))) {
                newSmsRecipients.remove(i);
            }
        }
        if (newSmsRecipients.isEmpty()) {
            newSmsRecipientName = "";
            newSmsRecipientNumber = "";
            return;
        }
        ContactInfo first = newSmsRecipients.get(0);
        newSmsRecipientName = first.name;
        newSmsRecipientNumber = first.number;
    }

    private View newSmsRecipientsPanel() {
        if (newSmsRecipients.isEmpty()) {
            TextView placeholder = text("To: search contacts or type number", 13, "#111111", true);
            placeholder.setPadding(dp(12), dp(8), dp(12), dp(8));
            placeholder.setBackground(roundRect("#ffffff", "#e5e5ea", 999));
            return placeholder;
        }
        HorizontalScrollView scroll = new HorizontalScrollView(this);
        scroll.setHorizontalScrollBarEnabled(false);
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        for (int i = 0; i < newSmsRecipients.size(); i += 1) {
            row.addView(newSmsRecipientPill(newSmsRecipients.get(i)), wrapRight(i == newSmsRecipients.size() - 1 ? 0 : 8));
        }
        scroll.addView(row);
        return scroll;
    }

    private View newSmsRecipientPill(ContactInfo recipient) {
        LinearLayout pill = new LinearLayout(this);
        pill.setOrientation(LinearLayout.HORIZONTAL);
        pill.setGravity(Gravity.CENTER_VERTICAL);
        pill.setPadding(dp(6), dp(6), dp(10), dp(6));
        pill.setBackground(roundRect("#e5f3ff", "#9fd0ff", 999));
        pill.addView(smsAvatar(recipient.avatar, false), fixed(30, 30, 8));
        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        copy.addView(singleLineText(recipient.number, 12, "#111111", true));
        if (!recipient.name.equals(recipient.number)) {
            copy.addView(singleLineText(recipient.name, 9, "#0a84ff", true));
        }
        pill.addView(copy, wrapRight(8));
        FrameLayout remove = new FrameLayout(this);
        remove.setMinimumWidth(dp(22));
        remove.setMinimumHeight(dp(22));
        remove.setBackground(roundRect("#ffffff", "#bfdbfe", 999));
        remove.setClickable(true);
        remove.setFocusable(true);
        remove.setOnClickListener(v -> runGuarded("new-sms-remove:" + recipient.number, () -> {
            removeNewSmsRecipient(recipient.number);
            rebuild();
        }));
        remove.addView(tintedIcon(R.drawable.ic_db_close, "#0a84ff", 12), new FrameLayout.LayoutParams(dp(12), dp(12), Gravity.CENTER));
        pill.addView(remove);
        return pill;
    }

    private void renderNewSmsRecipientMatches(LinearLayout target, String query, ContactCallback callback) {
        target.removeAllViews();
        loadDashboardContacts(query, false);
        if (looksLikePhoneNumber(query)) {
            String typedNumber = safe(query).trim();
            if (!alreadySelectedNewSmsRecipient(typedNumber)) {
                target.addView(contactRow("Add " + typedNumber, "Use this number as another recipient.", (name, number) -> callback.onContact("", typedNumber)), fullWidth(4));
            }
        }
        List<Map<String, String>> contacts = findContacts(query, 120);
        for (Map<String, String> contact : contacts) {
            String name = safe(contact.get("name"));
            String number = safe(contact.get("number"));
            if (alreadySelectedNewSmsRecipient(number)) {
                continue;
            }
            target.addView(contactRow(name, number, (contactName, contactNumber) -> callback.onContact(name, number)), fullWidth(4));
        }
        if (target.getChildCount() == 0) {
            TextView empty = text(contactsLoading ? "Loading contacts..." : "No dashboard contacts found", 12, "#64748b", false);
            empty.setGravity(Gravity.CENTER);
            empty.setPadding(dp(8), dp(16), dp(8), dp(16));
            target.addView(empty);
        }
    }

    private boolean alreadySelectedNewSmsRecipient(String number) {
        String target = contactCacheKey(number);
        for (ContactInfo recipient : newSmsRecipients) {
            if (target.equals(contactCacheKey(recipient.number))) {
                return true;
            }
        }
        return false;
    }

    private List<ContactInfo> resolveNewSmsRecipients(String typedValue) {
        List<ContactInfo> recipients = new ArrayList<>(newSmsRecipients);
        if (!recipients.isEmpty()) {
            return recipients;
        }
        String typed = safe(typedValue).trim();
        if (looksLikePhoneNumber(typed)) {
            recipients.add(new ContactInfo(typed, typed, avatarLabel(typed), true));
            return recipients;
        }
        if (!safe(newSmsRecipientNumber).trim().isEmpty()) {
            recipients.add(new ContactInfo(firstNonEmptyValue(newSmsRecipientName, newSmsRecipientNumber), newSmsRecipientNumber, avatarLabel(firstNonEmptyValue(newSmsRecipientName, newSmsRecipientNumber)), true));
            return recipients;
        }
        List<Map<String, String>> matches = findContacts(typed, 1);
        if (!matches.isEmpty()) {
            String name = safe(matches.get(0).get("name"));
            String number = safe(matches.get(0).get("number")).trim();
            recipients.add(new ContactInfo(firstNonEmptyValue(name, number), number, avatarLabel(firstNonEmptyValue(name, number)), true));
        }
        return recipients;
    }

    private String primaryNewSmsRecipientNumber(String typedValue) {
        List<ContactInfo> recipients = resolveNewSmsRecipients(typedValue);
        return recipients.isEmpty() ? "" : safe(recipients.get(0).number).trim();
    }

    private String primaryNewSmsRecipientLabel(String typedValue) {
        List<ContactInfo> recipients = resolveNewSmsRecipients(typedValue);
        if (recipients.isEmpty()) {
            return "";
        }
        return firstNonEmptyValue(recipients.get(0).name, recipients.get(0).number);
    }

    private void showSmsThreadMenu() {
        if (selectedSmsThread == null) {
            return;
        }
        Dialog dialog = createBottomSheetDialog();
        LinearLayout sheet = new LinearLayout(this);
        sheet.setOrientation(LinearLayout.VERTICAL);
        sheet.setPadding(dp(14), dp(14), dp(14), dp(14));
        sheet.setBackground(roundRect("#ffffff", "#ffffff", 24));
        ContactInfo contact = contactForThread(selectedSmsThread);
        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.addView(smsAvatar(contact.avatar, false), fixed(42, 42, 10));
        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        copy.addView(text(contact.name, 16, "#0f172a", true));
        copy.addView(text("Conversation options", 12, "#64748b", false));
        header.addView(copy, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        header.addView(iconAction(R.drawable.ic_db_close, "#f8fafc", "#0f172a", dialog::dismiss));
        sheet.addView(header, fullWidth(12));
        sheet.addView(attachmentRow(R.drawable.ic_db_person, "Contact details", contact.number, "#0b5ed7", () -> {
            dialog.dismiss();
            showContactInfoSheet(contact, selectedSmsThread);
        }), fullWidth(6));
        sheet.addView(attachmentRow(R.drawable.ic_db_clean, "Mark all read", "Clear unread state for this conversation.", "#166534", () -> {
            dialog.dismiss();
            selectedSmsThreadKeys.clear();
            selectedSmsThreadKeys.add(threadKey(selectedSmsThread));
            markSelectedSmsThreadsRead();
        }), fullWidth(6));
        sheet.addView(attachmentRow(R.drawable.ic_db_search, "Search in conversation", "Use the conversation list search to filter messages.", "#475569", () -> {
            dialog.dismiss();
            showSnack("Conversation search is listed in the audit as next work.");
        }), fullWidth(6));
        sheet.addView(attachmentRow(R.drawable.ic_db_open, "Google Messages audit", "Review remaining parity items.", "#7c3aed", () -> {
            dialog.dismiss();
            showSmsFeatureAuditSheet();
        }), fullWidth(6));
        sheet.addView(attachmentRow(R.drawable.ic_db_restart, "Delete conversation", "Dashboard conversation delete is not enabled in this app yet.", "#dc2626", () -> {
            dialog.dismiss();
            selectedSmsThreadKeys.clear();
            selectedSmsThreadKeys.add(threadKey(selectedSmsThread));
            confirmDeleteSelectedSmsThreads();
        }));
        showFixedBottomSheetDialog(dialog, sheet);
    }

    private void showSmsListMenu() {
        Dialog dialog = createBottomSheetDialog();
        LinearLayout sheet = new LinearLayout(this);
        sheet.setOrientation(LinearLayout.VERTICAL);
        sheet.setPadding(dp(14), dp(14), dp(14), dp(14));
        sheet.setBackground(roundRect("#ffffff", "#ffffff", 24));
        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.addView(iconTile(R.drawable.ic_db_sms, "#0b5ed7", 42, 14, 22), fixed(42, 42, 10));
        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        copy.addView(text("Conversation menu", 18, "#0f172a", true));
        copy.addView(text("Bulk actions for visible SMS threads.", 12, "#64748b", false));
        header.addView(copy, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        header.addView(iconAction(R.drawable.ic_db_close, "#f8fafc", "#0f172a", dialog::dismiss));
        sheet.addView(header, fullWidth(12));
        sheet.addView(attachmentRow(R.drawable.ic_db_add, "New conversation", "Start a new SMS thread.", "#0b5ed7", () -> {
            dialog.dismiss();
            openNewConversationScreen();
        }), fullWidth(6));
        sheet.addView(attachmentRow(R.drawable.ic_db_sms, "Select all", "Select every visible conversation.", "#0f766e", () -> {
            dialog.dismiss();
            smsBulkMode = true;
            selectAllVisibleSmsThreads();
            rebuild();
        }), fullWidth(6));
        sheet.addView(attachmentRow(R.drawable.ic_db_clean, "Mark read", "Mark selected conversations, or all visible when none are selected.", "#166534", () -> {
            dialog.dismiss();
            ensureVisibleSelectedForMenuAction();
            markSelectedSmsThreadsRead();
        }), fullWidth(6));
        sheet.addView(attachmentRow(R.drawable.ic_db_restart, "Delete", "Delete selected conversations, or all visible when none are selected.", "#dc2626", () -> {
            dialog.dismiss();
            ensureVisibleSelectedForMenuAction();
            confirmDeleteSelectedSmsThreads();
        }));
        showFixedBottomSheetDialog(dialog, sheet);
    }

    private void showSmsMessageActions(Map<String, Object> message) {
        Dialog dialog = createBottomSheetDialog();
        LinearLayout sheet = new LinearLayout(this);
        sheet.setOrientation(LinearLayout.VERTICAL);
        sheet.setPadding(dp(14), dp(14), dp(14), dp(14));
        sheet.setBackground(roundRect("#ffffff", "#ffffff", 24));
        sheet.addView(text("Message options", 18, "#0f172a", true), fullWidth(4));
        sheet.addView(text(formatSmsTimestamp(message.get("timestamp")) + " - " + messageSourceLabel(message), 12, "#64748b", false), fullWidth(12));
        sheet.addView(attachmentRow(R.drawable.ic_db_copy, "Copy text", stringValue(message.get("body"), ""), "#0b5ed7", () -> {
            dialog.dismiss();
            copyText(stringValue(message.get("body")));
        }), fullWidth(6));
        sheet.addView(attachmentRow(R.drawable.ic_db_open, "Info", "Sender, source, action id, delivery status.", "#7c3aed", () -> {
            dialog.dismiss();
            showSmsMessageInfo(message);
        }), fullWidth(6));
        sheet.addView(attachmentRow(R.drawable.ic_db_restart, "Delete", "Remove this message when Android allows it.", "#dc2626", () -> {
            dialog.dismiss();
            deleteSmsMessage(message);
        }));
        showFixedBottomSheetDialog(dialog, sheet);
    }

    private void showSmsMessageInfo(Map<String, Object> message) {
        showDetailDialog("SMS Message", messageSourceLabel(message), messageInfoJson(message));
    }

    private void deleteSmsMessage(Map<String, Object> message) {
        showSnack("Delete from dashboard messages is not enabled in the app yet.");
    }

    private void showSmsFeatureAuditSheet() {
        Dialog dialog = createBottomSheetDialog();
        LinearLayout sheet = new LinearLayout(this);
        sheet.setOrientation(LinearLayout.VERTICAL);
        sheet.setPadding(dp(14), dp(14), dp(14), dp(14));
        sheet.setBackground(roundRect("#ffffff", "#ffffff", 24));
        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.addView(iconTile(R.drawable.ic_db_sms, "#0b5ed7", 42, 14, 22), fixed(42, 42, 10));
        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        copy.addView(text("Messages parity audit", 17, "#0f172a", true));
        copy.addView(text("Implemented now and remaining Google Messages-style items.", 12, "#64748b", false));
        header.addView(copy, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        header.addView(iconAction(R.drawable.ic_db_close, "#f8fafc", "#0f172a", dialog::dismiss));
        sheet.addView(header, fullWidth(12));
        sheet.addView(auditLine("Available", "Bottom-scroll thread, sender info, message long-press menu, dashboard/API badges, system-thread no-reply state, full-screen compose, device selector, and SIM selector."));
        sheet.addView(auditLine("Still Missing", "Conversation search, archive, block/report spam, notification mute, reactions, media/gallery attachments, RCS typing/read receipts."));
        sheet.addView(auditLine("Android Limit", "The app screen reads dashboard SMS. Provider access is only used by the bridge sync service."));
        showFixedBottomSheetDialog(dialog, sheet);
    }

    private View auditLine(String label, String detail) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.VERTICAL);
        row.setPadding(dp(12), dp(10), dp(12), dp(10));
        row.setBackground(roundRect("#f8fafc", "#e2e8f0", 16));
        row.addView(text(label, 12, "#0f172a", true), fullWidth(4));
        row.addView(text(detail, 12, "#475569", false));
        return row;
    }

    private View smsEmptyState(String title, String detail) {
        LinearLayout empty = new LinearLayout(this);
        empty.setOrientation(LinearLayout.VERTICAL);
        empty.setGravity(Gravity.CENTER);
        empty.setPadding(dp(18), dp(96), dp(18), dp(18));
        empty.addView(iconTile(R.drawable.ic_db_sms, "#94a3b8", 58, 20, 30), fixed(58, 58, 0));
        TextView titleView = text(title, 17, "#0f172a", true);
        titleView.setGravity(Gravity.CENTER);
        empty.addView(titleView, fullWidth(8));
        TextView detailView = text(detail, 12, "#64748b", false);
        detailView.setGravity(Gravity.CENTER);
        empty.addView(detailView);
        return empty;
    }

    private View smsAvatar(String label, boolean unread) {
        TextView avatar = text(label, 17, unread ? "#0a84ff" : "#636366", true);
        avatar.setGravity(Gravity.CENTER);
        avatar.setBackground(roundRect(unread ? "#e5f3ff" : "#ededf0", unread ? "#b9dcff" : "#ededf0", 999));
        return avatar;
    }

    private String threadInitial(Map<String, Object> thread) {
        String title = stringValue(thread == null ? null : thread.get("title"), "?").trim();
        return title.isEmpty() ? "?" : title.substring(0, 1).toUpperCase(Locale.US);
    }

    private View bottomNavigation() {
        LinearLayout nav = new LinearLayout(this);
        nav.setOrientation(LinearLayout.HORIZONTAL);
        nav.setGravity(Gravity.CENTER_VERTICAL);
        nav.setPadding(dp(8), dp(2), dp(8), dp(2));
        nav.setBackground(roundRect("#ffffff", "#ffffff", 0));
        nav.addView(navItem("Home", R.drawable.ic_db_home, selectedTabIndex == TAB_HOME, () -> selectTab(TAB_HOME)), weighted(8));
        nav.addView(navItem("Message", R.drawable.ic_db_sms, selectedTabIndex == TAB_SMS, () -> selectTab(TAB_SMS)), weighted(8));
        nav.addView(navItem("Calls", R.drawable.ic_db_call, selectedTabIndex == TAB_PHONE, () -> selectTab(TAB_PHONE)), weighted(8));
        nav.addView(navItem("Contacts", R.drawable.ic_db_person, selectedTabIndex == TAB_CONTACTS, () -> selectTab(TAB_CONTACTS)), weighted(0));
        return nav;
    }

    private View navItem(String label, int iconRes, boolean active, Runnable action) {
        LinearLayout item = new LinearLayout(this);
        item.setOrientation(LinearLayout.VERTICAL);
        item.setGravity(Gravity.CENTER);
        item.setPadding(dp(8), 0, dp(8), 0);
        item.setBackgroundColor(Color.TRANSPARENT);
        FrameLayout indicator = new FrameLayout(this);
        indicator.setBackground(roundRect(active ? "#dbeafe" : "#ffffff", active ? "#dbeafe" : "#ffffff", 999));
        indicator.addView(tintedIcon(iconRes, active ? "#0b5ed7" : "#475569", 19), new FrameLayout.LayoutParams(dp(19), dp(19), Gravity.CENTER));
        item.addView(indicator, new LinearLayout.LayoutParams(dp(52), dp(26)));
        TextView labelView = text(label, 10, active ? "#0f172a" : "#475569", true);
        labelView.setGravity(Gravity.CENTER);
        item.addView(labelView, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(20)));
        item.setClickable(true);
        item.setFocusable(true);
        item.setOnClickListener(v -> runGuarded("nav:" + label, action));
        return item;
    }

    private View contactsWorkspace() {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(color("#f2f2f7"));

        LinearLayout root = rootLayout(12, 8, 12, 12);
        root.setBackgroundColor(color("#f2f2f7"));
        scroll.addView(root);

        root.addView(contactsListHeader(), fullWidth(12));

        LinearLayout searchShell = new LinearLayout(this);
        searchShell.setOrientation(LinearLayout.HORIZONTAL);
        searchShell.setGravity(Gravity.CENTER_VERTICAL);
        searchShell.setPadding(dp(12), 0, dp(12), 0);
        searchShell.setBackground(roundRect("#e9e9eb", "#e9e9eb", 14));
        searchShell.addView(tintedIcon(R.drawable.ic_db_search, "#8e8e93", 18), fixed(18, 18, 8));
        EditText search = input("Search contacts");
        search.setSingleLine(true);
        search.setBackgroundColor(Color.TRANSPARENT);
        search.setPadding(0, 0, 0, 0);
        search.setHintTextColor(color("#8e8e93"));
        search.setTextColor(color("#111111"));
        searchShell.addView(search, new LinearLayout.LayoutParams(0, dp(42), 1f));
        root.addView(searchShell, fullWidth(12));

        LinearLayout results = new LinearLayout(this);
        results.setOrientation(LinearLayout.VERTICAL);
        results.setPadding(dp(6), dp(6), dp(6), dp(6));
        results.setBackground(roundRect("#ffffff", "#e5e5ea", 18));
        root.addView(results, fullWidth(0));

        Runnable refreshContacts = () -> {
            results.removeAllViews();
            loadDeviceContacts(search.getText().toString(), false);
            loadDashboardContacts(search.getText().toString(), false);
            List<Map<String, String>> matches = findContacts(search.getText().toString(), 120);

            for (Map<String, String> contact : matches) {
                String name = safe(contact.get("name"));
                String number = safe(contact.get("number"));
                results.addView(contactRow(name, number, this::showContactActionSheet), fullWidth(4));
            }

            if (matches.isEmpty()) {
                if (!hasContactsPermission()) {
                    results.addView(contactPermissionRow(this::requestContactsPermission));
                } else {
                    results.addView(emptyLine((contactsLoading || deviceContactsLoading) ? "Loading contacts..." : "No contacts found for this search."));
                }
            }
        };

        refreshContacts.run();
        search.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {
            }

            @Override
            public void onTextChanged(CharSequence s, int start, int before, int count) {
                refreshContacts.run();
            }

            @Override
            public void afterTextChanged(Editable s) {
            }
        });
        return scroll;
    }

    private View contactsListHeader() {
        LinearLayout shell = new LinearLayout(this);
        shell.setOrientation(LinearLayout.VERTICAL);
        shell.setBackgroundColor(color("#f2f2f7"));

        LinearLayout top = new LinearLayout(this);
        top.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        copy.addView(text("Contacts", 30, "#111111", true));
        copy.addView(singleLineText(hasContactsPermission() ? "Phone contacts" : "Allow phone contacts", 12, "#64748b", false));
        top.addView(copy, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        top.addView(iconAction(R.drawable.ic_db_devices, "#ffffff", "#0a84ff", this::showCommunicationDeviceSheet), fixed(38, 38, 0));
        shell.addView(top, fullWidth(4));

        return shell;
    }

    private View phoneWorkspace() {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(color("#f2f2f7"));

        LinearLayout root = rootLayout(12, 8, 12, 12);
        root.setBackgroundColor(color("#f2f2f7"));
        scroll.addView(root);

        boolean callReady = boolValue(state.get("callFeatureReady"));
        String callStatus = stringValue(state.get("callStatus"), "Idle");
        String callNumber = stringValue(state.get("callNumber"));
        String callDirection = stringValue(state.get("callDirection"));
        boolean callLogReady = hasCallLogPermission() || BridgeConfig.load(this).hasDashboardAccess();
        List<RecentCallItem> recentCalls = recentCallItems(8);
        List<RecentCallItem> favorites = recentFavoriteItems(recentCalls, 6);

        root.addView(phoneListHeader(), fullWidth(8));

        if (!favorites.isEmpty()) {
            root.addView(settingsSectionHeader("Favorites", ""), fullWidth(4));
            root.addView(callFavoritesStrip(favorites), fullWidth(8));
        }

        if (!"idle".equalsIgnoreCase(callStatus) || !callNumber.isEmpty()) {
            LinearLayout statusCard = card(10, 18);
            statusCard.setBackground(roundRect("#ffffff", "#e5e5ea", 18));
            statusCard.addView(text("Current call", 11, "#8e8e93", true), fullWidth(2));
            statusCard.addView(text(capitalize(callStatus.isEmpty() ? "idle" : callStatus), 17, "#111111", true), fullWidth(2));
            statusCard.addView(text(joinNonEmpty(capitalize(callDirection), callNumber), 12, "#636366", false));
            root.addView(statusCard, fullWidth(8));
        }

        root.addView(settingsSectionHeader(
                "Recents",
                ""
        ), fullWidth(4));

        LinearLayout callLogCard = card(8, 18);
        callLogCard.setBackground(roundRect("#ffffff", "#e5e5ea", 18));
        if (!callLogReady) {
            callLogCard.addView(settingsRow(
                    R.drawable.ic_db_call,
                    "Allow calls",
                    "Enable call log access to show this phone's recent calls.",
                    "Allow",
                    "#0a84ff",
                    this::requestCallFeature
            ));
        } else if (callLogLoading) {
            callLogCard.addView(emptyLine("Loading calls..."));
        } else if (recentCalls.isEmpty()) {
            callLogCard.addView(emptyLine("No recent calls on this phone yet."));
        } else {
            for (RecentCallItem item : recentCalls) {
                callLogCard.addView(callLogRow(item), fullWidth(4));
            }
        }
        root.addView(callLogCard, fullWidth(8));

        return scroll;
    }

    private View phoneListHeader() {
        LinearLayout shell = new LinearLayout(this);
        shell.setOrientation(LinearLayout.VERTICAL);
        shell.setBackgroundColor(color("#f2f2f7"));

        LinearLayout top = new LinearLayout(this);
        top.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        copy.addView(text("Phone", 30, "#111111", true));
        copy.addView(singleLineText(communicationHeaderTitle("Call"), 12, "#64748b", false));
        top.addView(copy, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        top.addView(iconAction(R.drawable.ic_db_devices, "#ffffff", "#0a84ff", this::showCommunicationDeviceSheet), fixed(38, 38, 8));
        top.addView(iconAction(R.drawable.ic_db_add, "#0a84ff", "#ffffff", () -> showDialerSheet("", "")), fixed(38, 38, 0));
        shell.addView(top, fullWidth(4));

        return shell;
    }

    private View callLogRow(RecentCallItem item) {
        String accent = callTypeAccent(item.type);
        LinearLayout group = new LinearLayout(this);
        group.setOrientation(LinearLayout.VERTICAL);

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(6), dp(10), dp(6), dp(10));
        row.setBackgroundColor(color("#ffffff"));
        row.setClickable(true);
        row.setFocusable(true);
        row.setOnClickListener(v -> showDialerSheet(item.number, item.name));

        row.addView(iconTile(R.drawable.ic_db_call, accent, 32, 11, 16), fixed(32, 32, 10));

        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        copy.addView(singleLineText(firstNonEmptyValue(item.name, item.number, "Unknown"), 15, "#111111", true));
        copy.addView(singleLineText(joinNonEmpty(
                item.number.isEmpty() ? "Private number" : item.number,
                formatCallDuration(item.durationSeconds)
        ), 12, "#636366", false));
        row.addView(copy, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        LinearLayout tail = new LinearLayout(this);
        tail.setOrientation(LinearLayout.VERTICAL);
        tail.setGravity(Gravity.END);
        tail.addView(text(formatSmsTimestamp(item.date), 11, "#8e8e93", false));
        tail.addView(text(callTypeShortLabel(item.type), 11, accent, true));
        row.addView(tail);
        group.addView(row);

        View divider = new View(this);
        divider.setBackgroundColor(color("#e5e5ea"));
        group.addView(divider, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1)));
        return group;
    }

    private List<RecentCallItem> recentFavoriteItems(List<RecentCallItem> source, int limit) {
        LinkedHashMap<String, RecentCallItem> deduped = new LinkedHashMap<>();
        for (RecentCallItem item : source) {
            String key = firstNonEmptyValue(item.number, item.name).trim();
            if (key.isEmpty() || deduped.containsKey(key)) {
                continue;
            }
            deduped.put(key, item);
            if (deduped.size() >= limit) {
                break;
            }
        }
        return new ArrayList<>(deduped.values());
    }

    private View callFavoritesStrip(List<RecentCallItem> favorites) {
        HorizontalScrollView scroll = new HorizontalScrollView(this);
        scroll.setHorizontalScrollBarEnabled(false);
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        for (int i = 0; i < favorites.size(); i++) {
            RecentCallItem item = favorites.get(i);
            row.addView(callFavoriteChip(item), wrapRight(i == favorites.size() - 1 ? 0 : 10));
        }
        scroll.addView(row);
        return scroll;
    }

    private View callFavoriteChip(RecentCallItem item) {
        String accent = callTypeAccent(item.type);
        LinearLayout chip = new LinearLayout(this);
        chip.setOrientation(LinearLayout.VERTICAL);
        chip.setGravity(Gravity.CENTER);
        chip.setPadding(dp(12), dp(10), dp(12), dp(10));
        chip.setMinimumWidth(dp(92));
        chip.setBackground(roundRect("#ffffff", "#e5e5ea", 18));
        chip.setClickable(true);
        chip.setFocusable(true);
        chip.setOnClickListener(v -> showDialerSheet(item.number, item.name));
        chip.addView(iconTile(R.drawable.ic_db_call, accent, 34, 12, 18), fixed(34, 34, 0));
        TextView name = singleLineText(firstNonEmptyValue(item.name, item.number, "Call"), 12, "#111111", true);
        name.setGravity(Gravity.CENTER);
        chip.addView(name, fullWidth(2));
        TextView detail = singleLineText(callTypeLabel(item.type), 10, "#8e8e93", false);
        detail.setGravity(Gravity.CENTER);
        chip.addView(detail);
        return chip;
    }

    private View workspaceHeroCard(String title, String detail, int iconRes, String accent, String badgeText) {
        LinearLayout hero = card(14, 22);
        hero.setBackground(softTint(accent, 22));

        LinearLayout top = new LinearLayout(this);
        top.setGravity(Gravity.CENTER_VERTICAL);
        top.addView(iconTile(iconRes, accent, 42, 14, 22), fixed(42, 42, 10));

        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        copy.addView(text(title, 18, "#0f172a", true));
        copy.addView(text(detail, 12, "#475569", false));
        top.addView(copy, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        if (!safe(badgeText).trim().isEmpty()) {
            top.addView(pill(badgeText, "#ffffff", "#0f172a"));
        }

        hero.addView(top, fullWidth(0));
        return hero;
    }

    private View iosLargeTitleHeader(String title, String subtitle) {
        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.VERTICAL);
        header.setBackgroundColor(color("#f2f2f7"));
        header.addView(text(title, 32, "#111111", true), fullWidth(2));
        if (!safe(subtitle).trim().isEmpty()) {
            header.addView(text(subtitle, 12, "#8e8e93", false));
        }
        return header;
    }

    private View communicationActionRow(View first, View second) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.addView(first, weighted(8));
        row.addView(second, weighted(0));
        return row;
    }

    private View communicationShortcut(String title, String detail, int iconRes, String accent, Runnable action) {
        LinearLayout actionView = new LinearLayout(this);
        actionView.setOrientation(LinearLayout.HORIZONTAL);
        actionView.setGravity(Gravity.CENTER_VERTICAL);
        actionView.setPadding(dp(12), dp(10), dp(12), dp(10));
        actionView.setBackground(roundRect("#ffffff", "#e5e5ea", 18));
        actionView.setClickable(true);
        actionView.setFocusable(true);
        actionView.setOnClickListener(v -> runGuarded("comm-shortcut:" + title, action));
        actionView.addView(iconTile(iconRes, accent, 34, 12, 18), fixed(34, 34, 10));
        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        copy.addView(text(title, 14, "#111111", true));
        if (!safe(detail).trim().isEmpty()) {
            copy.addView(text(detail, 11, "#8e8e93", false));
        }
        actionView.addView(copy, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        return actionView;
    }

    private void showContactActionSheet(String name, String number) {
        String cleanName = safe(name).trim();
        String cleanNumber = safe(number).trim();
        Dialog dialog = createBottomSheetDialog();
        LinearLayout sheet = new LinearLayout(this);
        sheet.setOrientation(LinearLayout.VERTICAL);
        sheet.setPadding(dp(14), dp(14), dp(14), dp(14));
        sheet.setBackground(roundRect("#ffffff", "#ffffff", 24));

        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.VERTICAL);
        header.setGravity(Gravity.CENTER_HORIZONTAL);
        header.addView(smsAvatar(cleanName.isEmpty() ? "#" : cleanName.substring(0, 1).toUpperCase(Locale.US), false), fixed(56, 56, 0));
        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        copy.setGravity(Gravity.CENTER_HORIZONTAL);
        copy.addView(text(firstNonEmptyValue(cleanName, cleanNumber), 20, "#111111", true));
        copy.addView(text(cleanNumber, 13, "#8e8e93", false));
        header.addView(copy, fullWidth(8));
        sheet.addView(header, fullWidth(10));

        LinearLayout actionRow = new LinearLayout(this);
        actionRow.setOrientation(LinearLayout.HORIZONTAL);
        actionRow.setGravity(Gravity.CENTER_VERTICAL);
        actionRow.addView(contactQuickAction("Message", R.drawable.ic_db_sms, "#34c759", () -> {
            dialog.dismiss();
            openSmsComposerForContact(cleanName, cleanNumber);
        }), weighted(8));
        actionRow.addView(contactQuickAction("Call", R.drawable.ic_db_call, "#0a84ff", () -> {
            dialog.dismiss();
            showDialerSheet(cleanNumber, cleanName);
        }), weighted(8));
        actionRow.addView(contactQuickAction("Edit", R.drawable.ic_db_tune, "#ff9500", () -> {
            dialog.dismiss();
            openEditContact(cleanName, cleanNumber);
        }), weighted(8));
        actionRow.addView(contactQuickAction("Copy", R.drawable.ic_db_copy, "#8e8e93", () -> {
            dialog.dismiss();
            copyText(cleanNumber);
        }), weighted(0));
        sheet.addView(actionRow, fullWidth(10));

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(12), dp(12), dp(12), dp(12));
        card.setBackground(roundRect("#f2f2f7", "#e5e5ea", 18));
        card.addView(contactInfoLine("mobile", cleanNumber), fullWidth(8));
        card.addView(contactInfoLine("source", cleanName.isEmpty() ? "Phone number" : "Saved contact"));
        sheet.addView(card, fullWidth(10));

        sheet.addView(labelIconButton("Open in Contacts", R.drawable.ic_db_person, "#ffffff", "#0a84ff", () -> {
            dialog.dismiss();
            selectTab(TAB_CONTACTS);
        }));

        sheet.addView(iconAction(R.drawable.ic_db_close, "#ffffff", "#0a84ff", dialog::dismiss), fullWidth(0));

        showFixedBottomSheetDialog(dialog, sheet);
    }

    private void openEditContact(String name, String number) {
        String cleanName = safe(name).trim();
        String cleanNumber = safe(number).trim();
        Intent intent;
        Uri existing = contactLookupUri(cleanNumber);
        if (existing != null) {
            intent = new Intent(Intent.ACTION_EDIT, existing);
            intent.putExtra("finishActivityOnSaveCompleted", true);
        } else {
            intent = new Intent(ContactsContract.Intents.Insert.ACTION);
            intent.setType(ContactsContract.RawContacts.CONTENT_TYPE);
        }
        if (!cleanName.isEmpty()) {
            intent.putExtra(ContactsContract.Intents.Insert.NAME, cleanName);
        }
        if (!cleanNumber.isEmpty()) {
            intent.putExtra(ContactsContract.Intents.Insert.PHONE, cleanNumber);
        }
        try {
            startActivity(intent);
        } catch (RuntimeException error) {
            showSnack("Unable to open contact editor.");
        }
    }

    private Uri contactLookupUri(String number) {
        String cleanNumber = safe(number).trim();
        if (cleanNumber.isEmpty() || !hasContactsPermission()) {
            return null;
        }
        Cursor cursor = null;
        try {
            Uri lookup = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(cleanNumber));
            cursor = getContentResolver().query(
                    lookup,
                    new String[]{ContactsContract.PhoneLookup._ID, ContactsContract.PhoneLookup.LOOKUP_KEY},
                    null,
                    null,
                    null
            );
            if (cursor == null || !cursor.moveToFirst()) {
                return null;
            }
            int idIndex = cursor.getColumnIndex(ContactsContract.PhoneLookup._ID);
            int lookupIndex = cursor.getColumnIndex(ContactsContract.PhoneLookup.LOOKUP_KEY);
            if (idIndex < 0 || lookupIndex < 0) {
                return null;
            }
            long id = cursor.getLong(idIndex);
            String lookupKey = cursor.getString(lookupIndex);
            if (lookupKey == null || lookupKey.trim().isEmpty()) {
                return null;
            }
            return ContactsContract.Contacts.getLookupUri(id, lookupKey);
        } catch (RuntimeException error) {
            BridgeEventLog.append(this, "contacts: edit lookup failed " + error.getMessage());
            return null;
        } finally {
            if (cursor != null) {
                cursor.close();
            }
        }
    }

    private View contactQuickAction(String label, int iconRes, String accent, Runnable action) {
        LinearLayout actionView = new LinearLayout(this);
        actionView.setOrientation(LinearLayout.VERTICAL);
        actionView.setGravity(Gravity.CENTER);
        actionView.setPadding(dp(8), dp(10), dp(8), dp(10));
        actionView.setBackground(roundRect("#ffffff", "#e5e5ea", 18));
        actionView.setClickable(true);
        actionView.setFocusable(true);
        actionView.setOnClickListener(v -> runGuarded("contact-quick:" + label, action));
        actionView.addView(iconTile(iconRes, accent, 36, 12, 18), fixed(36, 36, 0));
        TextView labelView = text(label, 11, accent, true);
        labelView.setGravity(Gravity.CENTER);
        actionView.addView(labelView, fullWidth(2));
        return actionView;
    }

    private void openSmsComposerForContact(String name, String number) {
        selectedTabIndex = TAB_SMS;
        selectedSmsThread = null;
        smsMessages = new ArrayList<>();
        smsBulkMode = false;
        selectedSmsThreadKeys.clear();
        composingNewSms = true;
        clearNewSmsDraft();
        addNewSmsRecipient(name, number);
        newSmsContactQuery = "";
        scheduleRefresh();
        rebuild();
    }

    private void showDialerSheet(String presetNumber, String presetName) {
        Dialog dialog = createBottomSheetDialog();
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(dp(12), dp(12), dp(12), dp(12));
        form.setBackground(roundRect("#ffffff", "#ffffff", 20));

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.addView(iconTile(R.drawable.ic_db_call, "#0a84ff", 38, 12, 20), fixed(38, 38, 8));
        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        copy.addView(text("Phone", 16, "#111111", true));
        copy.addView(text("Number pad for a new call.", 11, "#8e8e93", false));
        header.addView(copy, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        header.addView(iconAction(R.drawable.ic_db_close, "#ffffff", "#0a84ff", dialog::dismiss));
        form.addView(header, fullWidth(8));

        TextView selected = text(
                safe(presetName).trim().isEmpty() ? "Manual dial" : "Selected: " + presetName.trim(),
                11,
                "#111111",
                true
        );
        selected.setBackground(roundRect("#f8fafc", "#e2e8f0", 999));
        selected.setPadding(dp(10), dp(6), dp(10), dp(6));
        form.addView(selected, fullWidth(6));

        String cleanPresetName = safe(presetName).trim();
        String[] numberState = new String[]{safe(presetNumber).trim()};

        LinearLayout displayCard = new LinearLayout(this);
        displayCard.setOrientation(LinearLayout.VERTICAL);
        displayCard.setPadding(dp(12), dp(10), dp(12), dp(10));
        displayCard.setBackground(roundRect("#f8fafc", "#dbe3ef", 16));

        TextView display = text(numberState[0].isEmpty() ? "Enter number" : numberState[0], 22, numberState[0].isEmpty() ? "#94a3b8" : "#0f172a", true);
        display.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        display.setSingleLine(true);
        display.setEllipsize(TextUtils.TruncateAt.START);
        displayCard.addView(display, fullWidth(4));

        TextView displayHint = text(
                cleanPresetName.isEmpty() ? "Phone number pad" : "Selected contact: " + cleanPresetName,
                10,
                "#64748b",
                false
        );
        displayCard.addView(displayHint);
        form.addView(displayCard, fullWidth(6));

        Runnable refreshDialer = () -> {
            String value = numberState[0].trim();
            boolean hasValue = !value.isEmpty();
            display.setText(hasValue ? value : "Enter number");
            display.setTextColor(color(hasValue ? "#0f172a" : "#94a3b8"));
            displayHint.setText(cleanPresetName.isEmpty() ? "Phone number pad" : "Selected contact: " + cleanPresetName);
        };

        String[][] digits = new String[][]{
                {"1", "", "2", "ABC", "3", "DEF"},
                {"4", "GHI", "5", "JKL", "6", "MNO"},
                {"7", "PQRS", "8", "TUV", "9", "WXYZ"},
                {"*", "", "0", "+", "#", ""}
        };
        for (String[] rowDigits : digits) {
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.addView(dialPadButton(rowDigits[0], rowDigits[1], () -> {
                numberState[0] = numberState[0] + rowDigits[0];
                refreshDialer.run();
            }), weighted(8));
            row.addView(dialPadButton(rowDigits[2], rowDigits[3], () -> {
                numberState[0] = numberState[0] + rowDigits[2];
                refreshDialer.run();
            }), weighted(8));
            row.addView(dialPadButton(rowDigits[4], rowDigits[5], () -> {
                numberState[0] = numberState[0] + rowDigits[4];
                refreshDialer.run();
            }), weighted(0));
            form.addView(row, fullWidth(6));
        }

        form.addView(text(
                BridgeConfig.load(this).hasDashboardAccess()
                        ? "Call will be requested through the selected dashboard device."
                        : "Call will be placed directly from this phone.",
                11,
                "#8e8e93",
                false
        ), fullWidth(6));

        LinearLayout tools = new LinearLayout(this);
        tools.setGravity(Gravity.CENTER_VERTICAL);
        tools.addView(iconAction(R.drawable.ic_db_back, "#f8fafc", "#0f172a", () -> {
            if (!numberState[0].isEmpty()) {
                numberState[0] = numberState[0].substring(0, numberState[0].length() - 1);
                refreshDialer.run();
            }
        }), fixed(38, 38, 8));
        tools.addView(iconAction(R.drawable.ic_db_clean, "#fff7ed", "#9a3412", () -> {
            numberState[0] = "";
            refreshDialer.run();
        }), fixed(38, 38, 8));
        tools.addView(labelIconButton("Contact", R.drawable.ic_db_person, "#ffffff", "#0a84ff", () -> {
            dialog.dismiss();
            showContactPickerSheet("Select number", (name, phone) -> showDialerSheet(phone, name));
        }), new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        form.addView(tools, fullWidth(6));

        LinearLayout actions = new LinearLayout(this);
        actions.setGravity(Gravity.CENTER_VERTICAL);
        actions.addView(labelIconButton("Cancel", R.drawable.ic_db_close, "#f8fafc", "#0f172a", dialog::dismiss), weighted(8));
        actions.addView(labelIconButton("Call", R.drawable.ic_db_call, "#0a84ff", "#ffffff", () -> {
            dialog.dismiss();
            placePhoneCall(numberState[0], true);
        }), weighted(0));
        form.addView(actions);

        refreshDialer.run();
        showBottomSheetDialog(dialog, form);
    }

    private View dialPadButton(String digit, String letters, Runnable action) {
        LinearLayout button = new LinearLayout(this);
        button.setOrientation(LinearLayout.VERTICAL);
        button.setGravity(Gravity.CENTER);
        button.setPadding(dp(6), dp(8), dp(6), dp(8));
        button.setMinimumHeight(dp(56));
        button.setBackground(roundRect("#ffffff", "#dbe3ef", 16));
        button.setClickable(true);
        button.setFocusable(true);
        button.setOnClickListener(v -> runGuarded("dial-pad:" + digit, action));

        TextView digitView = text(digit, 21, "#0f172a", true);
        digitView.setGravity(Gravity.CENTER);
        digitView.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        button.addView(digitView, fullWidth(2));

        TextView lettersView = text(letters.isEmpty() ? " " : letters, 8, "#64748b", true);
        lettersView.setGravity(Gravity.CENTER);
        button.addView(lettersView);
        return button;
    }

    private void placePhoneCall(String number, boolean directCall) {
        String cleanNumber = safe(number).trim();
        if (cleanNumber.isEmpty()) {
            showSnack("Phone number is required.");
            return;
        }
        BridgeConfig config = BridgeConfig.load(this);
        if (!config.hasDashboardAccess()) {
            placeLocalPhoneCall(cleanNumber);
            return;
        }
        String deviceId = activeCommunicationDeviceId();
        int simSlot = activeCommunicationSimSlot();
        new Thread(() -> {
            try {
                DashboardApiClient.dialCall(config, deviceId, simSlot, cleanNumber);
                runOnUiThread(() -> {
                    showSnack("Call requested.");
                    loadDashboardCallLog(false);
                });
            } catch (Exception error) {
                runOnUiThread(() -> showSnack(error.getMessage() == null ? "Failed to request call." : error.getMessage()));
            }
        }, "dashboard-call-dial").start();
    }

    private void placeLocalPhoneCall(String cleanNumber) {
        if (checkSelfPermission(Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) {
            requestCallFeature();
            showSnack("Allow call access to place calls from this phone.");
            return;
        }
        try {
            Intent callIntent = new Intent(Intent.ACTION_CALL, Uri.parse("tel:" + Uri.encode(cleanNumber)));
            callIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(callIntent);
            showSnack("Calling from this phone.");
        } catch (SecurityException error) {
            requestCallFeature();
            showSnack("Call permission is required.");
        } catch (RuntimeException error) {
            showSnack(error.getMessage() == null ? "Unable to place call." : error.getMessage());
        }
    }

    private boolean hasCallLogPermission() {
        return checkSelfPermission(Manifest.permission.READ_CALL_LOG) == PackageManager.PERMISSION_GRANTED;
    }

    private List<RecentCallItem> dashboardRecentCallItems(int limit) {
        List<RecentCallItem> items = new ArrayList<>();
        int max = Math.max(1, limit);
        for (Map<String, Object> row : dashboardCallLog) {
            if (items.size() >= max) break;
            items.add(new RecentCallItem(
                    stringValue(row.get("name")),
                    stringValue(row.get("number")),
                    intValue(row.get("type")),
                    longValue(row.get("date")),
                    longValue(row.get("durationSeconds"))
            ));
        }
        return items;
    }

    private void loadDashboardCallLog(boolean rebuildAfter) {
        BridgeConfig config = BridgeConfig.load(this);
        if (!config.hasDashboardAccess() || callLogLoading) {
            return;
        }
        callLogLoading = true;
        String deviceId = activeCommunicationDeviceId();
        int simSlot = activeCommunicationSimSlot();
        new Thread(() -> {
            try {
                List<Map<String, Object>> calls = DashboardApiClient.fetchRecentCalls(config, deviceId, simSlot, 20);
                runOnUiThread(() -> {
                    dashboardCallLog = calls;
                    callLogLoading = false;
                    if (rebuildAfter || selectedTabIndex == TAB_PHONE) rebuild();
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    callLogLoading = false;
                    BridgeEventLog.append(this, "dashboard: call log failed " + error.getMessage());
                    if (rebuildAfter || selectedTabIndex == TAB_PHONE) rebuild();
                });
            }
        }, "dashboard-call-log").start();
    }

    private List<RecentCallItem> recentCallLogItems(int limit) {
        List<RecentCallItem> items = new ArrayList<>();
        if (!hasCallLogPermission()) {
            return items;
        }

        Cursor cursor = null;
        try {
            cursor = getContentResolver().query(
                    CallLog.Calls.CONTENT_URI,
                    new String[]{
                            CallLog.Calls.CACHED_NAME,
                            CallLog.Calls.NUMBER,
                            CallLog.Calls.TYPE,
                            CallLog.Calls.DATE,
                            CallLog.Calls.DURATION
                    },
                    null,
                    null,
                    CallLog.Calls.DEFAULT_SORT_ORDER
            );
            if (cursor == null) {
                return items;
            }

            int nameIndex = cursor.getColumnIndex(CallLog.Calls.CACHED_NAME);
            int numberIndex = cursor.getColumnIndex(CallLog.Calls.NUMBER);
            int typeIndex = cursor.getColumnIndex(CallLog.Calls.TYPE);
            int dateIndex = cursor.getColumnIndex(CallLog.Calls.DATE);
            int durationIndex = cursor.getColumnIndex(CallLog.Calls.DURATION);

            while (cursor.moveToNext() && items.size() < limit) {
                items.add(new RecentCallItem(
                        nameIndex >= 0 ? safe(cursor.getString(nameIndex)).trim() : "",
                        numberIndex >= 0 ? safe(cursor.getString(numberIndex)).trim() : "",
                        typeIndex >= 0 ? cursor.getInt(typeIndex) : 0,
                        dateIndex >= 0 ? cursor.getLong(dateIndex) : 0L,
                        durationIndex >= 0 ? cursor.getLong(durationIndex) : 0L
                ));
            }
        } catch (SecurityException error) {
            BridgeEventLog.append(this, "call-log: permission denied " + error.getMessage());
        } catch (RuntimeException error) {
            BridgeEventLog.append(this, "call-log: query failed " + error.getMessage());
        } finally {
            if (cursor != null) {
                cursor.close();
            }
        }
        return items;
    }

    private String callTypeLabel(int type) {
        switch (type) {
            case CallLog.Calls.INCOMING_TYPE:
                return "Incoming";
            case CallLog.Calls.OUTGOING_TYPE:
                return "Outgoing";
            case CallLog.Calls.MISSED_TYPE:
                return "Missed";
            case CallLog.Calls.REJECTED_TYPE:
                return "Rejected";
            case CallLog.Calls.BLOCKED_TYPE:
                return "Blocked";
            case CallLog.Calls.VOICEMAIL_TYPE:
                return "Voicemail";
            default:
                return "Call";
        }
    }

    private String callTypeShortLabel(int type) {
        switch (type) {
            case CallLog.Calls.INCOMING_TYPE:
                return "IN";
            case CallLog.Calls.OUTGOING_TYPE:
                return "OUT";
            case CallLog.Calls.MISSED_TYPE:
                return "MISS";
            case CallLog.Calls.REJECTED_TYPE:
                return "REJ";
            case CallLog.Calls.BLOCKED_TYPE:
                return "BLOCK";
            case CallLog.Calls.VOICEMAIL_TYPE:
                return "VM";
            default:
                return "CALL";
        }
    }

    private String callTypeAccent(int type) {
        switch (type) {
            case CallLog.Calls.INCOMING_TYPE:
                return "#0b5ed7";
            case CallLog.Calls.OUTGOING_TYPE:
                return "#0f766e";
            case CallLog.Calls.MISSED_TYPE:
            case CallLog.Calls.REJECTED_TYPE:
                return "#dc2626";
            case CallLog.Calls.BLOCKED_TYPE:
                return "#7c3aed";
            case CallLog.Calls.VOICEMAIL_TYPE:
                return "#d97706";
            default:
                return "#475569";
        }
    }

    private String formatCallDuration(long durationSeconds) {
        if (durationSeconds <= 0) {
            return "";
        }
        long hours = durationSeconds / 3600L;
        long minutes = (durationSeconds % 3600L) / 60L;
        long seconds = durationSeconds % 60L;
        if (hours > 0) {
            return String.format(Locale.US, "%dh %02dm", hours, minutes);
        }
        if (minutes > 0) {
            return String.format(Locale.US, "%dm %02ds", minutes, seconds);
        }
        return String.format(Locale.US, "%ds", seconds);
    }

    private void applyRequestedTab(Intent intent) {
        int requestedTab = intent == null ? TAB_HOME : intent.getIntExtra(EXTRA_START_TAB, TAB_HOME);
        selectedTabIndex = normalizeTab(requestedTab);
    }

    private int normalizeTab(int tab) {
        if (tab < TAB_HOME || tab > TAB_PHONE) {
            return TAB_HOME;
        }
        return tab;
    }

    private View consoleRow(Map<String, Object> entry) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.VERTICAL);
        row.setPadding(dp(7), dp(5), dp(7), dp(5));
        row.setBackground(roundRect("#111827", "#1f2937", 0));
        row.setClickable(true);
        row.setFocusable(true);
        row.setOnClickListener(v -> runGuarded("console-detail", () -> showConsoleDetail(entry)));
        LinearLayout title = new LinearLayout(this);
        title.setGravity(Gravity.CENTER_VERTICAL);
        title.addView(singleLineText(shortConsoleEventName(entry), 11, "#ffffff", true), new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        title.addView(logBadge(typeLabel(stringValue(entry.get("type"), consoleCategory(entry))), "#14b8a6"), wrapRight(3));
        title.addView(logBadge(levelLabel(entry), levelColor(entry)), wrapRight(0));
        row.addView(title, fullWidth(3));
        row.addView(singleLineText(stringValue(entry.get("timestamp")) + "  " + stringValue(entry.get("detail")), 10, "#94a3b8", false));
        return row;
    }

    private View filterChip(String label, boolean active, Runnable action) {
        TextView chip = text(label, 11, active ? "#ffffff" : "#0f172a", true);
        chip.setGravity(Gravity.CENTER);
        chip.setPadding(dp(10), dp(7), dp(10), dp(7));
        chip.setBackground(roundRect(active ? "#0f766e" : "#111827", active ? "#0f766e" : "#334155", 999));
        if (!active) {
            chip.setTextColor(color("#e2e8f0"));
        }
        chip.setOnClickListener(v -> runGuarded("filter:" + label, action));
        return chip;
    }

    private View consoleSelect(String label, String selected, LinkedHashMap<String, String> options, String accent, ValueCallback callback) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(7), dp(5), dp(7), dp(5));
        box.setBackground(roundRect("#111827", accent, 12));
        TextView title = singleLineText(label, 9, "#94a3b8", true);
        title.setPadding(0, 0, 0, dp(2));
        box.addView(title, fullWidth(0));
        List<String> values = new ArrayList<>(options.keySet());
        List<String> labels = new ArrayList<>();
        for (String value : values) {
            labels.add(options.get(value));
        }
        Spinner spinner = new Spinner(this, Spinner.MODE_DROPDOWN);
        ArrayAdapter<String> adapter = new ArrayAdapter<String>(this, android.R.layout.simple_spinner_item, labels) {
            @Override
            public View getView(int position, View convertView, ViewGroup parent) {
                TextView view = (TextView) super.getView(position, convertView, parent);
                view.setTextColor(color("#ffffff"));
                view.setTextSize(12);
                view.setTypeface(Typeface.DEFAULT_BOLD);
                view.setSingleLine(true);
                view.setEllipsize(TextUtils.TruncateAt.END);
                view.setGravity(Gravity.CENTER_VERTICAL);
                view.setPadding(0, 0, 0, dp(2));
                return view;
            }

            @Override
            public View getDropDownView(int position, View convertView, ViewGroup parent) {
                TextView view = (TextView) super.getDropDownView(position, convertView, parent);
                view.setTextColor(color("#0f172a"));
                view.setTextSize(12);
                view.setSingleLine(true);
                view.setEllipsize(TextUtils.TruncateAt.END);
                view.setPadding(dp(12), dp(10), dp(12), dp(10));
                return view;
            }
        };
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        spinner.setAdapter(adapter);
        int selectedIndex = Math.max(0, values.indexOf(selected));
        spinner.setSelection(selectedIndex, false);
        spinner.setBackgroundColor(Color.TRANSPARENT);
        spinner.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                if (position < 0 || position >= values.size()) {
                    return;
                }
                String nextValue = values.get(position);
                if (nextValue.equals(selected)) {
                    return;
                }
                callback.onValue(nextValue);
            }

            @Override
            public void onNothingSelected(AdapterView<?> parent) {
            }
        });
        box.addView(spinner, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(30)));
        return box;
    }

    private LinkedHashMap<String, String> consoleTypeOptions() {
        LinkedHashMap<String, String> options = new LinkedHashMap<>();
        options.put("all", "All");
        LinkedHashMap<String, String> labels = new LinkedHashMap<>();
        labels.put("sms", "SMS");
        labels.put("call", "Call");
        labels.put("ussd", "USSD");
        labels.put("network", "Network");
        labels.put("setup", "Setup");
        labels.put("system", "System");
        List<String> orderedKeys = Arrays.asList("sms", "call", "ussd", "network", "setup", "system");
        Set<String> present = new HashSet<>();
        for (Map<String, Object> entry : consoleEntries()) {
            present.add(consoleCategory(entry));
        }
        for (String key : orderedKeys) {
            if (present.contains(key)) {
                options.put(key, labels.get(key));
            }
        }
        return options;
    }

    private LinkedHashMap<String, String> consoleLevelOptions() {
        LinkedHashMap<String, String> options = new LinkedHashMap<>();
        options.put("all", "All");
        options.put("info", "Info");
        options.put("warn", "Warn");
        options.put("error", "Error");
        return options;
    }

    private View outlineAction(String label, Runnable action) {
        Button button = chipButton(label, "#f8fafc", "#0f172a");
        button.setOnClickListener(v -> runGuarded("outline-action", action));
        return button;
    }

    private View darkAction(String label, int iconRes, Runnable action) {
        return labelIconButton(label, iconRes, "#0f172a", "#ffffff", action);
    }

    private View progressTrack(String accent) {
        LinearLayout track = new LinearLayout(this);
        track.setBackground(roundRect("#e2e8f0", "#e2e8f0", 999));
        View fill = new View(this);
        fill.setBackground(roundRect(accent, accent, 999));
        track.addView(fill, new LinearLayout.LayoutParams(0, dp(4), 1f));
        track.addView(new View(this), new LinearLayout.LayoutParams(0, dp(4), 1f));
        return track;
    }

    private View emptyLine(String text) {
        TextView line = text(text, 12, "#64748b", false);
        line.setPadding(0, dp(10), 0, dp(10));
        return line;
    }

    private View busyBar(String label) {
        TextView view = text(label, 13, "#ffffff", true);
        view.setGravity(Gravity.CENTER);
        view.setPadding(dp(12), dp(10), dp(12), dp(10));
        view.setBackground(roundRect("#0f172a", "#0f172a", 999));
        return view;
    }

    private FrameLayout.LayoutParams busyBarParams() {
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.TOP | Gravity.CENTER_HORIZONTAL
        );
        params.topMargin = dp(18);
        return params;
    }

    private void showPasteCodeDialog() {
        Dialog dialog = createBottomSheetDialog();
        LinearLayout sheet = new LinearLayout(this);
        sheet.setOrientation(LinearLayout.VERTICAL);
        sheet.setPadding(dp(14), dp(14), dp(14), dp(14));
        sheet.setBackground(roundRect("#ffffff", "#ffffff", 24));

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.addView(iconTile(R.drawable.ic_db_key, "#0f766e", 42, 14, 22), fixed(42, 42, 10));
        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        copy.addView(text("Enter secure token", 18, "#0f172a", true));
        copy.addView(text("Paste the encoded setup token from dashboard.", 12, "#64748b", false));
        header.addView(copy, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        sheet.addView(header, fullWidth(12));

        EditText input = input("Setup code");
        input.setSingleLine(false);
        input.setMinLines(4);
        input.setGravity(Gravity.TOP | Gravity.START);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        sheet.addView(input, fullWidth(12));

        LinearLayout actions = new LinearLayout(this);
        actions.setGravity(Gravity.CENTER_VERTICAL);
        actions.addView(labelIconButton("Paste", R.drawable.ic_db_copy, "#f8fafc", "#0f172a", () -> {
            ClipboardManager clipboard = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            ClipData clip = clipboard == null ? null : clipboard.getPrimaryClip();
            if (clip != null && clip.getItemCount() > 0) {
                CharSequence text = clip.getItemAt(0).coerceToText(this);
                input.setText(text == null ? "" : text.toString().trim());
            }
        }), weighted(8));
        actions.addView(labelIconButton("Connect", R.drawable.ic_db_arrow_forward, "#0f766e", "#ffffff", () -> {
            String code = input.getText().toString().trim();
            dialog.dismiss();
            importSetupCode(code, "Importing secure code...", false);
        }), weighted(0));
        sheet.addView(actions);
        showFixedBottomSheetDialog(dialog, sheet);
        input.requestFocus();
        input.postDelayed(() -> {
            InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
            if (imm != null) {
                imm.showSoftInput(input, InputMethodManager.SHOW_IMPLICIT);
            }
        }, 250L);
    }

    private void showNewConversationDialog() {
        Dialog dialog = createBottomSheetDialog();
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(dp(14), dp(14), dp(14), dp(14));
        form.setBackground(roundRect("#ffffff", "#ffffff", 24));
        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.addView(iconTile(R.drawable.ic_db_sms, "#2563eb", 42, 14, 22), fixed(42, 42, 10));
        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        copy.addView(text("New message", 18, "#0f172a", true));
        copy.addView(text("Start an outgoing SMS from this device.", 12, "#64748b", false));
        header.addView(copy, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        form.addView(header, fullWidth(12));
        EditText number = input("Phone number");
        number.setInputType(InputType.TYPE_CLASS_PHONE);
        EditText contactSearch = input("Search contacts");
        contactSearch.setSingleLine(true);
        LinearLayout contactsBox = new LinearLayout(this);
        contactsBox.setOrientation(LinearLayout.VERTICAL);
        contactsBox.setBackground(roundRect("#f8fafc", "#e2e8f0", 16));
        contactsBox.setPadding(dp(6), dp(6), dp(6), dp(6));
        contactSearch.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {
            }

            @Override
            public void onTextChanged(CharSequence s, int start, int before, int count) {
                renderContactMatches(contactsBox, s.toString(), (name, phone) -> {
                    number.setText(phone);
                    contactSearch.setText(name);
                    contactsBox.removeAllViews();
                });
            }

            @Override
            public void afterTextChanged(Editable s) {
            }
        });
        renderContactMatches(contactsBox, "", (name, phone) -> {
            number.setText(phone);
            contactSearch.setText(name);
            contactsBox.removeAllViews();
        });
        EditText message = input("Message");
        message.setSingleLine(false);
        message.setMinLines(3);
        message.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        form.addView(contactSearch, fullWidth(8));
        form.addView(contactsBox, fullWidth(10));
        form.addView(number, fullWidth(10));
        form.addView(message, fullWidth(12));
        LinearLayout actions = new LinearLayout(this);
        actions.setGravity(Gravity.CENTER_VERTICAL);
        actions.addView(labelIconButton("Cancel", R.drawable.ic_db_arrow_forward, "#f8fafc", "#0f172a", dialog::dismiss), weighted(8));
        actions.addView(labelIconButton("Send", R.drawable.ic_db_sms, "#2563eb", "#ffffff", () -> {
            String cleanNumber = number.getText().toString().trim();
            String cleanMessage = message.getText().toString().trim();
            if (cleanNumber.isEmpty() || cleanMessage.isEmpty()) {
                showSnack("Number and message are required.");
                return;
            }
            dialog.dismiss();
            sendSmsFromComposer(cleanMessage, cleanNumber);
        }), weighted(0));
        form.addView(actions);
        showBottomSheetDialog(dialog, form);
        number.requestFocus();
    }

    private void showSmsAttachmentSheet(EditText composer) {
        Dialog dialog = createBottomSheetDialog();
        LinearLayout sheet = new LinearLayout(this);
        sheet.setOrientation(LinearLayout.VERTICAL);
        sheet.setPadding(dp(14), dp(14), dp(14), dp(14));
        sheet.setBackground(roundRect("#ffffff", "#ffffff", 24));
        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.addView(iconTile(R.drawable.ic_db_add, "#0b5ed7", 42, 14, 22), fixed(42, 42, 10));
        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        copy.addView(text("Attach to SMS", 18, "#0f172a", true));
        copy.addView(text("SMS supports text attachments from contacts or clipboard.", 12, "#64748b", false));
        header.addView(copy, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        header.addView(iconAction(R.drawable.ic_db_close, "#f8fafc", "#0f172a", dialog::dismiss));
        sheet.addView(header, fullWidth(12));
        sheet.addView(attachmentRow(R.drawable.ic_db_person, "Attach contact", "Search contacts and insert name + number.", "#0b5ed7", () -> {
            dialog.dismiss();
            showContactPickerSheet("Attach contact", (name, phone) -> appendComposerText(composer, name + " " + phone));
        }));
        sheet.addView(attachmentRow(R.drawable.ic_db_copy, "Paste text", "Insert current clipboard text into the message.", "#0f766e", () -> {
            ClipboardManager clipboard = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            ClipData clip = clipboard == null ? null : clipboard.getPrimaryClip();
            if (clip != null && clip.getItemCount() > 0) {
                CharSequence text = clip.getItemAt(0).coerceToText(this);
                appendComposerText(composer, text == null ? "" : text.toString());
            }
            dialog.dismiss();
        }));
        sheet.addView(attachmentRow(R.drawable.ic_db_clean, "Clear draft", "Remove current composer text.", "#dc2626", () -> {
            composer.setText("");
            dialog.dismiss();
        }));
        showFixedBottomSheetDialog(dialog, sheet);
    }

    private void showContactPickerSheet(String title, ContactCallback callback) {
        Dialog dialog = createBottomSheetDialog();
        LinearLayout sheet = new LinearLayout(this);
        sheet.setOrientation(LinearLayout.VERTICAL);
        sheet.setPadding(dp(14), dp(14), dp(14), dp(14));
        sheet.setBackground(roundRect("#ffffff", "#ffffff", 24));
        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.addView(iconTile(R.drawable.ic_db_person, "#0b5ed7", 42, 14, 22), fixed(42, 42, 10));
        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        copy.addView(text(title, 18, "#0f172a", true));
        copy.addView(text("Search device contacts by name or number.", 12, "#64748b", false));
        header.addView(copy, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        header.addView(iconAction(R.drawable.ic_db_close, "#f8fafc", "#0f172a", dialog::dismiss));
        sheet.addView(header, fullWidth(12));
        EditText search = input("Search contacts");
        search.setSingleLine(true);
        sheet.addView(search, fullWidth(8));
        LinearLayout results = new LinearLayout(this);
        results.setOrientation(LinearLayout.VERTICAL);
        results.setBackground(roundRect("#f8fafc", "#e2e8f0", 16));
        results.setPadding(dp(6), dp(6), dp(6), dp(6));
        ContactCallback wrapped = (name, phone) -> {
            callback.onContact(name, phone);
            dialog.dismiss();
        };
        renderContactMatches(results, "", wrapped);
        search.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {
            }

            @Override
            public void onTextChanged(CharSequence s, int start, int before, int count) {
                renderContactMatches(results, s.toString(), wrapped);
            }

            @Override
            public void afterTextChanged(Editable s) {
            }
        });
        sheet.addView(results);
        showBottomSheetDialog(dialog, sheet);
        search.requestFocus();
    }

    private void showSettingsSheet() {
        boolean online = boolValue(state.get("online"));
        boolean bridgeRunning = bridgeRunning();
        boolean callReady = boolValue(state.get("callFeatureReady"));
        boolean webcamReady = boolValue(state.get("webcamFeatureReady"));
        boolean intercomReady = boolValue(state.get("intercomFeatureReady"));
        boolean smsInboxReady = boolValue(state.get("smsInboxReady"));
        boolean batteryDisabled = boolValue(state.get("batteryOptimizationDisabled"));
        boolean permissionsReady = boolValue(state.get("permissionsReady"));
        Dialog dialog = createBottomSheetDialog();
        LinearLayout sheet = new LinearLayout(this);
        sheet.setOrientation(LinearLayout.VERTICAL);
        sheet.setPadding(dp(12), dp(12), dp(12), dp(14));
        sheet.setBackground(roundRect("#ffffff", "#ffffff", 24));
        sheet.addView(settingsHero(online), fullWidth(12));
        sheet.addView(settingsSectionHeader("Feature activation", "Optional controls stay off until you activate them here."), fullWidth(8));
        sheet.addView(settingsRow(R.drawable.ic_db_call, "Call controls", callReady ? "Dashboard call actions are active." : "Enable when dashboard needs call access.", callReady ? "Active" : "Activate", "#0f766e", callReady ? null : () -> {
            dialog.dismiss();
            requestCallFeature();
        }));
        sheet.addView(settingsRow(R.drawable.ic_db_video, "Webcam", webcamReady ? "Camera access is active for dashboard webcam features." : "Enable when dashboard needs camera access beyond QR setup.", webcamReady ? "Active" : "Activate", "#0b5ed7", webcamReady ? null : () -> {
            dialog.dismiss();
            requestWebcamFeature();
        }));
        sheet.addView(settingsRow(R.drawable.ic_db_mic, "Intercom", intercomReady ? "Microphone access is active for intercom features." : "Enable when dashboard needs intercom microphone access.", intercomReady ? "Active" : "Activate", "#7c3aed", intercomReady ? null : () -> {
            dialog.dismiss();
            requestIntercomFeature();
        }));
        sheet.addView(settingsRow(R.drawable.ic_db_sms, "SMS inbox", smsInboxReady ? "Threaded SMS inbox is active in the SMS tab." : "Enable local SMS read access for threaded conversations.", smsInboxReady ? "Active" : "Activate", "#2563eb", smsInboxReady ? null : () -> {
            dialog.dismiss();
            requestSmsInboxAccess();
        }));
        if (!batteryDisabled) {
            sheet.addView(settingsSectionHeader("Background protection", "Disable battery optimization so the bridge can stay alive after onboarding."), fullWidth(8));
            sheet.addView(settingsRow(R.drawable.ic_db_battery, "Battery optimization", "Android can stop the bridge in the background until this is disabled.", "Disable", "#ca8a04", () -> {
                dialog.dismiss();
                requestDisableBatteryOptimization();
            }));
        }
        sheet.addView(settingsSectionHeader("Bridge controls", "Runtime actions and recovery."), fullWidth(2));
        sheet.addView(sheetAction(bridgeRunning ? R.drawable.ic_db_pause : R.drawable.ic_db_play, bridgeRunning ? "Stop bridge" : "Start bridge", () -> {
            dialog.dismiss();
            runBridgeAction(bridgeRunning ? "stopBridge" : "startBridge");
        }));
        sheet.addView(sheetAction(R.drawable.ic_db_restart, "Reset bridge", () -> {
            dialog.dismiss();
            confirmResetOnboarding();
        }));
        if (!permissionsReady) {
            sheet.addView(settingsSectionHeader("Core bridge access", "Required permissions for bridge messaging."), fullWidth(2));
            sheet.addView(sheetAction(R.drawable.ic_db_tune, "Review bridge access", () -> {
                dialog.dismiss();
                startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).setData(Uri.parse("package:" + getPackageName())));
            }));
        }
        sheet.addView(sheetAction(R.drawable.ic_db_tune, "Open app settings", () -> {
            dialog.dismiss();
            startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).setData(Uri.parse("package:" + getPackageName())));
        }));
        showBottomSheetDialog(dialog, sheet);
    }

    private View settingsRow(int iconRes, String title, String detail, String actionLabel, String accent, Runnable action) {
        boolean enabled = action != null;
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(12), dp(10), dp(12), dp(10));
        row.setBackground(roundRect("#ffffff", "#e2e8f0", 18));
        row.addView(iconTile(iconRes, accent, 38, 12, 20), fixed(38, 38, 10));
        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        copy.addView(singleLineText(title, 14, "#0f172a", true));
        copy.addView(singleLineText(detail, 11, "#64748b", false));
        row.addView(copy, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        Button button = chipButton(actionLabel, enabled ? accent : "#cbd5e1", "#ffffff");
        button.setEnabled(enabled);
        if (enabled) {
            button.setOnClickListener(v -> runGuarded("settings:" + title, action));
        }
        row.addView(button);
        LinearLayout.LayoutParams params = fullWidth(8);
        row.setLayoutParams(params);
        return row;
    }

    private View attachmentRow(int iconRes, String title, String detail, String accent, Runnable action) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(12), dp(10), dp(12), dp(10));
        row.setBackground(roundRect("#ffffff", "#e2e8f0", 18));
        row.setClickable(true);
        row.setFocusable(true);
        row.setOnClickListener(v -> runGuarded("attachment:" + title, action));
        row.addView(iconTile(iconRes, accent, 38, 12, 20), fixed(38, 38, 10));
        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        copy.addView(singleLineText(title, 14, "#0f172a", true));
        copy.addView(singleLineText(detail, 11, "#64748b", false));
        row.addView(copy, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        return row;
    }

    private View settingsHero(boolean online) {
        LinearLayout hero = new LinearLayout(this);
        hero.setOrientation(LinearLayout.HORIZONTAL);
        hero.setGravity(Gravity.CENTER_VERTICAL);
        hero.setPadding(dp(12), dp(12), dp(12), dp(12));
        hero.setBackground(gradient("#f8fbff", "#f7fafc", 20, "#e2e8f0"));
        hero.addView(iconTile(R.drawable.ic_db_tune, online ? "#15803d" : "#475569", 38, 12, 20), fixed(38, 38, 10));
        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        copy.addView(text("Menu", 15, "#0f172a", true));
        copy.addView(text(online ? "Live bridge with optional controls." : "Bridge access and protection controls.", 11, "#64748b", false));
        hero.addView(copy, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        hero.addView(pill(online ? "Online" : "Review", online ? "#dcfce7" : "#fff7ed", "#334155"));
        return hero;
    }

    private View settingsSectionHeader(String title, String detail) {
        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.VERTICAL);
        header.addView(text(title, 13, "#111111", true), fullWidth(3));
        if (!safe(detail).trim().isEmpty()) {
            header.addView(text(detail, 12, "#8e8e93", false));
        }
        return header;
    }

    private View sheetAction(int iconRes, String label, Runnable action) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(0, dp(6), 0, dp(6));
        row.setClickable(true);
        row.setFocusable(true);
        row.setOnClickListener(v -> runGuarded("sheet:" + label, action));
        row.addView(iconTile(iconRes, "#0f172a", 38, 12, 20), fixed(38, 38, 10));
        row.addView(text(label, 14, "#0f172a", true), new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        return row;
    }

    private void showConnectivityDialog() {
        boolean online = boolValue(state.get("online"));
        int battery = state.get("batteryLevel") == null ? 0 : intValue(state.get("batteryLevel"));
        int readiness = intValue(state.get("readinessScore"));
        String transport = stringValue(state.get("transport"), "MQTT");
        String bridgeState = stringValue(state.get("bridgeState"), "Stopped");
        String batteryText = state.get("batteryLevel") == null ? "Unknown" : battery + "%";
        String linkDetail = stringValue(state.get("connectionDetail"), stringValue(state.get("connectionSummary"), "No link detail yet."));
        String deviceDetail = stringValue(state.get("deviceInfoDetail"), stringValue(state.get("deviceInfoSummary"), "No device detail yet."));
        List<InsightTab> tabs = new ArrayList<>();
        tabs.add(new InsightTab("Overview", () -> {
            LinearLayout root = new LinearLayout(this);
            root.setOrientation(LinearLayout.VERTICAL);
            LinearLayout row1 = new LinearLayout(this);
            row1.setOrientation(LinearLayout.HORIZONTAL);
            row1.addView(insightStatCard("Transport", transport, bridgeState, "#0b5ed7"), weighted(8));
            row1.addView(insightStatCard("Battery", batteryText, stringValue(state.get("batteryStatus"), "Unknown"), "#0f766e"), weighted(0));
            root.addView(row1, fullWidth(8));
            LinearLayout row2 = new LinearLayout(this);
            row2.setOrientation(LinearLayout.HORIZONTAL);
            row2.addView(insightStatCard("Readiness", readiness + "%", stringValue(state.get("readinessLabel"), "Needs setup"), "#1d4ed8"), weighted(8));
            row2.addView(insightStatCard("Last event", latestConsoleSummary(), "Latest bridge signal", "#7c3aed"), weighted(0));
            root.addView(row2, fullWidth(10));
            root.addView(insightGraphPanel("Power & readiness", Arrays.asList(
                    new InsightBar("Battery", battery, "#0f766e"),
                    new InsightBar("Readiness", readiness, "#0b5ed7")
            )));
            return root;
        }));
        tabs.add(new InsightTab("Link", () -> insightCodePanel("Link state", linkDetail.isEmpty() ? "No link detail yet." : linkDetail)));
        tabs.add(new InsightTab("Device", () -> insightCodePanel("Device detail", deviceDetail)));
        showTabbedInsightSheet(
                "Connectivity & Device",
                online ? "Online" : bridgeState,
                online ? "#16a34a" : "#f59e0b",
                "#0b5ed7",
                tabs,
                () -> copyText(linkDetail + "\n\n" + deviceDetail)
        );
    }

    private void showQueueDialog() {
        int success = intValue(state.get("publishSuccess"));
        int pending = intValue(state.get("queueDepth"));
        int failed = intValue(state.get("publishFailure"));
        int total = Math.max(0, success + pending + failed);
        int failRate = total == 0 ? 0 : Math.round((failed * 100f) / total);
        String actionDetail = "queue_depth  = " + pending
                + "\npublish_ok   = " + success
                + "\npublish_fail = " + failed
                + "\n\n" + stringValue(state.get("healthDetail"));
        String recent = recentActionLog();
        List<InsightTab> tabs = new ArrayList<>();
        tabs.add(new InsightTab("Summary", () -> {
            LinearLayout root = new LinearLayout(this);
            root.setOrientation(LinearLayout.VERTICAL);
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.addView(insightStatCard("Success", String.valueOf(success), "Delivered/published", "#16a34a"), weighted(8));
            row.addView(insightStatCard("Pending", String.valueOf(pending), "Still queued", "#f59e0b"), weighted(8));
            row.addView(insightStatCard("Failed", String.valueOf(failed), failRate + "% of total", "#dc2626"), weighted(0));
            root.addView(row, fullWidth(10));
            root.addView(insightGraphPanel("Action flow", Arrays.asList(
                    new InsightBar("Success", total == 0 ? 0 : Math.round((success * 100f) / total), "#16a34a"),
                    new InsightBar("Pending", total == 0 ? 0 : Math.round((pending * 100f) / total), "#f59e0b"),
                    new InsightBar("Failed", total == 0 ? 0 : Math.round((failed * 100f) / total), "#dc2626")
            )));
            return root;
        }));
        tabs.add(new InsightTab("Flow", () -> insightCodePanel("Action summary", actionDetail)));
        tabs.add(new InsightTab("Actions", () -> insightCodePanel("Recent action log", recent.isEmpty() ? "No dashboard action logs yet." : recent)));
        showTabbedInsightSheet(
                "Queue & Delivery",
                total == 0 ? "Idle" : failRate + "% fail",
                failed == 0 ? "#1d4ed8" : "#dc2626",
                "#1d4ed8",
                tabs,
                () -> copyText(actionDetail)
        );
    }

    private void showConsoleDetail(Map<String, Object> entry) {
        showDetailDialog("Console Entry", stringValue(entry.get("type"), "event"), consoleEntryJson(entry));
    }

    private void showTabbedInsightSheet(String title, String badge, String badgeColor, String accent, List<InsightTab> tabs, Runnable onCopy) {
        if (tabs == null || tabs.isEmpty()) {
            return;
        }
        Dialog dialog = createBottomSheetDialog();
        LinearLayout sheet = new LinearLayout(this);
        sheet.setOrientation(LinearLayout.VERTICAL);
        sheet.setPadding(dp(14), dp(10), dp(14), dp(14));
        sheet.setBackground(roundRect("#ffffff", "#ffffff", 26));

        View handle = new View(this);
        handle.setBackground(roundRect("#e2e8f0", "#e2e8f0", 999));
        LinearLayout.LayoutParams handleParams = new LinearLayout.LayoutParams(dp(40), dp(4));
        handleParams.gravity = Gravity.CENTER_HORIZONTAL;
        handleParams.bottomMargin = dp(10);
        sheet.addView(handle, handleParams);

        LinearLayout hero = new LinearLayout(this);
        hero.setOrientation(LinearLayout.HORIZONTAL);
        hero.setGravity(Gravity.CENTER_VERTICAL);
        hero.setPadding(dp(12), dp(12), dp(12), dp(12));
        hero.setBackground(translucentGradient(accent, 18));
        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        copy.addView(text(title, 15, "#0f172a", true));
        copy.addView(text("Grouped live detail for quick review.", 11, "#475569", false));
        hero.addView(copy, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        hero.addView(pill(badge, translucentHex(badgeColor, 0.12f), badgeColor), wrapRight(4));
        hero.addView(iconAction(R.drawable.ic_db_copy, "#f8fafc", "#0f172a", onCopy), wrapRight(4));
        hero.addView(iconAction(R.drawable.ic_db_close, "#f8fafc", "#0f172a", dialog::dismiss));
        sheet.addView(hero, fullWidth(10));

        LinearLayout tabShell = new LinearLayout(this);
        tabShell.setOrientation(LinearLayout.VERTICAL);
        tabShell.setPadding(dp(6), dp(6), dp(6), dp(6));
        tabShell.setBackground(roundRect("#f8fafc", "#e2e8f0", 18));
        LinearLayout tabStrip = new LinearLayout(this);
        tabStrip.setOrientation(LinearLayout.HORIZONTAL);
        HorizontalScrollView tabScroll = new HorizontalScrollView(this);
        tabScroll.setHorizontalScrollBarEnabled(false);
        tabScroll.setOverScrollMode(View.OVER_SCROLL_NEVER);
        tabScroll.addView(tabStrip);
        tabShell.addView(tabScroll);
        FrameLayout content = new FrameLayout(this);
        final int[] selected = {0};
        final Runnable[] renderSelectedTab = new Runnable[1];
        renderSelectedTab[0] = () -> {
            tabStrip.removeAllViews();
            for (int i = 0; i < tabs.size(); i += 1) {
                int index = i;
                tabStrip.addView(insightTabButton(tabs.get(i).label, selected[0] == index, accent, () -> {
                    if (selected[0] == index) {
                        return;
                    }
                    selected[0] = index;
                    renderSelectedTab[0].run();
                }), wrapRight(i == tabs.size() - 1 ? 0 : 10));
            }
            content.removeAllViews();
            ScrollView scroll = new ScrollView(this);
            scroll.setFillViewport(true);
            scroll.setOverScrollMode(View.OVER_SCROLL_NEVER);
            scroll.addView(tabs.get(selected[0]).factory.create());
            content.addView(scroll, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            tabScroll.post(() -> {
                View selectedTab = tabStrip.getChildAt(selected[0]);
                if (selectedTab == null) {
                    return;
                }
                int target = selectedTab.getLeft() - dp(18);
                tabScroll.smoothScrollTo(Math.max(0, target), 0);
            });
        };
        renderSelectedTab[0].run();
        sheet.addView(tabShell, fullWidth(10));
        sheet.addView(content, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(520)));
        showFixedBottomSheetDialog(dialog, sheet);
    }

    private View insightTabButton(String label, boolean selected, String accent, Runnable action) {
        TextView tab = text(label, 12, selected ? accent : "#64748b", true);
        tab.setGravity(Gravity.CENTER);
        tab.setSingleLine(true);
        tab.setEllipsize(TextUtils.TruncateAt.END);
        tab.setPadding(dp(12), dp(8), dp(12), dp(8));
        tab.setBackground(roundRect(selected ? translucentHex(accent, 0.12f) : "#ffffff", selected ? accent : "#e2e8f0", 999));
        tab.setOnClickListener(v -> runGuarded("tab:" + label, action));
        return tab;
    }

    private View insightStatCard(String label, String value, String hint, String accent) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(10), dp(10), dp(10), dp(10));
        card.setBackground(roundRect("#f8fafc", "#e2e8f0", 16));
        card.addView(text(label, 10, accent, true), fullWidth(4));
        card.addView(text(value, 13, "#0f172a", true), fullWidth(3));
        card.addView(text(hint, 10, "#64748b", false));
        return card;
    }

    private View insightGraphPanel(String title, List<InsightBar> bars) {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(dp(12), dp(12), dp(12), dp(12));
        panel.setBackground(roundRect("#0b1220", "#172033", 18));
        panel.addView(text(title, 12, "#ffffff", true), fullWidth(10));
        for (InsightBar bar : bars) {
            panel.addView(insightGraphBar(bar), fullWidth(8));
        }
        return panel;
    }

    private View insightGraphBar(InsightBar bar) {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.addView(text(bar.label, 10, "#cbd5e1", true), new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        row.addView(text(Math.max(0, Math.min(100, bar.value)) + "%", 10, "#e2e8f0", true));
        root.addView(row, fullWidth(4));
        LinearLayout track = new LinearLayout(this);
        track.setBackground(roundRect("#172033", "#172033", 999));
        View fill = new View(this);
        fill.setBackground(roundRect(bar.color, bar.color, 999));
        int pct = Math.max(0, Math.min(100, bar.value));
        track.addView(fill, new LinearLayout.LayoutParams(0, dp(6), Math.max(1, pct)));
        track.addView(new View(this), new LinearLayout.LayoutParams(0, dp(6), Math.max(1, 100 - pct)));
        root.addView(track);
        return root;
    }

    private View insightCodePanel(String title, String value) {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(dp(10), dp(10), dp(10), dp(10));
        panel.setBackground(roundRect("#0b1220", "#172033", 16));
        panel.addView(text(title, 12, "#ffffff", true), fullWidth(8));
        TextView body = text(value, 11, "#e2e8f0", false);
        body.setTypeface(Typeface.MONOSPACE);
        body.setTextIsSelectable(true);
        panel.addView(body);
        return panel;
    }

    private void showDetailDialog(String title, String badge, String detail) {
        String formatted = modalJson(title, badge, detail);
        Dialog dialog = createBottomSheetDialog();
        LinearLayout sheet = new LinearLayout(this);
        sheet.setOrientation(LinearLayout.VERTICAL);
        sheet.setPadding(dp(12), dp(12), dp(12), dp(14));
        sheet.setBackground(roundRect("#ffffff", "#ffffff", 24));

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.addView(iconTile(R.drawable.ic_db_open, "#0b5ed7", 38, 12, 20), fixed(38, 38, 10));
        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        copy.addView(text(title, 16, "#0f172a", true));
        copy.addView(text(badge, 11, "#64748b", false));
        header.addView(copy, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        header.addView(iconAction(R.drawable.ic_db_copy, "#f8fafc", "#0f172a", () -> copyText(formatted)), wrapRight(6));
        header.addView(iconAction(R.drawable.ic_db_close, "#f8fafc", "#0f172a", dialog::dismiss));
        sheet.addView(header, fullWidth(12));

        TextView body = text(formatted, 12, "#e2e8f0", false);
        body.setTypeface(Typeface.MONOSPACE);
        body.setTextIsSelectable(true);
        body.setPadding(dp(10), dp(10), dp(10), dp(10));
        body.setBackground(roundRect("#0b1220", "#172033", 16));
        ScrollView detailScroll = new ScrollView(this);
        detailScroll.addView(body);
        sheet.addView(detailScroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(420)));
        showFixedBottomSheetDialog(dialog, sheet);
    }

    private void confirmClearConsole() {
        new AlertDialog.Builder(this)
                .setTitle("Clear console?")
                .setMessage("This clears local bridge console entries from the app.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Clear", (dialog, which) -> {
                    BridgeRecoveryActions.clearLog(this);
                    loadState(true);
                    showSnack("Console cleared");
                })
                .show();
    }

    private void confirmResetOnboarding() {
        new AlertDialog.Builder(this)
                .setTitle("Reset bridge setup?")
                .setMessage("This clears the current device connection and sends you back to onboarding. Dashboard actions will stop until setup is completed again.")
                .setNegativeButton("Cancel", null)
                .setPositiveButton("Reset", (dialog, which) -> {
                    BridgeRecoveryActions.resetOnboardingState(this);
                    showSetupSurface = true;
                    setupStatus = "Connection reset. Scan QR or paste setup code.";
                    loadState(true);
                })
                .show();
    }

    private void openQrScannerFlow() {
        if (busy || connectingFromSetup) {
            return;
        }
        if (!BridgePermissionHelper.hasQrFeature(this)) {
            BridgePermissionHelper.requestQrFeature(this, REQ_QR_PERMISSIONS);
            return;
        }
        showSetupSurface = true;
        setupStatus = "";
        setupScanDelivered = false;
        rebuild();
    }

    private void startQrScan() {
        try {
            startActivityForResult(new Intent(this, BridgeQrScannerActivity.class), REQ_QR_SCAN);
        } catch (Exception error) {
            showSnack("Unable to open scanner.");
            showSetupSurface = true;
            setupStatus = "";
            rebuild();
        }
    }

    private void importSetupCode(String code, String progress, boolean retryQrOnFailure) {
        String normalized = safe(code).trim();
        if (normalized.isEmpty()) {
            showSetupSurface = true;
            setupStatus = "Paste a valid setup code first.";
            rebuild();
            return;
        }

        connectingFromSetup = true;
        showSetupSurface = true;
        setupStatus = "";
        setupProgress = progress;
        rebuild();

        try {
            BridgeProvisioning.applyProvisioningPayload(this, normalized);
            BridgeEventLog.append(this, "Setup code applied");
            if (BridgePermissionHelper.hasCore(this) && BridgeAppGate.hasConnectionDetails(this)) {
                BridgeRecoveryActions.startBridge(this);
                BridgeEventLog.append(this, "Bridge started from setup import");
            }
            loadState(false);
            setupProgress = "Starting bridge...";
            startSetupPolling();
        } catch (Exception error) {
            connectingFromSetup = false;
            showSetupSurface = true;
            setupStatus = retryQrOnFailure ? "" : safe(error.getMessage(), "Invalid setup code.");
            rebuild();
            showSnack(safe(error.getMessage(), "Invalid setup code."));
            if (retryQrOnFailure) {
                handler.postDelayed(() -> {
                    setupScanDelivered = false;
                    showSetupSurface = true;
                    rebuild();
                }, 450L);
            }
        }
    }

    private void startSetupPolling() {
        handler.removeCallbacks(setupPollRunnable);
        setupPollAttempts = 0;
        handler.postDelayed(setupPollRunnable, SETUP_POLL_MS);
    }

    private void runBridgeAction(String method) {
        if (busy) {
            return;
        }
        busy = true;
        rebuild();
        try {
            if ("startBridge".equals(method)) {
                if (!BridgeAppGate.hasConnectionDetails(this)) {
                    showSnack("Connection setup required.");
                    showSetupSurface = true;
                } else {
                    BridgeRecoveryActions.startBridge(this);
                }
            } else if ("stopBridge".equals(method)) {
                BridgeRecoveryActions.stopBridge(this);
            } else if ("restartBridge".equals(method)) {
                BridgeRecoveryActions.stopBridge(this);
                BridgeRecoveryActions.startBridge(this);
            } else if ("clearQueue".equals(method)) {
                BridgeRecoveryActions.clearQueue(this);
            }
        } finally {
            busy = false;
            loadState(true);
        }
    }

    private void requestCallFeature() {
        if (BridgePermissionHelper.hasCallFeature(this)) {
            MqttBridgeService.requestSilentBulkSync(this);
            showSnack("Call controls activated");
            return;
        }
        BridgePermissionHelper.requestCallFeature(this, REQ_CALL_PERMISSIONS);
    }

    private void requestWebcamFeature() {
        if (BridgePermissionHelper.hasWebcamFeature(this)) {
            showSnack("Webcam access activated");
            return;
        }
        BridgePermissionHelper.requestWebcamFeature(this, REQ_WEBCAM_PERMISSIONS);
    }

    private void requestIntercomFeature() {
        if (BridgePermissionHelper.hasIntercomFeature(this)) {
            showSnack("Intercom access activated");
            return;
        }
        BridgePermissionHelper.requestIntercomFeature(this, REQ_INTERCOM_PERMISSIONS);
    }

    private void requestSmsInboxAccess() {
        if (BridgePermissionHelper.hasSmsInboxFeature(this)) {
            MqttBridgeService.requestSilentBulkSync(this);
            showSnack("SMS inbox access activated");
            loadSmsThreads();
            rebuild();
            return;
        }
        BridgePermissionHelper.requestSmsInboxFeature(this, REQ_SMS_INBOX_PERMISSIONS);
    }

    private void requestDisableBatteryOptimization() {
        if (isBatteryOptimizationDisabled()) {
            showSnack("Battery optimization is already disabled");
            return;
        }
        try {
            startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
        } catch (Exception ignored) {
            try {
                BridgePermissionHelper.openAppSettings(this);
            } catch (Exception appSettingsError) {
                showSnack("Unable to open battery optimization settings.");
            }
        }
    }

    private void consumePendingSetupCodeIfNeeded(boolean force) {
        if (!force && checkedPendingSetupCode) {
            return;
        }
        checkedPendingSetupCode = true;
        String normalized = pendingSetupToken.trim();
        pendingSetupToken = "";
        if (!normalized.isEmpty()) {
            importSetupCode(normalized, "Importing secure code...", false);
        }
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

    private void maybePromptBatteryOptimization() {
        if (batteryPromptShown
                || !boolValue(state.get("online"))
                || boolValue(state.get("needsOnboarding"))
                || boolValue(state.get("batteryOptimizationDisabled"))) {
            return;
        }
        batteryPromptShown = true;
        handler.postDelayed(this::showSettingsSheet, 250L);
    }

    private void scheduleRefresh() {
        handler.removeCallbacks(refreshRunnable);
        long interval = selectedTabIndex == TAB_SMS ? SMS_REFRESH_MS : isCallActive() ? CALL_REFRESH_MS : IDLE_REFRESH_MS;
        handler.postDelayed(refreshRunnable, interval);
    }

    private boolean isCallActive() {
        String status = stringValue(state.get("callStatus")).toLowerCase(Locale.US);
        return "ringing".equals(status) || "dialing".equals(status) || "connected".equals(status) || "answered".equals(status);
    }

    private void selectTab(int index) {
        if (selectedTabIndex == index) {
            return;
        }
        selectedTabIndex = index;
        if (index == TAB_SMS) {
            loadSmsThreads();
        } else if (index == TAB_PHONE) {
            loadDashboardCallLog(false);
        } else if (index == TAB_CONTACTS) {
            loadDeviceContacts(lastContactQuery, false);
            loadDashboardContacts(lastContactQuery, false);
        } else {
            composingNewSms = false;
        }
        scheduleRefresh();
        rebuild();
    }

    private void ensureSelectedCommunicationDevice() {
        BridgeConfig config = BridgeConfig.load(this);
        if (selectedCommunicationDeviceId.trim().isEmpty()) {
            selectedCommunicationDeviceId = stringValue(state.get("deviceId"), config.deviceId);
        }
        if (selectedCommunicationDeviceName.trim().isEmpty()) {
            selectedCommunicationDeviceName = selectedCommunicationDeviceId;
        }
    }

    private String activeCommunicationDeviceId() {
        ensureSelectedCommunicationDevice();
        return selectedCommunicationDeviceId.trim();
    }

    private String activeCommunicationDeviceName() {
        ensureSelectedCommunicationDevice();
        return firstNonEmptyValue(selectedCommunicationDeviceName, selectedCommunicationDeviceId, "Device");
    }

    private int activeCommunicationSimSlot() {
        return selectedCommunicationSimSlot >= 0 ? selectedCommunicationSimSlot : selectedSmsSimSlot;
    }

    private void loadDeviceInventory(boolean rebuildAfter) {
        BridgeConfig config = BridgeConfig.load(this);
        if (!config.hasDashboardAccess() || devicesLoading) {
            return;
        }
        devicesLoading = true;
        new Thread(() -> {
            List<Map<String, Object>> devices;
            List<Map<String, Object>> sims = new ArrayList<>();
            String deviceId = activeCommunicationDeviceId();
            try {
                devices = DashboardApiClient.fetchDevices(config);
                if (deviceId.isEmpty() && !devices.isEmpty()) {
                    deviceId = stringValue(devices.get(0).get("id"));
                }
                if (!deviceId.isEmpty()) {
                    sims = DashboardApiClient.fetchSims(config, deviceId);
                }
                String finalDeviceId = deviceId;
                List<Map<String, Object>> finalDevices = devices;
                List<Map<String, Object>> finalSims = sims;
                runOnUiThread(() -> {
                    dashboardDevices = finalDevices;
                    dashboardSims = finalSims;
                    if (!finalDeviceId.isEmpty()) {
                        selectedCommunicationDeviceId = finalDeviceId;
                        for (Map<String, Object> device : dashboardDevices) {
                            if (finalDeviceId.equals(stringValue(device.get("id")))) {
                                selectedCommunicationDeviceName = firstNonEmptyValue(stringValue(device.get("name")), finalDeviceId);
                                break;
                            }
                        }
                    }
                    if (selectedCommunicationSimSlot >= 0 && !simSlotExists(selectedCommunicationSimSlot)) {
                        selectedCommunicationSimSlot = -1;
                    }
                    devicesLoading = false;
                    if (rebuildAfter) rebuild();
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    devicesLoading = false;
                    BridgeEventLog.append(this, "dashboard: device inventory failed " + error.getMessage());
                    if (rebuildAfter) rebuild();
                });
            }
        }, "dashboard-devices").start();
    }

    private boolean simSlotExists(int slot) {
        for (Map<String, Object> sim : dashboardSims) {
            if (intValue(sim.get("slot")) == slot) {
                return true;
            }
        }
        return false;
    }

    private void showCommunicationDeviceSheet() {
        BridgeConfig config = BridgeConfig.load(this);
        if (!config.hasDashboardAccess()) {
            showSnack("Dashboard access is not configured.");
            return;
        }
        loadDeviceInventory(false);
        Dialog dialog = createBottomSheetDialog();
        LinearLayout sheet = new LinearLayout(this);
        sheet.setOrientation(LinearLayout.VERTICAL);
        sheet.setPadding(dp(14), dp(14), dp(14), dp(14));
        sheet.setBackground(roundRect("#ffffff", "#ffffff", 24));

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.addView(iconTile(R.drawable.ic_db_devices, "#0b5ed7", 42, 14, 22), fixed(42, 42, 10));
        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        copy.addView(text("Select device", 18, "#0f172a", true));
        copy.addView(text("Messages, calls, and contacts use the dashboard API.", 12, "#64748b", false));
        header.addView(copy, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        header.addView(iconAction(R.drawable.ic_db_close, "#f8fafc", "#0f172a", dialog::dismiss));
        sheet.addView(header, fullWidth(12));

        if (dashboardDevices.isEmpty()) {
            sheet.addView(emptyLine(devicesLoading ? "Loading devices..." : "No dashboard devices found."));
        } else {
            for (Map<String, Object> device : dashboardDevices) {
                String id = stringValue(device.get("id"));
                String name = firstNonEmptyValue(stringValue(device.get("name")), id);
                boolean active = id.equals(activeCommunicationDeviceId());
                sheet.addView(attachmentRow(
                        R.drawable.ic_db_devices,
                        (active ? "Using " : "Use ") + name,
                        id + (boolValue(device.get("online")) ? " - online" : ""),
                        active ? "#0b5ed7" : "#475569",
                        () -> {
                            selectedCommunicationDeviceId = id;
                            selectedCommunicationDeviceName = name;
                            selectedCommunicationSimSlot = -1;
                            selectedSmsSimSlot = -1;
                            selectedSmsThread = null;
                            smsMessages = new ArrayList<>();
                            dialog.dismiss();
                            loadDeviceInventory(true);
                            loadSmsThreads();
                            loadDashboardCallLog(false);
                            showSnack("Device selected: " + name);
                        }
                ), fullWidth(6));
            }
        }

        sheet.addView(text("SIM", 12, "#64748b", true), fullWidth(6));
        sheet.addView(attachmentRow(R.drawable.ic_db_sms, "Default SIM", "Let dashboard/device choose the send route.", selectedCommunicationSimSlot < 0 ? "#0b5ed7" : "#475569", () -> {
            selectedCommunicationSimSlot = -1;
            selectedSmsSimSlot = -1;
            dialog.dismiss();
            loadSmsThreads();
            loadDashboardCallLog(false);
            rebuild();
        }), fullWidth(6));
        for (Map<String, Object> sim : dashboardSims) {
            int slot = intValue(sim.get("slot"));
            String label = firstNonEmptyValue(stringValue(sim.get("label")), "SIM " + (slot + 1));
            String number = stringValue(sim.get("number"));
            String carrier = stringValue(sim.get("carrier"));
            String detail = firstNonEmptyValue(number, carrier, "SIM " + (slot + 1));
            boolean active = slot == selectedCommunicationSimSlot;
            sheet.addView(attachmentRow(R.drawable.ic_db_sms, (active ? "Using " : "Use ") + label, detail, active ? "#0b5ed7" : "#475569", () -> {
                selectedCommunicationSimSlot = slot;
                selectedSmsSimSlot = slot;
                dialog.dismiss();
                loadSmsThreads();
                loadDashboardCallLog(false);
                rebuild();
            }), fullWidth(6));
        }
        showFixedBottomSheetDialog(dialog, sheet);
    }

    private String communicationHeaderTitle(String label) {
        int sim = activeCommunicationSimSlot();
        return label + " - " + activeCommunicationDeviceName() + (sim >= 0 ? " SIM " + (sim + 1) : "");
    }

    private void loadSmsThreads() {
        smsLoading = true;
        BridgeConfig config = BridgeConfig.load(this);
        if (BridgePermissionHelper.hasSmsInboxFeature(this)) {
            smsThreads = new ArrayList<>(BridgeSmsStore.buildThreadSummaries(this));
        } else if (!config.hasDashboardAccess()) {
            smsLoading = false;
            return;
        }
        if (!config.hasDashboardAccess()) {
            smsLoading = false;
            return;
        }
        String deviceId = activeCommunicationDeviceId();
        int simSlot = activeCommunicationSimSlot();
        new Thread(() -> {
            try {
                List<Map<String, Object>> threads = DashboardApiClient.fetchSmsConversations(config, deviceId, simSlot);
                runOnUiThread(() -> {
                    smsThreads = mergeSmsThreads(BridgeSmsStore.buildThreadSummaries(this), threads);
                    if (selectedSmsThread != null) {
                        String selectedKey = stringValue(selectedSmsThread.get("threadKey"));
                        for (Map<String, Object> thread : smsThreads) {
                            if (selectedKey.equals(stringValue(thread.get("threadKey")))) {
                                selectedSmsThread = thread;
                                break;
                            }
                        }
                    }
                    smsLoading = false;
                    if (selectedTabIndex == TAB_SMS && selectedSmsThread == null) rebuild();
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    smsLoading = false;
                    BridgeEventLog.append(this, "dashboard: SMS conversations failed " + error.getMessage());
                    if (selectedTabIndex == TAB_SMS) rebuild();
                });
            }
        }, "dashboard-sms-threads").start();
    }

    private void openSmsThread(Map<String, Object> thread) {
        smsBulkMode = false;
        selectedSmsThreadKeys.clear();
        String selectedKey = threadKey(thread);
        markThreadReadLocally(selectedKey);
        loadSmsThreads();
        selectedSmsThread = findSmsThreadByKey(selectedKey);
        if (selectedSmsThread == null) {
            selectedSmsThread = thread;
        }
        loadSmsMessages(stringValue(selectedSmsThread.get("threadKey")));
        smsConversationScrollY = 0;
        smsConversationScrollToBottomOnNextBuild = true;
        rebuild();
    }

    private void loadSmsMessages(String threadKey) {
        if (threadKey.trim().isEmpty()) {
            smsMessages = new ArrayList<>();
            return;
        }
        BridgeConfig config = BridgeConfig.load(this);
        Map<String, Object> thread = selectedSmsThread;
        if (thread == null) {
            smsMessages = new ArrayList<>();
            return;
        }
        List<Map<String, Object>> localMessages = BridgeSmsStore.buildThreadMessages(this, threadKey);
        smsMessages = new ArrayList<>(localMessages);
        if (!config.hasDashboardAccess()) {
            return;
        }
        String deviceId = activeCommunicationDeviceId();
        int simSlot = activeCommunicationSimSlot();
        new Thread(() -> {
            try {
                List<Map<String, Object>> messages = DashboardApiClient.fetchSmsThread(config, deviceId, thread, simSlot);
                runOnUiThread(() -> {
                    smsMessages = mergeSmsMessages(BridgeSmsStore.buildThreadMessages(this, threadKey), messages);
                    if (selectedTabIndex == TAB_SMS && selectedSmsThread != null) rebuild();
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    smsMessages = new ArrayList<>(BridgeSmsStore.buildThreadMessages(this, threadKey));
                    BridgeEventLog.append(this, "dashboard: SMS thread failed " + error.getMessage());
                    if (selectedTabIndex == TAB_SMS && selectedSmsThread != null) rebuild();
                });
            }
        }, "dashboard-sms-thread").start();
    }

    private List<Map<String, Object>> mergeSmsThreads(List<Map<String, Object>> localThreads, List<Map<String, Object>> dashboardThreads) {
        LinkedHashMap<String, Map<String, Object>> merged = new LinkedHashMap<>();
        appendSmsThreads(merged, localThreads);
        appendSmsThreads(merged, dashboardThreads);
        List<Map<String, Object>> items = new ArrayList<>(merged.values());
        items.sort((left, right) -> Long.compare(longValue(right.get("timestamp")), longValue(left.get("timestamp"))));
        return items;
    }

    private List<RecentCallItem> recentCallItems(int limit) {
        LinkedHashMap<String, RecentCallItem> merged = new LinkedHashMap<>();
        appendRecentCalls(merged, recentCallLogItems(Math.max(1, limit)));
        appendRecentCalls(merged, dashboardRecentCallItems(Math.max(1, limit)));
        List<RecentCallItem> items = new ArrayList<>(merged.values());
        items.sort((left, right) -> Long.compare(right.date, left.date));
        int max = Math.max(1, limit);
        return items.size() <= max ? items : new ArrayList<>(items.subList(0, max));
    }

    private void appendRecentCalls(LinkedHashMap<String, RecentCallItem> target, List<RecentCallItem> source) {
        if (source == null) {
            return;
        }
        for (RecentCallItem item : source) {
            if (item == null) {
                continue;
            }
            String key = firstNonEmptyValue(contactCacheKey(item.number), item.name) + "|" + item.type + "|" + item.date;
            if (!key.trim().equals("||0")) {
                target.put(key, item);
            }
        }
    }

    private void appendSmsThreads(LinkedHashMap<String, Map<String, Object>> target, List<Map<String, Object>> source) {
        if (source == null) {
            return;
        }
        for (Map<String, Object> thread : source) {
            if (thread == null) {
                continue;
            }
            String key = firstNonEmptyValue(stringValue(thread.get("threadKey")), "addr:" + contactCacheKey(stringValue(thread.get("address"))));
            if (key.trim().isEmpty()) {
                continue;
            }
            target.put(key, new HashMap<>(thread));
        }
    }

    private List<Map<String, Object>> mergeSmsMessages(List<Map<String, Object>> localMessages, List<Map<String, Object>> dashboardMessages) {
        LinkedHashMap<String, Map<String, Object>> merged = new LinkedHashMap<>();
        appendSmsMessages(merged, localMessages);
        appendSmsMessages(merged, dashboardMessages);
        List<Map<String, Object>> items = new ArrayList<>(merged.values());
        items.sort((left, right) -> Long.compare(longValue(left.get("timestamp")), longValue(right.get("timestamp"))));
        return items;
    }

    private void appendSmsMessages(LinkedHashMap<String, Map<String, Object>> target, List<Map<String, Object>> source) {
        if (source == null) {
            return;
        }
        for (Map<String, Object> message : source) {
            if (message == null) {
                continue;
            }
            String key = firstNonEmptyValue(
                    stringValue(message.get("id")),
                    (boolValue(message.get("outgoing")) ? "out" : "in")
                            + "|"
                            + contactCacheKey(stringValue(message.get("address")))
                            + "|"
                            + longValue(message.get("timestamp"))
                            + "|"
                            + stringValue(message.get("body"))
            );
            if (!key.trim().isEmpty()) {
                target.put(key, new HashMap<>(message));
            }
        }
    }

    private Map<String, Object> findSmsThreadByKey(String key) {
        for (Map<String, Object> thread : smsThreads) {
            if (key.equals(threadKey(thread))) {
                return thread;
            }
        }
        return null;
    }

    private void markThreadReadLocally(String threadKey) {
        if (threadKey == null || threadKey.trim().isEmpty()) {
            return;
        }
        for (Map<String, Object> thread : smsThreads) {
            if (threadKey.equals(threadKey(thread))) {
                thread.put("unreadCount", 0);
            }
        }
        if (selectedSmsThread != null && threadKey.equals(threadKey(selectedSmsThread))) {
            selectedSmsThread.put("unreadCount", 0);
        }
    }

    private Map<String, Object> findSmsThreadByAddress(String number) {
        String target = contactCacheKey(number);
        for (Map<String, Object> thread : smsThreads) {
            if (target.equals(contactCacheKey(stringValue(thread.get("address"))))) {
                return thread;
            }
        }
        return null;
    }

    private void sendSmsFromComposer(String body, String number) {
        sendSmsFromComposerToRecipients(body, Arrays.asList(new ContactInfo(firstNonEmptyValue(number, number), number, avatarLabel(number), true)));
    }

    private void sendSmsFromComposerToRecipients(String body, List<ContactInfo> recipients) {
        String cleanBody = safe(body).trim();
        List<ContactInfo> cleanRecipients = new ArrayList<>();
        if (recipients != null) {
            for (ContactInfo recipient : recipients) {
                if (recipient == null) {
                    continue;
                }
                String cleanNumber = safe(recipient.number).trim();
                if (cleanNumber.isEmpty()) {
                    continue;
                }
                cleanRecipients.add(new ContactInfo(
                        firstNonEmptyValue(recipient.name, cleanNumber),
                        cleanNumber,
                        avatarLabel(firstNonEmptyValue(recipient.name, cleanNumber)),
                        true
                ));
            }
        }
        if (cleanRecipients.isEmpty() || cleanBody.isEmpty()) {
            showSnack(cleanRecipients.isEmpty() ? "Add at least one recipient." : "Message is required.");
            return;
        }
        BridgeConfig config = BridgeConfig.load(this);
        if (!config.hasDashboardAccess()) {
            sendSmsLocallyFromComposer(cleanBody, cleanRecipients);
            return;
        }

        smsSending = true;
        rebuild();
        String deviceId = activeCommunicationDeviceId();
        int simSlot = activeCommunicationSimSlot();
        List<String> numbers = new ArrayList<>();
        for (ContactInfo recipient : cleanRecipients) {
            numbers.add(recipient.number);
        }
        new Thread(() -> {
            try {
                DashboardApiClient.sendSms(config, deviceId, simSlot, numbers, cleanBody);
                runOnUiThread(() -> {
                    if (composingNewSms) {
                        selectedSmsThread = cleanRecipients.size() == 1 ? findSmsThreadByAddress(cleanRecipients.get(0).number) : null;
                        composingNewSms = false;
                        clearNewSmsDraft();
                    }
                    smsSending = false;
                    loadSmsThreads();
                    if (selectedSmsThread != null) {
                        loadSmsMessages(stringValue(selectedSmsThread.get("threadKey")));
                    }
                    showSnack(cleanRecipients.size() > 1 ? "SMS queued for " + cleanRecipients.size() + " recipients." : "SMS queued.");
                    rebuild();
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    smsSending = false;
                    rebuild();
                    showSnack(error.getMessage() == null ? "Failed to queue SMS." : error.getMessage());
                });
            }
        }, "dashboard-sms-send").start();
    }

    private void sendSmsLocallyFromComposer(String cleanBody, List<ContactInfo> cleanRecipients) {
        if (checkSelfPermission(Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) {
            BridgePermissionHelper.requestMissingCore(this, REQ_CORE_PERMISSIONS);
            showSnack("Allow SMS access to send from this phone.");
            return;
        }
        smsSending = true;
        rebuild();
        BridgeConfig config = BridgeConfig.load(this);
        if (config.hasProvisionedMqttConfig() && config.bridgeEnabled) {
            BridgeRecoveryActions.startBridge(this);
        }
        Integer simSlot = selectedSmsSimForSend();
        new Thread(() -> {
            int accepted = 0;
            String lastError = "";
            for (ContactInfo recipient : cleanRecipients) {
                String number = safe(recipient.number).trim();
                if (number.isEmpty()) {
                    continue;
                }
                String actionId = "local_sms_" + System.currentTimeMillis() + "_" + Math.abs(number.hashCode());
                SmsSender.SendResult result = SmsSender.send(this, actionId, number, cleanBody, 90_000, simSlot, null);
                if (result.accepted) {
                    accepted += 1;
                    BridgeSmsStore.recordOutgoing(this, actionId, number, cleanBody, System.currentTimeMillis(), "local_app");
                } else {
                    lastError = result.detail;
                }
            }
            int acceptedCount = accepted;
            String errorText = lastError;
            runOnUiThread(() -> {
                if (acceptedCount > 0) {
                    if (composingNewSms) {
                        selectedSmsThread = cleanRecipients.size() == 1 ? findSmsThreadByAddress(cleanRecipients.get(0).number) : null;
                        composingNewSms = false;
                        clearNewSmsDraft();
                    }
                    loadSmsThreads();
                    if (selectedSmsThread != null) {
                        loadSmsMessages(stringValue(selectedSmsThread.get("threadKey")));
                    }
                }
                smsSending = false;
                showSnack(acceptedCount > 0
                        ? (acceptedCount > 1 ? "SMS sent from this phone to " + acceptedCount + " recipients." : "SMS sent from this phone.")
                        : SmsSender.describeDetail(errorText));
                rebuild();
            });
        }, "local-sms-send").start();
    }

    private Integer selectedSmsSimForSend() {
        ensureSelectedSmsSimSlot();
        return selectedSmsSimSlot >= 0 ? selectedSmsSimSlot : null;
    }

    private void ensureSelectedSmsSimSlot() {
        if (selectedSmsSimSlot >= 0) {
            return;
        }
        int defaultSlot = defaultSmsSimSlot();
        if (defaultSlot >= 0) {
            selectedSmsSimSlot = defaultSlot;
            return;
        }
        List<SubscriptionInfo> subscriptions = activeSmsSubscriptions();
        if (!subscriptions.isEmpty() && subscriptions.get(0) != null) {
            selectedSmsSimSlot = Math.max(0, subscriptions.get(0).getSimSlotIndex());
        }
    }

    private int defaultSmsSimSlot() {
        if (Build.VERSION.SDK_INT < 22 || !hasSubscriptionReadPermission()) {
            return -1;
        }
        try {
            int defaultSubId = SubscriptionManager.getDefaultSmsSubscriptionId();
            if (defaultSubId < 0) return -1;
            for (SubscriptionInfo info : activeSmsSubscriptions()) {
                if (info != null && info.getSubscriptionId() == defaultSubId) {
                    return info.getSimSlotIndex();
                }
            }
        } catch (RuntimeException ignored) {
        }
        return -1;
    }

    private String currentComposerNumber() {
        if (selectedSmsThread != null) {
            return stringValue(selectedSmsThread.get("address"));
        }
        return primaryNewSmsRecipientNumber(newSmsContactQuery);
    }

    private View smsSimSelector(String targetNumber) {
        LinearLayout shell = new LinearLayout(this);
        shell.setOrientation(LinearLayout.HORIZONTAL);
        shell.setGravity(Gravity.CENTER_VERTICAL);
        shell.setPadding(dp(10), dp(4), dp(10), 0);
        shell.setBackgroundColor(Color.TRANSPARENT);
        shell.addView(text("SIM", 11, "#64748b", true), fixed(34, 34, 8));

        List<SubscriptionInfo> subscriptions = activeSmsSubscriptions();
        List<String> labels = new ArrayList<>();
        List<Integer> slots = new ArrayList<>();
        labels.add("Default SIM");
        slots.add(-1);
        for (SubscriptionInfo info : subscriptions) {
            if (info == null) continue;
            int slot = info.getSimSlotIndex();
            CharSequence carrier = info.getCarrierName();
            String label = "SIM " + (slot + 1);
            if (carrier != null && carrier.length() > 0) {
                label += " - " + carrier;
            }
            labels.add(label);
            slots.add(slot);
        }
        if (subscriptions.isEmpty() && !hasSubscriptionReadPermission()) {
            labels.set(0, "Default SIM (phone permission needed)");
        }

        Spinner spinner = new Spinner(this, Spinner.MODE_DROPDOWN);
        ArrayAdapter<String> adapter = new ArrayAdapter<String>(this, android.R.layout.simple_spinner_item, labels) {
            @Override
            public View getView(int position, View convertView, ViewGroup parent) {
                TextView view = (TextView) super.getView(position, convertView, parent);
                view.setTextColor(color("#0f172a"));
                view.setTextSize(12);
                view.setTypeface(Typeface.DEFAULT_BOLD);
                view.setPadding(0, 0, 0, 0);
                return view;
            }

            @Override
            public View getDropDownView(int position, View convertView, ViewGroup parent) {
                TextView view = (TextView) super.getDropDownView(position, convertView, parent);
                view.setTextColor(color("#0f172a"));
                view.setTextSize(13);
                view.setPadding(dp(12), dp(10), dp(12), dp(10));
                return view;
            }
        };
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        spinner.setAdapter(adapter);
        int selectedIndex = Math.max(0, slots.indexOf(selectedSmsSimSlot));
        spinner.setSelection(selectedIndex, false);
        spinner.setBackground(roundRect("#f8fafc", "#e2e8f0", 999));
        spinner.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            private boolean initialized;

            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                if (!initialized) {
                    initialized = true;
                    return;
                }
                int previous = selectedSmsSimSlot;
                selectedSmsSimSlot = slots.get(position);
                if (previous != selectedSmsSimSlot) {
                    handleSmsSimChanged(targetNumber);
                }
            }

            @Override
            public void onNothingSelected(AdapterView<?> parent) {
            }
        });
        shell.addView(spinner, new LinearLayout.LayoutParams(0, dp(34), 1f));
        int queued = BridgeSmsLocalQueue.countForAddress(this, targetNumber);
        if (queued > 0) {
            shell.addView(pill("Queued " + queued, "#fef3c7", "#92400e"), wrapLeft(8));
        }
        return shell;
    }

    private List<SubscriptionInfo> activeSmsSubscriptions() {
        List<SubscriptionInfo> subscriptions = new ArrayList<>();
        if (Build.VERSION.SDK_INT < 22 || !hasSubscriptionReadPermission()) {
            return subscriptions;
        }
        try {
            SubscriptionManager manager = getSystemService(SubscriptionManager.class);
            List<SubscriptionInfo> active = manager == null ? null : manager.getActiveSubscriptionInfoList();
            if (active != null) {
                subscriptions.addAll(active);
            }
        } catch (SecurityException ignored) {
        } catch (RuntimeException ignored) {
        }
        return subscriptions;
    }

    private void handleSmsSimChanged(String targetNumber) {
        String cleanNumber = safe(targetNumber).trim();
        if (cleanNumber.isEmpty()) {
            return;
        }
        if (selectedSmsThread != null) {
            Map<String, Object> thread = findSmsThreadByAddress(cleanNumber);
            if (thread != null) {
                selectedSmsThread = thread;
                loadSmsMessages(stringValue(thread.get("threadKey")));
                smsConversationScrollY = 0;
                smsConversationScrollToBottomOnNextBuild = true;
            }
        } else if (composingNewSms) {
            newSmsRecipientNumber = cleanNumber;
        }
    }

    private boolean hasSubscriptionReadPermission() {
        return checkSelfPermission(Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED;
    }

    private void showScheduleSmsSheet(String number, String presetBody) {
        String cleanPresetBody = safe(presetBody).trim();
        if (cleanPresetBody.isEmpty()) {
            showSnack("Write message first.");
            return;
        }
        Dialog dialog = createBottomSheetDialog();
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(dp(14), dp(14), dp(14), dp(14));
        form.setBackground(roundRect("#ffffff", "#ffffff", 24));
        form.addView(text("Schedule SMS", 18, "#0f172a", true), fullWidth(4));
        form.addView(text("Local queue sends when this app is running or opened after the due time.", 12, "#64748b", false), fullWidth(12));
        EditText to = input("Phone number");
        to.setInputType(InputType.TYPE_CLASS_PHONE);
        to.setText(safe(number));
        form.addView(to, fullWidth(8));
        LinearLayout messageCard = new LinearLayout(this);
        messageCard.setOrientation(LinearLayout.VERTICAL);
        messageCard.setPadding(dp(12), dp(10), dp(12), dp(10));
        messageCard.setBackground(roundRect("#f8fafc", "#e2e8f0", 18));
        messageCard.addView(text("Using current compose message", 12, "#0f172a", true), fullWidth(4));
        TextView messagePreview = text(cleanPresetBody, 11, "#475569", false);
        messagePreview.setMaxLines(3);
        messagePreview.setEllipsize(TextUtils.TruncateAt.END);
        messageCard.addView(messagePreview);
        form.addView(messageCard, fullWidth(8));
        final long[] dueAt = {defaultScheduledSmsTime()};
        LinearLayout sendAtCard = new LinearLayout(this);
        sendAtCard.setOrientation(LinearLayout.VERTICAL);
        sendAtCard.setPadding(dp(12), dp(10), dp(12), dp(10));
        sendAtCard.setBackground(roundRect("#f8fafc", "#e2e8f0", 18));
        sendAtCard.addView(text("Send at", 12, "#0f172a", true), fullWidth(4));
        TextView selectedDateTime = text(formatScheduledDateTime(dueAt[0]), 12, "#2563eb", true);
        sendAtCard.addView(selectedDateTime, fullWidth(8));
        LinearLayout pickerActions = new LinearLayout(this);
        pickerActions.setGravity(Gravity.CENTER_VERTICAL);
        pickerActions.addView(labelIconButton("Pick date", R.drawable.ic_db_open, "#f8fafc", "#0f172a", () -> openScheduleDateTimePicker(dueAt, selectedDateTime)), wrapRight(8));
        pickerActions.addView(labelIconButton("Now +5m", R.drawable.ic_db_sync, "#eef6ff", "#0b5ed7", () -> {
            dueAt[0] = defaultScheduledSmsTime();
            selectedDateTime.setText(formatScheduledDateTime(dueAt[0]));
        }));
        sendAtCard.addView(pickerActions);
        form.addView(sendAtCard, fullWidth(10));
        LinearLayout actions = new LinearLayout(this);
        actions.setGravity(Gravity.CENTER_VERTICAL);
        actions.addView(labelIconButton("Cancel", R.drawable.ic_db_close, "#f8fafc", "#0f172a", dialog::dismiss), weighted(8));
        actions.addView(labelIconButton("Queue", R.drawable.ic_db_sync, "#2563eb", "#ffffff", () -> {
            String cleanNumber = to.getText().toString().trim();
            if (cleanNumber.isEmpty()) {
                showSnack("Number is required.");
                return;
            }
            long scheduledAt = Math.max(System.currentTimeMillis(), dueAt[0]);
            String id = BridgeSmsLocalQueue.enqueue(this, cleanNumber, cleanPresetBody, scheduledAt, selectedSmsSimSlot, "local_schedule");
            dialog.dismiss();
            showSnack(id.isEmpty() ? "Unable to queue SMS." : "SMS queued locally.");
            loadSmsThreads();
            rebuild();
        }), weighted(0));
        form.addView(actions);
        showBottomSheetDialog(dialog, form);
    }

    private void showLocalSmsQueueSheet(String number) {
        Dialog dialog = createBottomSheetDialog();
        LinearLayout sheet = new LinearLayout(this);
        sheet.setOrientation(LinearLayout.VERTICAL);
        sheet.setPadding(dp(14), dp(14), dp(14), dp(14));
        sheet.setBackground(roundRect("#ffffff", "#ffffff", 24));
        sheet.addView(text("Local SMS Queue", 18, "#0f172a", true), fullWidth(4));
        sheet.addView(text("Pending and failed local scheduled SMS on this phone.", 12, "#64748b", false), fullWidth(12));
        String target = safe(number).trim();
        List<BridgeSmsLocalQueue.QueueItem> items = BridgeSmsLocalQueue.list(this);
        int shown = 0;
        for (BridgeSmsLocalQueue.QueueItem item : items) {
            if (!target.isEmpty() && !samePhoneNumber(item.address, target)) {
                continue;
            }
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.VERTICAL);
            row.setPadding(dp(12), dp(10), dp(12), dp(10));
            row.setBackground(roundRect("#f8fafc", "#e2e8f0", 16));
            row.addView(text(item.address + " - " + item.status, 13, "#0f172a", true), fullWidth(4));
            row.addView(text(formatSmsTimestamp(item.dueAt) + " | SIM " + (item.simSlot >= 0 ? (item.simSlot + 1) : "Default"), 11, "#64748b", false), fullWidth(4));
            row.addView(text(item.body, 12, "#475569", false));
            row.setOnLongClickListener(v -> {
                BridgeSmsLocalQueue.remove(this, item.id);
                dialog.dismiss();
                showSnack("Queued SMS removed.");
                rebuild();
                return true;
            });
            sheet.addView(row, fullWidth(8));
            shown += 1;
        }
        if (shown == 0) {
            sheet.addView(emptyLine("No queued SMS for this context."));
        }
        showFixedBottomSheetDialog(dialog, sheet);
    }

    private boolean samePhoneNumber(String left, String right) {
        String l = safe(left).replaceAll("[^0-9]", "");
        String r = safe(right).replaceAll("[^0-9]", "");
        if (l.length() > 10) l = l.substring(l.length() - 10);
        if (r.length() > 10) r = r.substring(r.length() - 10);
        return !l.isEmpty() && l.equals(r);
    }

    private void openSmsTemplateFilePicker() {
        try {
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("*/*");
            intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"text/csv", "text/comma-separated-values", "text/tab-separated-values", "text/plain"});
            startActivityForResult(intent, REQ_SMS_TEMPLATE_FILE);
        } catch (RuntimeException error) {
            showSnack("Unable to open file picker.");
        }
    }

    private void importSmsTemplateFile(Uri uri) {
        int imported = 0;
        try (InputStream stream = getContentResolver().openInputStream(uri);
             BufferedReader reader = new BufferedReader(new InputStreamReader(stream))) {
            String header = reader.readLine();
            if (header == null) {
                showSnack("Template is empty.");
                return;
            }
            List<String> columns = parseCsvLine(header);
            int phoneIndex = csvColumnIndex(columns, "phone", "number", "to", "recipient");
            int messageIndex = csvColumnIndex(columns, "message", "body", "text");
            int sendAtIndex = csvColumnIndex(columns, "send_at", "send at", "schedule_at", "scheduled_at");
            int simIndex = csvColumnIndex(columns, "sim_slot", "sim", "sim slot");
            if (phoneIndex < 0 && !smsTemplateImportTargetNumber.isEmpty()) {
                phoneIndex = -2;
            }
            if (messageIndex < 0) {
                showSnack("Template needs message column.");
                return;
            }
            String line;
            while ((line = reader.readLine()) != null) {
                List<String> row = parseCsvLine(line);
                String phone = phoneIndex == -2 ? smsTemplateImportTargetNumber : csvCell(row, phoneIndex);
                String message = csvCell(row, messageIndex);
                if (phone.trim().isEmpty() || message.trim().isEmpty()) {
                    continue;
                }
                long dueAt = parseSmsTemplateDueAt(csvCell(row, sendAtIndex));
                int simSlot = parseSimSlot(csvCell(row, simIndex));
                BridgeSmsLocalQueue.enqueue(this, phone, message, dueAt, simSlot >= -1 ? simSlot : selectedSmsSimSlot, "local_template");
                imported += 1;
            }
        } catch (Exception error) {
            showSnack("Import failed. Use CSV exported from Excel.");
            return;
        }
        showSnack(imported > 0 ? imported + " SMS queued." : "No valid template rows found.");
        processDueLocalSmsQueue();
        loadSmsThreads();
        rebuild();
    }

    private int csvColumnIndex(List<String> columns, String... names) {
        for (int i = 0; i < columns.size(); i += 1) {
            String column = columns.get(i).trim().toLowerCase(Locale.US);
            for (String name : names) {
                if (column.equals(name)) {
                    return i;
                }
            }
        }
        return -1;
    }

    private String csvCell(List<String> row, int index) {
        if (index < 0 || index >= row.size()) return "";
        return safe(row.get(index)).trim();
    }

    private List<String> parseCsvLine(String line) {
        List<String> cells = new ArrayList<>();
        StringBuilder current = new StringBuilder();
        boolean quoted = false;
        String raw = safe(line);
        for (int i = 0; i < raw.length(); i += 1) {
            char ch = raw.charAt(i);
            if (ch == '"') {
                if (quoted && i + 1 < raw.length() && raw.charAt(i + 1) == '"') {
                    current.append('"');
                    i += 1;
                } else {
                    quoted = !quoted;
                }
            } else if ((ch == ',' || ch == '\t') && !quoted) {
                cells.add(current.toString());
                current.setLength(0);
            } else {
                current.append(ch);
            }
        }
        cells.add(current.toString());
        return cells;
    }

    private long parseSmsTemplateDueAt(String value) {
        String clean = safe(value).trim();
        if (clean.isEmpty()) return System.currentTimeMillis();
        if (clean.matches("^[0-9]+$")) {
            long numeric = Long.parseLong(clean);
            if (numeric > 10_000_000_000L) return numeric;
            return System.currentTimeMillis() + (numeric * 60_000L);
        }
        String[] patterns = new String[]{
                "yyyy-MM-dd'T'HH:mm:ss",
                "yyyy-MM-dd'T'HH:mm",
                "yyyy-MM-dd HH:mm:ss",
                "yyyy-MM-dd HH:mm"
        };
        for (String pattern : patterns) {
            try {
                Date date = new SimpleDateFormat(pattern, Locale.US).parse(clean);
                if (date != null) return date.getTime();
            } catch (Exception ignored) {
            }
        }
        return System.currentTimeMillis();
    }

    private long defaultScheduledSmsTime() {
        Calendar calendar = Calendar.getInstance();
        calendar.setTimeInMillis(System.currentTimeMillis() + (5 * 60_000L));
        calendar.set(Calendar.SECOND, 0);
        calendar.set(Calendar.MILLISECOND, 0);
        return calendar.getTimeInMillis();
    }

    private String formatScheduledDateTime(long timestamp) {
        return new SimpleDateFormat("dd MMM yyyy, hh:mm a", Locale.US).format(new Date(timestamp));
    }

    private void openScheduleDateTimePicker(long[] dueAtHolder, TextView targetView) {
        Calendar calendar = Calendar.getInstance();
        calendar.setTimeInMillis(Math.max(System.currentTimeMillis(), dueAtHolder[0]));
        DatePickerDialog dateDialog = new DatePickerDialog(
                this,
                (view, year, month, dayOfMonth) -> {
                    Calendar selected = Calendar.getInstance();
                    selected.setTimeInMillis(Math.max(System.currentTimeMillis(), dueAtHolder[0]));
                    selected.set(Calendar.YEAR, year);
                    selected.set(Calendar.MONTH, month);
                    selected.set(Calendar.DAY_OF_MONTH, dayOfMonth);
                    TimePickerDialog timeDialog = new TimePickerDialog(
                            this,
                            (timeView, hourOfDay, minute) -> {
                                selected.set(Calendar.HOUR_OF_DAY, hourOfDay);
                                selected.set(Calendar.MINUTE, minute);
                                selected.set(Calendar.SECOND, 0);
                                selected.set(Calendar.MILLISECOND, 0);
                                dueAtHolder[0] = selected.getTimeInMillis();
                                targetView.setText(formatScheduledDateTime(dueAtHolder[0]));
                            },
                            selected.get(Calendar.HOUR_OF_DAY),
                            selected.get(Calendar.MINUTE),
                            false
                    );
                    timeDialog.show();
                },
                calendar.get(Calendar.YEAR),
                calendar.get(Calendar.MONTH),
                calendar.get(Calendar.DAY_OF_MONTH)
        );
        dateDialog.show();
    }

    private int parseSimSlot(String value) {
        String clean = safe(value).trim();
        if (clean.isEmpty()) return selectedSmsSimSlot;
        try {
            int parsed = Integer.parseInt(clean);
            if (parsed > 0 && parsed <= 2) {
                parsed -= 1;
            }
            return parsed >= 0 ? parsed : -1;
        } catch (NumberFormatException ignored) {
            return selectedSmsSimSlot;
        }
    }

    private void processDueLocalSmsQueue() {
        if (localQueueProcessing || checkSelfPermission(Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        localQueueProcessing = true;
        int sent = 0;
        long now = System.currentTimeMillis();
        for (BridgeSmsLocalQueue.QueueItem item : BridgeSmsLocalQueue.due(this, now)) {
            String actionId = safe(item.id, "local_queue_" + now);
            SmsSender.SendResult result = SmsSender.send(this, actionId, item.address, item.body, 90_000, item.simSlot >= 0 ? item.simSlot : null, null);
            if (result.accepted) {
                BridgeSmsStore.recordOutgoing(this, actionId, item.address, item.body, now, item.source);
                BridgeSmsLocalQueue.remove(this, item.id);
                sent += 1;
            } else {
                BridgeSmsLocalQueue.markFailed(this, item.id);
                BridgeEventLog.append(this, "sms: local queue failed " + result.detail);
            }
        }
        if (sent > 0) {
            BridgeEventLog.append(this, "sms: local queue sent " + sent + " item(s)");
        }
        localQueueProcessing = false;
    }

    private boolean handleHorizontalSwipe(float dx, float dy, long durationMs) {
        if (durationMs > 700L || Math.abs(dx) < dp(90) || Math.abs(dy) > dp(80) || Math.abs(dx) < Math.abs(dy) * 1.6f) {
            return false;
        }
        if (dx > 0) {
            if (composingNewSms) {
                composingNewSms = false;
                clearNewSmsDraft();
                rebuild();
                return true;
            }
            if (selectedSmsThread != null) {
                selectedSmsThread = null;
                smsMessages = new ArrayList<>();
                rebuild();
                return true;
            }
            int previousTab = previousTabInNavOrder(selectedTabIndex);
            if (previousTab != selectedTabIndex) {
                selectTab(previousTab);
                return true;
            }
        } else {
            int nextTab = nextTabInNavOrder(selectedTabIndex);
            if (nextTab != selectedTabIndex) {
                selectTab(nextTab);
                return true;
            }
        }
        return false;
    }

    private int previousTabInNavOrder(int currentTab) {
        for (int i = 1; i < TAB_NAV_ORDER.length; i += 1) {
            if (TAB_NAV_ORDER[i] == currentTab) {
                return TAB_NAV_ORDER[i - 1];
            }
        }
        return currentTab;
    }

    private int nextTabInNavOrder(int currentTab) {
        for (int i = 0; i < TAB_NAV_ORDER.length - 1; i += 1) {
            if (TAB_NAV_ORDER[i] == currentTab) {
                return TAB_NAV_ORDER[i + 1];
            }
        }
        return currentTab;
    }

    static Intent createIntent(Activity activity, int startTab) {
        Intent intent = new Intent(activity, HomeActivity.class);
        intent.putExtra(EXTRA_START_TAB, startTab);
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return intent;
    }

    static Intent createHomeIntent(Activity activity) {
        return createIntent(activity, TAB_HOME);
    }

    static Intent createContactsIntent(Activity activity) {
        return createIntent(activity, TAB_CONTACTS);
    }

    static Intent createPhoneIntent(Activity activity) {
        return createIntent(activity, TAB_PHONE);
    }

    private List<Map<String, Object>> visibleSmsThreads() {
        String query = smsSearchQuery.trim().toLowerCase(Locale.US);
        if (query.isEmpty()) {
            return smsThreads;
        }
        List<Map<String, Object>> visible = new ArrayList<>();
        for (Map<String, Object> thread : smsThreads) {
            ContactInfo contact = contactForThread(thread);
            String haystack = (stringValue(thread.get("title"))
                    + " " + stringValue(thread.get("address"))
                    + " " + contact.name
                    + " " + contact.number
                    + " " + stringValue(thread.get("preview"))).toLowerCase(Locale.US);
            if (haystack.contains(query)) {
                visible.add(thread);
            }
        }
        return visible;
    }

    private void toggleSmsThreadSelection(Map<String, Object> thread) {
        String key = threadKey(thread);
        if (key.isEmpty()) {
            return;
        }
        if (selectedSmsThreadKeys.contains(key)) {
            selectedSmsThreadKeys.remove(key);
        } else {
            selectedSmsThreadKeys.add(key);
        }
        rebuild();
    }

    private void selectAllVisibleSmsThreads() {
        selectedSmsThreadKeys.clear();
        for (Map<String, Object> thread : visibleSmsThreads()) {
            String key = threadKey(thread);
            if (!key.isEmpty()) {
                selectedSmsThreadKeys.add(key);
            }
        }
    }

    private void ensureVisibleSelectedForMenuAction() {
        if (!selectedSmsThreadKeys.isEmpty()) {
            return;
        }
        smsBulkMode = true;
        selectAllVisibleSmsThreads();
    }

    private boolean allVisibleSmsSelected() {
        List<Map<String, Object>> visible = visibleSmsThreads();
        if (visible.isEmpty()) {
            return false;
        }
        for (Map<String, Object> thread : visible) {
            if (!selectedSmsThreadKeys.contains(threadKey(thread))) {
                return false;
            }
        }
        return true;
    }

    private List<Map<String, Object>> selectedSmsThreads() {
        List<Map<String, Object>> selected = new ArrayList<>();
        for (Map<String, Object> thread : smsThreads) {
            if (selectedSmsThreadKeys.contains(threadKey(thread))) {
                selected.add(thread);
            }
        }
        return selected;
    }

    private void markSelectedSmsThreadsRead() {
        List<Map<String, Object>> selected = selectedSmsThreads();
        if (selected.isEmpty()) {
            showSnack("Select conversations first.");
            return;
        }
        BridgeSmsStore.SmsMutationResult localResult = BridgeSmsStore.markThreadsRead(this, selected);
        for (Map<String, Object> thread : selected) {
            thread.put("unreadCount", 0);
        }
        BridgeConfig config = BridgeConfig.load(this);
        if (!config.hasDashboardAccess()) {
            selectedSmsThreadKeys.clear();
            smsBulkMode = false;
            loadSmsThreads();
            showSnack(localResult.totalChanged() > 0 ? "Marked read." : "No unread messages.");
            rebuild();
            return;
        }
        String deviceId = activeCommunicationDeviceId();
        int simSlot = activeCommunicationSimSlot();
        new Thread(() -> {
            try {
                DashboardApiClient.markAllSmsRead(config, deviceId, simSlot);
                runOnUiThread(() -> {
                    selectedSmsThreadKeys.clear();
                    smsBulkMode = false;
                    loadSmsThreads();
                    showSnack("Marked read.");
                    rebuild();
                });
            } catch (Exception error) {
                runOnUiThread(() -> showSnack(error.getMessage() == null ? "Unable to mark read." : error.getMessage()));
            }
        }, "dashboard-sms-read").start();
    }

    private void confirmDeleteSelectedSmsThreads() {
        List<Map<String, Object>> selected = selectedSmsThreads();
        if (selected.isEmpty()) {
            showSnack("Select conversations first.");
            return;
        }
        showSnack("Delete from dashboard conversations is not enabled in the app yet.");
    }

    private String threadKey(Map<String, Object> thread) {
        return stringValue(thread == null ? null : thread.get("threadKey"));
    }

    private ContactInfo contactForThread(Map<String, Object> thread) {
        String address = stringValue(thread == null ? null : thread.get("address"));
        String title = stringValue(thread == null ? null : thread.get("title"), address.isEmpty() ? "Unknown sender" : address);
        return resolveSmsContact(address, title);
    }

    private ContactInfo resolveSmsContact(String address, String fallbackName) {
        String lookup = firstNonEmptyValue(address, fallbackName);
        String cacheKey = contactCacheKey(lookup);
        if (smsContactCache.containsKey(cacheKey)) {
            return smsContactCache.get(cacheKey);
        }

        ContactInfo fallback = new ContactInfo(fallbackName.isEmpty() ? "Unknown sender" : fallbackName, address, avatarLabel(fallbackName), false);
        if (lookup.trim().isEmpty()) {
            smsContactCache.put(cacheKey, fallback);
            return fallback;
        }

        String normalizedLookup = contactCacheKey(lookup);
        LinkedHashMap<String, Map<String, String>> contacts = new LinkedHashMap<>();
        appendContacts(contacts, deviceContacts);
        appendContacts(contacts, dashboardContacts);
        for (Map<String, String> row : contacts.values()) {
            String number = safe(row.get("number")).trim();
            if (number.isEmpty() || !normalizedLookup.equals(contactCacheKey(number))) {
                continue;
            }
            String name = firstNonEmptyValue(safe(row.get("name")), fallback.name, number);
            ContactInfo contact = new ContactInfo(name, number, avatarLabel(name), true);
            smsContactCache.put(cacheKey, contact);
            return contact;
        }
        smsContactCache.put(cacheKey, fallback);
        return fallback;
    }

    private String contactCacheKey(String value) {
        String clean = safe(value).trim();
        String digits = clean.replaceAll("[^0-9]", "");
        if (!digits.isEmpty()) {
            return digits.length() > 10 ? digits.substring(digits.length() - 10) : digits;
        }
        return clean.toLowerCase(Locale.US);
    }

    private String avatarLabel(String name) {
        String clean = safe(name).trim();
        if (clean.isEmpty()) {
            return "?";
        }
        char firstChar = clean.charAt(0);
        if (firstChar == '+' || Character.isDigit(firstChar)) {
            return "#";
        }
        String[] parts = clean.split("\\s+");
        String first = parts[0].substring(0, 1).toUpperCase(Locale.US);
        if (parts.length > 1 && !parts[parts.length - 1].isEmpty()) {
            return (first + parts[parts.length - 1].substring(0, 1)).toUpperCase(Locale.US);
        }
        return first;
    }

    private String firstNonEmptyValue(String... values) {
        for (String value : values) {
            if (value != null && !value.trim().isEmpty()) {
                return value.trim();
            }
        }
        return "";
    }

    private boolean isSystemSmsThread(Map<String, Object> thread) {
        String address = stringValue(thread == null ? null : thread.get("address")).trim();
        String digits = address.replaceAll("[^0-9]", "");
        if (address.isEmpty()) {
            return true;
        }
        if (!address.matches("[+0-9()\\-\\s]+")) {
            return true;
        }
        return !digits.isEmpty() && digits.length() < 8;
    }

    private String systemThreadTrueTitle(Map<String, Object> thread, ContactInfo contact) {
        return firstNonEmptyValue(
                stringValue(thread == null ? null : thread.get("title")),
                contact == null ? "" : contact.name,
                stringValue(thread == null ? null : thread.get("address")),
                "System sender"
        );
    }

    private String systemThreadListSubtitle() {
        String operatorName = operatorDisplayName(activeCarrierName());
        if (operatorName.isEmpty()) {
            return "System Message";
        }
        return "System Message (" + operatorName + ")";
    }

    private String operatorDisplayName(String value) {
        String clean = safe(value).trim();
        String normalized = clean.toLowerCase(Locale.US).replaceAll("[^a-z0-9]", "");
        if (!normalized.isEmpty() && normalized.matches("^[0-9]+$")) {
            return "";
        }
        if (normalized.equals("gp") || normalized.contains("grameen")) {
            return "Grameenphone";
        }
        if (normalized.contains("airtel")) {
            return "Airtel";
        }
        if (normalized.contains("robi")) {
            return "Robi";
        }
        if (normalized.contains("banglalink")) {
            return "Banglalink";
        }
        if (normalized.contains("teletalk")) {
            return "Teletalk";
        }
        return clean;
    }

    private String activeCarrierName() {
        for (SubscriptionInfo info : activeSmsSubscriptions()) {
            if (info == null || info.getCarrierName() == null) {
                continue;
            }
            String carrier = info.getCarrierName().toString().trim();
            if (!carrier.isEmpty()) {
                return carrier;
            }
        }
        return "";
    }

    private String messageSourceBadge(String source) {
        String clean = safe(source).toLowerCase(Locale.US);
        if (clean.contains("dashboard_http")) {
            return "API";
        }
        if (clean.contains("dashboard_mqtt")) {
            return "MQTT";
        }
        if (clean.contains("dashboard")) {
            return "DB";
        }
        return "";
    }

    private String messageSourceLabel(Map<String, Object> message) {
        String source = stringValue(message.get("source"), "phone").toLowerCase(Locale.US);
        if (source.contains("dashboard_http")) {
            return "Dashboard API";
        }
        if (source.contains("dashboard_mqtt")) {
            return "Dashboard MQTT";
        }
        if (source.contains("dashboard")) {
            return "Dashboard";
        }
        if (source.contains("local")) {
            return "Phone compose";
        }
        if (boolValue(message.get("outgoing"))) {
            return "Phone SMS";
        }
        return "Incoming SMS";
    }

    private String messageInfoJson(Map<String, Object> message) {
        try {
            JSONObject root = new JSONObject();
            root.put("id", stringValue(message.get("id")));
            root.put("action_id", stringValue(message.get("actionId"), stringValue(message.get("id"))));
            root.put("thread_key", stringValue(message.get("threadKey")));
            root.put("address", stringValue(message.get("address")));
            root.put("direction", boolValue(message.get("outgoing")) ? "outgoing" : "incoming");
            root.put("source", stringValue(message.get("source")));
            root.put("source_label", messageSourceLabel(message));
            root.put("status", stringValue(message.get("status")));
            root.put("read", boolValue(message.get("read")));
            root.put("local_mirror", boolValue(message.get("localOnly")));
            root.put("timestamp", longValue(message.get("timestamp")));
            root.put("body", stringValue(message.get("body")));
            return root.toString(2).replace("\\/", "/");
        } catch (Exception error) {
            return stringValue(message.get("body"));
        }
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> consoleEntries() {
        Object raw = state.get("consoleEntries");
        if (!(raw instanceof List)) {
            return new ArrayList<>();
        }
        List<Map<String, Object>> entries = new ArrayList<>();
        for (Object item : (List<?>) raw) {
            if (item instanceof Map) {
                entries.add((Map<String, Object>) item);
            }
        }
        return entries;
    }

    private List<Map<String, Object>> filteredConsoleEntries() {
        String query = consoleQuery.trim().toLowerCase(Locale.US);
        List<Map<String, Object>> filtered = new ArrayList<>();
        for (Map<String, Object> entry : consoleEntries()) {
            String category = consoleCategory(entry);
            String level = stringValue(entry.get("level"), "info").toLowerCase(Locale.US);
            String haystack = (stringValue(entry.get("type"))
                    + " " + stringValue(entry.get("source"))
                    + " " + stringValue(entry.get("summary"))
                    + " " + stringValue(entry.get("detail"))
                    + " " + stringValue(entry.get("raw"))).toLowerCase(Locale.US);
            if (!"all".equals(consoleCategoryFilter) && !consoleCategoryFilter.equals(category)) {
                continue;
            }
            if (!"all".equals(consoleLevelFilter) && !level.contains(consoleLevelFilter)) {
                continue;
            }
            if (!query.isEmpty() && !haystack.contains(query)) {
                continue;
            }
            filtered.add(entry);
        }
        return filtered;
    }

    private String consoleCategory(Map<String, Object> entry) {
        String explicitType = stringValue(entry.get("type")).trim().toLowerCase(Locale.US);
        if ("sms".equals(explicitType)) return "sms";
        if ("call".equals(explicitType)) return "call";
        if ("ussd".equals(explicitType)) return "ussd";
        if ("setup".equals(explicitType)) return "setup";
        if ("http".equals(explicitType) || "mqtt".equals(explicitType)
                || "network".equals(explicitType) || "internet".equals(explicitType)) {
            return "network";
        }

        String source = stringValue(entry.get("source")).trim().toLowerCase(Locale.US);
        if ("telemetry".equals(source) || "heartbeat".equals(source) || "system".equals(source)) {
            return "system";
        }
        if (source.contains("sms")) return "sms";
        if (source.contains("call")) return "call";
        if (source.contains("ussd")) return "ussd";
        if (source.contains("http") || source.contains("mqtt") || source.contains("network")) return "network";
        if (source.contains("setup") || source.contains("onboard")) return "setup";

        String text = (explicitType
                + " " + source
                + " " + stringValue(entry.get("summary"))
                + " " + stringValue(entry.get("detail"))
                + " " + stringValue(entry.get("raw"))).toLowerCase(Locale.US);
        if (text.contains("/status")
                || text.contains("telemetry")
                || text.contains("status push")
                || text.contains("health pulse")
                || text.contains("heartbeat")) {
            return "system";
        }
        if (text.contains("sms")) return "sms";
        if (text.contains("call") || text.contains("ring")) return "call";
        if (text.contains("ussd")) return "ussd";
        if (text.contains("http") || text.contains("mqtt")) return "network";
        if (text.contains("setup") || text.contains("onboard")) return "setup";
        return "system";
    }

    private String joinConsole(List<Map<String, Object>> entries) {
        StringBuilder builder = new StringBuilder();
        for (Map<String, Object> entry : entries) {
            if (builder.length() > 0) {
                builder.append('\n');
            }
            builder.append(stringValue(entry.get("raw"), stringValue(entry.get("summary"))));
        }
        return builder.toString();
    }

    private String latestConsoleSummary() {
        List<Map<String, Object>> entries = consoleEntries();
        if (entries.isEmpty()) {
            return "No events";
        }
        return stringValue(entries.get(0).get("summary"), stringValue(entries.get(0).get("raw"), "Event"));
    }

    private String shortConsoleEventName(Map<String, Object> entry) {
        String clean = stringValue(entry.get("summary"), stringValue(entry.get("raw"), "Event"))
                .replace("Device Bridge", "Bridge")
                .replace("command received", "cmd")
                .replace("received", "rx")
                .replace("published", "pub")
                .replace("telemetry", "telemetry")
                .trim()
                .replaceAll("\\s+", " ");
        if (clean.isEmpty()) {
            return "Event";
        }
        String[] words = clean.split("\\s+");
        int count = Math.min(4, words.length);
        StringBuilder builder = new StringBuilder();
        for (int i = 0; i < count; i += 1) {
            if (builder.length() > 0) {
                builder.append(' ');
            }
            builder.append(words[i]);
        }
        return builder.toString();
    }

    private String recentActionLog() {
        StringBuilder builder = new StringBuilder();
        int count = 0;
        for (Map<String, Object> entry : consoleEntries()) {
            if (count >= 20) {
                break;
            }
            String category = consoleCategory(entry);
            if (!"sms".equals(category)
                    && !"call".equals(category)
                    && !"ussd".equals(category)
                    && !"network".equals(category)
                    && !"setup".equals(category)
                    && !"system".equals(category)) {
                continue;
            }
            if (builder.length() > 0) {
                builder.append("\n\n");
            }
            builder.append("[")
                    .append(stringValue(entry.get("timestamp"), "--"))
                    .append("] ")
                    .append(typeLabel(category))
                    .append("/")
                    .append(stringValue(entry.get("level"), "info").toUpperCase(Locale.US))
                    .append("  ")
                    .append(stringValue(entry.get("summary"), "Event"));
            String detail = stringValue(entry.get("detail"));
            if (!detail.isEmpty()) {
                builder.append("\n  ").append(detail);
            }
            count += 1;
        }
        return builder.toString();
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

    private boolean bridgeRunning() {
        return boolValue(state.get("online"))
                || BridgeAppGate.isBridgeServiceRunning(this)
                || boolValue(state.get("bridgeEnabled"));
    }

    private boolean isBatteryOptimizationDisabled() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            return true;
        }
        PowerManager powerManager = getSystemService(PowerManager.class);
        return powerManager != null && powerManager.isIgnoringBatteryOptimizations(getPackageName());
    }

    private void registerBridgeEventReceiverIfNeeded() {
        if (eventReceiverRegistered) {
            return;
        }
        IntentFilter filter = new IntentFilter(BridgeAppEvents.ACTION_STATE_CHANGED);
        ContextCompat.registerReceiver(this, bridgeEventReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED);
        eventReceiverRegistered = true;
    }

    private void unregisterBridgeEventReceiverIfNeeded() {
        if (!eventReceiverRegistered) {
            return;
        }
        try {
            unregisterReceiver(bridgeEventReceiver);
        } catch (RuntimeException ignored) {
        }
        eventReceiverRegistered = false;
    }

    private void copyText(String value) {
        ClipboardManager clipboard = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
        if (clipboard != null) {
            clipboard.setPrimaryClip(ClipData.newPlainText("Device Bridge", value));
            showSnack("Copied");
        }
    }

    private void showSnack(String message) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
    }

    private String consoleEntryJson(Map<String, Object> entry) {
        try {
            JSONObject root = new JSONObject();
            root.put("timestamp", stringValue(entry.get("timestamp")));
            root.put("type", stringValue(entry.get("type"), consoleCategory(entry)));
            root.put("level", stringValue(entry.get("level"), "info"));
            root.put("summary", stringValue(entry.get("summary")));
            root.put("detail", stringValue(entry.get("detail")));
            Object payload = firstStructuredConsoleValue(entry);
            if (payload != null) {
                root.put("payload", payload);
            }
            Object response = parseJsonCandidate(firstNonEmpty(entry, "response", "resultPayload", "responsePayload", "mqttResponse", "httpResponse"));
            if (response != null) {
                root.put("response", response);
            }
            String raw = stringValue(entry.get("raw"));
            String message = stripStructuredPayload(raw);
            if (!message.trim().isEmpty()) {
                root.put("raw", message.trim());
            }
            return root.toString(2).replace("\\/", "/");
        } catch (Exception error) {
            return stringValue(entry.get("raw"), stringValue(entry.get("summary")));
        }
    }

    private boolean hasContactsPermission() {
        return Build.VERSION.SDK_INT < 23 || checkSelfPermission(android.Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED;
    }

    private void requestContactsPermission() {
        if (Build.VERSION.SDK_INT >= 23) {
            requestPermissions(new String[]{android.Manifest.permission.READ_CONTACTS}, REQ_CONTACTS_PERMISSION);
        }
    }

    private void renderContactMatches(LinearLayout target, String query, ContactCallback callback) {
        target.removeAllViews();
        loadDeviceContacts(query, false);
        loadDashboardContacts(query, false);
        List<Map<String, String>> contacts = findContacts(query, 120);
        if (contacts.isEmpty()) {
            if (!hasContactsPermission()) {
                target.addView(contactPermissionRow(this::requestContactsPermission));
            } else {
                TextView empty = text((contactsLoading || deviceContactsLoading) ? "Loading contacts..." : "No contacts found", 12, "#64748b", false);
                empty.setGravity(Gravity.CENTER);
                empty.setPadding(dp(8), dp(16), dp(8), dp(16));
                target.addView(empty);
            }
            return;
        }
        for (Map<String, String> contact : contacts) {
            String name = contact.get("name");
            String number = contact.get("number");
            target.addView(contactRow(name, number, callback), fullWidth(4));
        }
    }

    private boolean looksLikePhoneNumber(String value) {
        String clean = safe(value).trim();
        if (clean.length() < 3) return false;
        return clean.matches("^[+0-9()\\-\\s]+$") && clean.replaceAll("[^0-9]", "").length() >= 3;
    }

    private String resolveNewSmsRecipientNumber(String typedValue) {
        String typed = safe(typedValue).trim();
        if (looksLikePhoneNumber(typed)) {
            return typed;
        }
        if (!safe(newSmsRecipientNumber).trim().isEmpty()) {
            return newSmsRecipientNumber.trim();
        }
        List<Map<String, String>> matches = findContacts(typed, 1);
        if (!matches.isEmpty()) {
            newSmsRecipientName = safe(matches.get(0).get("name"));
            return safe(matches.get(0).get("number")).trim();
        }
        return typed;
    }

    private List<Map<String, String>> findContacts(String query, int limit) {
        LinkedHashMap<String, Map<String, String>> merged = new LinkedHashMap<>();
        appendContacts(merged, deviceContacts);
        appendContacts(merged, dashboardContacts);
        List<Map<String, String>> contacts = new ArrayList<>();
        String normalized = safe(query).trim().toLowerCase(Locale.US);
        int max = Math.max(1, limit);
        for (Map<String, String> contact : merged.values()) {
            if (contacts.size() >= max) break;
            String name = safe(contact.get("name")).trim();
            String number = safe(contact.get("number")).trim();
            String haystack = (name + " " + number).toLowerCase(Locale.US);
            if (!normalized.isEmpty() && !haystack.contains(normalized)) {
                continue;
            }
            if (!number.isEmpty()) {
                Map<String, String> row = new HashMap<>();
                row.put("name", name.isEmpty() ? number : name);
                row.put("number", number);
                contacts.add(row);
            }
        }
        return contacts;
    }

    private void appendContacts(LinkedHashMap<String, Map<String, String>> target, List<Map<String, String>> source) {
        if (source == null) {
            return;
        }
        for (Map<String, String> contact : source) {
            if (contact == null) {
                continue;
            }
            String number = safe(contact.get("number")).trim();
            if (number.isEmpty()) {
                continue;
            }
            String key = contactCacheKey(number);
            if (target.containsKey(key)) {
                continue;
            }
            Map<String, String> row = new HashMap<>();
            row.put("name", firstNonEmptyValue(safe(contact.get("name")), number));
            row.put("number", number);
            target.put(key, row);
        }
    }

    private void loadDeviceContacts(String query, boolean rebuildAfter) {
        if (!hasContactsPermission() || deviceContactsLoading) {
            return;
        }
        String cleanQuery = safe(query).trim();
        if (deviceContactsLoaded && cleanQuery.equals(lastDeviceContactQuery) && !rebuildAfter) {
            return;
        }
        lastDeviceContactQuery = cleanQuery;
        deviceContactsLoading = true;
        new Thread(() -> {
            List<Map<String, String>> contacts = readDeviceContacts(cleanQuery, 240);
            runOnUiThread(() -> {
                deviceContacts = contacts;
                deviceContactsLoading = false;
                deviceContactsLoaded = true;
                smsContactCache.clear();
                if (rebuildAfter || selectedTabIndex == TAB_CONTACTS) rebuild();
            });
        }, "device-contacts").start();
    }

    private List<Map<String, String>> readDeviceContacts(String query, int limit) {
        List<Map<String, String>> contacts = new ArrayList<>();
        if (!hasContactsPermission()) {
            return contacts;
        }
        String cleanQuery = safe(query).trim();
        String selection = null;
        String[] args = null;
        if (!cleanQuery.isEmpty()) {
            selection = ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME_PRIMARY + " LIKE ? OR "
                    + ContactsContract.CommonDataKinds.Phone.NUMBER + " LIKE ?";
            args = new String[]{"%" + cleanQuery + "%", "%" + cleanQuery + "%"};
        }
        Cursor cursor = null;
        try {
            cursor = getContentResolver().query(
                    ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                    new String[]{
                            ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME_PRIMARY,
                            ContactsContract.CommonDataKinds.Phone.NUMBER
                    },
                    selection,
                    args,
                    ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME_PRIMARY + " ASC"
            );
            if (cursor == null) {
                return contacts;
            }
            int nameIndex = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME_PRIMARY);
            int numberIndex = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NUMBER);
            Set<String> seen = new HashSet<>();
            int max = Math.max(1, limit);
            while (cursor.moveToNext() && contacts.size() < max) {
                String number = numberIndex >= 0 ? safe(cursor.getString(numberIndex)).trim() : "";
                if (number.isEmpty()) {
                    continue;
                }
                String key = contactCacheKey(number);
                if (seen.contains(key)) {
                    continue;
                }
                seen.add(key);
                String name = nameIndex >= 0 ? safe(cursor.getString(nameIndex)).trim() : "";
                Map<String, String> row = new HashMap<>();
                row.put("name", firstNonEmptyValue(name, number));
                row.put("number", number);
                contacts.add(row);
            }
        } catch (RuntimeException error) {
            BridgeEventLog.append(this, "contacts: query failed " + error.getMessage());
        } finally {
            if (cursor != null) {
                cursor.close();
            }
        }
        return contacts;
    }

    private void loadDashboardContacts(String query, boolean rebuildAfter) {
        BridgeConfig config = BridgeConfig.load(this);
        String cleanQuery = safe(query).trim();
        if (!config.hasDashboardAccess() || contactsLoading) {
            return;
        }
        if (cleanQuery.equals(lastContactQuery) && !dashboardContacts.isEmpty() && !rebuildAfter) {
            return;
        }
        contactsLoading = true;
        lastContactQuery = cleanQuery;
        new Thread(() -> {
            try {
                List<Map<String, String>> contacts = DashboardApiClient.fetchContacts(config, cleanQuery, 200);
                runOnUiThread(() -> {
                    dashboardContacts = contacts;
                    contactsLoading = false;
                    smsContactCache.clear();
                    if (rebuildAfter || selectedTabIndex == TAB_CONTACTS) rebuild();
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    contactsLoading = false;
                    BridgeEventLog.append(this, "dashboard: contacts failed " + error.getMessage());
                    if (rebuildAfter || selectedTabIndex == TAB_CONTACTS) rebuild();
                });
            }
        }, "dashboard-contacts").start();
    }

    private View contactPermissionRow(Runnable action) {
        return attachmentRow(R.drawable.ic_db_person, "Allow contacts", "Enable contact search for new SMS recipients.", "#0b5ed7", action);
    }

    private View contactRow(String name, String number, ContactCallback callback) {
        LinearLayout group = new LinearLayout(this);
        group.setOrientation(LinearLayout.VERTICAL);

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(6), dp(10), dp(6), dp(10));
        row.setBackgroundColor(color("#ffffff"));
        row.setClickable(true);
        row.setFocusable(true);
        row.setOnClickListener(v -> runGuarded("contact:" + number, () -> callback.onContact(name, number)));
        row.addView(smsAvatar(name.trim().isEmpty() ? "?" : name.substring(0, 1).toUpperCase(Locale.US), false), fixed(34, 34, 10));
        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        copy.addView(text(name, 15, "#111111", true));
        copy.addView(text(number, 12, "#636366", false));
        row.addView(copy, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        row.addView(tintedIcon(R.drawable.ic_db_arrow_forward, "#c7c7cc", 15), fixed(15, 15, 0));
        group.addView(row);

        View divider = new View(this);
        divider.setBackgroundColor(color("#e5e5ea"));
        group.addView(divider, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1)));
        return group;
    }

    private void showContactInfoSheet(ContactInfo contact, Map<String, Object> thread) {
        Dialog dialog = createBottomSheetDialog();
        LinearLayout sheet = new LinearLayout(this);
        sheet.setOrientation(LinearLayout.VERTICAL);
        sheet.setPadding(dp(12), dp(12), dp(12), dp(14));
        sheet.setBackground(roundRect("#ffffff", "#ffffff", 24));

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.addView(smsAvatar(contact.avatar, false), fixed(44, 44, 10));
        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        copy.addView(text(contact.name.isEmpty() ? "Unknown sender" : contact.name, 17, "#0f172a", true));
        copy.addView(text(contact.matched ? "Saved contact" : "Phone number only", 12, "#64748b", false));
        header.addView(copy, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        header.addView(iconAction(R.drawable.ic_db_copy, "#f8fafc", "#0f172a", () -> copyText(contact.number)), wrapRight(6));
        header.addView(iconAction(R.drawable.ic_db_close, "#f8fafc", "#0f172a", dialog::dismiss));
        sheet.addView(header, fullWidth(12));

        LinearLayout info = new LinearLayout(this);
        info.setOrientation(LinearLayout.VERTICAL);
        info.setPadding(dp(12), dp(12), dp(12), dp(12));
        info.setBackground(roundRect("#f8fafc", "#e2e8f0", 18));
        info.addView(contactInfoLine("Name", contact.name), fullWidth(8));
        info.addView(contactInfoLine("Number", contact.number.isEmpty() ? stringValue(thread.get("address"), "Unknown") : contact.number), fullWidth(8));
        info.addView(contactInfoLine("Thread", stringValue(thread.get("threadKey"), "SMS thread")), fullWidth(8));
        info.addView(contactInfoLine("Unread", String.valueOf(intValue(thread.get("unreadCount")))), fullWidth(8));
        info.addView(contactInfoLine("Last message", stringValue(thread.get("preview"), "No message body")));
        ScrollView infoScroll = new ScrollView(this);
        infoScroll.addView(info);
        sheet.addView(infoScroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(280)));

        if (!hasContactsPermission()) {
            sheet.addView(labelIconButton("Allow contacts", R.drawable.ic_db_person, "#0b5ed7", "#ffffff", () -> {
                dialog.dismiss();
                reopenNewConversationAfterContactsPermission = false;
                requestContactsPermission();
            }), fullWidth(10));
        }
        if (!contact.matched) {
            TextView hint = text("This sender is not linked to a saved contact yet. Add the number to contacts and reopen this screen to show the saved name.", 12, "#64748b", false);
            hint.setPadding(dp(6), dp(10), dp(6), 0);
            sheet.addView(hint);
        }
        showFixedBottomSheetDialog(dialog, sheet);
    }

    private View contactInfoLine(String label, String value) {
        LinearLayout line = new LinearLayout(this);
        line.setOrientation(LinearLayout.VERTICAL);
        line.addView(text(label, 10, "#64748b", true));
        TextView body = text(value == null || value.trim().isEmpty() ? "-" : value, 13, "#0f172a", false);
        body.setTextIsSelectable(true);
        line.addView(body);
        return line;
    }

    private void appendComposerText(EditText composer, String value) {
        String clean = safe(value).trim();
        if (clean.isEmpty()) {
            return;
        }
        String current = composer.getText().toString();
        composer.setText(current.isEmpty() ? clean : current + "\n" + clean);
        composer.setSelection(composer.getText().length());
    }

    private String modalJson(String title, String badge, String detail) {
        String data = prettyJsonValue(detail);
        boolean structured = data.startsWith("{") || data.startsWith("[");
        StringBuilder builder = new StringBuilder();
        builder.append("{\n");
        appendJsonField(builder, "title", title, true);
        appendJsonField(builder, "type", badge, true);
        builder.append("  \"data\": ");
        if (structured) {
            builder.append(indentJson(data, 2));
        } else {
            builder.append("\"").append(escapeJson(detail)).append("\"");
        }
        builder.append("\n}");
        return builder.toString().replace("\\/", "/");
    }

    private String prettyJsonValue(String value) {
        String clean = safe(value).trim();
        try {
            if (clean.startsWith("{")) {
                return new JSONObject(clean).toString(2).replace("\\/", "/");
            }
            if (clean.startsWith("[")) {
                return new JSONArray(clean).toString(2).replace("\\/", "/");
            }
        } catch (Exception ignored) {
        }
        return clean;
    }

    private Object firstStructuredConsoleValue(Map<String, Object> entry) {
        Object direct = parseJsonCandidate(firstNonEmpty(entry, "payload", "request", "requestPayload", "mqttPayload", "httpPayload"));
        if (direct != null) {
            return direct;
        }
        return extractPayloadFromRaw(stringValue(entry.get("raw")));
    }

    private String firstNonEmpty(Map<String, Object> entry, String... keys) {
        for (String key : keys) {
            String value = stringValue(entry.get(key));
            if (!value.isEmpty()) {
                return value;
            }
        }
        return "";
    }

    private Object parseJsonCandidate(String value) {
        String clean = safe(value).trim();
        if (clean.isEmpty()) {
            return null;
        }
        try {
            if (clean.startsWith("{")) {
                return new JSONObject(clean);
            }
            if (clean.startsWith("[")) {
                return new JSONArray(clean);
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    private Object extractPayloadFromRaw(String raw) {
        String json = extractJsonAfter(raw, "payload=");
        if (json.isEmpty()) {
            json = extractJsonAfter(raw, "response=");
        }
        return parseJsonCandidate(json);
    }

    private String stripStructuredPayload(String raw) {
        String clean = safe(raw);
        int payloadIndex = clean.indexOf("payload=");
        if (payloadIndex >= 0) {
            return clean.substring(0, payloadIndex).replace("::", "").trim();
        }
        int responseIndex = clean.indexOf("response=");
        if (responseIndex >= 0) {
            return clean.substring(0, responseIndex).replace("::", "").trim();
        }
        return clean;
    }

    private String extractJsonAfter(String source, String marker) {
        int markerIndex = safe(source).indexOf(marker);
        if (markerIndex < 0) {
            return "";
        }
        int start = markerIndex + marker.length();
        while (start < source.length() && Character.isWhitespace(source.charAt(start))) {
            start += 1;
        }
        if (start >= source.length()) {
            return "";
        }
        char open = source.charAt(start);
        char close = open == '{' ? '}' : open == '[' ? ']' : '\0';
        if (close == '\0') {
            return "";
        }
        int depth = 0;
        boolean inString = false;
        boolean escaped = false;
        for (int i = start; i < source.length(); i += 1) {
            char ch = source.charAt(i);
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch == '\\') {
                escaped = true;
                continue;
            }
            if (ch == '"') {
                inString = !inString;
                continue;
            }
            if (inString) {
                continue;
            }
            if (ch == open) {
                depth += 1;
            } else if (ch == close) {
                depth -= 1;
                if (depth == 0) {
                    return source.substring(start, i + 1);
                }
            }
        }
        return "";
    }

    private String indentJson(String value, int spaces) {
        String prefix = repeat(" ", spaces);
        return value.replace("\n", "\n" + prefix);
    }

    private void appendJsonField(StringBuilder builder, String key, String value, boolean comma) {
        builder.append("  \"")
                .append(escapeJson(key))
                .append("\": \"")
                .append(escapeJson(value))
                .append("\"");
        if (comma) {
            builder.append(",");
        }
        builder.append("\n");
    }

    private String escapeJson(String value) {
        return safe(value)
                .replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\r", "\\r")
                .replace("\n", "\\n");
    }

    private String repeat(String value, int count) {
        StringBuilder builder = new StringBuilder();
        for (int i = 0; i < count; i += 1) {
            builder.append(value);
        }
        return builder.toString();
    }

    private Dialog createBottomSheetDialog() {
        Dialog dialog = new Dialog(this);
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
        return dialog;
    }

    private void showBottomSheetDialog(Dialog dialog, View content) {
        LinearLayout outer = new LinearLayout(this);
        outer.setOrientation(LinearLayout.VERTICAL);
        outer.setPadding(dp(12), 0, dp(12), dp(12));
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(false);
        scroll.addView(content);
        outer.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        dialog.setContentView(outer);
        dialog.show();
        Window window = dialog.getWindow();
        if (window == null) {
            return;
        }
        window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
        window.setDimAmount(0.36f);
        window.setGravity(Gravity.BOTTOM);
        window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    private void showFixedBottomSheetDialog(Dialog dialog, View content) {
        LinearLayout outer = new LinearLayout(this);
        outer.setOrientation(LinearLayout.VERTICAL);
        outer.setPadding(dp(12), dp(18), dp(12), dp(12));
        outer.addView(content, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        dialog.setContentView(outer);
        dialog.show();
        Window window = dialog.getWindow();
        if (window == null) {
            return;
        }
        window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
        window.setDimAmount(0.36f);
        window.setGravity(Gravity.BOTTOM);
        window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }

    private String connectionTarget() {
        String[] lines = stringValue(state.get("connectionSummary")).split("\\n");
        for (String line : lines) {
            String clean = safe(line).trim();
            if (clean.startsWith("target")) {
                int idx = clean.indexOf('=');
                return idx >= 0 ? clean.substring(idx + 1).trim() : clean;
            }
        }
        return "";
    }

    private String retryLabel() {
        String source = stringValue(state.get("connectionSummary")).toLowerCase(Locale.US);
        if (source.contains("retry")) {
            return "retry window";
        }
        return "status refresh";
    }

    private String formatSmsTimestamp(Object raw) {
        long timestamp = longValue(raw);
        if (timestamp <= 0) {
            return "";
        }
        Date date = new Date(timestamp);
        SimpleDateFormat sameDay = new SimpleDateFormat("h:mm a", Locale.US);
        SimpleDateFormat otherDay = new SimpleDateFormat("d/M/yy h:mm a", Locale.US);
        return isSameDay(timestamp, System.currentTimeMillis()) ? sameDay.format(date) : otherDay.format(date);
    }

    private boolean isSameDay(long first, long second) {
        SimpleDateFormat key = new SimpleDateFormat("yyyyMMdd", Locale.US);
        return key.format(new Date(first)).equals(key.format(new Date(second)));
    }

    private String capitalize(String value) {
        String clean = safe(value).trim();
        if (clean.isEmpty()) {
            return "";
        }
        return clean.substring(0, 1).toUpperCase(Locale.US) + clean.substring(1);
    }

    private String joinNonEmpty(String first, String second) {
        String a = safe(first).trim();
        String b = safe(second).trim();
        if (a.isEmpty()) return b;
        if (b.isEmpty()) return a;
        return a + " - " + b;
    }

    private boolean boolValue(Object value) {
        return value instanceof Boolean ? (Boolean) value : "true".equalsIgnoreCase(String.valueOf(value));
    }

    private int intValue(Object value) {
        if (value instanceof Number) {
            return ((Number) value).intValue();
        }
        try {
            return Integer.parseInt(String.valueOf(value));
        } catch (Exception ignored) {
            return 0;
        }
    }

    private long longValue(Object value) {
        if (value instanceof Number) {
            return ((Number) value).longValue();
        }
        try {
            return Long.parseLong(String.valueOf(value));
        } catch (Exception ignored) {
            return 0L;
        }
    }

    private String stringValue(Object value) {
        return stringValue(value, "");
    }

    private String stringValue(Object value, String fallback) {
        if (value == null) {
            return fallback;
        }
        String clean = String.valueOf(value).trim();
        return clean.isEmpty() ? fallback : clean;
    }

    private String safe(String value) {
        return value == null ? "" : value;
    }

    private String safe(String value, String fallback) {
        return value == null || value.trim().isEmpty() ? fallback : value;
    }

    private void runGuarded(String key, Runnable action) {
        if (action == null) return;
        String cleanKey = safe(key, "action");
        long now = System.currentTimeMillis();
        Long last = guardedActionTimes.get(cleanKey);
        if (last != null && now - last < 750L) {
            return;
        }
        if ((busy || smsSending) && !cleanKey.startsWith("nav:")) {
            return;
        }
        guardedActionTimes.put(cleanKey, now);
        action.run();
    }

    private LinearLayout rootLayout(int left, int top, int right, int bottom) {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(left), dp(top), dp(right), dp(bottom));
        root.setBackgroundColor(color("#f2f5fa"));
        return root;
    }

    private LinearLayout card(int padding, int radius) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(padding), dp(padding), dp(padding), dp(padding));
        card.setBackground(roundRect("#ffffff", "#e2e8f0", radius));
        return card;
    }

    private View labelIconButton(String label, int iconRes, String bg, String fg, Runnable action) {
        LinearLayout button = new LinearLayout(this);
        button.setOrientation(LinearLayout.HORIZONTAL);
        button.setGravity(Gravity.CENTER);
        button.setPadding(dp(9), dp(7), dp(10), dp(7));
        button.setBackground(roundRect(bg, bg, 12));
        button.setClickable(true);
        button.setFocusable(true);
        button.setOnClickListener(v -> runGuarded("button:" + label, action));
        button.addView(tintedIcon(iconRes, fg, 15), fixed(15, 15, 6));
        button.addView(text(label, 11, fg, true));
        return button;
    }

    private View consoleUtility(int iconRes, Runnable action) {
        FrameLayout button = new FrameLayout(this);
        button.setMinimumWidth(dp(36));
        button.setMinimumHeight(dp(36));
        button.setPadding(dp(8), dp(8), dp(8), dp(8));
        button.setBackground(roundRect("#111827", "#111827", 12));
        button.setClickable(true);
        button.setFocusable(true);
        button.setOnClickListener(v -> runGuarded("console-utility", action));
        button.addView(tintedIcon(iconRes, "#ffffff", 18), new FrameLayout.LayoutParams(dp(18), dp(18), Gravity.CENTER));
        return button;
    }

    private View iconAction(int iconRes, String bg, String fg, Runnable action) {
        FrameLayout button = new FrameLayout(this);
        button.setMinimumWidth(dp(38));
        button.setMinimumHeight(dp(38));
        button.setBackground(roundRect(bg, "#e2e8f0", 12));
        button.setClickable(true);
        button.setFocusable(true);
        button.setOnClickListener(v -> runGuarded("icon:" + iconRes, action));
        button.addView(tintedIcon(iconRes, fg, 18), new FrameLayout.LayoutParams(dp(18), dp(18), Gravity.CENTER));
        return button;
    }

    private View iconTile(int iconRes, String accent, int size, int radius, int iconSize) {
        FrameLayout tile = new FrameLayout(this);
        tile.setMinimumWidth(dp(size));
        tile.setMinimumHeight(dp(size));
        tile.setBackground(translucentRound(accent, 0x1f, radius));
        tile.addView(tintedIcon(iconRes, accent, iconSize), new FrameLayout.LayoutParams(dp(iconSize), dp(iconSize), Gravity.CENTER));
        return tile;
    }

    private View iconChip(int iconRes, String bg, String fg, int size, int iconSize) {
        FrameLayout chip = new FrameLayout(this);
        chip.setMinimumWidth(dp(size));
        chip.setMinimumHeight(dp(size));
        chip.setBackground(roundRect(bg, "#e2e8f0", 999));
        chip.addView(tintedIcon(iconRes, fg, iconSize), new FrameLayout.LayoutParams(dp(iconSize), dp(iconSize), Gravity.CENTER));
        return chip;
    }

    private ImageView tintedIcon(int iconRes, String tint, int size) {
        ImageView icon = new ImageView(this);
        icon.setImageResource(iconRes);
        icon.setColorFilter(color(tint));
        icon.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
        icon.setAdjustViewBounds(false);
        icon.setMinimumWidth(dp(size));
        icon.setMinimumHeight(dp(size));
        return icon;
    }

    private View logBadge(String label, String accent) {
        TextView badge = text(label, 9, accent, true);
        badge.setGravity(Gravity.CENTER);
        badge.setSingleLine(true);
        badge.setPadding(dp(5), dp(2), dp(5), dp(2));
        badge.setBackground(translucentRound(accent, 0x29, 999));
        return badge;
    }

    private String levelColor(Map<String, Object> entry) {
        String level = stringValue(entry.get("level"), "info").toLowerCase(Locale.US);
        if ("error".equals(level)) return "#f87171";
        if ("warn".equals(level)) return "#fbbf24";
        return "#60a5fa";
    }

    private String levelLabel(Map<String, Object> entry) {
        String level = stringValue(entry.get("level"), "info").trim().toLowerCase(Locale.US);
        if ("error".equals(level)) return "ERR";
        if ("warn".equals(level) || "warning".equals(level)) return "WRN";
        if ("info".equals(level) || level.isEmpty()) return "INF";
        return level.substring(0, Math.min(3, level.length())).toUpperCase(Locale.US);
    }

    private String typeLabel(String type) {
        String normalized = safe(type).trim().toLowerCase(Locale.US);
        if ("sms".equals(normalized)) return "SMS";
        if ("ussd".equals(normalized)) return "USD";
        if ("mqtt".equals(normalized)) return "MQT";
        if ("http".equals(normalized)) return "HTP";
        if ("network".equals(normalized) || "internet".equals(normalized)) return "NET";
        if ("call".equals(normalized)) return "CAL";
        if ("queue".equals(normalized)) return "QUE";
        if ("setup".equals(normalized)) return "STP";
        if ("system".equals(normalized) || normalized.isEmpty()) return "SYS";
        return normalized.substring(0, Math.min(3, normalized.length())).toUpperCase(Locale.US);
    }

    private EditText input(String hint) {
        EditText input = new EditText(this);
        input.setHint(hint);
        input.setTextSize(13);
        input.setPadding(dp(12), dp(10), dp(12), dp(10));
        input.setBackground(roundRect("#f8fafc", "#cbd5e1", 14));
        return input;
    }

    private TextView text(String value, int sp, String color, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(sp);
        view.setTextColor(color(color));
        view.setLineSpacing(0f, 1.14f);
        view.setIncludeFontPadding(true);
        if (bold) {
            view.setTypeface(Typeface.DEFAULT_BOLD);
        }
        return view;
    }

    private TextView singleLineText(String value, int sp, String color, boolean bold) {
        TextView view = text(value, sp, color, bold);
        view.setSingleLine(true);
        view.setEllipsize(TextUtils.TruncateAt.END);
        return view;
    }

    private TextView pill(String label, String bg, String fg) {
        TextView view = text(label, 10, fg, true);
        view.setGravity(Gravity.CENTER);
        view.setSingleLine(true);
        view.setEllipsize(TextUtils.TruncateAt.END);
        view.setPadding(dp(8), dp(5), dp(8), dp(5));
        view.setBackground(roundRect(bg, bg, 999));
        return view;
    }

    private Button chipButton(String label, String bg, String fg) {
        Button button = new Button(this);
        button.setAllCaps(false);
        button.setText(label);
        button.setTextSize(11);
        button.setTypeface(Typeface.DEFAULT_BOLD);
        button.setTextColor(color(fg));
        button.setPadding(dp(9), dp(6), dp(9), dp(6));
        button.setMinHeight(0);
        button.setMinimumHeight(0);
        button.setBackground(roundRect(bg, bg, 12));
        return button;
    }

    private GradientDrawable roundRect(String fill, String stroke, int radius) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color(fill));
        drawable.setCornerRadius(dp(radius));
        drawable.setStroke(dp(1), color(stroke));
        return drawable;
    }

    private GradientDrawable translucentRound(String fill, int alpha, int radius) {
        int parsed = color(fill);
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(Color.argb(alpha, Color.red(parsed), Color.green(parsed), Color.blue(parsed)));
        drawable.setCornerRadius(dp(radius));
        drawable.setStroke(dp(1), Color.argb(Math.min(255, alpha + 10), Color.red(parsed), Color.green(parsed), Color.blue(parsed)));
        return drawable;
    }

    private GradientDrawable gradient(String start, String end, int radius) {
        GradientDrawable drawable = new GradientDrawable(
                GradientDrawable.Orientation.TL_BR,
                new int[]{color(start), color(end)}
        );
        drawable.setCornerRadius(dp(radius));
        return drawable;
    }

    private GradientDrawable gradient(String start, String end, int radius, String stroke) {
        GradientDrawable drawable = gradient(start, end, radius);
        drawable.setStroke(dp(1), color(stroke));
        return drawable;
    }

    private GradientDrawable translucentGradient(String accent, int radius) {
        int parsed = color(accent);
        GradientDrawable drawable = new GradientDrawable(
                GradientDrawable.Orientation.LEFT_RIGHT,
                new int[]{
                        Color.argb(41, Color.red(parsed), Color.green(parsed), Color.blue(parsed)),
                        Color.argb(13, Color.red(parsed), Color.green(parsed), Color.blue(parsed))
                }
        );
        drawable.setCornerRadius(dp(radius));
        drawable.setStroke(dp(1), Color.argb(61, Color.red(parsed), Color.green(parsed), Color.blue(parsed)));
        return drawable;
    }

    private String translucentHex(String base, float alpha) {
        int parsed = color(base);
        int r = Math.round(Color.red(parsed) * alpha + 255 * (1f - alpha));
        int g = Math.round(Color.green(parsed) * alpha + 255 * (1f - alpha));
        int b = Math.round(Color.blue(parsed) * alpha + 255 * (1f - alpha));
        return String.format(Locale.US, "#%02x%02x%02x", r, g, b);
    }

    private GradientDrawable softTint(String accent, int radius) {
        GradientDrawable drawable = new GradientDrawable(
                GradientDrawable.Orientation.TL_BR,
                new int[]{Color.WHITE, lighten(accent)}
        );
        drawable.setCornerRadius(dp(radius));
        drawable.setStroke(dp(1), blendStroke(accent));
        return drawable;
    }

    private int lighten(String colorHex) {
        int parsed = color(colorHex);
        return Color.rgb(
                (Color.red(parsed) + 255 * 9) / 10,
                (Color.green(parsed) + 255 * 9) / 10,
                (Color.blue(parsed) + 255 * 9) / 10
        );
    }

    private int blendStroke(String colorHex) {
        int parsed = color(colorHex);
        return Color.rgb(
                (Color.red(parsed) + 226 * 4) / 5,
                (Color.green(parsed) + 232 * 4) / 5,
                (Color.blue(parsed) + 240 * 4) / 5
        );
    }

    private LinearLayout.LayoutParams fullWidth(int bottomMargin) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        params.bottomMargin = dp(bottomMargin);
        return params;
    }

    private LinearLayout.LayoutParams weighted(int rightMargin) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        params.setMarginEnd(dp(rightMargin));
        return params;
    }

    private LinearLayout.LayoutParams wrapRight(int rightMargin) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        params.setMarginEnd(dp(rightMargin));
        return params;
    }

    private LinearLayout.LayoutParams wrapLeft(int leftMargin) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        params.setMarginStart(dp(leftMargin));
        return params;
    }

    private LinearLayout.LayoutParams fixed(int width, int height, int rightMargin) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(dp(width), dp(height));
        params.setMarginEnd(dp(rightMargin));
        return params;
    }

    private int color(String hex) {
        return Color.parseColor(hex);
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density);
    }
}
