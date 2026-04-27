package com.devicebridge.android;

import android.Manifest;
import android.app.ActivityManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.media.AudioManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.database.Cursor;
import android.net.Uri;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.wifi.ScanResult;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.Bundle;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.StatFs;
import android.os.SystemClock;
import android.provider.CallLog;
import android.provider.Settings;
import android.telecom.PhoneAccountHandle;
import android.telecom.TelecomManager;
import android.telephony.PhoneStateListener;
import android.telephony.SignalStrength;
import android.telephony.SubscriptionInfo;
import android.telephony.SubscriptionManager;
import android.telephony.TelephonyManager;
import android.util.Log;

import org.eclipse.paho.client.mqttv3.IMqttDeliveryToken;
import org.eclipse.paho.client.mqttv3.MqttCallbackExtended;
import org.eclipse.paho.client.mqttv3.MqttClient;
import org.eclipse.paho.client.mqttv3.MqttConnectOptions;
import org.eclipse.paho.client.mqttv3.MqttException;
import org.eclipse.paho.client.mqttv3.MqttMessage;
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Queue;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

public class MqttBridgeService extends Service {
    static final String ACTION_START = "com.devicebridge.android.START";
    static final String ACTION_STOP = "com.devicebridge.android.STOP";
    static final String ACTION_PUBLISH_INCOMING = "com.devicebridge.android.PUBLISH_INCOMING";
    static final String ACTION_TEST_STATUS_PUSH = "com.devicebridge.android.TEST_STATUS_PUSH";
    static final String ACTION_CLEAR_QUEUE = "com.devicebridge.android.CLEAR_QUEUE";
    static final String EXTRA_FROM = "from";
    static final String EXTRA_TEXT = "text";
    static final String EXTRA_TIMESTAMP = "timestamp";
    static final String EXTRA_SLOT = "slot";

    private static final String TAG = "DeviceBridge";
    private static final String CHANNEL_ID = "device_bridge";
    private static final int NOTIFICATION_ID = 7201;
    private static final int RECONNECT_DELAY_SECONDS = 15;
    private static final int STATUS_HEARTBEAT_INTERVAL_SECONDS = 45;
    private static final int HTTP_OUTSTANDING_POLL_INTERVAL_SECONDS = 15;
    private static final int BULK_SYNC_LIMIT = 240;
    private static final String KEY_INITIAL_SMS_SYNC_PREFIX = "initial_sms_sync_done_";
    private static final String KEY_INITIAL_CALL_SYNC_PREFIX = "initial_call_sync_done_";
    private static final String KEY_SMS_SYNC_WATERMARK_PREFIX = "initial_sms_sync_watermark_";
    private static final String KEY_CALL_SYNC_WATERMARK_PREFIX = "initial_call_sync_watermark_";
    private static final String KEY_PENDING_PERMISSION_BULK_SYNC_PREFIX = "pending_permission_bulk_sync_";
    private static volatile MqttBridgeService activeService;

    private final ScheduledExecutorService executor = Executors.newSingleThreadScheduledExecutor();
    private final Queue<PendingPublish> pendingPublishes = new ConcurrentLinkedQueue<>();
    private volatile MqttClient client;
    private volatile BridgeConfig config;
    private volatile ScheduledFuture<?> reconnectFuture;
    private volatile ScheduledFuture<?> statusHeartbeatFuture;
    private volatile ScheduledFuture<?> outstandingPollFuture;
    private volatile boolean stopRequested;
    private volatile boolean commandSubscriptionsReady;
    private volatile boolean activeHttpTransport;
    private volatile long publishSuccessCount;
    private volatile long publishFailureCount;
    private volatile long lastStatusPushAtMs;
    private volatile long lastQueuePollAtMs;
    private volatile long lastMessageEventAtMs;
    private volatile long lastIncomingSyncAtMs;
    private volatile long lastSendAcceptedAtMs;
    private volatile PhoneStateListener callStateListener;
    private volatile BroadcastReceiver phoneStateReceiver;
    private volatile int lastCallState = TelephonyManager.CALL_STATE_IDLE;
    private volatile String lastCallNumber = "";
    private volatile String pendingDialNumber = "";
    private volatile DeviceIdentitySnapshot cachedDeviceIdentity = new DeviceIdentitySnapshot("", "", "", "", "", "", "");
    private volatile List<SimSlotSnapshot> cachedSimSlots = new ArrayList<>();
    private volatile long lastDetailedStatusAtMs;
    private volatile boolean detailedStatusPending = true;
    private volatile long lastHttpRecoveryAttemptAtMs;
    private BridgeHttpHandler httpHandler;

    @Override
    public void onCreate() {
        super.onCreate();
        activeService = this;
        httpHandler = new BridgeHttpHandler(this, executor);
        hydrateRuntimeTelemetry();
        createNotificationChannel();
        registerPhoneStateReceiver();
        registerCallStateListener();
        BridgeEventLog.append(this, "Device Bridge service created");
        BridgeRuntimeState.save(this, "idle", false, "Bridge not started");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_START : intent.getAction();
        config = BridgeConfig.load(this);
        registerPhoneStateReceiver();
        registerCallStateListener();
        if (ACTION_STOP.equals(action)) {
            BridgeEventLog.append(this, "Stop requested from service command");
            stopBridge();
            return START_NOT_STICKY;
        }
        if (ACTION_CLEAR_QUEUE.equals(action)) {
            pendingPublishes.clear();
            BridgeEventLog.append(this, "Local bridge queue cleared");
            persistRuntimeTelemetry();
            return START_NOT_STICKY;
        }

        if (ACTION_PUBLISH_INCOMING.equals(action) && !currentConfig().bridgeEnabled) {
            Log.i(TAG, "Ignoring inbound SMS because bridge is disabled");
            BridgeEventLog.append(this, "Inbound SMS ignored because bridge is disabled");
            return START_NOT_STICKY;
        }

        if (ACTION_START.equals(action) && !hasUsableConnection(config)) {
            config.withBridgeEnabled(false).save(this);
            BridgeEventLog.append(this, "Bridge start blocked: connection setup required");
            updateRuntimeState("config_missing", false, "Open onboarding and import a QR or setup code.");
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }

        stopRequested = false;
        startForegroundCompat();
        BridgeEventLog.append(this, "Bridge start command received");
        updateRuntimeState("starting", false, "Starting bridge");
        if (ACTION_START.equals(action)) {
            config = currentConfig().withBridgeEnabled(true);
            config.save(this);
            detailedStatusPending = true;
        }
        connectAsync();

        if (ACTION_TEST_STATUS_PUSH.equals(action)) {
            BridgeEventLog.append(this, "Status push test requested");
            executor.execute(() -> publishStatus("online", true));
        }

        if (ACTION_PUBLISH_INCOMING.equals(action) && intent != null) {
            publishIncomingSms(
                    intent.getStringExtra(EXTRA_FROM),
                    intent.getStringExtra(EXTRA_TEXT),
                    intent.getLongExtra(EXTRA_TIMESTAMP, System.currentTimeMillis()),
                    intent.getIntExtra(EXTRA_SLOT, -1)
            );
        }

        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        activeService = null;
        cancelReconnect();
        cancelStatusHeartbeat();
        cancelOutstandingPoll();
        unregisterPhoneStateReceiver();
        unregisterCallStateListener();
        executor.execute(() -> {
            try {
                MqttClient current = client;
                if (current != null) {
                    current.disconnectForcibly(500, 500);
                    current.close();
                }
            } catch (MqttException ignored) {
            }
        });
        executor.shutdownNow();
        BridgeRuntimeState.save(this, currentConfig().bridgeEnabled ? "stopped" : "offline", false, "Bridge stopped");
        super.onDestroy();
    }

