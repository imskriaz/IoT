package com.devicebridge.android;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.provider.Telephony;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

final class BridgeSmsStore {
    private static final String KEY_LOCAL_SMS_MIRROR = "local_sms_mirror";
    private static final int MAX_PROVIDER_MESSAGES = 400;
    private static final int MAX_LOCAL_MESSAGES = 160;
    private static final long LOCAL_RETENTION_MS = 14L * 24L * 60L * 60L * 1000L;

    private BridgeSmsStore() {
    }

    static List<Map<String, Object>> buildThreadSummaries(Activity activity) {
        List<SmsRecord> records = loadMergedMessages(activity);
        if (records.isEmpty()) {
            return Collections.emptyList();
        }

        Map<String, ThreadBucket> buckets = new LinkedHashMap<>();
        for (SmsRecord record : records) {
            ThreadBucket bucket = buckets.get(record.threadKey);
            if (bucket == null) {
                bucket = new ThreadBucket(record.threadKey, record.address, record.timestamp, record.body);
                buckets.put(record.threadKey, bucket);
            }
            bucket.latestAt = Math.max(bucket.latestAt, record.timestamp);
            if (bucket.preview.isEmpty()) {
                bucket.preview = record.body;
            }
            if (!record.outgoing && !record.read) {
                bucket.unreadCount += 1;
            }
            if (!bucket.hasDraft && record.localOnly && record.outgoing) {
                bucket.hasDraft = true;
            }
        }

        List<Map<String, Object>> threads = new ArrayList<>();
        for (ThreadBucket bucket : buckets.values()) {
            Map<String, Object> item = new HashMap<>();
            item.put("threadKey", bucket.threadKey);
            item.put("address", bucket.address);
            item.put("title", displayAddress(bucket.address));
            item.put("preview", compactPreview(bucket.preview));
            item.put("timestamp", bucket.latestAt);
            item.put("unreadCount", bucket.unreadCount);
            item.put("hasLocalDraft", bucket.hasDraft);
            threads.add(item);
        }

        threads.sort((left, right) -> Long.compare(longValue(right.get("timestamp")), longValue(left.get("timestamp"))));
        return threads;
    }

    static List<Map<String, Object>> buildThreadMessages(Activity activity, String requestedThreadKey) {
        String normalizedThreadKey = requestedThreadKey == null ? "" : requestedThreadKey.trim();
        if (normalizedThreadKey.isEmpty()) {
            return Collections.emptyList();
        }

        List<SmsRecord> records = loadMergedMessages(activity);
        List<Map<String, Object>> messages = new ArrayList<>();
        for (SmsRecord record : records) {
            if (!normalizedThreadKey.equals(record.threadKey)) {
                continue;
            }
            Map<String, Object> item = new HashMap<>();
            item.put("id", record.id);
            item.put("threadKey", record.threadKey);
            item.put("address", record.address);
            item.put("body", record.body);
            item.put("timestamp", record.timestamp);
            item.put("outgoing", record.outgoing);
            item.put("read", record.read);
            item.put("status", record.status);
            item.put("localOnly", record.localOnly);
            messages.add(item);
        }
        messages.sort(Comparator.comparingLong(item -> longValue(item.get("timestamp"))));
        return messages;
    }

    static void recordOutgoing(Context context, String actionId, String address, String body, long timestamp) {
        if (context == null) {
            return;
        }
        appendLocalRecord(
                context,
                new SmsRecord(
                        safe(actionId, "local-" + timestamp),
                        "",
                        buildAddressThreadKey(address),
                        safe(address, ""),
                        safe(body, ""),
                        timestamp > 0 ? timestamp : System.currentTimeMillis(),
                        true,
                        true,
                        "queued",
                        true
                )
        );
    }

    static void recordIncoming(Context context, String address, String body, long timestamp) {
        if (context == null) {
            return;
        }
        appendLocalRecord(
                context,
                new SmsRecord(
                        "incoming-" + Math.max(1L, timestamp),
                        "",
                        buildAddressThreadKey(address),
                        safe(address, ""),
                        safe(body, ""),
                        timestamp > 0 ? timestamp : System.currentTimeMillis(),
                        false,
                        false,
                        "received",
                        true
                )
        );
    }

