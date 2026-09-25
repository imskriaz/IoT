package com.devicebridge.android;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;

/** Crash-safe, bounded bridge outbox. */
final class BridgeOutbox {
    private static final String FILE_NAME = "bridge_outbox.json";
    private static final int SCHEMA_VERSION = 2;
    static final int MAX_PUBLISH_ENTRIES = 200;
    static final int MAX_TERMINAL_ENTRIES = 100;
    private static final Object IO_LOCK = new Object();

    static final class PublishEntry {
        final String id;
        final String topic;
        final String payload;
        final long createdAtMs;

        PublishEntry(String id, String topic, String payload, long createdAtMs) {
            this.id = id == null ? "" : id;
            this.topic = topic == null ? "" : topic;
            this.payload = payload == null ? "" : payload;
            this.createdAtMs = createdAtMs;
        }

        /** Compatibility constructor for the in-memory queue drain. */
        PublishEntry(String topic, String payload) {
            this("p_" + UUID.randomUUID(), topic, payload, System.currentTimeMillis());
        }
    }

    static final class TerminalEntry {
        final String id;
        final String actionId;
        final String payloadJson;
        final long createdAtMs;

        TerminalEntry(String id, String actionId, String payloadJson, long createdAtMs) {
            this.id = id == null ? "" : id;
            this.actionId = actionId == null ? "" : actionId;
            this.payloadJson = payloadJson == null ? "" : payloadJson;
            this.createdAtMs = createdAtMs;
        }
    }

    private BridgeOutbox() {
    }

    private static File fileFor(Context context) {
        return new File(context.getApplicationContext().getFilesDir(), FILE_NAME);
    }

    private static JSONObject empty() throws Exception {
        JSONObject json = new JSONObject();
        json.put("schema", SCHEMA_VERSION);
        json.put("publishes", new JSONArray());
        json.put("terminals", new JSONArray());
        return json;
    }