    static void publishIncomingFromReceiver(Context context, String from, String text, long timestamp, int slot) {
        MqttBridgeService service = activeService;
        if (service != null) {
            service.publishIncomingSms(from, text, timestamp, slot);
            return;
        }

        if (!BridgeConfig.load(context).bridgeEnabled) {
            return;
        }

        Intent intent = new Intent(context, MqttBridgeService.class)
                .setAction(ACTION_PUBLISH_INCOMING)
                .putExtra(EXTRA_FROM, from)
                .putExtra(EXTRA_TEXT, text)
                .putExtra(EXTRA_TIMESTAMP, timestamp)
                .putExtra(EXTRA_SLOT, slot);
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } catch (RuntimeException error) {
            Log.w(TAG, "Unable to start bridge for inbound SMS", error);
        }
    }

    static void requestImmediateStatusPush(Context context) {
        Intent intent = new Intent(context, MqttBridgeService.class).setAction(ACTION_TEST_STATUS_PUSH);
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } catch (RuntimeException error) {
            BridgeEventLog.append(context, "Status push test could not start");
        }
    }

    static void requestClearQueue(Context context) {
        Intent intent = new Intent(context, MqttBridgeService.class).setAction(ACTION_CLEAR_QUEUE);
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } catch (RuntimeException error) {
            BridgeEventLog.append(context, "Queue clear could not start");
        }
    }

    static void requestSilentBulkSync(Context context) {
        if (context == null) {
            return;
        }
        Context appContext = context.getApplicationContext();
        MqttBridgeService service = activeService;
        if (service != null) {
            service.executor.execute(() -> service.syncSmsAndCallsToDashboardOnce(true));
            return;
        }

        BridgeConfig cfg = BridgeConfig.load(appContext);
        if ((cfg.hasProvisionedMqttConfig() && !cfg.usesHttpTransport()) || !cfg.hasHttpBridgeConfig()) {
            appContext.getSharedPreferences(BridgeConfig.PREFS, Context.MODE_PRIVATE)
                    .edit()
                    .putBoolean(syncPrefKey(KEY_PENDING_PERMISSION_BULK_SYNC_PREFIX, cfg), true)
                    .apply();
            BridgeEventLog.append(appContext, cfg.hasProvisionedMqttConfig()
                    ? "Bulk sync waiting for active MQTT bridge connection"
                    : "Bulk sync waiting for active bridge connection");
            if (cfg.hasProvisionedMqttConfig() && cfg.bridgeEnabled) {
                Intent intent = new Intent(appContext, MqttBridgeService.class).setAction(ACTION_START);
                try {
                    if (Build.VERSION.SDK_INT >= 26) {
                        appContext.startForegroundService(intent);
                    } else {
                        appContext.startService(intent);
                    }
                } catch (RuntimeException error) {
                    BridgeEventLog.append(appContext, "Bulk sync could not start bridge service");
                }
            }
            return;
        }

        new Thread(() -> runHttpBulkSync(appContext, cfg, true), "device-bridge-bulk-sync").start();
    }

    static void publishSentResult(String actionId, String number, int partCount, int timeoutMs, boolean success, String detail) {
        MqttBridgeService service = activeService;
        if (service == null) {
            return;
        }
        if (service.currentTransportUsesHttp()) {
            service.postHttpMessageEvent(actionId, success ? "SENT" : "FAILED", detail, number);
            return;
        }
        JSONObject payload = new JSONObject();
        try {
            payload.put("number", number == null ? "" : number);
            payload.put("parts", partCount);
        } catch (JSONException ignored) {
        }
        service.publishActionResult(actionId, "send_sms", success ? "completed" : "failed", success ? 0 : 1, detail, payload, timeoutMs);
    }

    static void publishDelivered(String actionId, String number) {
        MqttBridgeService service = activeService;
        if (service == null) {
            return;
        }
        if (service.currentTransportUsesHttp()) {
            service.postHttpMessageEvent(actionId, "DELIVERED", "sms_delivered", number);
            return;
        }
        JSONObject json = new JSONObject();
        try {
            json.put("type", "sms_delivered");
            json.put("action_id", actionId == null ? "" : actionId);
            json.put("number", number == null ? "" : number);
            json.put("timestamp", System.currentTimeMillis());
        } catch (JSONException ignored) {
        }
        service.publishJson(service.currentConfig().topic("sms/delivered"), json);
    }

    private void connectAsync() {
        executor.execute(this::connectInternal);
    }

    private boolean hasUsableConnection(BridgeConfig cfg) {
        return cfg != null && cfg.hasBridgeConnectionConfig();
    }

    private void connectInternal() {
        BridgeConfig cfg = currentConfig();
        if (stopRequested || !cfg.bridgeEnabled) {
            return;
        }

        boolean useHttpFirst = cfg.usesHttpTransport() || (cfg.usesAutoTransport() && !cfg.hasProvisionedMqttConfig() && cfg.hasHttpBridgeConfig());
        updateRuntimeState("connecting", false, useHttpFirst
                ? "Connecting to " + cfg.serverUrl
                : "Connecting to " + cfg.brokerUri());
        cancelReconnect();

        if (useHttpFirst) {
            activeHttpTransport = true;
            closeClientQuietly();
            if (!cfg.hasHttpBridgeConfig()) {
                logTelemetry("HTTP bridge config is incomplete");
                updateRuntimeState("http_config_missing", false, "Dashboard fallback requires server URL, API key, and device ID");
                scheduleReconnect();
                return;
            }

            BridgeHttpClient.Result result = httpHandler.connect(cfg, statusPayload("online"));
            if (!result.success) {
                logTelemetry("HTTP status push failed: " + result.detail);
                updateRuntimeState("http_connect_failed", false, result.detail);
                scheduleReconnect();
                return;
            }

            logTelemetry("HTTP bridge connected to " + cfg.serverUrl);
            updateBridgeNotification("Device Bridge online", "HTTP connected");
            scheduleStatusHeartbeat();
            scheduleOutstandingPoll();
            updateRuntimeState("online", false, "HTTP bridge active via " + cfg.serverUrl);
            syncSmsAndCallsToDashboardOnce(consumePendingPermissionBulkSync(cfg));
            return;
        }

        try {
            activeHttpTransport = false;
            MqttClient current = client;
            if (current != null && current.isConnected()) {
                activeHttpTransport = false;
                cancelOutstandingPoll();
                commandSubscriptionsReady = true;
                publishStatus("online", true);
                scheduleStatusHeartbeat();
                logTelemetry("MQTT already connected");
                updateBridgeNotification("Device Bridge online", "MQTT connected");
                updateRuntimeState("online", true, "Connected to " + cfg.brokerUri());
                return;
            }
            commandSubscriptionsReady = false;
            closeClientQuietly();

            String clientId = cfg.deviceId + "_android_bridge";
            MqttClient mqttClient = new MqttClient(cfg.brokerUri(), clientId, new MemoryPersistence());
            mqttClient.setCallback(new MqttCallbackExtended() {
                @Override
                public void connectComplete(boolean reconnect, String serverURI) {
                    logTelemetry(reconnect
                            ? "MQTT reconnected: " + serverURI
                            : "MQTT connected: " + serverURI);
                    subscribeAndAnnounce();
                }

                @Override
                public void connectionLost(Throwable cause) {
                    Log.w(TAG, "MQTT connection lost", cause);
                    commandSubscriptionsReady = false;
                    cancelStatusHeartbeat();
                    logTelemetry("MQTT connection lost");
                    updateBridgeNotification("Device Bridge reconnecting", "MQTT connection lost");
                    updateRuntimeState("mqtt_connection_lost", false, detailForError(cause, "MQTT connection lost"));
                    scheduleReconnect();
                }

                @Override
                public void messageArrived(String topic, MqttMessage message) {
                    handleCommand(topic, new String(message.getPayload(), StandardCharsets.UTF_8));
                }

                @Override
                public void deliveryComplete(IMqttDeliveryToken token) {
                }
            });

            MqttConnectOptions options = new MqttConnectOptions();
            options.setAutomaticReconnect(false);
            options.setCleanSession(true);
            options.setConnectionTimeout(20);
            options.setKeepAliveInterval(60);
            if (!cfg.username.isEmpty()) {
                options.setUserName(cfg.username);
                options.setPassword(cfg.password.toCharArray());
            }

            mqttClient.connect(options);
            client = mqttClient;
            logTelemetry("MQTT connect completed, subscribing to command topics");
            subscribeAndAnnounce();
        } catch (MqttException error) {
            Log.e(TAG, "MQTT connect failed: " + cfg.brokerUri(), error);
            logTelemetry("MQTT connect failed: " + detailForError(error, "connect failed"));
            updateRuntimeState("mqtt_connect_failed", false, detailForError(error, "MQTT connect failed"));
            if (cfg.usesAutoTransport() && cfg.hasHttpBridgeConfig()) {
                logTelemetry("MQTT unavailable, falling back to HTTP");
                activeHttpTransport = true;
                BridgeHttpClient.Result result = httpHandler.connect(cfg, statusPayload("online"));
                if (result.success) {
                    logTelemetry("HTTP fallback connected to " + cfg.serverUrl);
                    updateBridgeNotification("Device Bridge online", "HTTP fallback connected");
                    scheduleStatusHeartbeat();
                    scheduleOutstandingPoll();
                    updateRuntimeState("online", false, "HTTP fallback active via " + cfg.serverUrl);
                    syncSmsAndCallsToDashboardOnce(consumePendingPermissionBulkSync(cfg));
                    return;
                }
                recordHttpFailure("HTTP fallback failed", result.detail);
            }
            scheduleReconnect();
        }
    }

    private void subscribeAndAnnounce() {
        try {
            MqttClient current = client;
            BridgeConfig cfg = currentConfig();
            if (current == null || !current.isConnected()) {
                return;
            }
            current.subscribe(cfg.topic("command/#"), 1);
            current.subscribe(cfg.topic("cmd/#"), 1);
            activeHttpTransport = false;
            cancelOutstandingPoll();
            commandSubscriptionsReady = true;
            logTelemetry("Subscribed to bridge command topics");
            publishStatus("online", true);
            scheduleStatusHeartbeat();
            updateBridgeNotification("Device Bridge online", "MQTT connected");
            updateRuntimeState("online", true, "Connected to " + cfg.brokerUri());
            flushPendingPublishes();
            syncSmsAndCallsToDashboardOnce(consumePendingPermissionBulkSync(cfg));
        } catch (MqttException error) {
            Log.e(TAG, "Subscribe failed", error);
            commandSubscriptionsReady = false;
            cancelStatusHeartbeat();
            logTelemetry("MQTT subscribe failed: " + detailForError(error, "subscribe failed"));
            updateRuntimeState("mqtt_subscribe_failed", false, detailForError(error, "MQTT subscribe failed"));
            scheduleReconnect();
        }
    }

    private void handleCommand(String topic, String body) {
        executor.execute(() -> {
            JSONObject data = parseJson(body);
            String command = data.optString("command", "");
            if (command.isEmpty()) {
                command = commandFromTopic(topic);
            }
            String normalized = command.replace('-', '_').trim().toLowerCase(Locale.US);
            String actionId = firstNonEmpty(
                    data.optString("action_id", ""),
                    data.optString("messageId", ""),
                    data.optString("id", ""),
                    "android_" + System.currentTimeMillis()
            );

            switch (normalized) {
                case "send_sms":
                    logConsoleEvent("sms", "Command received: send_sms");
                    handleSendSms(actionId, data);
                    break;
                case "sync_sms":
                case "pull_sms":
                case "pull_messages":
                    logConsoleEvent("sms", "Command received: " + normalized);
                    handleSyncSms(actionId);
                    break;
                case "make_call":
                case "call_dial":
                case "dial_number":
                    logConsoleEvent("call", "Command received: " + normalized);
                    handleMakeCall(actionId, data);
                    break;
                case "sync_calls":
                case "sync_call_history":
                case "call_history_sync":
                    logConsoleEvent("call", "Command received: " + normalized);
                    handleSyncCalls(actionId);
                    break;
                case "send_ussd":
                    logConsoleEvent("ussd", "Command received: send_ussd");
                    handleSendUssd(actionId, data);
                    break;
                case "answer_call":
                    logConsoleEvent("call", "Command received: answer_call");
                    handleAnswerCall(actionId);
                    break;
                case "reject_call":
                case "end_call":
                case "hangup_call":
                    logConsoleEvent("call", "Command received: " + normalized);
                    handleEndCall(actionId, normalized);
                    break;
                case "hold_call":
                    logConsoleEvent("call", "Command received: hold_call");
                    handleHoldCall(actionId, data);
                    break;
                case "mute_call":
                    logConsoleEvent("call", "Command received: mute_call");
                    handleMuteCall(actionId, data);
                    break;
                case "wifi_scan":
                    logConsoleEvent("internet", "Command received: wifi_scan");
                    handleWifiScan(actionId, data);
                    break;
                case "get_status":
                    BridgeEventLog.append(this, "Command received: " + normalized);
                    publishStatus("online", true);
                    publishActionResult(actionId, normalized, "completed", 0, "status_published", statusPayload("online", true), 90000);
                    break;
                case "status_watch":
                    BridgeEventLog.append(this, "Command received: " + normalized);
                    publishStatus("online", false);
                    publishActionResult(actionId, normalized, "completed", 0, "status_published", statusPayload("online", false), 90000);
                    break;
                default:
                    BridgeEventLog.append(this, "Unsupported command received: " + normalized);
                    publishActionResult(actionId, normalized, "failed", 2, "unsupported_command", null, 90000);
                    break;
            }
        });
    }

    private void handleSendSms(String actionId, JSONObject data) {
        String number = firstNonEmpty(data.optString("number", ""), data.optString("to", ""));
        String text = firstNonEmpty(data.optString("text", ""), data.optString("message", ""));
        int timeoutMs = data.optInt("timeout_ms", data.optInt("timeoutMs", data.optInt("timeout", 90000)));
        Integer preferredSimSlot = requestedSimSlot(data);
        Integer preferredSubscriptionId = firstInteger(
                jsonInteger(data, "subscription_id"),
                jsonInteger(data, "sim_subscription_id"),
                jsonInteger(data, "subscriptionId"),
                jsonInteger(data, "simSubscriptionId")
        );

        SmsSender.SendResult result = SmsSender.send(this, actionId, number, text, timeoutMs, preferredSimSlot, preferredSubscriptionId);
        if (!result.accepted) {
            logConsoleEvent("sms", "SMS send rejected: " + result.detail);
            publishSentResult(actionId, number, 0, timeoutMs, false, result.detail);
            return;
        }
        logConsoleEvent("sms", "SMS accepted for " + number + " (" + result.partCount + " part)");
        BridgeSmsStore.recordOutgoing(this, actionId, number, text, System.currentTimeMillis(), "dashboard_mqtt");
        lastSendAcceptedAtMs = System.currentTimeMillis();
        persistRuntimeTelemetry();

        JSONObject payload = new JSONObject();
        try {
            payload.put("number", number);
            payload.put("parts", result.partCount);
        } catch (JSONException ignored) {
        }
        publishActionResult(actionId, "send_sms", "accepted", 0, "sms_queued", payload, timeoutMs);
    }

    private void handleSyncSms(String actionId) {
        if (checkSelfPermission(Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) {
            logConsoleEvent("sms", "SMS sync rejected: READ_SMS permission missing");
            publishActionResult(actionId, "sync_sms", "failed", 1, "sms_read_permission_denied", null, 90000);
            return;
        }

        logConsoleEvent("sms", "Manual SMS sync started");
        syncExistingSmsToDashboardOnce(true);
        publishActionResult(actionId, "sync_sms", "completed", 0, "sms_sync_requested", null, 90000);
    }

    private void handleMakeCall(String actionId, JSONObject data) {
        String number = firstNonEmpty(data.optString("number", ""), data.optString("to", ""));
        if (number.isEmpty()) {
            publishActionResult(actionId, "make_call", "failed", 1, "call_number_required", null, 45000);
            return;
        }
        if (checkSelfPermission(Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) {
            logConsoleEvent("call", "Call request rejected: CALL_PHONE permission missing");
            publishActionResult(actionId, "make_call", "failed", 1, "call_permission_denied", null, 45000);
            return;
        }

        Integer preferredSimSlot = requestedSimSlot(data);
        Integer preferredSubscriptionId = firstInteger(
                jsonInteger(data, "subscription_id"),
                jsonInteger(data, "sim_subscription_id"),
                jsonInteger(data, "subscriptionId"),
                jsonInteger(data, "simSubscriptionId")
        );
        Integer resolvedSubscriptionId = resolveSubscriptionIdForCommand(preferredSimSlot, preferredSubscriptionId);
        Integer resolvedSimSlot = preferredSimSlot;
        if (resolvedSimSlot == null) {
            resolvedSimSlot = resolveSimSlotForSubscription(resolvedSubscriptionId);
        }

        Uri callUri = Uri.parse("tel:" + Uri.encode(number));
        Intent callIntent = new Intent(Intent.ACTION_CALL, callUri);
        callIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

        Bundle telecomExtras = new Bundle();
        applyPreferredCallRoute(callIntent, telecomExtras, resolvedSimSlot, resolvedSubscriptionId);

        try {
            pendingDialNumber = number;
            lastCallNumber = number;
            TelecomManager telecomManager = getSystemService(TelecomManager.class);
            if (telecomManager != null && Build.VERSION.SDK_INT >= 23 && telecomExtras.containsKey(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE)) {
                telecomManager.placeCall(callUri, telecomExtras);
            } else {
                startActivity(callIntent);
            }
            logConsoleEvent("call", "Call started for " + number);
            publishCallStatus("dialing", number, "outgoing");

            JSONObject payload = new JSONObject();
            try {
                payload.put("number", number);
                payload.put("status", "dialing");
                if (resolvedSimSlot != null) {
                    payload.put("sim_slot", resolvedSimSlot);
                }
                if (resolvedSubscriptionId != null) {
                    payload.put("subscription_id", resolvedSubscriptionId);
                }
            } catch (JSONException ignored) {
            }
            publishActionResult(actionId, "make_call", "accepted", 0, "call_dial_started", payload, 45000);
        } catch (SecurityException error) {
            logConsoleEvent("call", "Call request rejected: permission denied");
            publishActionResult(actionId, "make_call", "failed", 1, "call_permission_denied", null, 45000);
        } catch (RuntimeException error) {
            logConsoleEvent("call", "Call request failed: " + detailForError(error, "call start failed"));
            publishActionResult(actionId, "make_call", "failed", 1, "call_start_failed", null, 45000);
        }
    }

    private void handleSyncCalls(String actionId) {
        if (!hasCallLogPermission()) {
            logConsoleEvent("call", "Call history sync rejected: READ_CALL_LOG permission missing");
            publishActionResult(actionId, "sync_calls", "failed", 1, "call_log_permission_denied", null, 90000);
            return;
        }

        logConsoleEvent("call", "Manual call history sync started");
        syncExistingCallsToDashboardOnce(true, true);
        publishActionResult(actionId, "sync_calls", "completed", 0, "call_history_sync_requested", null, 90000);
    }

    private void handleSendUssd(String actionId, JSONObject data) {
        String code = firstNonEmpty(
                data.optString("code", ""),
                data.optString("ussd", ""),
                data.optString("text", "")
        );
        final int timeoutMs = data.optInt("timeout_ms", data.optInt("timeoutMs", data.optInt("timeout", 60000)));
        if (code.isEmpty()) {
            publishActionResult(actionId, "send_ussd", "failed", 1, "ussd_code_required", null, timeoutMs);
            return;
        }
        if (Build.VERSION.SDK_INT < 26) {
            logConsoleEvent("ussd", "USSD request rejected: Android version too old");
            publishActionResult(actionId, "send_ussd", "failed", 1, "ussd_not_supported", null, timeoutMs);
            return;
        }
        if (checkSelfPermission(Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) {
            logConsoleEvent("ussd", "USSD request rejected: CALL_PHONE permission missing");
            publishActionResult(actionId, "send_ussd", "failed", 1, "ussd_permission_denied", null, timeoutMs);
            return;
        }

        Integer preferredSimSlot = requestedSimSlot(data);
        Integer preferredSubscriptionId = firstInteger(
                jsonInteger(data, "subscription_id"),
                jsonInteger(data, "sim_subscription_id"),
                jsonInteger(data, "subscriptionId"),
                jsonInteger(data, "simSubscriptionId")
        );
        TelephonyManager telephonyManager = resolveTelephonyManagerForCommand(preferredSimSlot, preferredSubscriptionId);
        if (telephonyManager == null) {
            logConsoleEvent("ussd", "USSD request rejected: telephony unavailable");
            publishActionResult(actionId, "send_ussd", "failed", 1, "ussd_telephony_unavailable", null, timeoutMs);
            return;
        }

        JSONObject acceptedPayload = new JSONObject();
        try {
            acceptedPayload.put("code", code);
            if (preferredSimSlot != null) {
                acceptedPayload.put("sim_slot", preferredSimSlot);
            }
            if (preferredSubscriptionId != null) {
                acceptedPayload.put("subscription_id", preferredSubscriptionId);
            }
        } catch (JSONException ignored) {
        }

        final AtomicBoolean finished = new AtomicBoolean(false);
        final ScheduledFuture<?>[] timeoutFutureRef = new ScheduledFuture<?>[1];

        try {
            telephonyManager.sendUssdRequest(code, new TelephonyManager.UssdResponseCallback() {
                @Override
                public void onReceiveUssdResponse(TelephonyManager telephonyManager, String request, CharSequence response) {
                    executor.execute(() -> {
                        ScheduledFuture<?> timeoutFuture = timeoutFutureRef[0];
                        if (timeoutFuture != null) {
                            timeoutFuture.cancel(false);
                        }
                        if (!finished.compareAndSet(false, true)) {
                            return;
                        }
                        String responseText = response == null ? "" : response.toString();
                        logConsoleEvent("ussd", "USSD response received for " + request);
                        publishUssdResult(request, responseText, "success", false);

                        JSONObject payload = new JSONObject();
                        try {
                            payload.put("code", request);
                            payload.put("response", responseText);
                        } catch (JSONException ignored) {
                        }
                        publishActionResult(actionId, "send_ussd", "completed", 0, "ussd_response_received", payload, timeoutMs);
                    });
                }

                @Override
                public void onReceiveUssdResponseFailed(TelephonyManager telephonyManager, String request, int failureCode) {
                    executor.execute(() -> {
                        ScheduledFuture<?> timeoutFuture = timeoutFutureRef[0];
                        if (timeoutFuture != null) {
                            timeoutFuture.cancel(false);
                        }
                        if (!finished.compareAndSet(false, true)) {
                            return;
                        }
                        String detail = mapUssdFailure(failureCode);
                        logConsoleEvent("ussd", "USSD response failed: " + detail);
                        publishUssdResult(request, detail, "failed", false);

                        JSONObject payload = new JSONObject();
                        try {
                            payload.put("code", request);
                            payload.put("failure_code", failureCode);
                        } catch (JSONException ignored) {
                        }
                        publishActionResult(actionId, "send_ussd", "failed", failureCode, detail, payload, timeoutMs);
                    });
                }
            }, new Handler(Looper.getMainLooper()));

            timeoutFutureRef[0] = executor.schedule(() -> {
                if (!finished.compareAndSet(false, true)) {
                    return;
                }

                logConsoleEvent("ussd", "USSD response timed out for " + code);
                publishUssdResult(code, "ussd_response_timeout", "failed", false);

                JSONObject payload = new JSONObject();
                try {
                    payload.put("code", code);
                    payload.put("timeout_ms", timeoutMs);
                } catch (JSONException ignored) {
                }
                publishActionResult(actionId, "send_ussd", "failed", 1, "ussd_response_timeout", payload, timeoutMs);
            }, Math.max(1000, timeoutMs), TimeUnit.MILLISECONDS);

            logConsoleEvent("ussd", "USSD request sent: " + code);
            publishActionResult(actionId, "send_ussd", "accepted", 0, "ussd_sent", acceptedPayload, timeoutMs);
        } catch (SecurityException error) {
            logConsoleEvent("ussd", "USSD request rejected: permission denied");
            publishActionResult(actionId, "send_ussd", "failed", 1, "ussd_permission_denied", null, timeoutMs);
        } catch (RuntimeException error) {
            ScheduledFuture<?> timeoutFuture = timeoutFutureRef[0];
            if (timeoutFuture != null) {
                timeoutFuture.cancel(false);
            }
            finished.set(true);
            logConsoleEvent("ussd", "USSD request failed: " + detailForError(error, "ussd_send_failed"));
            publishActionResult(actionId, "send_ussd", "failed", 1, "ussd_send_failed", acceptedPayload, timeoutMs);
        }
    }

    private void handleAnswerCall(String actionId) {
        if (checkSelfPermission(Manifest.permission.ANSWER_PHONE_CALLS) != PackageManager.PERMISSION_GRANTED) {
            logConsoleEvent("call", "Answer call rejected: ANSWER_PHONE_CALLS permission missing");
            publishActionResult(actionId, "answer_call", "failed", 1, "call_answer_permission_denied", null, 15000);
            return;
        }

        TelecomManager telecomManager = getSystemService(TelecomManager.class);
        if (telecomManager == null) {
            logConsoleEvent("call", "Answer call rejected: telecom manager unavailable");
            publishActionResult(actionId, "answer_call", "failed", 1, "telecom_unavailable", null, 15000);
            return;
        }

        try {
            telecomManager.acceptRingingCall();
            logConsoleEvent("call", "Incoming call answer requested");
            JSONObject payload = new JSONObject();
            try {
                payload.put("status", "answer_requested");
            } catch (JSONException ignored) {
            }
            publishActionResult(actionId, "answer_call", "accepted", 0, "call_answer_requested", payload, 15000);
        } catch (SecurityException error) {
            logConsoleEvent("call", "Answer call rejected: permission denied");
            publishActionResult(actionId, "answer_call", "failed", 1, "call_answer_permission_denied", null, 15000);
        } catch (RuntimeException error) {
            logConsoleEvent("call", "Answer call failed: " + detailForError(error, "call_answer_failed"));
            publishActionResult(actionId, "answer_call", "failed", 1, "call_answer_failed", null, 15000);
        }
    }

    private void handleEndCall(String actionId, String normalizedCommand) {
        if (checkSelfPermission(Manifest.permission.ANSWER_PHONE_CALLS) != PackageManager.PERMISSION_GRANTED) {
            logConsoleEvent("call", "End call rejected: ANSWER_PHONE_CALLS permission missing");
            publishActionResult(actionId, normalizedCommand, "failed", 1, "call_end_permission_denied", null, 15000);
            return;
        }

        TelecomManager telecomManager = getSystemService(TelecomManager.class);
        if (telecomManager == null) {
            logConsoleEvent("call", "End call rejected: telecom manager unavailable");
            publishActionResult(actionId, normalizedCommand, "failed", 1, "telecom_unavailable", null, 15000);
            return;
        }

        if (Build.VERSION.SDK_INT < 28) {
            logConsoleEvent("call", "End call rejected: Android version does not support telecom endCall");
            publishActionResult(actionId, normalizedCommand, "failed", 2, "call_end_not_supported", null, 15000);
            return;
        }

        try {
            boolean ended = telecomManager.endCall();
            if (!ended) {
                logConsoleEvent("call", "End call requested but no active/ringing call was available");
                publishActionResult(actionId, normalizedCommand, "failed", 1, "no_active_call", null, 15000);
                return;
            }
            logConsoleEvent("call", ("reject_call".equals(normalizedCommand) ? "Incoming call reject" : "Call end") + " requested");
            JSONObject payload = new JSONObject();
            try {
                payload.put("status", "reject_call".equals(normalizedCommand) ? "reject_requested" : "end_requested");
            } catch (JSONException ignored) {
            }
            publishActionResult(actionId, normalizedCommand, "accepted", 0,
                    "reject_call".equals(normalizedCommand) ? "call_reject_requested" : "call_end_requested",
                    payload,
                    15000);
        } catch (SecurityException error) {
            logConsoleEvent("call", "End call rejected: permission denied");
            publishActionResult(actionId, normalizedCommand, "failed", 1, "call_end_permission_denied", null, 15000);
        } catch (RuntimeException error) {
            logConsoleEvent("call", "End call failed: " + detailForError(error, "call_end_failed"));
            publishActionResult(actionId, normalizedCommand, "failed", 1, "call_end_failed", null, 15000);
        }
    }

    private void handleHoldCall(String actionId, JSONObject data) {
        boolean hold = data.optBoolean("hold", true);
        String detail = hold ? "call_hold_not_supported" : "call_resume_not_supported";
        logConsoleEvent("call", "Hold command unsupported without default dialer role");
        publishActionResult(actionId, "hold_call", "failed", 2, detail, null, 15000);
    }

    private void handleMuteCall(String actionId, JSONObject data) {
        boolean mute = data.optBoolean("mute", true);
        AudioManager audioManager = getSystemService(AudioManager.class);
        if (audioManager == null) {
            logConsoleEvent("call", "Mute call rejected: audio manager unavailable");
            publishActionResult(actionId, "mute_call", "failed", 1, "audio_manager_unavailable", null, 15000);
            return;
        }

        try {
            audioManager.setMicrophoneMute(mute);
            logConsoleEvent("call", "Call microphone " + (mute ? "mute" : "unmute") + " requested");
            JSONObject payload = new JSONObject();
            try {
                payload.put("muted", mute);
            } catch (JSONException ignored) {
            }
            publishActionResult(actionId, "mute_call", "completed", 0,
                    mute ? "call_muted" : "call_unmuted",
                    payload,
                    15000);
        } catch (RuntimeException error) {
            logConsoleEvent("call", "Mute call failed: " + detailForError(error, "call_mute_failed"));
            publishActionResult(actionId, "mute_call", "failed", 1, "call_mute_failed", null, 15000);
        }
    }

    private void handleWifiScan(String actionId, JSONObject data) {
        int timeoutMs = data.optInt("timeout_ms", data.optInt("timeoutMs", data.optInt("timeout", 65000)));
        WifiManager wifiManager = getApplicationContext().getSystemService(WifiManager.class);
        if (wifiManager == null) {
            logConsoleEvent("internet", "Wi-Fi scan rejected: wifi manager unavailable");
            publishActionResult(actionId, "wifi_scan", "failed", 1, "wifi_manager_unavailable", null, timeoutMs);
            return;
        }
        if (!hasWifiDetailPermission()) {
            logConsoleEvent("internet", "Wi-Fi scan rejected: required permission missing");
            publishActionResult(actionId, "wifi_scan", "failed", 1, "wifi_permission_denied", null, timeoutMs);
            return;
        }
        if (!wifiManager.isWifiEnabled()) {
            logConsoleEvent("internet", "Wi-Fi scan rejected: Wi-Fi disabled");
            publishActionResult(actionId, "wifi_scan", "failed", 1, "wifi_disabled", null, timeoutMs);
            return;
        }

        long startedAtMs = SystemClock.elapsedRealtime();
        boolean scanStarted;
        try {
            scanStarted = wifiManager.startScan();
        } catch (SecurityException error) {
            logConsoleEvent("internet", "Wi-Fi scan rejected: permission denied");
            publishActionResult(actionId, "wifi_scan", "failed", 1, "wifi_permission_denied", null, timeoutMs);
            return;
        } catch (RuntimeException error) {
            logConsoleEvent("internet", "Wi-Fi scan start failed: " + detailForError(error, "wifi_scan_start_failed"));
            publishActionResult(actionId, "wifi_scan", "failed", 1, "wifi_scan_start_failed", null, timeoutMs);
            return;
        }

        long delayMs = scanStarted ? 4000L : 1200L;
        new Handler(Looper.getMainLooper()).postDelayed(
                () -> executor.execute(() -> completeWifiScan(actionId, timeoutMs, startedAtMs, scanStarted, wifiManager)),
                delayMs
        );
    }

    private void completeWifiScan(String actionId, int timeoutMs, long startedAtMs, boolean scanStarted, WifiManager wifiManager) {
        List<ScanResult> results;
        try {
            results = wifiManager.getScanResults();
        } catch (SecurityException error) {
            logConsoleEvent("internet", "Wi-Fi scan failed: permission denied");
            publishActionResult(actionId, "wifi_scan", "failed", 1, "wifi_permission_denied", null, timeoutMs);
            return;
        } catch (RuntimeException error) {
            logConsoleEvent("internet", "Wi-Fi scan failed: " + detailForError(error, "wifi_scan_failed"));
            publishActionResult(actionId, "wifi_scan", "failed", 1, "wifi_scan_failed", null, timeoutMs);
            return;
        }

        JSONObject payload = new JSONObject();
        try {
            JSONArray networks = new JSONArray();
            if (results != null) {
                for (ScanResult result : results) {
                    if (result == null) {
                        continue;
                    }
                    JSONObject network = new JSONObject();
                    String ssid = normalizeWifiSsid(result.SSID);
                    network.put("ssid", ssid.isEmpty() ? "Hidden Network" : ssid);
                    network.put("bssid", result.BSSID == null ? "" : result.BSSID);
                    network.put("rssi", result.level);
                    network.put("encryption", describeWifiEncryption(result.capabilities));
                    network.put("channel", wifiChannelForFrequency(result.frequency));
                    network.put("frequency", result.frequency);
                    networks.put(network);
                }
            }

            JSONObject report = new JSONObject();
            report.put("total_visible", networks.length());
            report.put("elapsed_ms", Math.max(0L, SystemClock.elapsedRealtime() - startedAtMs));
            report.put("mode", scanStarted ? "active" : "cached");
            report.put("channel", 0);

            payload.put("networks", networks);
            payload.put("report", report);
        } catch (JSONException ignored) {
        }

        JSONArray networksArray = payload.optJSONArray("networks");
        logConsoleEvent("internet", "Wi-Fi scan completed with "
                + (networksArray == null ? 0 : networksArray.length()) + " result(s)");
        publishActionResult(actionId, "wifi_scan", "completed", 0, "wifi_scan_completed", payload, timeoutMs);
    }

    private void publishIncomingSms(String from, String text, long timestamp, int slot) {
        BridgeSmsStore.recordIncoming(this, from, text, timestamp);
        logConsoleEvent("sms", "Incoming SMS from " + firstNonEmpty(from, "unknown"));
        JSONObject json = new JSONObject();
        try {
            json.put("type", "sms_incoming");
            json.put("device_id", currentConfig().deviceId);
            json.put("from", from == null ? "" : from);
            json.put("text", text == null ? "" : text);
            json.put("content", text == null ? "" : text);
            json.put("timestamp", timestamp);
            if (slot >= 0) {
                json.put("sim_slot", slot);
            }
        } catch (JSONException ignored) {
        }
        if (currentTransportUsesHttp()) {
            postHttpIncomingSms(json);
            return;
        }
        publishJson(currentConfig().topic("sms/incoming"), json);
    }

    private void syncSmsAndCallsToDashboardOnce(boolean allowInitialBackfill) {
        syncExistingSmsToDashboardOnce(allowInitialBackfill);
        syncExistingCallsToDashboardOnce(allowInitialBackfill);
    }

    private boolean consumePendingPermissionBulkSync(BridgeConfig cfg) {
        SharedPreferences prefs = getSharedPreferences(BridgeConfig.PREFS, MODE_PRIVATE);
        String key = syncPrefKey(KEY_PENDING_PERMISSION_BULK_SYNC_PREFIX, cfg);
        boolean pending = prefs.getBoolean(key, false);
        if (pending) {
            prefs.edit().putBoolean(key, false).apply();
        }
        return pending;
    }

    private static void runHttpBulkSync(Context context, BridgeConfig cfg, boolean allowInitialBackfill) {
        syncExistingSmsToDashboardOnce(context, cfg, allowInitialBackfill, payload -> BridgeHttpClient.postIncomingSms(cfg, payload));
        syncExistingCallsToDashboardOnce(context, cfg, allowInitialBackfill, payload -> BridgeHttpClient.postStatus(cfg, payload));
    }

    private void syncExistingSmsToDashboardOnce(boolean allowInitialBackfill) {
        BridgeConfig cfg = currentConfig();
        if (cfg == null || cfg.deviceId == null || cfg.deviceId.trim().isEmpty()) {
            return;
        }
        if (checkSelfPermission(Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        SharedPreferences prefs = getSharedPreferences(BridgeConfig.PREFS, MODE_PRIVATE);
        String doneKey = syncPrefKey(KEY_INITIAL_SMS_SYNC_PREFIX, cfg);
        String watermarkKey = syncPrefKey(KEY_SMS_SYNC_WATERMARK_PREFIX, cfg);
        boolean alreadyDone = prefs.getBoolean(doneKey, false);
        long watermark = Math.max(0L, prefs.getLong(watermarkKey, 0L));
        List<java.util.Map<String, Object>> localMessages = BridgeSmsStore.buildRecentMessages(this, BULK_SYNC_LIMIT);
        long newestTimestamp = maxSmsSyncTimestamp(localMessages, watermark);
        if (watermark <= 0L && (alreadyDone || !allowInitialBackfill)) {
            prefs.edit()
                    .putBoolean(doneKey, true)
                    .putLong(watermarkKey, newestTimestamp)
                    .apply();
            return;
        }
        List<java.util.Map<String, Object>> messages = filterSmsSyncMessages(localMessages, watermark);
        if (messages.isEmpty()) {
            prefs.edit()
                    .putBoolean(doneKey, true)
                    .putLong(watermarkKey, newestTimestamp)
                    .apply();
            return;
        }
        prefs.edit().putLong(watermarkKey, newestTimestamp).apply();
        publishSmsSyncState("sms_sync_start", messages.size(), 0);
        int synced = 0;
        for (java.util.Map<String, Object> message : messages) {
            if (publishSmsSyncRecord(message)) {
                synced += 1;
            }
        }
        publishSmsSyncState("sms_sync_complete", messages.size(), synced);
        prefs.edit()
                .putBoolean(doneKey, true)
                .putLong(watermarkKey, newestTimestamp)
                .apply();
        logConsoleEvent("sms", "Initial SMS sync published " + synced + " message(s)");
    }

    private static void syncExistingSmsToDashboardOnce(Context context, BridgeConfig cfg, boolean allowInitialBackfill, JsonSender sender) {
        if (context == null || cfg == null || sender == null || cfg.deviceId == null || cfg.deviceId.trim().isEmpty()) {
            return;
        }
        if (!hasPermission(context, Manifest.permission.READ_SMS)) {
            return;
        }
        SharedPreferences prefs = context.getSharedPreferences(BridgeConfig.PREFS, Context.MODE_PRIVATE);
        String doneKey = syncPrefKey(KEY_INITIAL_SMS_SYNC_PREFIX, cfg);
        String watermarkKey = syncPrefKey(KEY_SMS_SYNC_WATERMARK_PREFIX, cfg);
        boolean alreadyDone = prefs.getBoolean(doneKey, false);
        long watermark = Math.max(0L, prefs.getLong(watermarkKey, 0L));
        List<java.util.Map<String, Object>> localMessages = BridgeSmsStore.buildRecentMessages(context, BULK_SYNC_LIMIT);
        long newestTimestamp = maxSmsSyncTimestamp(localMessages, watermark);
        if (watermark <= 0L && (alreadyDone || !allowInitialBackfill)) {
            prefs.edit()
                    .putBoolean(doneKey, true)
                    .putLong(watermarkKey, newestTimestamp)
                    .apply();
            return;
        }
        List<java.util.Map<String, Object>> messages = filterSmsSyncMessages(localMessages, watermark);
        if (messages.isEmpty()) {
            prefs.edit()
                    .putBoolean(doneKey, true)
                    .putLong(watermarkKey, newestTimestamp)
                    .apply();
            return;
        }
        prefs.edit().putLong(watermarkKey, newestTimestamp).apply();
        sender.send(buildSmsSyncStatePayload(cfg, "sms_sync_start", messages.size(), 0));
        int synced = 0;
        for (java.util.Map<String, Object> message : messages) {
            JSONObject payload = buildSmsSyncPayload(cfg, message);
            if (payload != null) {
                sender.send(payload);
                synced += 1;
            }
        }
        sender.send(buildSmsSyncStatePayload(cfg, "sms_sync_complete", messages.size(), synced));
        prefs.edit()
                .putBoolean(doneKey, true)
                .putLong(watermarkKey, newestTimestamp)
                .apply();
        BridgeEventLog.append(context, "Initial SMS sync published " + synced + " message(s)");
    }

    private void publishSmsSyncState(String type, int total, int synced) {
        JSONObject json = buildSmsSyncStatePayload(currentConfig(), type, total, synced);
        if (currentTransportUsesHttp()) {
            postHttpIncomingSms(json);
        } else {
            publishJson(currentConfig().topic("sms/incoming"), json);
        }
    }

    private boolean publishSmsSyncRecord(java.util.Map<String, Object> message) {
        if (message == null) return false;
        String address = objectString(message.get("address"));
        String body = objectString(message.get("body"));
        if (address.isEmpty() || body.isEmpty()) return false;
        JSONObject json = buildSmsSyncPayload(currentConfig(), message);
        if (json == null) return false;
        if (currentTransportUsesHttp()) {
            postHttpIncomingSms(json);
        } else {
            publishJson(currentConfig().topic("sms/incoming"), json);
        }
        return true;
    }

    private static JSONObject buildSmsSyncStatePayload(BridgeConfig cfg, String type, int total, int synced) {
        JSONObject json = new JSONObject();
        try {
            json.put("type", type);
            json.put("sync", true);
            json.put("device_id", cfg.deviceId);
            json.put("total", Math.max(0, total));
            json.put("synced", Math.max(0, synced));
            json.put("timestamp", System.currentTimeMillis());
        } catch (JSONException ignored) {
        }
        return json;
    }

    private static JSONObject buildSmsSyncPayload(BridgeConfig cfg, java.util.Map<String, Object> message) {
        if (cfg == null || message == null) return null;
        String address = objectString(message.get("address"));
        String body = objectString(message.get("body"));
        if (address.isEmpty() || body.isEmpty()) return null;
        boolean outgoing = Boolean.TRUE.equals(message.get("outgoing"));
        JSONObject json = new JSONObject();
        try {
            json.put("type", "sms_sync");
            json.put("sync", true);
            json.put("device_id", cfg.deviceId);
            json.put("direction", outgoing ? "outgoing" : "incoming");
            json.put("outgoing", outgoing);
            json.put("from", outgoing ? "" : address);
            json.put("to", outgoing ? address : "");
            json.put("from_number", outgoing ? "" : address);
            json.put("to_number", outgoing ? address : "");
            json.put("text", body);
            json.put("content", body);
            json.put("message", body);
            json.put("timestamp", objectLong(message.get("timestamp"), System.currentTimeMillis()));
            json.put("read", Boolean.TRUE.equals(message.get("read")) ? 1 : 0);
            json.put("source", "android-initial-sync");
        } catch (JSONException ignored) {
        }
        return json;
    }

    private static List<java.util.Map<String, Object>> filterSmsSyncMessages(List<java.util.Map<String, Object>> source, long watermark) {
        List<java.util.Map<String, Object>> filtered = new ArrayList<>();
        if (source == null) {
            return filtered;
        }
        for (java.util.Map<String, Object> message : source) {
            if (objectLong(message == null ? null : message.get("timestamp"), 0L) > watermark) {
                filtered.add(message);
            }
        }
        return filtered;
    }

    private static long maxSmsSyncTimestamp(List<java.util.Map<String, Object>> messages, long fallback) {
        long max = Math.max(0L, fallback);
        if (messages == null) {
            return max;
        }
        for (java.util.Map<String, Object> message : messages) {
            max = Math.max(max, objectLong(message == null ? null : message.get("timestamp"), 0L));
        }
        return max;
    }

    private void syncExistingCallsToDashboardOnce(boolean allowInitialBackfill) {
        syncExistingCallsToDashboardOnce(allowInitialBackfill, false);
    }

    private void syncExistingCallsToDashboardOnce(boolean allowInitialBackfill, boolean emitProgress) {
        BridgeConfig cfg = currentConfig();
        if (cfg == null || cfg.deviceId == null || cfg.deviceId.trim().isEmpty()) {
            return;
        }
        if (!hasCallLogPermission()) {
            return;
        }
        SharedPreferences prefs = getSharedPreferences(BridgeConfig.PREFS, MODE_PRIVATE);
        String doneKey = syncPrefKey(KEY_INITIAL_CALL_SYNC_PREFIX, cfg);
        String watermarkKey = syncPrefKey(KEY_CALL_SYNC_WATERMARK_PREFIX, cfg);
        boolean alreadyDone = prefs.getBoolean(doneKey, false);
        long watermark = Math.max(0L, prefs.getLong(watermarkKey, 0L));
        List<CallLogSyncRecord> localCalls = buildRecentCallLogRecords(this, BULK_SYNC_LIMIT);
        long newestTimestamp = maxCallSyncTimestamp(localCalls, watermark);
        if (watermark <= 0L && (alreadyDone || !allowInitialBackfill)) {
            if (emitProgress) {
                publishCallSyncState("call_sync_complete", 0, 0);
            }
            prefs.edit()
                    .putBoolean(doneKey, true)
                    .putLong(watermarkKey, newestTimestamp)
                    .apply();
            return;
        }

        List<CallLogSyncRecord> calls = filterCallSyncRecords(localCalls, watermark);
        if (calls.isEmpty()) {
            if (emitProgress) {
                publishCallSyncState("call_sync_complete", 0, 0);
            }
            prefs.edit()
                    .putBoolean(doneKey, true)
                    .putLong(watermarkKey, newestTimestamp)
                    .apply();
            return;
        }
        prefs.edit().putLong(watermarkKey, newestTimestamp).apply();
        if (emitProgress) {
            publishCallSyncState("call_sync_start", calls.size(), 0);
        }
        int synced = 0;
        for (CallLogSyncRecord call : calls) {
            if (publishCallSyncRecord(call)) {
                synced += 1;
            }
        }
        if (emitProgress) {
            publishCallSyncState("call_sync_complete", calls.size(), synced);
        }
        prefs.edit()
                .putBoolean(doneKey, true)
                .putLong(watermarkKey, newestTimestamp)
                .apply();
        logConsoleEvent("call", "Initial call sync published " + synced + " call(s)");
    }

    private static void syncExistingCallsToDashboardOnce(Context context, BridgeConfig cfg, boolean allowInitialBackfill, JsonSender sender) {
        if (context == null || cfg == null || sender == null || cfg.deviceId == null || cfg.deviceId.trim().isEmpty()) {
            return;
        }
        if (!hasPermission(context, Manifest.permission.READ_CALL_LOG)) {
            return;
        }
        SharedPreferences prefs = context.getSharedPreferences(BridgeConfig.PREFS, Context.MODE_PRIVATE);
        String doneKey = syncPrefKey(KEY_INITIAL_CALL_SYNC_PREFIX, cfg);
        String watermarkKey = syncPrefKey(KEY_CALL_SYNC_WATERMARK_PREFIX, cfg);
        boolean alreadyDone = prefs.getBoolean(doneKey, false);
        long watermark = Math.max(0L, prefs.getLong(watermarkKey, 0L));
        List<CallLogSyncRecord> localCalls = buildRecentCallLogRecords(context, BULK_SYNC_LIMIT);
        long newestTimestamp = maxCallSyncTimestamp(localCalls, watermark);
        if (watermark <= 0L && (alreadyDone || !allowInitialBackfill)) {
            prefs.edit()
                    .putBoolean(doneKey, true)
                    .putLong(watermarkKey, newestTimestamp)
                    .apply();
            return;
        }

        List<CallLogSyncRecord> calls = filterCallSyncRecords(localCalls, watermark);
        if (calls.isEmpty()) {
            prefs.edit()
                    .putBoolean(doneKey, true)
                    .putLong(watermarkKey, newestTimestamp)
                    .apply();
            return;
        }
        prefs.edit().putLong(watermarkKey, newestTimestamp).apply();
        int synced = 0;
        for (CallLogSyncRecord call : calls) {
            JSONObject payload = buildCallSyncPayload(cfg, call);
            if (payload != null) {
                sender.send(payload);
                synced += 1;
            }
        }
        prefs.edit()
                .putBoolean(doneKey, true)
                .putLong(watermarkKey, newestTimestamp)
                .apply();
        BridgeEventLog.append(context, "Initial call sync published " + synced + " call(s)");
    }

    private void publishCallSyncState(String type, int total, int synced) {
        JSONObject payload = buildCallSyncStatePayload(currentConfig(), type, total, synced);
        if (currentTransportUsesHttp()) {
            postHttpStatus(payload);
        } else {
            publishJson(currentConfig().topic("call/status"), payload);
        }
    }

    private boolean publishCallSyncRecord(CallLogSyncRecord call) {
        JSONObject payload = buildCallSyncPayload(currentConfig(), call);
        if (payload == null) return false;
        if (currentTransportUsesHttp()) {
            postHttpStatus(payload);
        } else {
            publishJson(currentConfig().topic("call/status"), payload);
        }
        return true;
    }

    private static JSONObject buildCallSyncStatePayload(BridgeConfig cfg, String type, int total, int synced) {
        JSONObject json = new JSONObject();
        try {
            json.put("type", type);
            json.put("sync", true);
            json.put("device_id", cfg.deviceId);
            json.put("total", Math.max(0, total));
            json.put("synced", Math.max(0, synced));
            json.put("timestamp", System.currentTimeMillis());
        } catch (JSONException ignored) {
        }
        return json;
    }

    private static JSONObject buildCallSyncPayload(BridgeConfig cfg, CallLogSyncRecord call) {
        if (cfg == null || call == null || call.number.isEmpty()) return null;
        JSONObject json = new JSONObject();
        JSONObject nested = new JSONObject();
        try {
            nested.put("status", call.status);
            nested.put("direction", call.direction);
            nested.put("number", call.number);
            nested.put("name", call.name);
            nested.put("duration", call.durationSeconds);
            nested.put("updatedAt", call.timestamp);

            json.put("type", "call_sync");
            json.put("sync", true);
            json.put("device_id", cfg.deviceId);
            json.put("status", call.status);
            json.put("direction", call.direction);
            json.put("number", call.number);
            json.put("name", call.name);
            json.put("duration", call.durationSeconds);
            json.put("timestamp", call.timestamp);
            json.put("call_status", call.status);
            json.put("call_direction", call.direction);
            json.put("call_number", call.number);
            json.put("call_updated_at", call.timestamp);
            json.put("call", nested);
        } catch (JSONException ignored) {
        }
        return json;
    }

    private static String syncPrefKey(String prefix, BridgeConfig cfg) {
        String deviceId = cfg == null ? "" : objectString(cfg.deviceId).trim();
        return prefix + (deviceId.isEmpty() ? "local" : deviceId);
    }

    private static List<CallLogSyncRecord> filterCallSyncRecords(List<CallLogSyncRecord> source, long watermark) {
        List<CallLogSyncRecord> filtered = new ArrayList<>();
        if (source == null) {
            return filtered;
        }
        for (CallLogSyncRecord call : source) {
            if (call != null && call.timestamp > watermark) {
                filtered.add(call);
            }
        }
        return filtered;
    }

    private static long maxCallSyncTimestamp(List<CallLogSyncRecord> calls, long fallback) {
        long max = Math.max(0L, fallback);
        if (calls == null) {
            return max;
        }
        for (CallLogSyncRecord call : calls) {
            if (call != null) {
                max = Math.max(max, call.timestamp);
            }
        }
        return max;
    }

    private static List<CallLogSyncRecord> buildRecentCallLogRecords(Context context, int limit) {
        List<CallLogSyncRecord> calls = new ArrayList<>();
        if (context == null || !hasPermission(context, Manifest.permission.READ_CALL_LOG)) {
            return calls;
        }
        try (Cursor cursor = context.getContentResolver().query(
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
                CallLog.Calls.DATE + " DESC"
        )) {
            if (cursor == null) {
                return calls;
            }
            int nameIndex = cursor.getColumnIndex(CallLog.Calls.CACHED_NAME);
            int numberIndex = cursor.getColumnIndex(CallLog.Calls.NUMBER);
            int typeIndex = cursor.getColumnIndex(CallLog.Calls.TYPE);
            int dateIndex = cursor.getColumnIndex(CallLog.Calls.DATE);
            int durationIndex = cursor.getColumnIndex(CallLog.Calls.DURATION);
            while (cursor.moveToNext() && calls.size() < limit) {
                String number = numberIndex >= 0 ? cursor.getString(numberIndex) : "";
                number = number == null ? "" : number.trim();
                if (number.isEmpty()) {
                    continue;
                }
                String name = nameIndex >= 0 ? cursor.getString(nameIndex) : "";
                int type = typeIndex >= 0 ? cursor.getInt(typeIndex) : CallLog.Calls.INCOMING_TYPE;
                long timestamp = dateIndex >= 0 ? cursor.getLong(dateIndex) : System.currentTimeMillis();
                int durationSeconds = durationIndex >= 0 ? Math.max(0, cursor.getInt(durationIndex)) : 0;
                calls.add(new CallLogSyncRecord(
                        name == null ? "" : name.trim(),
                        number,
                        callDirectionForType(type),
                        callStatusForType(type, durationSeconds),
                        timestamp > 0 ? timestamp : System.currentTimeMillis(),
                        durationSeconds
                ));
            }
        } catch (RuntimeException error) {
            Log.w(TAG, "Unable to read call log for sync", error);
        }
        return calls;
    }

    private static String callDirectionForType(int type) {
        if (type == CallLog.Calls.OUTGOING_TYPE) {
            return "outgoing";
        }
        return "incoming";
    }

    private static String callStatusForType(int type, int durationSeconds) {
        switch (type) {
            case CallLog.Calls.MISSED_TYPE:
                return "missed";
            case CallLog.Calls.REJECTED_TYPE:
                return "rejected";
            case CallLog.Calls.BLOCKED_TYPE:
                return "blocked";
            case CallLog.Calls.VOICEMAIL_TYPE:
                return "voicemail";
            case CallLog.Calls.INCOMING_TYPE:
                return durationSeconds > 0 ? "ended" : "missed";
            case CallLog.Calls.OUTGOING_TYPE:
            default:
                return "ended";
        }
    }

    private void publishStatus(String state) {
        publishStatus(state, false);
    }

    private void publishStatus(String state, boolean forceDetailed) {
        JSONObject payload = statusPayload(state, forceDetailed);
        if (currentTransportUsesHttp()) {
            postHttpStatus(payload);
            return;
        }
        publishJson(currentConfig().topic("status"), payload);
    }

    private void registerCallStateListener() {
        if (callStateListener != null || !hasPhoneStatePermission()) {
            return;
        }
        TelephonyManager telephonyManager = getSystemService(TelephonyManager.class);
        if (telephonyManager == null) {
            return;
        }
        callStateListener = new PhoneStateListener() {
            @Override
            public void onCallStateChanged(int state, String phoneNumber) {
                executor.execute(() -> handleCallStateChanged(state, phoneNumber));
            }
        };
        try {
            telephonyManager.listen(callStateListener, PhoneStateListener.LISTEN_CALL_STATE);
            BridgeEventLog.append(this, "Call state listener registered");
        } catch (SecurityException ignored) {
            callStateListener = null;
        } catch (RuntimeException ignored) {
            callStateListener = null;
        }
    }

    private void unregisterCallStateListener() {
        PhoneStateListener listener = callStateListener;
        TelephonyManager telephonyManager = getSystemService(TelephonyManager.class);
        if (listener == null || telephonyManager == null) {
            callStateListener = null;
            return;
        }
        try {
            telephonyManager.listen(listener, PhoneStateListener.LISTEN_NONE);
        } catch (RuntimeException ignored) {
        }
        callStateListener = null;
    }

    private void registerPhoneStateReceiver() {
        if (phoneStateReceiver != null || !hasPhoneStatePermission()) {
            return;
        }
        IntentFilter filter = new IntentFilter(TelephonyManager.ACTION_PHONE_STATE_CHANGED);
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (intent == null) {
                    return;
                }
                String state = firstNonEmpty(intent.getStringExtra(TelephonyManager.EXTRA_STATE), "");
                String incomingNumber = firstNonEmpty(intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER), "");
                if (!TelephonyManager.EXTRA_STATE_RINGING.equals(state) || incomingNumber.isEmpty()) {
                    return;
                }
                executor.execute(() -> handleIncomingNumberHint(incomingNumber));
            }
        };
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED);
            } else {
                registerReceiver(receiver, filter);
            }
            phoneStateReceiver = receiver;
            BridgeEventLog.append(this, "Phone state receiver registered");
        } catch (RuntimeException ignored) {
            phoneStateReceiver = null;
        }
    }

    private void unregisterPhoneStateReceiver() {
        BroadcastReceiver receiver = phoneStateReceiver;
        if (receiver == null) {
            return;
        }
        try {
            unregisterReceiver(receiver);
        } catch (RuntimeException ignored) {
        }
        phoneStateReceiver = null;
    }

    private void handleCallStateChanged(int state, String phoneNumber) {
        String resolvedNumber = firstNonEmpty(phoneNumber, lastCallNumber, pendingDialNumber);
        int previousState = lastCallState;
        lastCallState = state;
        if (!resolvedNumber.isEmpty()) {
            lastCallNumber = resolvedNumber;
        }

        if (state == TelephonyManager.CALL_STATE_RINGING) {
            if (resolvedNumber.isEmpty() && !hasCallLogPermission()) {
                logConsoleEvent("call", "Incoming call detected but caller ID is unavailable: grant Incoming caller ID permission");
            }
            recordLocalCallState("ringing", "incoming", resolvedNumber);
            publishIncomingCall(resolvedNumber);
            publishCallStatus("ringing", resolvedNumber, "incoming");
            return;
        }

        if (state == TelephonyManager.CALL_STATE_OFFHOOK) {
            String status = previousState == TelephonyManager.CALL_STATE_RINGING ? "answered" : "connected";
            String direction = previousState == TelephonyManager.CALL_STATE_RINGING ? "incoming" : "outgoing";
            recordLocalCallState(status, direction, resolvedNumber);
            publishCallStatus(status, resolvedNumber, direction);
            return;
        }

        if (state == TelephonyManager.CALL_STATE_IDLE) {
            if (previousState == TelephonyManager.CALL_STATE_RINGING) {
                recordLocalCallState("missed", "incoming", resolvedNumber);
                publishCallStatus("missed", resolvedNumber, "incoming");
            } else if (previousState == TelephonyManager.CALL_STATE_OFFHOOK) {
                String direction = pendingDialNumber.isEmpty() ? "incoming" : "outgoing";
                recordLocalCallState("ended", direction, resolvedNumber);
                publishCallStatus("ended", resolvedNumber, direction);
            }
            pendingDialNumber = "";
            lastCallNumber = "";
        }
    }

    private void recordLocalCallState(String status, String direction, String number) {
        String normalizedStatus = status == null ? "" : status.trim().toLowerCase(Locale.US);
        String normalizedDirection = direction == null ? "" : direction.trim().toLowerCase(Locale.US);
        String normalizedNumber = number == null ? "" : number.trim();
        StringBuilder message = new StringBuilder("Call ")
                .append(normalizedStatus.isEmpty() ? "updated" : normalizedStatus);
        if (!normalizedDirection.isEmpty()) {
            message.append(" (").append(normalizedDirection).append(")");
        }
        if (!normalizedNumber.isEmpty()) {
            message.append(" for ").append(normalizedNumber);
        }
        logConsoleEvent("call", message.toString());
        lastMessageEventAtMs = System.currentTimeMillis();
        persistRuntimeTelemetry();
    }

    private void publishIncomingCall(String number) {
        JSONObject payload = new JSONObject();
        try {
            payload.put("type", "call_incoming");
            payload.put("device_id", currentConfig().deviceId);
            payload.put("number", number == null ? "" : number);
            payload.put("timestamp", System.currentTimeMillis());
        } catch (JSONException ignored) {
        }
        publishJson(currentConfig().topic("call/incoming"), payload);
    }

    private void publishCallStatus(String status, String number, String direction) {
        JSONObject payload = new JSONObject();
        try {
            payload.put("type", "call_status");
            payload.put("device_id", currentConfig().deviceId);
            payload.put("status", status == null ? "" : status);
            payload.put("number", number == null ? "" : number);
            payload.put("direction", direction == null ? "" : direction);
            payload.put("timestamp", System.currentTimeMillis());
        } catch (JSONException ignored) {
        }
        publishJson(currentConfig().topic("call/status"), payload);
    }

    private void publishUssdResult(String code, String response, String status, boolean sessionActive) {
        JSONObject payload = new JSONObject();
        try {
            payload.put("type", "ussd_result");
            payload.put("device_id", currentConfig().deviceId);
            payload.put("code", code == null ? "" : code);
            payload.put("response", response == null ? "" : response);
            payload.put("status", status == null ? "" : status);
            payload.put("session_active", sessionActive);
            payload.put("timestamp", System.currentTimeMillis());
        } catch (JSONException ignored) {
        }
        publishJson(currentConfig().topic("ussd/result"), payload);
    }

    private TelephonyManager resolveTelephonyManagerForCommand(Integer preferredSimSlot, Integer preferredSubscriptionId) {
        TelephonyManager telephonyManager = getSystemService(TelephonyManager.class);
        if (telephonyManager == null) {
            return null;
        }
        Integer subscriptionId = resolveSubscriptionIdForCommand(preferredSimSlot, preferredSubscriptionId);
        return createTelephonyManagerForSubscription(telephonyManager, subscriptionId == null ? -1 : subscriptionId);
    }

    private Integer resolveSubscriptionIdForCommand(Integer preferredSimSlot, Integer preferredSubscriptionId) {
        Integer subscriptionId = normalizeSubscriptionId(preferredSubscriptionId);
        if (subscriptionId == null) {
            subscriptionId = resolveSubscriptionIdForSlot(preferredSimSlot);
        }
        if (subscriptionId == null) {
            subscriptionId = normalizeSubscriptionId(safeDefaultVoiceSubscriptionId());
        }
        return subscriptionId;
    }

    private JSONObject statusPayload() {
        return statusPayload("online", true);
    }

    private JSONObject statusPayload(String state) {
        return statusPayload(state, false);
    }

    private JSONObject statusPayload(String state, boolean forceDetailed) {
        JSONObject json = new JSONObject();
        try {
            boolean includeDetailed = shouldIncludeDetailedStatus(forceDetailed);
            StatusSnapshot snapshot = captureStatusSnapshot(state, includeDetailed);
            json.put("type", "status");
            json.put("device_id", currentConfig().deviceId);
            json.put("bridge", "android_sms");
            json.put("transport_mode", currentConfig().transportMode);
            json.put("status", snapshot.state);
            json.put("active_path", currentTransportUsesHttp() ? "http" : snapshot.activePath);
            json.put("mqtt_connected", snapshot.mqttConnected);
            json.put("mqtt_subscribed", snapshot.mqttSubscribed);
            json.put("mqtt_published_count", snapshot.mqttPublishedCount);
            json.put("mqtt_publish_failures", snapshot.mqttPublishFailures);
            json.put("storage_queue_depth", snapshot.storageQueueDepth);
            json.put("storage_media_available", snapshot.storageMediaAvailable);
            json.put("storage_total_bytes", snapshot.storageTotalBytes);
            json.put("storage_used_bytes", snapshot.storageUsedBytes);
            json.put("storage_free_bytes", snapshot.storageFreeBytes);
            json.put("storage_media_label", snapshot.storageMediaLabel);
            json.put("storage_media_type", snapshot.storageMediaType);
            if (snapshot.batteryLevel != null) {
                json.put("battery", snapshot.batteryLevel);
            }
            if (snapshot.charging != null) {
                json.put("charging", snapshot.charging);
            }
            if (snapshot.temperatureC != null) {
                json.put("temperature", snapshot.temperatureC);
            }
            if (snapshot.voltageMv != null) {
                json.put("voltage_mV", snapshot.voltageMv);
            }
            if (includeDetailed) {
                if (!snapshot.manufacturer.isEmpty()) {
                    json.put("manufacturer", snapshot.manufacturer);
                }
                if (!snapshot.brand.isEmpty()) {
                    json.put("brand", snapshot.brand);
                }
                if (!snapshot.model.isEmpty()) {
                    json.put("model", snapshot.model);
                }
                if (!snapshot.deviceName.isEmpty()) {
                    json.put("device_name", snapshot.deviceName);
                }
                if (!snapshot.androidId.isEmpty()) {
                    json.put("android_id", snapshot.androidId);
                }
                if (!snapshot.installId.isEmpty()) {
                    json.put("install_id", snapshot.installId);
                }
            }
            json.put("uptime_ms", snapshot.uptimeMs);
            json.put("send_sms_permission", snapshot.sendSmsPermission);
            json.put("receive_sms_permission", snapshot.receiveSmsPermission);
            json.put("call_phone_permission", snapshot.callPhonePermission);
            boolean answerPhoneCallsPermission = Build.VERSION.SDK_INT >= 26
                    && checkSelfPermission(Manifest.permission.ANSWER_PHONE_CALLS) == PackageManager.PERMISSION_GRANTED;
            boolean readCallLogPermission = checkSelfPermission(Manifest.permission.READ_CALL_LOG) == PackageManager.PERMISSION_GRANTED;
            boolean readContactsPermission = checkSelfPermission(Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED;
            boolean recordAudioPermission = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
            boolean cameraPermission = checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
            boolean mqttReady = snapshot.mqttConnected && snapshot.mqttSubscribed;
            boolean smsComplete = snapshot.telephonySupported && snapshot.telephonyEnabled
                    && mqttReady && snapshot.sendSmsPermission && snapshot.receiveSmsPermission;
            boolean callDialSupported = snapshot.telephonySupported && snapshot.telephonyEnabled && snapshot.callPhonePermission;
            boolean callControlSupported = callDialSupported && answerPhoneCallsPermission;
            boolean callStatusSupported = callDialSupported && readCallLogPermission;
            boolean callLiveTalkSupported = false;
            boolean contactsComplete = mqttReady && readContactsPermission;
            boolean ussdComplete = callDialSupported && Build.VERSION.SDK_INT >= 26 && mqttReady;
            boolean cameraComplete = false;
            boolean audioComplete = false;
            boolean intercomComplete = false;
            json.put("answer_phone_calls_permission", answerPhoneCallsPermission);
            json.put("read_call_log_permission", readCallLogPermission);
            json.put("read_contacts_permission", readContactsPermission);
            json.put("record_audio_permission", recordAudioPermission);
            json.put("camera_permission", cameraPermission);
            json.put("post_notifications_permission", snapshot.notificationsPermission);
            json.put("read_sms_requested", false);
            json.put("telephony_supported", snapshot.telephonySupported);
            json.put("telephony_enabled", snapshot.telephonyEnabled);
            json.put("sms_supported", smsComplete);
            json.put("contacts_supported", contactsComplete);
            json.put("call_dial_supported", callDialSupported);
            json.put("call_control_supported", callControlSupported);
            json.put("call_status_supported", callStatusSupported);
            json.put("call_live_talk_supported", callLiveTalkSupported);
            json.put("call_supported", callDialSupported && callControlSupported && callStatusSupported && callLiveTalkSupported);
            json.put("ussd_supported", ussdComplete);
            json.put("camera_capture_supported", cameraComplete);
            json.put("audio_supported", audioComplete);
            json.put("intercom_supported", intercomComplete);
            json.put("data_mode_enabled", snapshot.dataModeEnabled);
            json.put("modem_registered", snapshot.modemRegistered);
            json.put("modem_operator_name", snapshot.operatorName);
            json.put("networkType", snapshot.networkType);
            json.put("modem_data_session_open", snapshot.cellularActive);
            json.put("modem_ip_bearer_ready", snapshot.cellularIpReady);
            if (includeDetailed) {
                json.put("sim_slot_count", snapshot.simSlots.size());
                json.put("sim_active_slot", snapshot.activeSimSlotIndex);
                json.put("dual_sim", snapshot.simSlots.size() >= 2);
                json.put("sim_slots", simSlotsJson(snapshot.simSlots));
            }
            if (snapshot.modemSignalAsu != null) {
                json.put("modem_signal", snapshot.modemSignalAsu);
            }
            if (!snapshot.cellularIpAddress.isEmpty()) {
                json.put("modem_ip_address", snapshot.cellularIpAddress);
                json.put("modem_data_ip", snapshot.cellularIpAddress);
            }
            if (includeDetailed && !snapshot.simSlots.isEmpty()) {
                SimSlotSnapshot activeSlot = null;
                for (SimSlotSnapshot slot : snapshot.simSlots) {
                    if (slot.slotIndex == snapshot.activeSimSlotIndex) {
                        activeSlot = slot;
                        break;
                    }
                }
                if (activeSlot == null) {
                    activeSlot = snapshot.simSlots.get(0);
                }
                if (activeSlot != null && !activeSlot.number.isEmpty()) {
                    json.put("modem_subscriber_number", activeSlot.number);
                }
            }
            json.put("wifi_started", snapshot.wifiEnabled);
            json.put("wifi_configured", snapshot.wifiEnabled || snapshot.wifiConnected);
            json.put("wifi_connected", snapshot.wifiConnected);
            if (!snapshot.wifiSsid.isEmpty()) {
                json.put("wifi_ssid", snapshot.wifiSsid);
            }
            if (!snapshot.wifiIpAddress.isEmpty()) {
                json.put("wifi_ip_address", snapshot.wifiIpAddress);
            }
            if (snapshot.wifiRssi != null) {
                json.put("wifi_rssi", snapshot.wifiRssi);
            }
            JSONObject mqtt = new JSONObject();
            mqtt.put("connected", snapshot.mqttConnected);
            mqtt.put("subscribed", snapshot.mqttSubscribed);
            mqtt.put("publishedCount", snapshot.mqttPublishedCount);
            mqtt.put("publishFailures", snapshot.mqttPublishFailures);
            json.put("mqtt", mqtt);
            JSONObject wifi = new JSONObject();
            wifi.put("mode", snapshot.wifiEnabled ? "sta" : "off");
            wifi.put("connected", snapshot.wifiConnected);
            wifi.put("ssid", snapshot.wifiSsid);
            wifi.put("ipAddress", snapshot.wifiIpAddress);
            if (snapshot.wifiRssi != null) {
                wifi.put("rssi", snapshot.wifiRssi);
            }
            wifi.put("configured", snapshot.wifiEnabled || snapshot.wifiConnected);
            wifi.put("started", snapshot.wifiEnabled);
            wifi.put("ipAssigned", !snapshot.wifiIpAddress.isEmpty());
            json.put("wifi", wifi);
            JSONObject mobile = new JSONObject();
            mobile.put("connected", snapshot.cellularConnected);
            mobile.put("networkType", snapshot.networkType);
            mobile.put("operator", snapshot.operatorName);
            mobile.put("operatorName", snapshot.operatorName);
            mobile.put("ipAddress", snapshot.cellularIpAddress);
            if (snapshot.modemSignalAsu != null) {
                mobile.put("signalStrength", snapshot.modemSignalAsu);
            }
            if (includeDetailed) {
                mobile.put("slots", simSlotsJson(snapshot.simSlots));
            }
            json.put("mobile", mobile);
            JSONObject sim = new JSONObject();
            if (includeDetailed) {
                sim.put("slotCount", snapshot.simSlots.size());
                sim.put("dualSim", snapshot.simSlots.size() >= 2);
                sim.put("activeSlotIndex", snapshot.activeSimSlotIndex);
                if (!snapshot.simSlots.isEmpty()) {
                    SimSlotSnapshot activeSlot = null;
                    for (SimSlotSnapshot slot : snapshot.simSlots) {
                        if (slot.slotIndex == snapshot.activeSimSlotIndex) {
                            activeSlot = slot;
                            break;
                        }
                    }
                    if (activeSlot == null) {
                        activeSlot = snapshot.simSlots.get(0);
                    }
                    if (activeSlot != null) {
                        sim.put("operator", activeSlot.carrierName);
                        sim.put("operatorName", activeSlot.carrierName);
                        sim.put("number", activeSlot.number);
                        sim.put("subscriberNumber", activeSlot.number);
                        sim.put("registered", activeSlot.registered);
                        sim.put("ready", activeSlot.ready);
                        sim.put("dataIp", activeSlot.dataIp);
                    }
                }
                sim.put("slots", simSlotsJson(snapshot.simSlots));
            }
            json.put("sim", sim);
            JSONObject system = new JSONObject();
            if (snapshot.batteryLevel != null) {
                system.put("battery", snapshot.batteryLevel);
            }
            if (snapshot.charging != null) {
                system.put("charging", snapshot.charging);
            }
            if (snapshot.temperatureC != null) {
                system.put("temperature", snapshot.temperatureC);
            }
            if (snapshot.voltageMv != null) {
                system.put("voltage_mV", snapshot.voltageMv);
            }
            system.put("uptime", snapshot.uptimeSeconds);
            system.put("freeHeap", snapshot.availableMemoryBytes);
            if (includeDetailed) {
                system.put("deviceName", snapshot.deviceName);
                system.put("manufacturer", snapshot.manufacturer);
                system.put("brand", snapshot.brand);
                system.put("model", snapshot.model);
                system.put("androidId", snapshot.androidId);
                system.put("installId", snapshot.installId);
            }
            json.put("system", system);
            if (includeDetailed) {
                JSONObject device = new JSONObject();
                device.put("platform", "android");
                device.put("manufacturer", snapshot.manufacturer);
                device.put("brand", snapshot.brand);
                device.put("model", snapshot.model);
                device.put("deviceName", snapshot.deviceName);
                device.put("androidId", snapshot.androidId);
                device.put("installId", snapshot.installId);
                json.put("device", device);
            }
            JSONObject storage = new JSONObject();
            storage.put("mounted", snapshot.storageMediaAvailable);
            storage.put("mediaAvailable", snapshot.storageMediaAvailable);
            storage.put("bufferedOnly", false);
            storage.put("queueDepth", snapshot.storageQueueDepth);
            storage.put("pendingUploads", 0);
            storage.put("totalBytes", snapshot.storageTotalBytes);
            storage.put("usedBytes", snapshot.storageUsedBytes);
            storage.put("freeBytes", snapshot.storageFreeBytes);
            storage.put("type", snapshot.storageMediaType);
            storage.put("label", snapshot.storageMediaLabel);
            json.put("storage", storage);
            JSONObject caps = new JSONObject();
            caps.put("mqtt", mqttReady);
            caps.put("modem", snapshot.telephonySupported && snapshot.telephonyEnabled);
            caps.put("sms", smsComplete);
            caps.put("calls", false);
            caps.put("contacts", contactsComplete);
            caps.put("ussd", ussdComplete);
            caps.put("wifi", snapshot.wifiEnabled || snapshot.wifiConnected);
            caps.put("storage", snapshot.storageMediaAvailable);
            caps.put("sd", snapshot.storageMediaAvailable);
            caps.put("camera", false);
            caps.put("webcam", false);
            caps.put("audio", false);
            caps.put("intercom", false);
            caps.put("battery", snapshot.batteryLevel != null);
            json.put("caps", caps);
            JSONObject modules = new JSONObject();
            putModuleRule(modules, "sms", smsComplete, smsComplete ? "SMS send and receive ready" : "SMS requires MQTT, telephony, send permission, and receive permission");
            putModuleRule(modules, "calls", false, "Calls require dial, answer/end, status feed, and live talk support");
            putModuleRule(modules, "contacts", contactsComplete, contactsComplete ? "Contacts can be read locally and synced" : "Contacts require read permission and MQTT");
            putModuleRule(modules, "ussd", ussdComplete, ussdComplete ? "USSD command path ready" : "USSD requires telephony and MQTT");
            putModuleRule(modules, "webcam", false, "Camera live feed is not implemented on this bridge");
            putModuleRule(modules, "audio", false, "Audio live feed is not implemented on this bridge");
            putModuleRule(modules, "intercom", false, "Intercom requires camera and audio live paths");
            json.put("modules", modules);
            json.put("timestamp", System.currentTimeMillis());
        } catch (JSONException ignored) {
        }
        return json;
    }

    private static void putModuleRule(JSONObject modules, String key, boolean available, String reason) throws JSONException {
        JSONObject module = new JSONObject();
        module.put("available", available);
        module.put("complete", available);
        module.put("ready", available);
        module.put("reason", reason);
        modules.put(key, module);
    }

    private boolean shouldIncludeDetailedStatus(boolean forceDetailed) {
        if (forceDetailed || detailedStatusPending) {
            return true;
        }
        if (cachedDeviceIdentity == null || (cachedDeviceIdentity.androidId.isEmpty() && cachedDeviceIdentity.installId.isEmpty())) {
            return true;
        }
        if (!hasCachedSimNumber() && (System.currentTimeMillis() - lastDetailedStatusAtMs) >= TimeUnit.MINUTES.toMillis(2)) {
            return true;
        }
        return false;
    }

    private boolean hasCachedSimNumber() {
        List<SimSlotSnapshot> slots = cachedSimSlots;
        if (slots == null || slots.isEmpty()) {
            return false;
        }
        for (SimSlotSnapshot slot : slots) {
            if (slot != null && !slot.number.isEmpty()) {
                return true;
            }
        }
        return false;
    }

    private void publishActionResult(String actionId, String command, String result, int resultCode, String detail, JSONObject payload, int timeoutMs) {
        JSONObject json = new JSONObject();
        try {
            json.put("action_id", actionId == null ? "" : actionId);
            json.put("messageId", actionId == null ? "" : actionId);
            json.put("device_id", currentConfig().deviceId);
            json.put("command", command == null ? "" : command);
            json.put("result", result);
            json.put("success", "completed".equals(result) || "accepted".equals(result));
            json.put("result_code", resultCode);
            json.put("feature_reason", 0);
            json.put("detail", detail == null ? "" : detail);
            json.put("created_ms", System.currentTimeMillis());
            json.put("timeout_ms", timeoutMs > 0 ? timeoutMs : 90000);
            if (payload != null) {
                json.put("payload", payload);
            }
        } catch (JSONException ignored) {
        }
        if (currentTransportUsesHttp()) {
            return;
        }
        publishJson(currentConfig().topic("action/result"), json);
    }

    private void publishJson(String topic, JSONObject json) {
        executor.execute(() -> {
            MqttClient current = client;
            if (current == null || !current.isConnected()) {
                if (pendingPublishes.size() < 100) {
                    pendingPublishes.add(new PendingPublish(topic, json.toString()));
                    logTelemetry("Device send queued: " + compactTopic(topic)
                            + " :: payload=" + fullJson(json));
                    persistRuntimeTelemetry();
                }
                return;
            }
            try {
                current.publish(topic, new MqttMessage(json.toString().getBytes(StandardCharsets.UTF_8)) {{
                    setQos(1);
                    setRetained(false);
                }});
                publishSuccessCount += 1;
                logTelemetry("Device sent: " + compactTopic(topic)
                        + " :: payload=" + fullJson(json));
                recordPublishSuccess(topic);
            } catch (MqttException error) {
                publishFailureCount += 1;
                Log.e(TAG, "Publish failed: " + topic, error);
                logTelemetry("Device send failed: " + compactTopic(topic)
                        + " :: response=" + detailForError(error, "publish failed")
                        + " payload=" + fullJson(json));
                persistRuntimeTelemetry();
            }
        });
    }

    private void flushPendingPublishes() {
        PendingPublish pending;
        while ((pending = pendingPublishes.poll()) != null) {
            try {
                MqttClient current = client;
                if (current == null || !current.isConnected()) {
                    pendingPublishes.add(pending);
                    return;
                }
                MqttMessage message = new MqttMessage(pending.payload.getBytes(StandardCharsets.UTF_8));
                message.setQos(1);
                current.publish(pending.topic, message);
                publishSuccessCount += 1;
                logTelemetry("Device sent pending: " + compactTopic(pending.topic)
                        + " :: payload=" + fullText(pending.payload));
                recordPublishSuccess(pending.topic);
            } catch (MqttException error) {
                publishFailureCount += 1;
                Log.e(TAG, "Pending publish failed: " + pending.topic, error);
                logTelemetry("Device pending send failed: " + compactTopic(pending.topic)
                        + " :: response=" + detailForError(error, "pending publish failed")
                        + " payload=" + fullText(pending.payload));
                persistRuntimeTelemetry();
            }
        }
    }

    private void stopBridge() {
        stopRequested = true;
        cancelReconnect();
        cancelStatusHeartbeat();
        cancelOutstandingPoll();
        commandSubscriptionsReady = false;
        pendingPublishes.clear();
        BridgeEventLog.append(this, "Stopping Device Bridge service");
        currentConfig().withBridgeEnabled(false).save(this);
        config = currentConfig().withBridgeEnabled(false);
        executor.execute(() -> {
            try {
                MqttClient current = client;
                if (current != null) {
                    publishStatus("offline");
                    current.disconnectForcibly(500, 500);
                    current.close();
                }
            } catch (MqttException ignored) {
            } finally {
                client = null;
                updateRuntimeState("offline", false, "Bridge stopped");
                stopForeground(true);
                stopSelf();
            }
        });
    }

    BridgeConfig currentConfig() {
        BridgeConfig cfg = config;
        if (cfg == null) {
            cfg = BridgeConfig.load(this);
            config = cfg;
        }
        return cfg;
    }

    private boolean currentTransportUsesHttp() {
        BridgeConfig cfg = currentConfig();
        return cfg.usesHttpTransport() || (cfg.usesAutoTransport() && activeHttpTransport);
    }

    boolean isStopRequested() {
        return stopRequested;
    }

    void logBridgeEvent(String message) {
        BridgeEventLog.append(this, message);
    }

    private void logConsoleEvent(String source, String message) {
        String prefix = source == null ? "" : source.trim().toLowerCase(Locale.US);
        if (prefix.isEmpty()) {
            BridgeEventLog.append(this, message);
            return;
        }
        BridgeEventLog.append(this, prefix + ": " + message);
    }

    private void logTelemetry(String message) {
        logConsoleEvent("telemetry", message);
    }

    void recordHttpFailure(String message) {
        recordHttpFailure(message, "");
    }

    void recordHttpFailure(String message, String detail) {
        String detailText = detail == null ? "" : detail.trim();
        String fullMessage = detailText.isEmpty() ? message : (message + ": " + detailText);
        BridgeEventLog.append(this, fullMessage);
        publishFailureCount += 1;
        if (currentTransportUsesHttp() && currentConfig().bridgeEnabled && !stopRequested) {
            updateRuntimeState("http_degraded", false, fullMessage);
            maybeScheduleHttpRecovery(fullMessage);
        }
        persistRuntimeTelemetry();
    }

    void recordHttpStatusSuccess() {
        publishSuccessCount += 1;
        lastStatusPushAtMs = System.currentTimeMillis();
        lastHttpRecoveryAttemptAtMs = 0L;
        if (currentTransportUsesHttp() && currentConfig().bridgeEnabled && !stopRequested) {
            updateRuntimeState("online", false, "HTTP bridge active via " + currentConfig().serverUrl);
        }
        persistRuntimeTelemetry();
    }

    void recordHttpIncomingSmsSuccess() {
        publishSuccessCount += 1;
        lastIncomingSyncAtMs = System.currentTimeMillis();
        persistRuntimeTelemetry();
    }

    void recordHttpMessageEventSuccess() {
        publishSuccessCount += 1;
        lastMessageEventAtMs = System.currentTimeMillis();
        persistRuntimeTelemetry();
    }

    void recordHttpQueuePollStart() {
        lastQueuePollAtMs = System.currentTimeMillis();
        persistRuntimeTelemetry();
    }

    SmsSender.SendResult sendHttpOutstandingMessage(BridgeHttpClient.OutstandingMessage message) {
        SmsSender.SendResult result = SmsSender.send(
                this,
                message.id,
                message.to,
                message.content,
                message.timeoutMs,
                message.simSlot,
                message.subscriptionId
        );
        if (result.accepted) {
            BridgeSmsStore.recordOutgoing(this, message.id, message.to, message.content, System.currentTimeMillis(), "dashboard_http");
        }
        return result;
    }

    private String commandFromTopic(String topic) {
        String[] parts = topic == null ? new String[0] : topic.split("/");
        for (int i = 0; i < parts.length - 1; i++) {
            if ("command".equals(parts[i]) || "cmd".equals(parts[i])) {
                return parts[i + 1];
            }
        }
        return "";
    }

    private JSONObject parseJson(String body) {
        try {
            return new JSONObject(body == null || body.trim().isEmpty() ? "{}" : body);
        } catch (JSONException ignored) {
            return new JSONObject();
        }
    }

    private static String firstNonEmpty(String... values) {
        for (String value : values) {
            if (value != null && !value.trim().isEmpty()) {
                return value.trim();
            }
        }
        return "";
    }

    private static String objectString(Object value) {
        return value == null ? "" : String.valueOf(value).trim();
    }

    private static long objectLong(Object value, long fallback) {
        if (value instanceof Number) {
            return ((Number) value).longValue();
        }
        try {
            return Long.parseLong(objectString(value));
        } catch (NumberFormatException ignored) {
            return fallback;
        }
    }

    private void handleIncomingNumberHint(String phoneNumber) {
        String normalizedNumber = phoneNumber == null ? "" : phoneNumber.trim();
        if (normalizedNumber.isEmpty()) {
            return;
        }
        boolean changed = !samePhoneNumber(lastCallNumber, normalizedNumber);
        lastCallNumber = normalizedNumber;
        if (lastCallState == TelephonyManager.CALL_STATE_RINGING && changed) {
            recordLocalCallState("ringing", "incoming", normalizedNumber);
            publishIncomingCall(normalizedNumber);
            publishCallStatus("ringing", normalizedNumber, "incoming");
        }
    }

    private static Integer firstInteger(Integer... values) {
        for (Integer value : values) {
            if (value != null) {
                return value;
            }
        }
        return null;
    }

    private static Integer jsonInteger(JSONObject data, String key) {
        if (data == null || key == null || !data.has(key) || data.isNull(key)) {
            return null;
        }
        try {
            return data.getInt(key);
        } catch (JSONException ignored) {
            try {
                String raw = data.getString(key);
                if (raw == null || raw.trim().isEmpty()) {
                    return null;
                }
                return Integer.parseInt(raw.trim());
            } catch (Exception ignoredAgain) {
                return null;
            }
        }
    }

    private static Integer requestedSimSlot(JSONObject data) {
        return firstInteger(
                jsonInteger(data, "sim_slot"),
                jsonInteger(data, "simSlot"),
                jsonInteger(data, "slot")
        );
    }

    private DeviceIdentitySnapshot captureDeviceIdentity(TelephonyManager telephonyManager) {
        String manufacturer = firstNonEmpty(Build.MANUFACTURER);
        String brand = firstNonEmpty(Build.BRAND);
        String model = firstNonEmpty(Build.MODEL);
        String deviceName = firstNonEmpty((manufacturer + " " + model).trim(), model, manufacturer, Build.DEVICE);
        String androidId = "";
        try {
            String value = Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID);
            androidId = value == null ? "" : value.trim();
        } catch (RuntimeException ignored) {
        }

        return new DeviceIdentitySnapshot(
                manufacturer,
                brand,
                model,
                deviceName,
                androidId,
                currentConfig().installId,
                ""
        );
    }

    private List<SimSlotSnapshot> captureSimSlots(
            SubscriptionManager subscriptionManager,
            TelephonyManager telephonyManager,
            boolean telephonySupported,
            String fallbackOperatorName,
            String fallbackNetworkType,
            Integer fallbackSignalAsu,
            boolean fallbackRegistered,
            String fallbackDataIp
    ) {
        List<SimSlotSnapshot> slots = new ArrayList<>();
        if (!telephonySupported || Build.VERSION.SDK_INT < 22) {
            return slots;
        }

        int defaultDataSubscriptionId = safeDefaultDataSubscriptionId();
        int defaultSmsSubscriptionId = safeDefaultSmsSubscriptionId();
        int defaultVoiceSubscriptionId = safeDefaultVoiceSubscriptionId();

        List<SubscriptionInfo> subscriptions = null;
        if (subscriptionManager != null && hasPhoneStatePermission()) {
            try {
                subscriptions = subscriptionManager.getActiveSubscriptionInfoList();
            } catch (SecurityException ignored) {
                subscriptions = null;
            } catch (RuntimeException ignored) {
                subscriptions = null;
            }
        }

        if (subscriptions != null && !subscriptions.isEmpty()) {
            for (SubscriptionInfo info : subscriptions) {
                if (info == null) {
                    continue;
                }
                int slotIndex = Math.max(0, info.getSimSlotIndex());
                int subscriptionId = info.getSubscriptionId();
                TelephonyManager slotTelephony = createTelephonyManagerForSubscription(telephonyManager, subscriptionId);
                int simState = safeSimState(telephonyManager, slotIndex);
                boolean ready = simState == TelephonyManager.SIM_STATE_READY;
                boolean smsPreferred = subscriptionId == defaultSmsSubscriptionId;
                boolean dataPreferred = subscriptionId == defaultDataSubscriptionId;
                boolean voicePreferred = subscriptionId == defaultVoiceSubscriptionId;
                String carrierName = firstNonEmpty(
                        safeCharSequence(info.getCarrierName()),
                        safeOperatorName(slotTelephony),
                        (dataPreferred || smsPreferred || voicePreferred) ? fallbackOperatorName : ""
                );
                String displayName = firstNonEmpty(
                        safeCharSequence(info.getDisplayName()),
                        carrierName,
                        "SIM " + (slotIndex + 1)
                );
                String number = resolveSubscriptionNumber(info, slotTelephony);
                Integer signalAsu = safeSignalAsu(slotTelephony);
                String networkType = mapNetworkTypeLabel(safeDataNetworkType(slotTelephony));
                boolean registered = ready && (dataPreferred || smsPreferred || voicePreferred || hasCarrierName(carrierName) || fallbackRegistered);

                slots.add(new SimSlotSnapshot(
                        slotIndex,
                        subscriptionId,
                        displayName,
                        carrierName,
                        number,
                        networkType,
                        signalAsu != null ? signalAsu : ((dataPreferred || smsPreferred || voicePreferred) ? fallbackSignalAsu : null),
                        ready,
                        registered,
                        safeNetworkRoaming(slotTelephony),
                        smsPreferred,
                        dataPreferred,
                        voicePreferred,
                        firstNonEmpty(safeCountryIso(slotTelephony), safeCountryIso(telephonyManager)),
                        dataPreferred ? fallbackDataIp : ""
                ));
            }
        }

        if (!slots.isEmpty()) {
            return slots;
        }

        int slotCount = inferSimSlotCount(telephonyManager);
        if (slotCount <= 0) {
            slotCount = 1;
        }

        for (int slotIndex = 0; slotIndex < slotCount; slotIndex++) {
            boolean primarySlot = slotIndex == 0;
            int simState = safeSimState(telephonyManager, slotIndex);
            boolean ready = simState == TelephonyManager.SIM_STATE_READY;
            boolean registered = primarySlot ? fallbackRegistered : ready;
            String number = primarySlot ? safeLine1Number(telephonyManager) : "";

            slots.add(new SimSlotSnapshot(
                    slotIndex,
                    null,
                    "SIM " + (slotIndex + 1),
                    primarySlot ? fallbackOperatorName : "",
                    number,
                    primarySlot ? fallbackNetworkType : "Unknown",
                    primarySlot ? fallbackSignalAsu : null,
                    ready,
                    registered,
                    safeNetworkRoaming(telephonyManager),
                    primarySlot,
                    primarySlot,
                    primarySlot,
                    safeCountryIso(telephonyManager),
                    primarySlot ? fallbackDataIp : ""
            ));
        }

        return slots;
    }

    private static int resolveActiveSimSlotIndex(List<SimSlotSnapshot> slots) {
        if (slots == null || slots.isEmpty()) {
            return -1;
        }
        for (SimSlotSnapshot slot : slots) {
            if (slot != null && slot.smsPreferred) {
                return slot.slotIndex;
            }
        }
        for (SimSlotSnapshot slot : slots) {
            if (slot != null && slot.dataPreferred) {
                return slot.slotIndex;
            }
        }
        return slots.get(0).slotIndex;
    }

    private boolean hasPhoneStatePermission() {
        return checkSelfPermission(Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasCallLogPermission() {
        return checkSelfPermission(Manifest.permission.READ_CALL_LOG) == PackageManager.PERMISSION_GRANTED;
    }

    private static boolean hasPermission(Context context, String permission) {
        return context != null
                && (Build.VERSION.SDK_INT < 23
                || context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED);
    }

    private static boolean samePhoneNumber(String left, String right) {
        return normalizePhoneNumber(left).equals(normalizePhoneNumber(right));
    }

    private static String normalizePhoneNumber(String value) {
        if (value == null || value.trim().isEmpty()) {
            return "";
        }
        String normalized = value.replaceAll("[^0-9+]", "");
        if (normalized.startsWith("00")) {
            normalized = "+" + normalized.substring(2);
        }
        return normalized;
    }

    private boolean hasPhoneNumbersPermission() {
        return Build.VERSION.SDK_INT < 26
                || checkSelfPermission(Manifest.permission.READ_PHONE_NUMBERS) == PackageManager.PERMISSION_GRANTED
                || hasPhoneStatePermission();
    }

    private static Integer normalizeSubscriptionId(Integer preferredSubscriptionId) {
        if (preferredSubscriptionId == null) {
            return null;
        }
        int value = preferredSubscriptionId;
        return value >= 0 ? value : null;
    }

    private Integer resolveSubscriptionIdForSlot(Integer preferredSimSlot) {
        if (preferredSimSlot == null || preferredSimSlot < 0 || Build.VERSION.SDK_INT < 22 || !hasPhoneStatePermission()) {
            return null;
        }
        try {
            SubscriptionManager subscriptionManager = getSystemService(SubscriptionManager.class);
            if (subscriptionManager == null) {
                return null;
            }
            List<SubscriptionInfo> subscriptions = subscriptionManager.getActiveSubscriptionInfoList();
            if (subscriptions == null) {
                return null;
            }
            for (SubscriptionInfo info : subscriptions) {
                if (info != null && info.getSimSlotIndex() == preferredSimSlot) {
                    return info.getSubscriptionId();
                }
            }
        } catch (SecurityException ignored) {
            return null;
        } catch (RuntimeException ignored) {
            return null;
        }
        return null;
    }

    private Integer resolveSimSlotForSubscription(Integer subscriptionId) {
        if (subscriptionId == null || subscriptionId < 0 || Build.VERSION.SDK_INT < 22 || !hasPhoneStatePermission()) {
            return null;
        }
        try {
            SubscriptionManager subscriptionManager = getSystemService(SubscriptionManager.class);
            if (subscriptionManager == null) {
                return null;
            }
            List<SubscriptionInfo> subscriptions = subscriptionManager.getActiveSubscriptionInfoList();
            if (subscriptions == null) {
                return null;
            }
            for (SubscriptionInfo info : subscriptions) {
                if (info != null && info.getSubscriptionId() == subscriptionId) {
                    return info.getSimSlotIndex();
                }
            }
        } catch (SecurityException ignored) {
            return null;
        } catch (RuntimeException ignored) {
            return null;
        }
        return null;
    }

    private void applyPreferredCallRoute(Intent callIntent, Bundle telecomExtras, Integer simSlot, Integer subscriptionId) {
        if (callIntent == null) {
            return;
        }
        if (subscriptionId != null) {
            callIntent.putExtra("subscription", subscriptionId);
            callIntent.putExtra("Subscription", subscriptionId);
            callIntent.putExtra("subscription_id", subscriptionId);
            callIntent.putExtra("com.android.phone.extra.subscription", subscriptionId);
            callIntent.putExtra("phone", subscriptionId);
            telecomExtras.putInt("subscription", subscriptionId);
            telecomExtras.putInt("subscription_id", subscriptionId);
        }
        if (simSlot != null) {
            callIntent.putExtra("slot", simSlot);
            callIntent.putExtra("simSlot", simSlot);
            callIntent.putExtra("com.android.phone.extra.slot", simSlot);
            callIntent.putExtra("com.android.phone.force.slot", true);
            telecomExtras.putInt("slot", simSlot);
            telecomExtras.putInt("simSlot", simSlot);
        }
        PhoneAccountHandle phoneAccountHandle = resolvePhoneAccountHandleForSubscription(subscriptionId);
        if (phoneAccountHandle != null && Build.VERSION.SDK_INT >= 23) {
            callIntent.putExtra(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, phoneAccountHandle);
            telecomExtras.putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, phoneAccountHandle);
        }
    }

    private PhoneAccountHandle resolvePhoneAccountHandleForSubscription(Integer subscriptionId) {
        if (subscriptionId == null || subscriptionId < 0 || Build.VERSION.SDK_INT < 23) {
            return null;
        }
        TelecomManager telecomManager = getSystemService(TelecomManager.class);
        TelephonyManager telephonyManager = getSystemService(TelephonyManager.class);
        if (telecomManager == null || telephonyManager == null) {
            return null;
        }
        java.lang.reflect.Method getSubscriptionIdMethod;
        try {
            getSubscriptionIdMethod = TelephonyManager.class.getMethod("getSubscriptionId", PhoneAccountHandle.class);
        } catch (NoSuchMethodException ignored) {
            return null;
        }
        try {
            List<PhoneAccountHandle> accounts = telecomManager.getCallCapablePhoneAccounts();
            if (accounts == null) {
                return null;
            }
            for (PhoneAccountHandle account : accounts) {
                if (account == null) {
                    continue;
                }
                Object value = getSubscriptionIdMethod.invoke(telephonyManager, account);
                if (value instanceof Integer && ((Integer) value) == subscriptionId) {
                    return account;
                }
            }
        } catch (ReflectiveOperationException ignored) {
            return null;
        } catch (SecurityException ignored) {
            return null;
        } catch (RuntimeException ignored) {
            return null;
        }
        return null;
    }

    private static String mapUssdFailure(int failureCode) {
        switch (failureCode) {
            case TelephonyManager.USSD_RETURN_FAILURE:
                return "ussd_return_failure";
            case TelephonyManager.USSD_ERROR_SERVICE_UNAVAIL:
                return "ussd_service_unavailable";
            default:
                return "ussd_failed_" + failureCode;
        }
    }

    private static TelephonyManager createTelephonyManagerForSubscription(TelephonyManager telephonyManager, int subscriptionId) {
        if (telephonyManager == null || Build.VERSION.SDK_INT < 24 || subscriptionId < 0) {
            return telephonyManager;
        }
        try {
            return telephonyManager.createForSubscriptionId(subscriptionId);
        } catch (RuntimeException ignored) {
            return telephonyManager;
        }
    }

    private static String safeCountryIso(TelephonyManager telephonyManager) {
        if (telephonyManager == null) {
            return "";
        }
        try {
            String value = telephonyManager.getNetworkCountryIso();
            return value == null ? "" : value.trim().toUpperCase(Locale.US);
        } catch (SecurityException ignored) {
            return "";
        } catch (RuntimeException ignored) {
            return "";
        }
    }

    private static boolean safeNetworkRoaming(TelephonyManager telephonyManager) {
        if (telephonyManager == null) {
            return false;
        }
        try {
            return telephonyManager.isNetworkRoaming();
        } catch (SecurityException ignored) {
            return false;
        } catch (RuntimeException ignored) {
            return false;
        }
    }

    private static int safeDataNetworkType(TelephonyManager telephonyManager) {
        if (telephonyManager == null) {
            return TelephonyManager.NETWORK_TYPE_UNKNOWN;
        }
        try {
            return telephonyManager.getDataNetworkType();
        } catch (SecurityException ignored) {
            return TelephonyManager.NETWORK_TYPE_UNKNOWN;
        } catch (RuntimeException ignored) {
            return TelephonyManager.NETWORK_TYPE_UNKNOWN;
        }
    }

    private static int inferSimSlotCount(TelephonyManager telephonyManager) {
        if (telephonyManager == null) {
            return 0;
        }
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                int modemCount = telephonyManager.getActiveModemCount();
                if (modemCount > 0) {
                    return modemCount;
                }
            }
        } catch (RuntimeException ignored) {
        }
        try {
            if (Build.VERSION.SDK_INT >= 23) {
                int phoneCount = telephonyManager.getPhoneCount();
                if (phoneCount > 0) {
                    return phoneCount;
                }
            }
        } catch (RuntimeException ignored) {
        }
        return 1;
    }

    private static int safeSimState(TelephonyManager telephonyManager, int slotIndex) {
        if (telephonyManager == null) {
            return TelephonyManager.SIM_STATE_UNKNOWN;
        }
        try {
            if (Build.VERSION.SDK_INT >= 26 && slotIndex >= 0) {
                return telephonyManager.getSimState(slotIndex);
            }
        } catch (RuntimeException ignored) {
        }
        try {
            return telephonyManager.getSimState();
        } catch (RuntimeException ignored) {
            return TelephonyManager.SIM_STATE_UNKNOWN;
        }
    }

    private static int safeDefaultDataSubscriptionId() {
        if (Build.VERSION.SDK_INT < 24) {
            return -1;
        }
        try {
            return SubscriptionManager.getDefaultDataSubscriptionId();
        } catch (RuntimeException ignored) {
            return -1;
        }
    }

    private static int safeDefaultSmsSubscriptionId() {
        if (Build.VERSION.SDK_INT < 22) {
            return -1;
        }
        try {
            return SubscriptionManager.getDefaultSmsSubscriptionId();
        } catch (RuntimeException ignored) {
            return -1;
        }
    }

    private static int safeDefaultVoiceSubscriptionId() {
        if (Build.VERSION.SDK_INT < 24) {
            return -1;
        }
        try {
            return SubscriptionManager.getDefaultVoiceSubscriptionId();
        } catch (RuntimeException ignored) {
            return -1;
        }
    }

    private static String safeCharSequence(CharSequence value) {
        return value == null ? "" : value.toString().trim();
    }

    private String resolveSubscriptionNumber(SubscriptionInfo info, TelephonyManager telephonyManager) {
        String number = "";
        try {
            number = safeCharSequence(info == null ? null : info.getNumber());
        } catch (RuntimeException ignored) {
            number = "";
        }
        if (!number.isEmpty()) {
            return number;
        }
        if (!hasPhoneNumbersPermission()) {
            return "";
        }
        return safeLine1Number(telephonyManager);
    }

    private static String safeLine1Number(TelephonyManager telephonyManager) {
        if (telephonyManager == null) {
            return "";
        }
        try {
            String value = telephonyManager.getLine1Number();
            return value == null ? "" : value.trim();
        } catch (SecurityException ignored) {
            return "";
        } catch (RuntimeException ignored) {
            return "";
        }
    }

    private static JSONArray simSlotsJson(List<SimSlotSnapshot> slots) throws JSONException {
        JSONArray array = new JSONArray();
        if (slots == null) {
            return array;
        }
        for (SimSlotSnapshot slot : slots) {
            if (slot == null) {
                continue;
            }
            JSONObject item = new JSONObject();
            item.put("slotIndex", slot.slotIndex);
            if (slot.subscriptionId != null) {
                item.put("subscriptionId", slot.subscriptionId);
            }
            item.put("displayName", slot.displayName);
            item.put("carrierName", slot.carrierName);
            if (!slot.number.isEmpty()) {
                item.put("number", slot.number);
                item.put("subscriberNumber", slot.number);
            }
            item.put("networkType", slot.networkType);
            if (slot.signalAsu != null) {
                item.put("signalAsu", slot.signalAsu);
            }
            item.put("ready", slot.ready);
            item.put("registered", slot.registered);
            item.put("roaming", slot.roaming);
            item.put("smsPreferred", slot.smsPreferred);
            item.put("dataPreferred", slot.dataPreferred);
            item.put("voicePreferred", slot.voicePreferred);
            if (!slot.countryIso.isEmpty()) {
                item.put("countryIso", slot.countryIso);
            }
            if (!slot.dataIp.isEmpty()) {
                item.put("dataIp", slot.dataIp);
            }
            array.put(item);
        }
        return array;
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < 26) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Device Bridge",
                NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Keeps the Device Bridge MQTT service running.");
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.createNotificationChannel(channel);
        }
    }

    private void startForegroundCompat() {
        Intent openIntent = new Intent(this, MainActivity.class);
        PendingIntent contentIntent = PendingIntent.getActivity(
                this,
                0,
                openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | immutableFlag()
        );

        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        Notification notification = buildBridgeNotification(builder, "Connectivity", "Connecting", contentIntent);

        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private Notification buildBridgeNotification(Notification.Builder builder, String title, String text, PendingIntent contentIntent) {
        return builder
                .setSmallIcon(R.drawable.ic_stat_bridge)
                .setContentTitle(title)
                .setContentText(text)
                .setContentIntent(contentIntent)
                .setOngoing(true)
                .build();
    }

    private void updateBridgeNotification(String title, String text) {
        Intent openIntent = new Intent(this, MainActivity.class);
        PendingIntent contentIntent = PendingIntent.getActivity(
                this,
                0,
                openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | immutableFlag()
        );
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.notify(NOTIFICATION_ID, buildBridgeNotification(
                    builder,
                    "Connectivity",
                    notificationConnectionStatus(title, text),
                    contentIntent
            ));
        }
    }

    private static String notificationConnectionStatus(String title, String text) {
        String combined = ((title == null ? "" : title) + " " + (text == null ? "" : text)).toLowerCase(Locale.US);
        if (combined.contains("online") || combined.contains("connected")) {
            return "Connected";
        }
        if (combined.contains("connect") || combined.contains("retry") || combined.contains("reconnect") || combined.contains("starting")) {
            return "Connecting";
        }
        return "Disconnected";
    }

    static int immutableFlag() {
        return Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0;
    }

    private void scheduleReconnect() {
        if (stopRequested || executor.isShutdown() || !currentConfig().bridgeEnabled) {
            return;
        }
        ScheduledFuture<?> currentFuture = reconnectFuture;
        if (currentFuture != null && !currentFuture.isDone()) {
            return;
        }
        reconnectFuture = executor.schedule(this::connectInternal, RECONNECT_DELAY_SECONDS, TimeUnit.SECONDS);
        logTelemetry("Reconnect scheduled in " + RECONNECT_DELAY_SECONDS + "s");
        updateBridgeNotification("Device Bridge reconnecting", "Retrying in " + RECONNECT_DELAY_SECONDS + "s");
        updateRuntimeState("reconnecting", false, currentTransportUsesHttp()
                ? "Retrying HTTP in " + RECONNECT_DELAY_SECONDS + "s"
                : "Retrying MQTT in " + RECONNECT_DELAY_SECONDS + "s");
    }

    private void cancelReconnect() {
        ScheduledFuture<?> currentFuture = reconnectFuture;
        if (currentFuture != null) {
            currentFuture.cancel(false);
            reconnectFuture = null;
        }
    }

    private void scheduleStatusHeartbeat() {
        cancelStatusHeartbeat();
        statusHeartbeatFuture = executor.scheduleWithFixedDelay(
                this::runStatusHeartbeatSafely,
                STATUS_HEARTBEAT_INTERVAL_SECONDS,
                STATUS_HEARTBEAT_INTERVAL_SECONDS,
                TimeUnit.SECONDS
        );
    }

    private void cancelStatusHeartbeat() {
        ScheduledFuture<?> currentFuture = statusHeartbeatFuture;
        if (currentFuture != null) {
            currentFuture.cancel(false);
            statusHeartbeatFuture = null;
        }
    }

    private void scheduleOutstandingPoll() {
        if (!currentTransportUsesHttp()) {
            cancelOutstandingPoll();
            return;
        }
        ScheduledFuture<?> currentFuture = outstandingPollFuture;
        if (currentFuture != null && !currentFuture.isDone()) {
            return;
        }
        outstandingPollFuture = executor.scheduleWithFixedDelay(
                this::runOutstandingPollSafely,
                5,
                HTTP_OUTSTANDING_POLL_INTERVAL_SECONDS,
                TimeUnit.SECONDS
        );
    }

    private void cancelOutstandingPoll() {
        ScheduledFuture<?> currentFuture = outstandingPollFuture;
        if (currentFuture != null) {
            currentFuture.cancel(false);
            outstandingPollFuture = null;
        }
    }

    private void postHttpStatus(JSONObject payload) {
        logTelemetry("Sending HTTP status :: payload=" + fullJson(payload));
        httpHandler.postStatusAsync(payload);
    }

    private void postHttpIncomingSms(JSONObject payload) {
        logConsoleEvent("sms", "Device sent HTTP SMS :: payload=" + fullJson(payload));
        httpHandler.postIncomingSmsAsync(payload);
    }

    private void postHttpMessageEvent(String actionId, String eventName, String detail, String number) {
        logConsoleEvent("sms", "Device sent HTTP message event: " + eventName
                + " :: payload=action_id=" + (actionId == null ? "" : actionId)
                + ", number=" + (number == null ? "" : number)
                + ", detail=" + fullText(detail));
        httpHandler.postMessageEventAsync(actionId, eventName, detail, number);
    }

    private void pollOutstandingHttpMessages() {
        httpHandler.pollOutstandingMessages();
    }

    private void runStatusHeartbeatSafely() {
        try {
            publishStatus("online");
        } catch (RuntimeException error) {
            recordHttpFailure("HTTP heartbeat crashed", detailForError(error, "status heartbeat crashed"));
        }
    }

    private void runOutstandingPollSafely() {
        try {
            pollOutstandingHttpMessages();
        } catch (RuntimeException error) {
            recordHttpFailure("HTTP outstanding poll crashed", detailForError(error, "outstanding poll crashed"));
        }
    }

    private void maybeScheduleHttpRecovery(String detail) {
        long now = System.currentTimeMillis();
        if ((now - lastHttpRecoveryAttemptAtMs) < TimeUnit.SECONDS.toMillis(20)) {
            return;
        }
        lastHttpRecoveryAttemptAtMs = now;
        logTelemetry("HTTP recovery scheduled: " + fullText(detail));
        scheduleReconnect();
    }

    private StatusSnapshot captureStatusSnapshot(String state, boolean refreshDetailed) {
        ConnectivityManager connectivityManager = getSystemService(ConnectivityManager.class);
        WifiManager wifiManager = getApplicationContext().getSystemService(WifiManager.class);
        TelephonyManager telephonyManager = getSystemService(TelephonyManager.class);
        SubscriptionManager subscriptionManager = Build.VERSION.SDK_INT >= 22 ? getSystemService(SubscriptionManager.class) : null;
        ActivityManager activityManager = getSystemService(ActivityManager.class);

        Network activeNetwork = connectivityManager == null ? null : connectivityManager.getActiveNetwork();
        NetworkCapabilities capabilities = (connectivityManager == null || activeNetwork == null)
                ? null
                : connectivityManager.getNetworkCapabilities(activeNetwork);
        LinkProperties linkProperties = (connectivityManager == null || activeNetwork == null)
                ? null
                : connectivityManager.getLinkProperties(activeNetwork);

        boolean wifiTransport = capabilities != null && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI);
        boolean cellularTransport = capabilities != null && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR);
        String activePath = wifiTransport ? "wifi" : (cellularTransport ? "modem" : ("online".equals(state) ? "modem" : "offline"));

        boolean wifiEnabled = wifiManager != null && wifiManager.isWifiEnabled();
        String activeIpAddress = firstIpv4Address(linkProperties);
        WifiInfo wifiInfo = null;
        if (hasWifiDetailPermission()) {
            if (Build.VERSION.SDK_INT >= 29 && capabilities != null) {
                Object transportInfo = capabilities.getTransportInfo();
                if (transportInfo instanceof WifiInfo) {
                    wifiInfo = (WifiInfo) transportInfo;
                }
            }
        }
        if (wifiInfo == null && wifiManager != null && hasWifiDetailPermission()) {
            try {
                wifiInfo = wifiManager.getConnectionInfo();
            } catch (SecurityException ignored) {
                wifiInfo = null;
            } catch (RuntimeException ignored) {
                wifiInfo = null;
            }
        }
        String rawWifiSsid = wifiInfo == null ? "" : normalizeWifiSsid(wifiInfo.getSSID());
        boolean wifiConnected = wifiTransport
                || !rawWifiSsid.isEmpty()
                || (wifiInfo != null && wifiInfo.getNetworkId() != -1);
        String wifiSsid = rawWifiSsid;
        Integer wifiRssi = (wifiInfo != null && wifiInfo.getNetworkId() != -1) ? wifiInfo.getRssi() : null;
        String wifiIpAddress = wifiTransport ? activeIpAddress : "";
        String cellularIpAddress = cellularTransport ? activeIpAddress : "";

        boolean telephonySupported = telephonyManager != null
                && telephonyManager.getPhoneType() != TelephonyManager.PHONE_TYPE_NONE;
        boolean telephonyEnabled = telephonySupported
                && (checkSelfPermission(Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED);
        String operatorName = telephonySupported ? safeOperatorName(telephonyManager) : "";
        String networkType = telephonySupported ? mapNetworkTypeLabel(safeDataNetworkType(telephonyManager)) : "Unknown";
        Integer modemSignalAsu = telephonySupported ? safeSignalAsu(telephonyManager) : null;
        boolean modemRegistered = telephonySupported && (cellularTransport || hasCarrierName(operatorName));
        DeviceIdentitySnapshot deviceIdentity = cachedDeviceIdentity;
        List<SimSlotSnapshot> simSlots = cachedSimSlots;
        if (refreshDetailed || deviceIdentity == null) {
            deviceIdentity = captureDeviceIdentity(telephonyManager);
            simSlots = captureSimSlots(
                    subscriptionManager,
                    telephonyManager,
                    telephonySupported,
                    operatorName,
                    networkType,
                    modemSignalAsu,
                    modemRegistered,
                    cellularIpAddress
            );
            cachedDeviceIdentity = deviceIdentity;
            cachedSimSlots = new ArrayList<>(simSlots);
            lastDetailedStatusAtMs = System.currentTimeMillis();
            detailedStatusPending = false;
        } else if (simSlots == null) {
            simSlots = new ArrayList<>();
        }
        int activeSimSlotIndex = resolveActiveSimSlotIndex(simSlots);

        Intent batteryStatus = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        Integer batteryLevel = null;
        Boolean charging = null;
        Double temperatureC = null;
        Integer voltageMv = null;
        if (batteryStatus != null) {
            int level = batteryStatus.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
            int scale = batteryStatus.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
            if (level >= 0 && scale > 0) {
                batteryLevel = Math.round((level * 100f) / scale);
            }
            int batteryStatusValue = batteryStatus.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
            charging = batteryStatusValue == BatteryManager.BATTERY_STATUS_CHARGING
                    || batteryStatusValue == BatteryManager.BATTERY_STATUS_FULL;
            int tempTenths = batteryStatus.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Integer.MIN_VALUE);
            if (tempTenths != Integer.MIN_VALUE) {
                temperatureC = tempTenths / 10.0d;
            }
            int voltage = batteryStatus.getIntExtra(BatteryManager.EXTRA_VOLTAGE, -1);
            if (voltage > 0) {
                voltageMv = voltage;
            }
        }

        long totalBytes = 0L;
        long freeBytes = 0L;
        long usedBytes = 0L;
        boolean storageAvailable = false;
        try {
            StatFs statFs = new StatFs(getFilesDir().getAbsolutePath());
            totalBytes = statFs.getTotalBytes();
            freeBytes = statFs.getAvailableBytes();
            usedBytes = Math.max(0L, totalBytes - freeBytes);
            storageAvailable = totalBytes > 0L;
        } catch (IllegalArgumentException ignored) {
        }

        long availableMemory = 0L;
        if (activityManager != null) {
            ActivityManager.MemoryInfo info = new ActivityManager.MemoryInfo();
            activityManager.getMemoryInfo(info);
            availableMemory = info.availMem;
        }

        return new StatusSnapshot(
                state,
                activePath,
                client != null && client.isConnected(),
                commandSubscriptionsReady,
                publishSuccessCount,
                publishFailureCount,
                pendingPublishes.size(),
                storageAvailable,
                totalBytes,
                usedBytes,
                freeBytes,
                "Internal Storage",
                "Internal",
                batteryLevel,
                charging,
                temperatureC,
                voltageMv,
                SystemClock.elapsedRealtime(),
                Math.max(0L, SystemClock.elapsedRealtime() / 1000L),
                availableMemory,
                checkSelfPermission(Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED,
                checkSelfPermission(Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED,
                checkSelfPermission(Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED,
                notificationPermissionGranted(),
                telephonySupported,
                telephonyEnabled,
                cellularTransport,
                modemRegistered,
                cellularTransport,
                !cellularIpAddress.isEmpty(),
                operatorName,
                networkType,
                modemSignalAsu,
                wifiEnabled,
                wifiConnected,
                wifiSsid,
                wifiIpAddress,
                wifiRssi,
                cellularIpAddress,
                deviceIdentity.manufacturer,
                deviceIdentity.brand,
                deviceIdentity.model,
                deviceIdentity.deviceName,
                deviceIdentity.androidId,
                deviceIdentity.installId,
                deviceIdentity.imei,
                simSlots,
                activeSimSlotIndex
        );
    }

    private boolean notificationPermissionGranted() {
        return Build.VERSION.SDK_INT < 33
                || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasWifiDetailPermission() {
        if (Build.VERSION.SDK_INT >= 33) {
            return checkSelfPermission(Manifest.permission.NEARBY_WIFI_DEVICES) == PackageManager.PERMISSION_GRANTED;
        }
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private static String normalizeWifiSsid(String ssid) {
        if (ssid == null) {
            return "";
        }
        String cleaned = ssid.trim();
        if (cleaned.startsWith("\"") && cleaned.endsWith("\"") && cleaned.length() >= 2) {
            cleaned = cleaned.substring(1, cleaned.length() - 1);
        }
        if ("<unknown ssid>".equalsIgnoreCase(cleaned)) {
            return "";
        }
        return cleaned;
    }

    private static String describeWifiEncryption(String capabilities) {
        String value = capabilities == null ? "" : capabilities.toUpperCase(Locale.US);
        if (value.contains("SAE") && value.contains("PSK")) {
            return "WPA2/WPA3-PSK";
        }
        if (value.contains("SAE")) {
            return "WPA3-SAE";
        }
        if (value.contains("PSK")) {
            return "WPA2-PSK";
        }
        if (value.contains("EAP")) {
            return "WPA-EAP";
        }
        if (value.contains("WEP")) {
            return "WEP";
        }
        if (value.contains("OWE")) {
            return "OWE";
        }
        return "open";
    }

    private static int wifiChannelForFrequency(int frequency) {
        if (frequency >= 2412 && frequency <= 2484) {
            return frequency == 2484 ? 14 : ((frequency - 2412) / 5) + 1;
        }
        if (frequency >= 5000 && frequency <= 5895) {
            return (frequency - 5000) / 5;
        }
        if (frequency >= 5955 && frequency <= 7115) {
            return (frequency - 5950) / 5;
        }
        return 0;
    }

    private static String firstIpv4Address(LinkProperties properties) {
        if (properties == null) {
            return "";
        }
        for (LinkAddress address : properties.getLinkAddresses()) {
            if (address == null || address.getAddress() == null) {
                continue;
            }
            String host = address.getAddress().getHostAddress();
            if (host != null && host.contains(".") && !host.startsWith("127.")) {
                return host;
            }
        }
        return "";
    }

    private static boolean hasCarrierName(String operatorName) {
        return operatorName != null
                && !operatorName.trim().isEmpty()
                && !"unknown".equalsIgnoreCase(operatorName.trim());
    }

    private static String safeOperatorName(TelephonyManager telephonyManager) {
        try {
            String value = telephonyManager.getNetworkOperatorName();
            return value == null ? "" : value.trim();
        } catch (SecurityException ignored) {
            return "";
        }
    }

    private static Integer safeSignalAsu(TelephonyManager telephonyManager) {
        if (Build.VERSION.SDK_INT < 28) {
            return null;
        }
        try {
            SignalStrength signalStrength = telephonyManager.getSignalStrength();
            if (signalStrength == null) {
                return null;
            }
            int asu = signalStrength.getGsmSignalStrength();
            if (asu < 0 || asu == 99) {
                return null;
            }
            return asu;
        } catch (SecurityException ignored) {
            return null;
        }
    }

    private static String mapNetworkTypeLabel(int networkType) {
        switch (networkType) {
            case TelephonyManager.NETWORK_TYPE_GPRS:
            case TelephonyManager.NETWORK_TYPE_EDGE:
            case TelephonyManager.NETWORK_TYPE_CDMA:
            case TelephonyManager.NETWORK_TYPE_1xRTT:
            case TelephonyManager.NETWORK_TYPE_IDEN:
            case TelephonyManager.NETWORK_TYPE_GSM:
                return "2G";
            case TelephonyManager.NETWORK_TYPE_UMTS:
            case TelephonyManager.NETWORK_TYPE_EVDO_0:
            case TelephonyManager.NETWORK_TYPE_EVDO_A:
            case TelephonyManager.NETWORK_TYPE_HSDPA:
            case TelephonyManager.NETWORK_TYPE_HSUPA:
            case TelephonyManager.NETWORK_TYPE_HSPA:
            case TelephonyManager.NETWORK_TYPE_EVDO_B:
            case TelephonyManager.NETWORK_TYPE_EHRPD:
            case TelephonyManager.NETWORK_TYPE_HSPAP:
            case TelephonyManager.NETWORK_TYPE_TD_SCDMA:
                return "3G";
            case TelephonyManager.NETWORK_TYPE_LTE:
            case TelephonyManager.NETWORK_TYPE_IWLAN:
                return "4G/LTE";
            case TelephonyManager.NETWORK_TYPE_NR:
                return "5G";
            case TelephonyManager.NETWORK_TYPE_UNKNOWN:
            default:
                return "Unknown";
        }
    }

    private void closeClientQuietly() {
        try {
            MqttClient current = client;
            if (current != null) {
                if (current.isConnected()) {
                    current.disconnectForcibly(500, 500);
                }
                current.close();
            }
        } catch (MqttException ignored) {
        } finally {
            client = null;
        }
    }

    private void updateRuntimeState(String serviceState, boolean mqttConnected, String detail) {
        BridgeRuntimeState.saveSnapshot(
                this,
                serviceState,
                mqttConnected,
                detail,
                publishSuccessCount,
                publishFailureCount,
                pendingPublishes.size(),
                lastStatusPushAtMs,
                lastQueuePollAtMs,
                lastMessageEventAtMs,
                lastIncomingSyncAtMs,
                lastSendAcceptedAtMs
        );
    }

    private void persistRuntimeTelemetry() {
        BridgeRuntimeState current = BridgeRuntimeState.load(this);
        BridgeRuntimeState.saveSnapshot(
                this,
                current.serviceState,
                current.mqttConnected,
                current.detail,
                publishSuccessCount,
                publishFailureCount,
                pendingPublishes.size(),
                lastStatusPushAtMs,
                lastQueuePollAtMs,
                lastMessageEventAtMs,
                lastIncomingSyncAtMs,
                lastSendAcceptedAtMs
        );
    }

    private void hydrateRuntimeTelemetry() {
        BridgeRuntimeState runtime = BridgeRuntimeState.load(this);
        publishSuccessCount = runtime.publishSuccessCount;
        publishFailureCount = runtime.publishFailureCount;
        lastStatusPushAtMs = runtime.lastStatusPushAtMs;
        lastQueuePollAtMs = runtime.lastQueuePollAtMs;
        lastMessageEventAtMs = runtime.lastMessageEventAtMs;
        lastIncomingSyncAtMs = runtime.lastIncomingSyncAtMs;
        lastSendAcceptedAtMs = runtime.lastSendAcceptedAtMs;
    }

    private void recordPublishSuccess(String topic) {
        long now = System.currentTimeMillis();
        if (topic != null) {
            if (topic.contains("/status")) {
                lastStatusPushAtMs = now;
            } else if (topic.contains("/sms/incoming")) {
                lastIncomingSyncAtMs = now;
            } else if (topic.contains("/action/result") || topic.contains("/sms/delivered")) {
                lastMessageEventAtMs = now;
            }
        }
        persistRuntimeTelemetry();
    }

    private static String detailForError(Throwable error, String fallback) {
        if (error == null || error.getMessage() == null || error.getMessage().trim().isEmpty()) {
            return fallback;
        }
        return error.getMessage().trim();
    }

    private static String compactTopic(String topic) {
        if (topic == null || topic.trim().isEmpty()) {
            return "unknown";
        }
        String[] parts = topic.trim().split("/");
        if (parts.length <= 2) {
            return topic.trim();
        }
        return parts[parts.length - 2] + "/" + parts[parts.length - 1];
    }

    private static String fullJson(JSONObject json) {
        return fullText(json == null ? "" : json.toString());
    }

    private static String fullText(String value) {
        if (value == null) {
            return "";
        }
        return value.replace('\n', ' ').replace('\r', ' ').trim();
    }

    private static final class DeviceIdentitySnapshot {
        final String manufacturer;
        final String brand;
        final String model;
        final String deviceName;
        final String androidId;
        final String installId;
        final String imei;

        DeviceIdentitySnapshot(String manufacturer, String brand, String model, String deviceName, String androidId, String installId, String imei) {
            this.manufacturer = manufacturer == null ? "" : manufacturer;
            this.brand = brand == null ? "" : brand;
            this.model = model == null ? "" : model;
            this.deviceName = deviceName == null ? "" : deviceName;
            this.androidId = androidId == null ? "" : androidId;
            this.installId = installId == null ? "" : installId;
            this.imei = imei == null ? "" : imei;
        }
    }

    private static final class SimSlotSnapshot {
        final int slotIndex;
        final Integer subscriptionId;
        final String displayName;
        final String carrierName;
        final String number;
        final String networkType;
        final Integer signalAsu;
        final boolean ready;
        final boolean registered;
        final boolean roaming;
        final boolean smsPreferred;
        final boolean dataPreferred;
        final boolean voicePreferred;
        final String countryIso;
        final String dataIp;

        SimSlotSnapshot(
                int slotIndex,
                Integer subscriptionId,
                String displayName,
                String carrierName,
                String number,
                String networkType,
                Integer signalAsu,
                boolean ready,
                boolean registered,
                boolean roaming,
                boolean smsPreferred,
                boolean dataPreferred,
                boolean voicePreferred,
                String countryIso,
                String dataIp
        ) {
            this.slotIndex = slotIndex;
            this.subscriptionId = subscriptionId;
            this.displayName = displayName == null ? "" : displayName;
            this.carrierName = carrierName == null ? "" : carrierName;
            this.number = number == null ? "" : number;
            this.networkType = networkType == null ? "Unknown" : networkType;
            this.signalAsu = signalAsu;
            this.ready = ready;
            this.registered = registered;
            this.roaming = roaming;
            this.smsPreferred = smsPreferred;
            this.dataPreferred = dataPreferred;
            this.voicePreferred = voicePreferred;
            this.countryIso = countryIso == null ? "" : countryIso;
            this.dataIp = dataIp == null ? "" : dataIp;
        }
    }

    private static final class StatusSnapshot {
        final String state;
        final String activePath;
        final boolean mqttConnected;
        final boolean mqttSubscribed;
        final long mqttPublishedCount;
        final long mqttPublishFailures;
        final int storageQueueDepth;
        final boolean storageMediaAvailable;
        final long storageTotalBytes;
        final long storageUsedBytes;
        final long storageFreeBytes;
        final String storageMediaLabel;
        final String storageMediaType;
        final Integer batteryLevel;
        final Boolean charging;
        final Double temperatureC;
        final Integer voltageMv;
        final long uptimeMs;
        final long uptimeSeconds;
        final long availableMemoryBytes;
        final boolean sendSmsPermission;
        final boolean receiveSmsPermission;
        final boolean callPhonePermission;
        final boolean notificationsPermission;
        final boolean telephonySupported;
        final boolean telephonyEnabled;
        final boolean dataModeEnabled;
        final boolean modemRegistered;
        final boolean cellularActive;
        final boolean cellularIpReady;
        final String operatorName;
        final String networkType;
        final Integer modemSignalAsu;
        final boolean wifiEnabled;
        final boolean wifiConnected;
        final String wifiSsid;
        final String wifiIpAddress;
        final Integer wifiRssi;
        final String cellularIpAddress;
        final boolean cellularConnected;
        final String manufacturer;
        final String brand;
        final String model;
        final String deviceName;
        final String androidId;
        final String installId;
        final String imei;
        final List<SimSlotSnapshot> simSlots;
        final int activeSimSlotIndex;

        StatusSnapshot(
                String state,
                String activePath,
                boolean mqttConnected,
                boolean mqttSubscribed,
                long mqttPublishedCount,
                long mqttPublishFailures,
                int storageQueueDepth,
                boolean storageMediaAvailable,
                long storageTotalBytes,
                long storageUsedBytes,
                long storageFreeBytes,
                String storageMediaLabel,
                String storageMediaType,
                Integer batteryLevel,
                Boolean charging,
                Double temperatureC,
                Integer voltageMv,
                long uptimeMs,
                long uptimeSeconds,
                long availableMemoryBytes,
                boolean sendSmsPermission,
                boolean receiveSmsPermission,
                boolean callPhonePermission,
                boolean notificationsPermission,
                boolean telephonySupported,
                boolean telephonyEnabled,
                boolean dataModeEnabled,
                boolean modemRegistered,
                boolean cellularActive,
                boolean cellularIpReady,
                String operatorName,
                String networkType,
                Integer modemSignalAsu,
                boolean wifiEnabled,
                boolean wifiConnected,
                String wifiSsid,
                String wifiIpAddress,
                Integer wifiRssi,
                String cellularIpAddress,
                String manufacturer,
                String brand,
                String model,
                String deviceName,
                String androidId,
                String installId,
                String imei,
                List<SimSlotSnapshot> simSlots,
                int activeSimSlotIndex
        ) {
            this.state = state;
            this.activePath = activePath;
            this.mqttConnected = mqttConnected;
            this.mqttSubscribed = mqttSubscribed;
            this.mqttPublishedCount = mqttPublishedCount;
            this.mqttPublishFailures = mqttPublishFailures;
            this.storageQueueDepth = storageQueueDepth;
            this.storageMediaAvailable = storageMediaAvailable;
            this.storageTotalBytes = storageTotalBytes;
            this.storageUsedBytes = storageUsedBytes;
            this.storageFreeBytes = storageFreeBytes;
            this.storageMediaLabel = storageMediaLabel;
            this.storageMediaType = storageMediaType;
            this.batteryLevel = batteryLevel;
            this.charging = charging;
            this.temperatureC = temperatureC;
            this.voltageMv = voltageMv;
            this.uptimeMs = uptimeMs;
            this.uptimeSeconds = uptimeSeconds;
            this.availableMemoryBytes = availableMemoryBytes;
            this.sendSmsPermission = sendSmsPermission;
            this.receiveSmsPermission = receiveSmsPermission;
            this.callPhonePermission = callPhonePermission;
            this.notificationsPermission = notificationsPermission;
            this.telephonySupported = telephonySupported;
            this.telephonyEnabled = telephonyEnabled;
            this.dataModeEnabled = dataModeEnabled;
            this.modemRegistered = modemRegistered;
            this.cellularActive = cellularActive;
            this.cellularIpReady = cellularIpReady;
            this.operatorName = operatorName == null ? "" : operatorName;
            this.networkType = networkType == null ? "Unknown" : networkType;
            this.modemSignalAsu = modemSignalAsu;
            this.wifiEnabled = wifiEnabled;
            this.wifiConnected = wifiConnected;
            this.wifiSsid = wifiSsid == null ? "" : wifiSsid;
            this.wifiIpAddress = wifiIpAddress == null ? "" : wifiIpAddress;
            this.wifiRssi = wifiRssi;
            this.cellularIpAddress = cellularIpAddress == null ? "" : cellularIpAddress;
            this.cellularConnected = cellularActive || cellularIpReady;
            this.manufacturer = manufacturer == null ? "" : manufacturer;
            this.brand = brand == null ? "" : brand;
            this.model = model == null ? "" : model;
            this.deviceName = deviceName == null ? "" : deviceName;
            this.androidId = androidId == null ? "" : androidId;
            this.installId = installId == null ? "" : installId;
            this.imei = imei == null ? "" : imei;
            this.simSlots = simSlots == null ? new ArrayList<>() : simSlots;
            this.activeSimSlotIndex = activeSimSlotIndex;
        }
    }

    private interface JsonSender {
        void send(JSONObject payload);
    }

    private static final class CallLogSyncRecord {
        final String name;
        final String number;
        final String direction;
        final String status;
        final long timestamp;
        final int durationSeconds;

        CallLogSyncRecord(String name, String number, String direction, String status, long timestamp, int durationSeconds) {
            this.name = name == null ? "" : name;
            this.number = number == null ? "" : number;
            this.direction = direction == null ? "" : direction;
            this.status = status == null ? "" : status;
            this.timestamp = timestamp;
            this.durationSeconds = Math.max(0, durationSeconds);
        }
    }

    private static final class PendingPublish {
        final String topic;
        final String payload;

        PendingPublish(String topic, String payload) {
            this.topic = topic;
            this.payload = payload;
        }
    }
}