    private static List<SmsRecord> loadMergedMessages(Activity activity) {
        List<SmsRecord> providerRecords = loadProviderMessages(activity);
        List<SmsRecord> localRecords = loadLocalMirror(activity);
        if (localRecords.isEmpty()) {
            return providerRecords;
        }

        Map<String, String> addressToThread = new HashMap<>();
        Set<String> fingerprints = new HashSet<>();
        for (SmsRecord record : providerRecords) {
            String normalizedAddress = normalizeAddress(record.address);
            if (!normalizedAddress.isEmpty()) {
                addressToThread.put(normalizedAddress, record.threadKey);
            }
            fingerprints.add(dedupeFingerprint(record));
        }

        for (SmsRecord record : localRecords) {
            String normalizedAddress = normalizeAddress(record.address);
            String providerThread = addressToThread.get(normalizedAddress);
            SmsRecord effective = providerThread == null
                    ? record
                    : record.withThreadKey(providerThread);
            String fingerprint = dedupeFingerprint(effective);
            if (fingerprints.contains(fingerprint)) {
                continue;
            }
            providerRecords.add(effective);
            fingerprints.add(fingerprint);
        }

        providerRecords.sort((left, right) -> Long.compare(right.timestamp, left.timestamp));
        return providerRecords;
    }

    private static List<SmsRecord> loadProviderMessages(Activity activity) {
        List<SmsRecord> records = new ArrayList<>();
        if (activity == null || activity.checkSelfPermission(Manifest.permission.READ_SMS) != PackageManager.PERMISSION_GRANTED) {
            return records;
        }

        Cursor cursor = null;
        try {
            cursor = activity.getContentResolver().query(
                    Telephony.Sms.CONTENT_URI,
                    new String[] {
                            Telephony.Sms._ID,
                            Telephony.Sms.THREAD_ID,
                            Telephony.Sms.ADDRESS,
                            Telephony.Sms.BODY,
                            Telephony.Sms.DATE,
                            Telephony.Sms.TYPE,
                            Telephony.Sms.READ
                    },
                    null,
                    null,
                    Telephony.Sms.DEFAULT_SORT_ORDER
            );
            if (cursor == null) {
                return records;
            }

            int idIndex = cursor.getColumnIndex(Telephony.Sms._ID);
            int threadIdIndex = cursor.getColumnIndex(Telephony.Sms.THREAD_ID);
            int addressIndex = cursor.getColumnIndex(Telephony.Sms.ADDRESS);
            int bodyIndex = cursor.getColumnIndex(Telephony.Sms.BODY);
            int dateIndex = cursor.getColumnIndex(Telephony.Sms.DATE);
            int typeIndex = cursor.getColumnIndex(Telephony.Sms.TYPE);
            int readIndex = cursor.getColumnIndex(Telephony.Sms.READ);

            int count = 0;
            while (cursor.moveToNext() && count < MAX_PROVIDER_MESSAGES) {
                String id = stringAt(cursor, idIndex);
                String address = stringAt(cursor, addressIndex);
                String body = stringAt(cursor, bodyIndex);
                long timestamp = longAt(cursor, dateIndex);
                int type = intAt(cursor, typeIndex);
                boolean outgoing = type == Telephony.Sms.MESSAGE_TYPE_SENT
                        || type == Telephony.Sms.MESSAGE_TYPE_OUTBOX
                        || type == Telephony.Sms.MESSAGE_TYPE_QUEUED
                        || type == Telephony.Sms.MESSAGE_TYPE_FAILED;
                boolean read = intAt(cursor, readIndex) == 1 || outgoing;
                long threadId = longAt(cursor, threadIdIndex);
                records.add(new SmsRecord(
                        id,
                        String.valueOf(threadId),
                        buildThreadKey(threadId, address),
                        address,
                        body,
                        timestamp,
                        outgoing,
                        read,
                        statusForType(type),
                        false
                ));
                count += 1;
            }
        } catch (RuntimeException ignored) {
            return records;
        } finally {
            if (cursor != null) {
                cursor.close();
            }
        }
        return records;
    }