    private static JSONObject loadStrict(File file) throws Exception {
        if (!file.exists()) return empty();
        if (file.length() <= 0L) throw new IllegalStateException("outbox_empty_file");
        String text = new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8).trim();
        if (text.isEmpty() || text.indexOf('\u0000') >= 0) {
            throw new IllegalStateException("outbox_corrupt_file");
        }
        JSONObject parsed = new JSONObject(text);
        if (!(parsed.opt("publishes") instanceof JSONArray)
                || !(parsed.opt("terminals") instanceof JSONArray)) {
            throw new IllegalStateException("outbox_invalid_schema");
        }
        return parsed;
    }

    private static boolean saveAtomic(File file, JSONObject root) {
        File parent = file.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) return false;
        File temporary = new File(file.getAbsolutePath() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(temporary, false)) {
            out.write(root.toString().getBytes(StandardCharsets.UTF_8));
            out.flush();
            out.getFD().sync();
        } catch (Exception error) {
            //noinspection ResultOfMethodCallIgnored
            temporary.delete();
            return false;
        }
        try {
            try {
                Files.move(temporary.toPath(), file.toPath(),
                        StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException unsupported) {
                Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING);
            }
            return true;
        } catch (Exception error) {
            //noinspection ResultOfMethodCallIgnored
            temporary.delete();
            return false;
        }
    }

    /** Adds work or refuses it. Existing unacknowledged entries are never evicted. */
    static boolean recordPublish(Context context, String topic, String payload) {
        return context != null && recordPublish(fileFor(context), topic, payload);
    }

    static boolean recordPublish(File file, String topic, String payload) {
        if (file == null || topic == null || topic.trim().isEmpty() || payload == null || payload.isEmpty()) return false;
        synchronized (IO_LOCK) {
            try {
                JSONObject root = loadStrict(file);
                JSONArray publishes = root.getJSONArray("publishes");
                if (publishes.length() >= MAX_PUBLISH_ENTRIES) return false;
                JSONObject entry = new JSONObject();
                entry.put("id", "p_" + UUID.randomUUID());
                entry.put("topic", topic);
                entry.put("payload", payload);
                entry.put("createdAtMs", System.currentTimeMillis());
                publishes.put(entry);
                root.put("schema", SCHEMA_VERSION);
                return saveAtomic(file, root);
            } catch (Exception error) {
                return false;
            }
        }
    }

    static boolean recordTerminalResult(Context context, String actionId, String payloadJson) {
        return context != null && recordTerminalResult(fileFor(context), actionId, payloadJson);
    }

    static boolean recordTerminalResult(File file, String actionId, String payloadJson) {
        String cleanActionId = actionId == null ? "" : actionId.trim();
        if (file == null || cleanActionId.isEmpty() || payloadJson == null || payloadJson.isEmpty()) return false;
        synchronized (IO_LOCK) {
            try {
                JSONObject root = loadStrict(file);
                JSONArray terminals = root.getJSONArray("terminals");
                for (int i = 0; i < terminals.length(); i++) {
                    JSONObject existing = terminals.optJSONObject(i);
                    if (existing != null && cleanActionId.equals(existing.optString("actionId", ""))) {
                        // Terminal identity is immutable. Identical duplicate callbacks are idempotent.
                        return payloadJson.equals(existing.optString("payload", ""));
                    }
                }
                if (terminals.length() >= MAX_TERMINAL_ENTRIES) return false;
                JSONObject entry = new JSONObject();
                entry.put("id", "t_" + UUID.randomUUID());
                entry.put("actionId", cleanActionId);
                entry.put("payload", payloadJson);
                entry.put("createdAtMs", System.currentTimeMillis());
                terminals.put(entry);
                root.put("schema", SCHEMA_VERSION);
                return saveAtomic(file, root);
            } catch (Exception error) {
                return false;
            }
        }
    }

    static List<PublishEntry> loadPublishes(Context context) {
        return context == null ? Collections.emptyList() : loadPublishes(fileFor(context));
    }

    static List<PublishEntry> loadPublishes(File file) {
        synchronized (IO_LOCK) {
            try {
                JSONArray source = loadStrict(file).getJSONArray("publishes");
                List<PublishEntry> entries = new ArrayList<>();
                for (int i = 0; i < source.length(); i++) {
                    JSONObject entry = source.optJSONObject(i);
                    if (entry == null) continue;
                    String topic = entry.optString("topic", "");
                    String payload = entry.optString("payload", "");
                    if (topic.isEmpty() || payload.isEmpty()) continue;
                    entries.add(new PublishEntry(
                            stableId(entry.optString("id", ""), "p", topic, payload, i),
                            topic, payload, entry.optLong("createdAtMs", 0L)));
                }
                return entries;
            } catch (Exception error) {
                return Collections.emptyList();
            }
        }
    }

    static List<TerminalEntry> peekTerminalResults(Context context) {
        return context == null ? Collections.emptyList() : peekTerminalResults(fileFor(context));
    }

    static List<TerminalEntry> peekTerminalResults(File file) {
        synchronized (IO_LOCK) {
            try {
                JSONArray source = loadStrict(file).getJSONArray("terminals");
                List<TerminalEntry> entries = new ArrayList<>();
                for (int i = 0; i < source.length(); i++) {
                    JSONObject entry = source.optJSONObject(i);
                    if (entry == null) continue;
                    String actionId = entry.optString("actionId", "");
                    String payload = entry.optString("payload", "");
                    if (actionId.isEmpty() || payload.isEmpty()) continue;
                    entries.add(new TerminalEntry(
                            stableId(entry.optString("id", ""), "t", actionId, payload, i),
                            actionId, payload, entry.optLong("createdAtMs", 0L)));
                }
                return entries;
            } catch (Exception error) {
                return Collections.emptyList();
            }
        }
    }

    /**
     * Compatibility read for older service code. Callers must acknowledge each
     * entry with acknowledgeTerminal after the transport has accepted it.
     */
    static List<TerminalEntry> takeTerminalResults(Context context) {
        return peekTerminalResults(context);
    }

    /** Atomically replaces the publish snapshot; never evicts an entry silently. */
    static boolean replacePublishes(Context context, List<PublishEntry> entries) {
        if (context == null || entries == null || entries.size() > MAX_PUBLISH_ENTRIES) return false;
        synchronized (IO_LOCK) {
            try {
                JSONObject root = loadStrict(fileFor(context));
                JSONArray publishes = new JSONArray();
                for (PublishEntry entry : entries) {
                    if (entry == null || entry.topic.isEmpty() || entry.payload.isEmpty()) return false;
                    JSONObject json = new JSONObject();
                    json.put("id", entry.id.isEmpty() ? "p_" + UUID.randomUUID() : entry.id);
                    json.put("topic", entry.topic);
                    json.put("payload", entry.payload);
                    json.put("createdAtMs", entry.createdAtMs);
                    publishes.put(json);
                }
                root.put("schema", SCHEMA_VERSION);
                root.put("publishes", publishes);
                return saveAtomic(fileFor(context), root);
            } catch (Exception error) {
                return false;
            }
        }
    }

    static boolean acknowledgePublish(Context context, String id) {
        return context != null && acknowledge(fileFor(context), "publishes", id, "p");
    }

    static boolean acknowledgePublish(File file, String id) {
        return acknowledge(file, "publishes", id, "p");
    }

    static boolean acknowledgeTerminal(Context context, String id) {
        return context != null && acknowledge(fileFor(context), "terminals", id, "t");
    }

    static boolean acknowledgeTerminal(File file, String id) {
        return acknowledge(file, "terminals", id, "t");
    }

    /** Removes the unique terminal record for an action after a live publish.
     * Terminal entry IDs are generated by the journal and are unavailable to
     * the command callback that originally created the record, so action ID is
     * the stable correlation key for this path. */
    static boolean acknowledgeTerminalByActionId(Context context, String actionId) {
        return context != null && acknowledgeTerminalByActionId(fileFor(context), actionId);
    }

    static boolean acknowledgeTerminalByActionId(File file, String actionId) {
        String cleanActionId = actionId == null ? "" : actionId.trim();
        if (file == null || cleanActionId.isEmpty()) return false;
        synchronized (IO_LOCK) {
            try {
                JSONObject root = loadStrict(file);
                JSONArray source = root.getJSONArray("terminals");
                JSONArray retained = new JSONArray();
                boolean found = false;
                for (int i = 0; i < source.length(); i++) {
                    JSONObject entry = source.optJSONObject(i);
                    if (entry == null) continue;
                    if (!found && cleanActionId.equals(entry.optString("actionId", ""))) {
                        found = true;
                    } else {
                        retained.put(entry);
                    }
                }
                if (!found) return false;
                root.put("terminals", retained);
                root.put("schema", SCHEMA_VERSION);
                return saveAtomic(file, root);
            } catch (Exception error) {
                return false;
            }
        }
    }

    private static boolean acknowledge(File file, String arrayName, String id, String prefix) {
        if (file == null || id == null || id.trim().isEmpty()) return false;
        synchronized (IO_LOCK) {
            try {
                JSONObject root = loadStrict(file);
                JSONArray source = root.getJSONArray(arrayName);
                JSONArray retained = new JSONArray();
                boolean found = false;
                for (int i = 0; i < source.length(); i++) {
                    JSONObject entry = source.optJSONObject(i);
                    if (entry == null) continue;
                    String left = "publishes".equals(arrayName)
                            ? entry.optString("topic", "") : entry.optString("actionId", "");
                    String payload = entry.optString("payload", "");
                    String entryId = stableId(entry.optString("id", ""), prefix, left, payload, i);
                    if (!found && id.equals(entryId)) found = true;
                    else retained.put(entry);
                }
                if (!found) return false;
                root.put(arrayName, retained);
                root.put("schema", SCHEMA_VERSION);
                return saveAtomic(file, root);
            } catch (Exception error) {
                return false;
            }
        }
    }

    private static String stableId(String id, String prefix, String left, String payload, int index) {
        if (id != null && !id.trim().isEmpty()) return id.trim();
        String material = prefix + "\n" + left + "\n" + payload + "\n" + index;
        return "legacy_" + prefix + "_" + Integer.toUnsignedString(material.hashCode(), 16);
    }

    static boolean clearAll(Context context) {
        if (context == null) return false;
        synchronized (IO_LOCK) {
            try {
                return saveAtomic(fileFor(context), empty());
            } catch (Exception error) {
                return false;
            }
        }
    }
}
