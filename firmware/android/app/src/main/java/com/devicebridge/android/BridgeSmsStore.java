package com.devicebridge.android;

import android.Manifest;
import android.app.Activity;
import android.content.ContentValues;
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
    private static final String KEY_THREAD_READ_SHADOWS = "local_sms_thread_read_shadows";
    private static final String KEY_THREAD_DELETE_SHADOWS = "local_sms_thread_delete_shadows";
    private static final String KEY_DELETED_MESSAGE_IDS = "local_sms_deleted_message_ids";
    private static final int MAX_PROVIDER_MESSAGES = 400;
    private static final int MAX_LOCAL_MESSAGES = 160;
    private static final int MAX_DELETED_MESSAGE_IDS = 800;
    private static final long LOCAL_RETENTION_MS = 14L * 24L * 60L * 60L * 1000L;

    private BridgeSmsStore() {
    }

    static final class SmsMutationResult {
        final int providerChanged;
        final int localChanged;
        final boolean providerBlocked;

        SmsMutationResult(int providerChanged, int localChanged, boolean providerBlocked) {
            this.providerChanged = providerChanged;
            this.localChanged = localChanged;
            this.providerBlocked = providerBlocked;
        }

        int totalChanged() {
            return providerChanged + localChanged;
        }
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
            item.put("source", record.source);
            item.put("actionId", record.id);
            messages.add(item);
        }
        messages.sort(Comparator.comparingLong(item -> longValue(item.get("timestamp"))));
        return messages;
    }

    static List<Map<String, Object>> buildRecentMessages(Context context, int limit) {
        List<SmsRecord> records = loadMergedMessages(context);
        records.sort(Comparator.comparingLong(record -> record.timestamp));
        int max = Math.max(1, limit);
        int start = Math.max(0, records.size() - max);
        List<Map<String, Object>> messages = new ArrayList<>();
        for (int i = start; i < records.size(); i += 1) {
            SmsRecord record = records.get(i);
            Map<String, Object> item = new HashMap<>();
            item.put("id", record.id);
            item.put("threadKey", record.threadKey);
            item.put("address", record.address);
            item.put("body", record.body);
            item.put("timestamp", record.timestamp);
            item.put("outgoing", record.outgoing);
            item.put("read", record.read);
            item.put("status", record.status);
            item.put("source", record.source);
            item.put("localOnly", record.localOnly);
            messages.add(item);
        }
        return messages;
    }

    static void recordOutgoing(Context context, String actionId, String address, String body, long timestamp) {
        recordOutgoing(context, actionId, address, body, timestamp, "local");
    }

    static void recordOutgoing(Context context, String actionId, String address, String body, long timestamp, String source) {
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
                        true,
                        safe(source, "local")
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
                        true,
                        "device"
                )
        );
    }

    static void updateOutgoingStatus(Context context, String actionId, String status) {
        if (context == null) {
            return;
        }
        String cleanActionId = safe(actionId, "").trim();
        String cleanStatus = safe(status, "").trim();
        if (cleanActionId.isEmpty() || cleanStatus.isEmpty()) {
            return;
        }

        JSONArray existing = parseArray(readMirrorValue(context));
        JSONArray retained = new JSONArray();
        int changed = 0;
        for (int i = 0; i < existing.length(); i += 1) {
            JSONObject item = existing.optJSONObject(i);
            if (item == null) {
                continue;
            }
            if (cleanActionId.equals(item.optString("id", ""))) {
                try {
                    item.put("status", cleanStatus);
                    if (item.optBoolean("outgoing", false)) {
                        item.put("read", true);
                    }
                    changed += 1;
                } catch (JSONException ignored) {
                }
            }
            retained.put(item);
        }
        if (changed > 0) {
            prefs(context).edit().putString(KEY_LOCAL_SMS_MIRROR, retained.toString()).apply();
        }
    }

    static SmsMutationResult markThreadsRead(Activity activity, List<Map<String, Object>> threads) {
        List<ThreadReference> refs = threadReferences(threads);
        if (refs.isEmpty()) {
            return new SmsMutationResult(0, 0, false);
        }

        int providerChanged = 0;
        boolean providerBlocked = false;
        if (activity != null) {
            ContentValues values = new ContentValues();
            values.put(Telephony.Sms.READ, 1);
            for (ThreadReference ref : refs) {
                try {
                    if (!ref.threadId.isEmpty()) {
                        providerChanged += activity.getContentResolver().update(
                                Telephony.Sms.CONTENT_URI,
                                values,
                                Telephony.Sms.THREAD_ID + "=? AND " + Telephony.Sms.READ + "=0",
                                new String[]{ref.threadId}
                        );
                    } else if (!ref.address.isEmpty()) {
                        providerChanged += activity.getContentResolver().update(
                                Telephony.Sms.CONTENT_URI,
                                values,
                                Telephony.Sms.ADDRESS + "=? AND " + Telephony.Sms.READ + "=0",
                                new String[]{ref.address}
                        );
                    }
                } catch (SecurityException error) {
                    providerBlocked = true;
                    BridgeEventLog.append(activity, "sms: mark read blocked by Android provider policy");
                    break;
                } catch (RuntimeException error) {
                    BridgeEventLog.append(activity, "sms: mark read failed " + error.getMessage());
                }
            }
        }

        int localChanged = markLocalThreadsRead(activity, refs);
        int shadowChanged = applyThreadShadow(activity, KEY_THREAD_READ_SHADOWS, refs);
        return new SmsMutationResult(providerChanged, localChanged + shadowChanged, providerBlocked);
    }

    static SmsMutationResult deleteThreads(Activity activity, List<Map<String, Object>> threads) {
        List<ThreadReference> refs = threadReferences(threads);
        if (refs.isEmpty()) {
            return new SmsMutationResult(0, 0, false);
        }

        int providerChanged = 0;
        boolean providerBlocked = false;
        if (activity != null) {
            for (ThreadReference ref : refs) {
                try {
                    if (!ref.threadId.isEmpty()) {
                        providerChanged += activity.getContentResolver().delete(
                                Telephony.Sms.CONTENT_URI,
                                Telephony.Sms.THREAD_ID + "=?",
                                new String[]{ref.threadId}
                        );
                    } else if (!ref.address.isEmpty()) {
                        providerChanged += activity.getContentResolver().delete(
                                Telephony.Sms.CONTENT_URI,
                                Telephony.Sms.ADDRESS + "=?",
                                new String[]{ref.address}
                        );
                    }
                } catch (SecurityException error) {
                    providerBlocked = true;
                    BridgeEventLog.append(activity, "sms: delete blocked by Android provider policy");
                    break;
                } catch (RuntimeException error) {
                    BridgeEventLog.append(activity, "sms: delete failed " + error.getMessage());
                }
            }
        }

        int localChanged = deleteLocalThreads(activity, refs);
        int shadowChanged = applyThreadShadow(activity, KEY_THREAD_DELETE_SHADOWS, refs);
        return new SmsMutationResult(providerChanged, localChanged + shadowChanged, providerBlocked);
    }

    static SmsMutationResult deleteMessages(Activity activity, List<Map<String, Object>> messages) {
        List<MessageReference> refs = messageReferences(messages);
        if (refs.isEmpty()) {
            return new SmsMutationResult(0, 0, false);
        }

        int providerChanged = 0;
        boolean providerBlocked = false;
        if (activity != null) {
            for (MessageReference ref : refs) {
                if (ref.localOnly || ref.id.isEmpty()) {
                    continue;
                }
                try {
                    providerChanged += activity.getContentResolver().delete(
                            Telephony.Sms.CONTENT_URI,
                            Telephony.Sms._ID + "=?",
                            new String[]{ref.id}
                    );
                } catch (SecurityException error) {
                    providerBlocked = true;
                    BridgeEventLog.append(activity, "sms: message delete blocked by Android provider policy");
                    break;
                } catch (RuntimeException error) {
                    BridgeEventLog.append(activity, "sms: message delete failed " + error.getMessage());
                }
            }
        }

        int localChanged = deleteLocalMessages(activity, refs);
        int shadowChanged = applyDeletedMessageShadow(activity, refs);
        return new SmsMutationResult(providerChanged, localChanged + shadowChanged, providerBlocked);
    }

    private static List<SmsRecord> loadMergedMessages(Context context) {
        List<SmsRecord> providerRecords = loadProviderMessages(context);
        List<SmsRecord> localRecords = loadLocalMirror(context);
        if (localRecords.isEmpty()) {
            return applyLocalShadows(context, providerRecords);
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

        return applyLocalShadows(context, providerRecords);
    }

    private static List<SmsRecord> loadProviderMessages(Context activity) {
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
                        false,
                        "phone"
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
                    true,
                    item.optString("source", inferSource(item.optString("id", ""), item.optBoolean("outgoing", false)))
            ));
        }

        if (retained.length() != array.length()) {
            prefs(context).edit().putString(KEY_LOCAL_SMS_MIRROR, retained.toString()).apply();
        }
        return records;
    }

    private static int markLocalThreadsRead(Context context, List<ThreadReference> refs) {
        if (context == null || refs.isEmpty()) {
            return 0;
        }
        JSONArray existing = parseArray(readMirrorValue(context));
        JSONArray retained = new JSONArray();
        int changed = 0;
        for (int i = 0; i < existing.length(); i += 1) {
            JSONObject item = existing.optJSONObject(i);
            if (item == null) {
                continue;
            }
            if (matchesThreadRef(item, refs) && !item.optBoolean("read", false)) {
                try {
                    item.put("read", true);
                    changed += 1;
                } catch (JSONException ignored) {
                }
            }
            retained.put(item);
        }
        if (changed > 0) {
            prefs(context).edit().putString(KEY_LOCAL_SMS_MIRROR, retained.toString()).apply();
        }
        return changed;
    }

    private static int deleteLocalThreads(Context context, List<ThreadReference> refs) {
        if (context == null || refs.isEmpty()) {
            return 0;
        }
        JSONArray existing = parseArray(readMirrorValue(context));
        JSONArray retained = new JSONArray();
        int changed = 0;
        for (int i = 0; i < existing.length(); i += 1) {
            JSONObject item = existing.optJSONObject(i);
            if (item == null) {
                continue;
            }
            if (matchesThreadRef(item, refs)) {
                changed += 1;
                continue;
            }
            retained.put(item);
        }
        if (changed > 0) {
            prefs(context).edit().putString(KEY_LOCAL_SMS_MIRROR, retained.toString()).apply();
        }
        return changed;
    }

    private static int deleteLocalMessages(Context context, List<MessageReference> refs) {
        if (context == null || refs.isEmpty()) {
            return 0;
        }
        JSONArray existing = parseArray(readMirrorValue(context));
        JSONArray retained = new JSONArray();
        int changed = 0;
        for (int i = 0; i < existing.length(); i += 1) {
            JSONObject item = existing.optJSONObject(i);
            if (item == null) {
                continue;
            }
            if (matchesMessageRef(item, refs)) {
                changed += 1;
                continue;
            }
            retained.put(item);
        }
        if (changed > 0) {
            prefs(context).edit().putString(KEY_LOCAL_SMS_MIRROR, retained.toString()).apply();
        }
        return changed;
    }

    private static List<SmsRecord> applyLocalShadows(Context context, List<SmsRecord> records) {
        if (records == null || records.isEmpty()) {
            return records == null ? new ArrayList<>() : records;
        }
        List<ThreadShadow> readShadows = loadThreadShadows(context, KEY_THREAD_READ_SHADOWS);
        List<ThreadShadow> deleteShadows = loadThreadShadows(context, KEY_THREAD_DELETE_SHADOWS);
        Set<String> deletedMessageIds = loadDeletedMessageIds(context);
        List<SmsRecord> effective = new ArrayList<>();
        for (SmsRecord record : records) {
            if (record == null) {
                continue;
            }
            if (!record.id.isEmpty() && deletedMessageIds.contains(record.id)) {
                continue;
            }
            if (matchesThreadShadow(record, deleteShadows)) {
                continue;
            }
            effective.add(matchesThreadShadow(record, readShadows) ? record.withRead(true) : record);
        }
        effective.sort((left, right) -> Long.compare(right.timestamp, left.timestamp));
        return effective;
    }

    private static int applyThreadShadow(Context context, String key, List<ThreadReference> refs) {
        if (context == null || key == null || key.trim().isEmpty() || refs == null || refs.isEmpty()) {
            return 0;
        }
        List<ThreadShadow> merged = new ArrayList<>(loadThreadShadows(context, key));
        long cutoffTimestamp = System.currentTimeMillis();
        int changed = 0;
        for (ThreadReference ref : refs) {
            if (ref == null) {
                continue;
            }
            String dedupe = ref.threadKey + "|" + ref.normalizedAddress;
            boolean replaced = false;
            for (int i = 0; i < merged.size(); i += 1) {
                ThreadShadow current = merged.get(i);
                if (current == null) {
                    continue;
                }
                String currentDedupe = current.threadKey + "|" + current.normalizedAddress;
                if (!dedupe.equals(currentDedupe)) {
                    continue;
                }
                merged.set(i, new ThreadShadow(ref.threadKey, ref.normalizedAddress, cutoffTimestamp));
                replaced = true;
                changed += 1;
                break;
            }
            if (!replaced) {
                merged.add(new ThreadShadow(ref.threadKey, ref.normalizedAddress, cutoffTimestamp));
                changed += 1;
            }
        }
        saveThreadShadows(context, key, merged);
        return changed;
    }

    private static int applyDeletedMessageShadow(Context context, List<MessageReference> refs) {
        if (context == null || refs == null || refs.isEmpty()) {
            return 0;
        }
        Set<String> deleted = loadDeletedMessageIds(context);
        int changed = 0;
        for (MessageReference ref : refs) {
            if (ref == null || ref.localOnly || ref.id.isEmpty()) {
                continue;
            }
            if (deleted.add(ref.id)) {
                changed += 1;
            }
        }
        if (changed > 0) {
            saveDeletedMessageIds(context, deleted);
        }
        return changed;
    }

    private static boolean matchesThreadRef(JSONObject item, List<ThreadReference> refs) {
        String itemThreadKey = item.optString("threadKey", "");
        String itemAddress = normalizeAddress(item.optString("address", ""));
        String itemAddressThread = buildAddressThreadKey(item.optString("address", ""));
        for (ThreadReference ref : refs) {
            if (!ref.threadKey.isEmpty() && ref.threadKey.equals(itemThreadKey)) {
                return true;
            }
            if (!ref.threadKey.isEmpty() && ref.threadKey.equals(itemAddressThread)) {
                return true;
            }
            if (!ref.normalizedAddress.isEmpty() && ref.normalizedAddress.equals(itemAddress)) {
                return true;
            }
        }
        return false;
    }

    private static boolean matchesMessageRef(JSONObject item, List<MessageReference> refs) {
        String itemId = item.optString("id", "");
        for (MessageReference ref : refs) {
            if (!ref.id.isEmpty() && ref.id.equals(itemId)) {
                return true;
            }
        }
        return false;
    }

    private static boolean matchesThreadShadow(SmsRecord record, List<ThreadShadow> shadows) {
        if (record == null || shadows == null || shadows.isEmpty()) {
            return false;
        }
        String normalizedAddress = normalizeAddress(record.address);
        for (ThreadShadow shadow : shadows) {
            if (shadow == null || shadow.cutoffTimestamp <= 0L || record.timestamp > shadow.cutoffTimestamp) {
                continue;
            }
            if (!shadow.threadKey.isEmpty() && shadow.threadKey.equals(record.threadKey)) {
                return true;
            }
            if (!shadow.normalizedAddress.isEmpty() && shadow.normalizedAddress.equals(normalizedAddress)) {
                return true;
            }
        }
        return false;
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
                        true,
                        item.optString("source", inferSource(item.optString("id", ""), item.optBoolean("outgoing", false)))
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
            next.put("source", record.source);
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

    private static List<ThreadReference> threadReferences(List<Map<String, Object>> threads) {
        List<ThreadReference> refs = new ArrayList<>();
        if (threads == null) {
            return refs;
        }
        Set<String> seen = new HashSet<>();
        for (Map<String, Object> thread : threads) {
            if (thread == null) {
                continue;
            }
            String threadKey = objectString(thread.get("threadKey")).trim();
            String address = objectString(thread.get("address")).trim();
            String id = "";
            if (threadKey.startsWith("thread:")) {
                id = threadKey.substring("thread:".length()).trim();
            }
            String dedupe = threadKey + "|" + normalizeAddress(address);
            if (dedupe.trim().equals("|") || seen.contains(dedupe)) {
                continue;
            }
            refs.add(new ThreadReference(threadKey, id, address, normalizeAddress(address)));
            seen.add(dedupe);
        }
        return refs;
    }

    private static List<MessageReference> messageReferences(List<Map<String, Object>> messages) {
        List<MessageReference> refs = new ArrayList<>();
        if (messages == null) {
            return refs;
        }
        Set<String> seen = new HashSet<>();
        for (Map<String, Object> message : messages) {
            if (message == null) {
                continue;
            }
            String id = objectString(message.get("id")).trim();
            if (id.isEmpty() || seen.contains(id)) {
                continue;
            }
            refs.add(new MessageReference(id, boolValue(message.get("localOnly"))));
            seen.add(id);
        }
        return refs;
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

    private static List<ThreadShadow> loadThreadShadows(Context context, String key) {
        List<ThreadShadow> shadows = new ArrayList<>();
        if (context == null || key == null || key.trim().isEmpty()) {
            return shadows;
        }
        long retentionCutoff = System.currentTimeMillis() - LOCAL_RETENTION_MS;
        JSONArray source = parseArray(prefs(context).getString(key, "[]"));
        JSONArray retained = new JSONArray();
        for (int i = 0; i < source.length(); i += 1) {
            JSONObject item = source.optJSONObject(i);
            if (item == null) {
                continue;
            }
            long cutoffTimestamp = item.optLong("cutoffTimestamp", 0L);
            if (cutoffTimestamp <= 0L || cutoffTimestamp < retentionCutoff) {
                continue;
            }
            String threadKey = item.optString("threadKey", "").trim();
            String normalizedAddress = item.optString("normalizedAddress", "").trim();
            if (threadKey.isEmpty() && normalizedAddress.isEmpty()) {
                continue;
            }
            retained.put(item);
            shadows.add(new ThreadShadow(threadKey, normalizedAddress, cutoffTimestamp));
        }
        if (retained.length() != source.length()) {
            prefs(context).edit().putString(key, retained.toString()).apply();
        }
        return shadows;
    }

    private static void saveThreadShadows(Context context, String key, List<ThreadShadow> shadows) {
        if (context == null || key == null || key.trim().isEmpty()) {
            return;
        }
        JSONArray array = new JSONArray();
        int start = Math.max(0, shadows.size() - MAX_LOCAL_MESSAGES);
        for (int i = start; i < shadows.size(); i += 1) {
            ThreadShadow shadow = shadows.get(i);
            if (shadow == null) {
                continue;
            }
            JSONObject item = new JSONObject();
            try {
                item.put("threadKey", shadow.threadKey);
                item.put("normalizedAddress", shadow.normalizedAddress);
                item.put("cutoffTimestamp", shadow.cutoffTimestamp);
            } catch (JSONException ignored) {
            }
            array.put(item);
        }
        prefs(context).edit().putString(key, array.toString()).apply();
    }

    private static Set<String> loadDeletedMessageIds(Context context) {
        Set<String> ids = new HashSet<>();
        if (context == null) {
            return ids;
        }
        JSONArray source = parseArray(prefs(context).getString(KEY_DELETED_MESSAGE_IDS, "[]"));
        JSONArray retained = new JSONArray();
        int start = Math.max(0, source.length() - MAX_DELETED_MESSAGE_IDS);
        for (int i = start; i < source.length(); i += 1) {
            String id = source.optString(i, "").trim();
            if (id.isEmpty() || ids.contains(id)) {
                continue;
            }
            ids.add(id);
            retained.put(id);
        }
        if (retained.length() != source.length()) {
            prefs(context).edit().putString(KEY_DELETED_MESSAGE_IDS, retained.toString()).apply();
        }
        return ids;
    }

    private static void saveDeletedMessageIds(Context context, Set<String> ids) {
        if (context == null) {
            return;
        }
        JSONArray array = new JSONArray();
        List<String> ordered = new ArrayList<>(ids);
        int start = Math.max(0, ordered.size() - MAX_DELETED_MESSAGE_IDS);
        for (int i = start; i < ordered.size(); i += 1) {
            array.put(ordered.get(i));
        }
        prefs(context).edit().putString(KEY_DELETED_MESSAGE_IDS, array.toString()).apply();
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

    private static String inferSource(String id, boolean outgoing) {
        String clean = safe(id, "").toLowerCase(Locale.US);
        if (!outgoing) {
            return "device";
        }
        if (clean.startsWith("local_compose_")) {
            return "local";
        }
        if (clean.startsWith("http") || clean.contains("http")) {
            return "dashboard_http";
        }
        return "dashboard";
    }

    private static boolean boolValue(Object value) {
        if (value instanceof Boolean) {
            return (Boolean) value;
        }
        if (value instanceof String) {
            return Boolean.parseBoolean(((String) value).trim());
        }
        return false;
    }

    private static String objectString(Object value) {
        return value == null ? "" : String.valueOf(value);
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
        final String source;

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
                boolean localOnly,
                String source
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
            this.source = source == null || source.trim().isEmpty() ? "phone" : source;
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
                    localOnly,
                    source
            );
        }

        SmsRecord withRead(boolean nextRead) {
            return new SmsRecord(
                    id,
                    threadId,
                    threadKey,
                    address,
                    body,
                    timestamp,
                    outgoing,
                    nextRead,
                    status,
                    localOnly,
                    source
            );
        }

        SmsRecord withStatus(String nextStatus) {
            return new SmsRecord(
                    id,
                    threadId,
                    threadKey,
                    address,
                    body,
                    timestamp,
                    outgoing,
                    read,
                    nextStatus,
                    localOnly,
                    source
            );
        }
    }

    private static final class ThreadReference {
        final String threadKey;
        final String threadId;
        final String address;
        final String normalizedAddress;

        ThreadReference(String threadKey, String threadId, String address, String normalizedAddress) {
            this.threadKey = threadKey == null ? "" : threadKey;
            this.threadId = threadId == null ? "" : threadId;
            this.address = address == null ? "" : address;
            this.normalizedAddress = normalizedAddress == null ? "" : normalizedAddress;
        }
    }

    private static final class MessageReference {
        final String id;
        final boolean localOnly;

        MessageReference(String id, boolean localOnly) {
            this.id = id == null ? "" : id;
            this.localOnly = localOnly;
        }
    }

    private static final class ThreadShadow {
        final String threadKey;
        final String normalizedAddress;
        final long cutoffTimestamp;

        ThreadShadow(String threadKey, String normalizedAddress, long cutoffTimestamp) {
            this.threadKey = threadKey == null ? "" : threadKey.trim();
            this.normalizedAddress = normalizedAddress == null ? "" : normalizedAddress.trim();
            this.cutoffTimestamp = cutoffTimestamp;
        }
    }
}