    private static List<SmsRecord> loadLocalMirror(Context context) {
        List<SmsRecord> records = new ArrayList<>();
        if (context == null) {
            return records;
        }

        long cutoff = System.currentTimeMillis() - LOCAL_RETENTION_MS;
        JSONArray array = parseArray(readMirrorValue(context));
        JSONArray retained = new JSONArray();
        for (int i = 0; i < array.length(); i += 1) {
            JSONObject item = array.optJSONObject(i);
            if (item == null) {
                continue;
            }
            long timestamp = item.optLong("timestamp", 0L);
            if (timestamp <= 0L || timestamp < cutoff) {
                continue;
            }
            retained.put(item);
            records.add(new SmsRecord(
                    item.optString("id", "local-" + timestamp + "-" + i),
                    item.optString("threadId", ""),
                    item.optString("threadKey", buildAddressThreadKey(item.optString("address", ""))),
                    item.optString("address", ""),
                    item.optString("body", ""),
                    timestamp,
                    item.optBoolean("outgoing", false),
                    item.optBoolean("read", false),
                    item.optString("status", ""),
                    true
            ));
        }

        if (retained.length() != array.length()) {
            prefs(context).edit().putString(KEY_LOCAL_SMS_MIRROR, retained.toString()).apply();
        }
        return records;
    }

    private static void appendLocalRecord(Context context, SmsRecord record) {
        if (context == null || record == null || record.body.trim().isEmpty()) {
            return;
        }

        JSONArray existing = parseArray(readMirrorValue(context));
        JSONArray retained = new JSONArray();
        long cutoff = System.currentTimeMillis() - LOCAL_RETENTION_MS;
        String nextFingerprint = dedupeFingerprint(record);

        List<JSONObject> retainedItems = new ArrayList<>();
        for (int i = 0; i < existing.length(); i += 1) {
            JSONObject item = existing.optJSONObject(i);
            if (item == null) {
                continue;
            }
            long timestamp = item.optLong("timestamp", 0L);
            if (timestamp <= 0L || timestamp < cutoff) {
                continue;
            }
            SmsRecord current = new SmsRecord(
                    item.optString("id", "local-" + timestamp + "-" + i),
                    item.optString("threadId", ""),
                    item.optString("threadKey", buildAddressThreadKey(item.optString("address", ""))),
                    item.optString("address", ""),
                    item.optString("body", ""),
                    timestamp,
                    item.optBoolean("outgoing", false),
                    item.optBoolean("read", false),
                    item.optString("status", ""),
                    true
            );
            if (dedupeFingerprint(current).equals(nextFingerprint)) {
                return;
            }
            retainedItems.add(item);
        }

        JSONObject next = new JSONObject();
        try {
            next.put("id", record.id);
            next.put("threadId", record.threadId);
            next.put("threadKey", record.threadKey);
            next.put("address", record.address);
            next.put("body", record.body);
            next.put("timestamp", record.timestamp);
            next.put("outgoing", record.outgoing);
            next.put("read", record.read);
            next.put("status", record.status);
        } catch (JSONException ignored) {
        }
        retainedItems.add(next);

        int start = Math.max(0, retainedItems.size() - MAX_LOCAL_MESSAGES);
        for (int i = start; i < retainedItems.size(); i += 1) {
            retained.put(retainedItems.get(i));
        }
        prefs(context).edit().putString(KEY_LOCAL_SMS_MIRROR, retained.toString()).apply();
    }

    private static String readMirrorValue(Context context) {
        if (context == null) {
            return "[]";
        }
        String value = prefs(context).getString(KEY_LOCAL_SMS_MIRROR, "[]");
        return value == null || value.trim().isEmpty() ? "[]" : value;
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(BridgeConfig.PREFS, Context.MODE_PRIVATE);
    }

    private static JSONArray parseArray(String raw) {
        try {
            return new JSONArray(raw == null || raw.trim().isEmpty() ? "[]" : raw);
        } catch (JSONException ignored) {
            return new JSONArray();
        }
    }

    private static String dedupeFingerprint(SmsRecord record) {
        long bucket = record.timestamp / 5000L;
        return (record.outgoing ? "out" : "in")
                + "|"
                + normalizeAddress(record.address)
                + "|"
                + normalizeBody(record.body)
                + "|"
                + bucket;
    }

