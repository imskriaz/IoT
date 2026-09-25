package com.devicebridge.android;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

final class BridgeSmsLocalQueue {
    private static final String PREFS = "bridge_sms_local_queue";
    private static final String KEY_ITEMS = "items";

    static final class QueueItem {
        final String id;
        final String address;
        final String body;
        final long dueAt;
        final int simSlot;
        final String source;
        final String status;

        QueueItem(String id, String address, String body, long dueAt, int simSlot, String source, String status) {
            this.id = safe(id);
            this.address = safe(address);
            this.body = safe(body);
            this.dueAt = dueAt;
            this.simSlot = simSlot;
            this.source = safe(source, "local_schedule");
            this.status = safe(status, "pending");
        }
    }

    private BridgeSmsLocalQueue() {
    }

    static String enqueue(Context context, String address, String body, long dueAt, int simSlot, String source) {
        if (context == null) return "";
        String cleanAddress = safe(address).trim();
        String cleanBody = safe(body).trim();
        if (cleanAddress.isEmpty() || cleanBody.isEmpty()) return "";
        String id = "local_queue_" + System.currentTimeMillis() + "_" + Math.abs((cleanAddress + cleanBody).hashCode());
        List<QueueItem> items = list(context);
        items.add(new QueueItem(id, cleanAddress, cleanBody, dueAt > 0 ? dueAt : System.currentTimeMillis(), simSlot, source, "pending"));
        save(context, items);
        return id;
    }

    static List<QueueItem> list(Context context) {
        List<QueueItem> items = new ArrayList<>();
        if (context == null) return items;
        String raw = prefs(context).getString(KEY_ITEMS, "[]");
        try {
            JSONArray array = new JSONArray(raw);
            for (int i = 0; i < array.length(); i += 1) {
                JSONObject object = array.optJSONObject(i);
                if (object == null) continue;
                items.add(new QueueItem(
                        object.optString("id"),
                        object.optString("address"),
                        object.optString("body"),
                        object.optLong("dueAt"),
                        object.optInt("simSlot", -1),
                        object.optString("source", "local_schedule"),
                        object.optString("status", "pending")
                ));
            }
        } catch (Exception ignored) {
        }
        return items;
    }

    static List<QueueItem> due(Context context, long now) {
        List<QueueItem> due = new ArrayList<>();
        for (QueueItem item : list(context)) {
            if ("pending".equals(item.status) && item.dueAt <= now) {
                due.add(item);
            }
        }
        return due;
    }

    static void remove(Context context, String id) {
        if (context == null || safe(id).isEmpty()) return;
        List<QueueItem> kept = new ArrayList<>();
        for (QueueItem item : list(context)) {
            if (!safe(id).equals(item.id)) {
                kept.add(item);
            }
        }
        save(context, kept);
    }

    static void markFailed(Context context, String id) {
        if (context == null || safe(id).isEmpty()) return;
        List<QueueItem> updated = new ArrayList<>();
        for (QueueItem item : list(context)) {
            if (safe(id).equals(item.id)) {
                updated.add(new QueueItem(item.id, item.address, item.body, item.dueAt, item.simSlot, item.source, "failed"));
            } else {
                updated.add(item);
            }
        }
        save(context, updated);
    }

    static int countForAddress(Context context, String address) {
        String target = normalizeAddress(address);
        if (target.isEmpty()) return 0;
        int count = 0;
        for (QueueItem item : list(context)) {
            if ("pending".equals(item.status) && target.equals(normalizeAddress(item.address))) {
                count += 1;
            }
        }
        return count;
    }

    private static void save(Context context, List<QueueItem> items) {
        JSONArray array = new JSONArray();
        for (QueueItem item : items) {
            try {
                JSONObject object = new JSONObject();
                object.put("id", item.id);
                object.put("address", item.address);
                object.put("body", item.body);
                object.put("dueAt", item.dueAt);
                object.put("simSlot", item.simSlot);
                object.put("source", item.source);
                object.put("status", item.status);
                array.put(object);
            } catch (Exception ignored) {
            }
        }
        prefs(context).edit().putString(KEY_ITEMS, array.toString()).apply();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static String normalizeAddress(String value) {
        String digits = safe(value).replaceAll("[^0-9]", "");
        if (digits.length() > 10) {
            digits = digits.substring(digits.length() - 10);
        }
        return digits.toLowerCase(Locale.US);
    }

    private static String safe(String value) {
        return value == null ? "" : value;
    }

    private static String safe(String value, String fallback) {
        String clean = safe(value).trim();
        return clean.isEmpty() ? fallback : clean;
    }
}
