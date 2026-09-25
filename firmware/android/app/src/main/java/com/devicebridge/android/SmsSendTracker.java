package com.devicebridge.android;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.telephony.SmsManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashSet;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/** Durable, idempotent aggregation of Android multipart SMS callbacks. */
final class SmsSendTracker {
    private static final int MAX_PENDING_STATES = 256;
    private static final int MAX_TERMINAL_KEYS = 512;
    private static final long TOMBSTONE_TTL_MS = TimeUnit.DAYS.toMillis(7);
    private static final String PREFS = BridgeConfig.PREFS;
    private static final String KEY_PENDING = "sms_tracker_pending";
    private static final String KEY_TERMINALS = "sms_tracker_terminals";
    private static final Object LOCK = new Object();
    private static final Map<String, State> STATES = new ConcurrentHashMap<>();
    private static final ScheduledExecutorService TIMEOUTS = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread thread = new Thread(r, "android-sms-timeouts");
        thread.setDaemon(true);
        return thread;
    });

    enum Registration {
        ACCEPTED("sms_queued"),
        DUPLICATE("sms_duplicate_action"),
        FULL("sms_queue_full"),
        INVALID("sms_invalid_action_id"),
        PERSISTENCE_FAILED("sms_tracker_persistence_failed");

        final String detail;

        Registration(String detail) {
            this.detail = detail;
        }
    }

    private SmsSendTracker() {
    }

    static Registration register(Context context, String actionId, String number, int partCount, int timeoutMs) {
        if (context == null || actionId == null || actionId.trim().isEmpty() || partCount <= 0) {
            return Registration.INVALID;
        }
        Context app = context.getApplicationContext();
        String key = key(actionId);
        long now = System.currentTimeMillis();
        synchronized (LOCK) {
            try {
                SharedPreferences prefs = prefs(app);
                JSONObject pending = object(prefs.getString(KEY_PENDING, "{}"));
                JSONObject terminals = object(prefs.getString(KEY_TERMINALS, "{}"));
                pruneExpiredTerminals(terminals, now);

                if (terminals.has(key) || STATES.containsKey(key)) {
                    persistRoots(prefs, pending, terminals);
                    return Registration.DUPLICATE;
                }
                JSONObject persisted = pending.optJSONObject(key);
                if (persisted != null) {
                    State existing = decodeState(app, persisted, actionId, number);
                    if (existing != null && !existing.isExpired(now)) {
                        STATES.put(key, existing);
                        scheduleTimeout(key, existing, now);
                    } else if (existing != null) {
                        makeTerminal(pending, terminals, key, now);
                        persistRoots(prefs, pending, terminals);
                        publishTimeout(existing);
                    }
                    return Registration.DUPLICATE;
                }
                if (pending.length() >= MAX_PENDING_STATES || terminals.length() >= MAX_TERMINAL_KEYS) {
                    persistRoots(prefs, pending, terminals);
                    return Registration.FULL;
                }

                State state = new State(app, actionId.trim(), number, partCount,
                        sanitizeTimeout(timeoutMs), now);
                pending.put(key, encodeState(state));
                if (!persistRoots(prefs, pending, terminals)) {
                    return Registration.PERSISTENCE_FAILED;
                }
                STATES.put(key, state);
                scheduleTimeout(key, state, now);
                return Registration.ACCEPTED;
            } catch (Exception error) {
                return Registration.PERSISTENCE_FAILED;
            }
        }
    }

    /** Restores timeout ownership as soon as the bridge process starts. */
    static void restore(Context context) {
        if (context == null) return;
        Context app = context.getApplicationContext();
        synchronized (LOCK) {
            try {
                SharedPreferences prefs = prefs(app);
                JSONObject pending = object(prefs.getString(KEY_PENDING, "{}"));
                JSONObject terminals = object(prefs.getString(KEY_TERMINALS, "{}"));
                long now = System.currentTimeMillis();
                pruneExpiredTerminals(terminals, now);
                Iterator<String> names = pending.keys();
                Set<String> keys = new HashSet<>();
                while (names.hasNext()) keys.add(names.next());
                for (String key : keys) {
                    State state = decodeState(app, pending.optJSONObject(key), key, "");
                    if (state == null) continue;
                    if (state.isExpired(now)) {
                        makeTerminal(pending, terminals, key, now);
                        publishTimeout(state);
                    } else {
                        STATES.put(key, state);
                        scheduleTimeout(key, state, now);
                    }
                }
                persistRoots(prefs, pending, terminals);
            } catch (Exception ignored) {
                // Corrupt tracker state fails closed: register() will refuse to
                // dispatch until the state can be read instead of resending.
            }
        }
    }

    static void remove(String actionId) {
        String key = key(actionId);
        synchronized (LOCK) {
            State removed = STATES.remove(key);
            Context context = removed == null ? null : removed.context;
            if (context == null) return;
            try {
                SharedPreferences prefs = prefs(context);
                JSONObject pending = object(prefs.getString(KEY_PENDING, "{}"));
                pending.remove(key);
                prefs.edit().putString(KEY_PENDING, pending.toString()).commit();
            } catch (Exception ignored) {
            }
        }
    }

    static void markSent(Context context, String actionId, String number, int resultCode, Bundle extras) {
        markSent(context, actionId, number, -1, resultCode, extras);
    }

    static void markSent(Context context, String actionId, String number, int partIndex, int resultCode, Bundle extras) {
        if (context == null || actionId == null || actionId.trim().isEmpty()) return;
        PublishEvent event = null;
        synchronized (LOCK) {
            String key = key(actionId);
            State state = stateForCallback(context, key, actionId, number);
            if (state == null) return;

            if (resultCode != Activity.RESULT_OK) {
                if (state.sendPublished) return;
                state.sendPublished = true;
                if (terminalize(state, key, true)) {
                    event = PublishEvent.sent(state, false, detailFor(resultCode, extras));
                } else {
                    state.sendPublished = false;
                }
            } else {
                int normalizedPart = normalizePartIndex(partIndex, state.totalParts);
                if (normalizedPart < 0 || !state.sentPartIndexes.add(normalizedPart)) return;
                state.sentParts = state.sentPartIndexes.size();
                if (state.sentParts >= state.totalParts && !state.sendPublished) {
                    state.sendPublished = true;
                    if (terminalize(state, key, state.deliveryPublished)) {
                        event = PublishEvent.sent(state, true, "sms_sent");
                    } else {
                        state.sendPublished = false;
                        persistState(state, key, false);
                    }
                } else {
                    persistState(state, key, false);
                }
            }
        }
        if (event != null) event.publish(context);
    }

    static void markDelivered(Context context, String actionId, String number) {
        markDelivered(context, actionId, number, -1);
    }

    static void markDelivered(Context context, String actionId, String number, int partIndex) {
        if (context == null || actionId == null || actionId.trim().isEmpty()) return;
        PublishEvent event = null;
        synchronized (LOCK) {
            String key = key(actionId);
            State state = stateForCallback(context, key, actionId, number);
            if (state == null) return;
            int normalizedPart = normalizePartIndex(partIndex, state.totalParts);
            if (normalizedPart < 0 || !state.deliveredPartIndexes.add(normalizedPart)) return;
            state.deliveredParts = state.deliveredPartIndexes.size();
            if (state.deliveredParts >= state.totalParts && !state.deliveryPublished) {
                state.deliveryPublished = true;
                if (terminalize(state, key, state.sendPublished)) {
                    event = PublishEvent.delivered(state);
                } else {
                    state.deliveryPublished = false;
                    persistState(state, key, false);
                }
            } else {
                persistState(state, key, false);
            }
        }
        if (event != null) event.publish(context);
    }

    private static State stateForCallback(Context context, String key, String actionId, String number) {
        State state = STATES.get(key);
        if (state != null) return state;
        try {
            SharedPreferences prefs = prefs(context);
            JSONObject pending = object(prefs.getString(KEY_PENDING, "{}"));
            JSONObject json = pending.optJSONObject(key);
            if (json == null) return null;
            state = decodeState(context.getApplicationContext(), json, actionId, number);
            if (state == null) return null;
            if (state.isExpired(System.currentTimeMillis())) {
                markTimedOut(key, state);
                return null;
            }
            STATES.put(key, state);
            scheduleTimeout(key, state, System.currentTimeMillis());
            return state;
        } catch (Exception ignored) {
            return null;
        }
    }

    private static void scheduleTimeout(String key, State state, long now) {
        long due = state.createdAtMs + state.maxAgeMs();
        TIMEOUTS.schedule(() -> markTimedOut(key, null), Math.max(1L, due - now), TimeUnit.MILLISECONDS);
    }

    private static void markTimedOut(String key, State fallback) {
        State state;
        synchronized (LOCK) {
            state = STATES.get(key);
            if (state == null) state = fallback;
            if (state == null || state.sendPublished || !state.isExpired(System.currentTimeMillis())) return;
            state.sendPublished = true;
            if (!terminalize(state, key, true)) {
                state.sendPublished = false;
                return;
            }
        }
        publishTimeout(state);
    }

    private static void publishTimeout(State state) {
        if (state == null) return;
        BridgeSmsStore.updateOutgoingStatus(state.context, state.actionId, "failed");
        MqttBridgeService.publishSentResult(state.context, state.actionId, state.number,
                state.totalParts, state.timeoutMs, false, "sms_timeout");
    }

    /** Adds a no-resend tombstone before optionally removing callback state. */
    private static boolean terminalize(State state, String key, boolean removePending) {
        if (!persistState(state, key, removePending)) return false;
        if (removePending) STATES.remove(key);
        return true;
    }

    private static boolean persistState(State state, String key, boolean removePending) {
        if (state == null || state.context == null) return false;
        try {
            SharedPreferences prefs = prefs(state.context);
            JSONObject pending = object(prefs.getString(KEY_PENDING, "{}"));
            JSONObject terminals = object(prefs.getString(KEY_TERMINALS, "{}"));
            pruneExpiredTerminals(terminals, System.currentTimeMillis());
            if (removePending) pending.remove(key);
            else pending.put(key, encodeState(state));
            if ((state.sendPublished || state.deliveryPublished) && !terminals.has(key)) {
                if (terminals.length() >= MAX_TERMINAL_KEYS) return false;
                terminals.put(key, System.currentTimeMillis());
            }
            return persistRoots(prefs, pending, terminals);
        } catch (Exception ignored) {
            return false;
        }
    }

    private static void makeTerminal(JSONObject pending, JSONObject terminals, String key, long now) throws Exception {
        pending.remove(key);
        if (!terminals.has(key) && terminals.length() < MAX_TERMINAL_KEYS) terminals.put(key, now);
        STATES.remove(key);
    }

    private static boolean persistRoots(SharedPreferences prefs, JSONObject pending, JSONObject terminals) {
        return prefs.edit()
                .putString(KEY_PENDING, pending.toString())
                .putString(KEY_TERMINALS, terminals.toString())
                .commit();
    }

    private static JSONObject encodeState(State state) throws Exception {
        JSONObject json = new JSONObject();
        json.put("actionId", state.actionId);
        json.put("number", state.number);
        json.put("totalParts", state.totalParts);
        json.put("timeoutMs", state.timeoutMs);
        json.put("createdAtMs", state.createdAtMs);
        json.put("sentPartIndexes", toJsonArray(state.sentPartIndexes));
        json.put("deliveredPartIndexes", toJsonArray(state.deliveredPartIndexes));
        json.put("sendPublished", state.sendPublished);
        json.put("deliveryPublished", state.deliveryPublished);
        return json;
    }

    private static State decodeState(Context context, JSONObject json, String fallbackActionId, String fallbackNumber) {
        if (json == null) return null;
        String actionId = json.optString("actionId", fallbackActionId);
        int totalParts = json.optInt("totalParts", 0);
        if (actionId == null || actionId.trim().isEmpty() || totalParts <= 0) return null;
        State state = new State(context, actionId, json.optString("number", fallbackNumber), totalParts,
                sanitizeTimeout(json.optInt("timeoutMs", 90000)),
                json.optLong("createdAtMs", System.currentTimeMillis()));
        readIndexes(json.optJSONArray("sentPartIndexes"), state.sentPartIndexes, totalParts);
        readIndexes(json.optJSONArray("deliveredPartIndexes"), state.deliveredPartIndexes, totalParts);
        // Migrate the old counter-only format conservatively. It cannot identify
        // which multipart callbacks arrived, so only a complete count is trusted.
        if (state.sentPartIndexes.isEmpty() && json.optInt("sentParts", 0) >= totalParts) {
            for (int i = 0; i < totalParts; i++) state.sentPartIndexes.add(i);
        }
        if (state.deliveredPartIndexes.isEmpty() && json.optInt("deliveredParts", 0) >= totalParts) {
            for (int i = 0; i < totalParts; i++) state.deliveredPartIndexes.add(i);
        }
        state.sentParts = state.sentPartIndexes.size();
        state.deliveredParts = state.deliveredPartIndexes.size();
        state.sendPublished = json.optBoolean("sendPublished", false);
        state.deliveryPublished = json.optBoolean("deliveryPublished", false);
        return state;
    }

    private static JSONArray toJsonArray(Set<Integer> indexes) {
        JSONArray array = new JSONArray();
        for (Integer index : indexes) array.put(index);
        return array;
    }

    private static void readIndexes(JSONArray array, Set<Integer> target, int totalParts) {
        if (array == null) return;
        for (int i = 0; i < array.length(); i++) {
            int index = array.optInt(i, -1);
            if (index >= 0 && index < totalParts) target.add(index);
        }
    }

    private static void pruneExpiredTerminals(JSONObject terminals, long now) {
        Iterator<String> names = terminals.keys();
        Set<String> remove = new HashSet<>();
        while (names.hasNext()) {
            String name = names.next();
            long timestamp = terminals.optLong(name, 0L);
            if (timestamp <= 0L || now - timestamp > TOMBSTONE_TTL_MS) remove.add(name);
        }
        for (String name : remove) terminals.remove(name);
    }

    private static JSONObject object(String json) throws Exception {
        return new JSONObject(json == null || json.trim().isEmpty() ? "{}" : json);
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static int normalizePartIndex(int partIndex, int totalParts) {
        if (partIndex < 0) return totalParts == 1 ? 0 : -1;
        return partIndex < totalParts ? partIndex : -1;
    }

    private static String detailFor(int resultCode, Bundle extras) {
        if (extras != null && extras.getBoolean("noDefault", false)) return "sms_default_sim_required";
        switch (resultCode) {
            case SmsManager.RESULT_ERROR_GENERIC_FAILURE: return "sms_send_failed";
            case SmsManager.RESULT_ERROR_NO_SERVICE: return "sms_no_service";
            case SmsManager.RESULT_ERROR_NULL_PDU: return "sms_null_pdu";
            case SmsManager.RESULT_ERROR_RADIO_OFF: return "sms_radio_off";
            default: return "sms_send_failed_" + resultCode;
        }
    }

    private static String key(String actionId) {
        return actionId == null ? "" : actionId.trim();
    }

    private static int sanitizeTimeout(int timeoutMs) {
        return timeoutMs > 0 ? timeoutMs : 90000;
    }

    private static final class PublishEvent {
        final State state;
        final boolean delivered;
        final boolean success;
        final String detail;

        private PublishEvent(State state, boolean delivered, boolean success, String detail) {
            this.state = state;
            this.delivered = delivered;
            this.success = success;
            this.detail = detail;
        }

        static PublishEvent sent(State state, boolean success, String detail) {
            return new PublishEvent(state, false, success, detail);
        }

        static PublishEvent delivered(State state) {
            return new PublishEvent(state, true, true, "sms_delivered");
        }

        void publish(Context callbackContext) {
            Context context = state.context == null ? callbackContext : state.context;
            if (delivered) {
                BridgeSmsStore.updateOutgoingStatus(context, state.actionId, "delivered");
                MqttBridgeService.publishDelivered(context, state.actionId, state.number);
            } else {
                BridgeSmsStore.updateOutgoingStatus(context, state.actionId, success ? "sent" : "failed");
                MqttBridgeService.publishSentResult(context, state.actionId, state.number,
                        state.totalParts, state.timeoutMs, success, detail);
            }
        }
    }

    private static final class State {
        final String actionId;
        final String number;
        final Context context;
        final int totalParts;
        final int timeoutMs;
        final long createdAtMs;
        final Set<Integer> sentPartIndexes = new HashSet<>();
        final Set<Integer> deliveredPartIndexes = new HashSet<>();
        int sentParts;
        int deliveredParts;
        boolean sendPublished;
        boolean deliveryPublished;

        State(Context context, String actionId, String number, int totalParts, int timeoutMs, long createdAtMs) {
            this.context = context;
            this.actionId = actionId;
            this.number = number == null ? "" : number;
            this.totalParts = totalParts;
            this.timeoutMs = timeoutMs;
            this.createdAtMs = createdAtMs;
        }

        long maxAgeMs() {
            return Math.max(timeoutMs, 90000) + 60000L;
        }

        boolean isExpired(long now) {
            return createdAtMs > 0L && now - createdAtMs > maxAgeMs();
        }
    }
}