    private static String normalizeBody(String body) {
        return safe(body, "").trim().replaceAll("\\s+", " ").toLowerCase(Locale.US);
    }

    private static String normalizeAddress(String address) {
        String value = safe(address, "").trim();
        if (value.isEmpty()) {
            return "";
        }
        String digits = value.replaceAll("[^0-9+]", "");
        return digits.isEmpty() ? value.toLowerCase(Locale.US) : digits;
    }

    private static String buildThreadKey(long threadId, String address) {
        if (threadId > 0L) {
            return "thread:" + threadId;
        }
        return buildAddressThreadKey(address);
    }

    private static String buildAddressThreadKey(String address) {
        String normalized = normalizeAddress(address);
        return normalized.isEmpty() ? "thread:unknown" : "addr:" + normalized;
    }

    private static String displayAddress(String address) {
        String value = safe(address, "").trim();
        return value.isEmpty() ? "Unknown sender" : value;
    }

    private static String compactPreview(String body) {
        String value = safe(body, "").trim().replaceAll("\\s+", " ");
        if (value.length() <= 72) {
            return value;
        }
        return value.substring(0, 69).trim() + "...";
    }

    private static String statusForType(int type) {
        switch (type) {
            case Telephony.Sms.MESSAGE_TYPE_INBOX:
                return "received";
            case Telephony.Sms.MESSAGE_TYPE_SENT:
                return "sent";
            case Telephony.Sms.MESSAGE_TYPE_OUTBOX:
                return "outbox";
            case Telephony.Sms.MESSAGE_TYPE_FAILED:
                return "failed";
            case Telephony.Sms.MESSAGE_TYPE_QUEUED:
                return "queued";
            default:
                return "message";
        }
    }

    private static String stringAt(Cursor cursor, int index) {
        if (cursor == null || index < 0 || cursor.isNull(index)) {
            return "";
        }
        return safe(cursor.getString(index), "");
    }

    private static long longAt(Cursor cursor, int index) {
        if (cursor == null || index < 0 || cursor.isNull(index)) {
            return 0L;
        }
        return cursor.getLong(index);
    }

    private static int intAt(Cursor cursor, int index) {
        if (cursor == null || index < 0 || cursor.isNull(index)) {
            return 0;
        }
        return cursor.getInt(index);
    }

    private static long longValue(Object value) {
        if (value instanceof Number) {
            return ((Number) value).longValue();
        }
        if (value instanceof String) {
            try {
                return Long.parseLong(((String) value).trim());
            } catch (NumberFormatException ignored) {
                return 0L;
            }
        }
        return 0L;
    }

    private static String safe(String value, String fallback) {
        return value == null ? fallback : value;
    }

    private static final class ThreadBucket {
        final String threadKey;
        final String address;
        long latestAt;
        String preview;
        int unreadCount;
        boolean hasDraft;

        ThreadBucket(String threadKey, String address, long latestAt, String preview) {
            this.threadKey = threadKey;
            this.address = address;
            this.latestAt = latestAt;
            this.preview = preview == null ? "" : preview;
        }
    }

    private static final class SmsRecord {
        final String id;
        final String threadId;
        final String threadKey;
        final String address;
        final String body;
        final long timestamp;
        final boolean outgoing;
        final boolean read;
        final String status;
        final boolean localOnly;

        SmsRecord(
                String id,
                String threadId,
                String threadKey,
                String address,
                String body,
                long timestamp,
                boolean outgoing,
                boolean read,
                String status,
                boolean localOnly
        ) {
            this.id = id == null ? "" : id;
            this.threadId = threadId == null ? "" : threadId;
            this.threadKey = threadKey == null ? "thread:unknown" : threadKey;
            this.address = address == null ? "" : address;
            this.body = body == null ? "" : body;
            this.timestamp = timestamp;
            this.outgoing = outgoing;
            this.read = read;
            this.status = status == null ? "" : status;
            this.localOnly = localOnly;
        }

        SmsRecord withThreadKey(String nextThreadKey) {
            return new SmsRecord(
                    id,
                    threadId,
                    nextThreadKey,
                    address,
                    body,
                    timestamp,
                    outgoing,
                    read,
                    status,
                    localOnly
            );
        }
    }
}
