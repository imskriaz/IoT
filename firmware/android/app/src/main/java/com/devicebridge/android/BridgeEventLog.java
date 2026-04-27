package com.devicebridge.android;

import android.content.Context;
import android.content.SharedPreferences;

import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

final class BridgeEventLog {
    private static final String PREFS = BridgeConfig.PREFS;
    private static final String KEY_LOG = "event_log";
    private static final int MAX_LINES = 500;
    private static final long RETENTION_WINDOW_MS = 24L * 60L * 60L * 1000L;
    private static final long DEDUPE_WINDOW_MS = 15_000L;
    private static final String TIMESTAMP_PATTERN = "yyyy-MM-dd HH:mm:ss";

    private BridgeEventLog() {
    }

    static void append(Context context, String message) {
        if (context == null || message == null) {
            return;
        }

        String normalizedMessage = normalizeMessage(message);
        if (normalizedMessage.isEmpty()) {
            return;
        }

        String line = timestamp() + "  " + message.trim();
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String current = prefs.getString(KEY_LOG, "");
        String[] lines = current == null || current.trim().isEmpty()
                ? new String[0]
                : current.trim().split("\\n");
        long cutoffMs = System.currentTimeMillis() - RETENTION_WINDOW_MS;
        long dedupeCutoffMs = System.currentTimeMillis() - DEDUPE_WINDOW_MS;
        StringBuilder trimmed = new StringBuilder();
        int kept = 0;
        boolean duplicateDetected = false;
        for (String existing : lines) {
            if (existing == null || existing.trim().isEmpty()) {
                continue;
            }
            long lineTimestamp = timestampForLine(existing);
            if (lineTimestamp > 0L && lineTimestamp < cutoffMs) {
                continue;
            }
            if (!duplicateDetected
                    && lineTimestamp >= dedupeCutoffMs
                    && normalizedMessage.equals(normalizeMessage(extractMessage(existing)))) {
                duplicateDetected = true;
            }
            if (trimmed.length() > 0) {
                trimmed.append('\n');
            }
            trimmed.append(existing.trim());
            kept += 1;
        }

        if (duplicateDetected) {
            prefs.edit().putString(KEY_LOG, trimmed.toString()).apply();
            return;
        }

        if (trimmed.length() > 0) {
            trimmed.append('\n');
        }
        trimmed.append(line);
        kept += 1;

        if (kept > MAX_LINES) {
            String[] retainedLines = trimmed.toString().split("\\n");
            StringBuilder bounded = new StringBuilder();
            for (int i = Math.max(0, retainedLines.length - MAX_LINES); i < retainedLines.length; i += 1) {
                if (bounded.length() > 0) {
                    bounded.append('\n');
                }
                bounded.append(retainedLines[i]);
            }
            prefs.edit().putString(KEY_LOG, bounded.toString()).apply();
            BridgeSessionLog.append(context, "event", message.trim());
            BridgeAppEvents.notifyStateChanged(context, "console");
            return;
        }

        prefs.edit().putString(KEY_LOG, trimmed.toString()).apply();
        BridgeSessionLog.append(context, "event", message.trim());
        BridgeAppEvents.notifyStateChanged(context, "console");
    }

    static String read(Context context) {
        if (context == null) {
            return "";
        }
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_LOG, "");
    }

    static void clear(Context context) {
        if (context == null) {
            return;
        }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY_LOG).apply();
        BridgeSessionLog.append(context, "event", "Console cleared");
        BridgeAppEvents.notifyStateChanged(context, "console_cleared");
    }

    private static String timestamp() {
        return new SimpleDateFormat(TIMESTAMP_PATTERN, Locale.US).format(new Date());
    }

    private static long timestampForLine(String line) {
        if (line == null || line.length() < 19) {
            return 0L;
        }
        String candidate = line.substring(0, 19);
        try {
            Date parsed = new SimpleDateFormat(TIMESTAMP_PATTERN, Locale.US).parse(candidate);
            return parsed == null ? 0L : parsed.getTime();
        } catch (ParseException ignored) {
            return 0L;
        }
    }

    private static String extractMessage(String line) {
        if (line == null) {
            return "";
        }
        if (line.length() > 21 && Character.isDigit(line.charAt(0))) {
            return line.substring(21).trim();
        }
        return line.trim();
    }

    private static String normalizeMessage(String message) {
        if (message == null) {
            return "";
        }
        return message.trim().replaceAll("\\s+", " ").toLowerCase(Locale.US);
    }
}


