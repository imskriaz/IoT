package com.devicebridge.android;

import android.content.Context;

import java.io.BufferedWriter;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

final class BridgeSessionLog {
    private static final String FILE_NAME = "bridge-session.log";
    private static final long MAX_BYTES = 256L * 1024L;
    private static final int MAX_TAIL_LINES = 180;
    private static final Object LOCK = new Object();
    private static final String TIMESTAMP_PATTERN = "yyyy-MM-dd HH:mm:ss.SSS";

    private BridgeSessionLog() {
    }

    static void reset(Context context, String reason) {
        if (context == null) {
            return;
        }
        synchronized (LOCK) {
            File file = logFile(context);
            try {
                File parent = file.getParentFile();
                if (parent != null && !parent.exists()) {
                    parent.mkdirs();
                }
                try (FileOutputStream outputStream = new FileOutputStream(file, false)) {
                    outputStream.write(new byte[0]);
                }
            } catch (Exception ignored) {
            }
            append(context, "session", "Session started" + suffix(reason));
        }
    }

    static void append(Context context, String category, String message) {
        if (context == null || message == null || message.trim().isEmpty()) {
            return;
        }
        synchronized (LOCK) {
            File file = logFile(context);
            try {
                File parent = file.getParentFile();
                if (parent != null && !parent.exists()) {
                    parent.mkdirs();
                }
                if (file.exists() && file.length() > MAX_BYTES) {
                    trimToTail(file);
                }
                try (BufferedWriter writer = new BufferedWriter(
                        new OutputStreamWriter(new FileOutputStream(file, true), StandardCharsets.UTF_8))) {
                    writer.write(timestamp());
                    writer.write("  ");
                    String normalizedCategory = category == null ? "" : category.trim();
                    if (!normalizedCategory.isEmpty()) {
                        writer.write(normalizedCategory);
                        writer.write(": ");
                    }
                    writer.write(message.trim());
                    writer.newLine();
                }
            } catch (Exception ignored) {
            }
        }
    }

    static void appendCrash(Context context, Throwable error, String origin) {
        if (context == null || error == null) {
            return;
        }
        StringBuilder builder = new StringBuilder();
        builder.append("Uncaught exception");
        if (origin != null && !origin.trim().isEmpty()) {
            builder.append(" in ").append(origin.trim());
        }
        builder.append(": ").append(error.getClass().getSimpleName());
        if (error.getMessage() != null && !error.getMessage().trim().isEmpty()) {
            builder.append(" :: ").append(error.getMessage().trim());
        }
        append(context, "crash", builder.toString());
        for (StackTraceElement element : error.getStackTrace()) {
            append(context, "crash", "at " + String.valueOf(element));
        }
        Throwable cause = error.getCause();
        if (cause != null && cause != error) {
            append(context, "crash", "caused by " + cause.getClass().getSimpleName()
                    + (cause.getMessage() == null ? "" : " :: " + cause.getMessage()));
            for (StackTraceElement element : cause.getStackTrace()) {
                append(context, "crash", "at " + String.valueOf(element));
            }
        }
    }

    static String readTail(Context context, int maxLines) {
        if (context == null) {
            return "No session log available.";
        }
        synchronized (LOCK) {
            File file = logFile(context);
            if (!file.exists()) {
                return "No session log available.";
            }
            try (FileInputStream inputStream = new FileInputStream(file)) {
                byte[] data = new byte[(int) Math.min(Integer.MAX_VALUE, file.length())];
                int read = inputStream.read(data);
                if (read <= 0) {
                    return "No session log available.";
                }
                String raw = new String(data, 0, read, StandardCharsets.UTF_8).trim();
                if (raw.isEmpty()) {
                    return "No session log available.";
                }
                String[] lines = raw.split("\\r?\\n");
                int start = Math.max(0, lines.length - Math.max(1, maxLines));
                StringBuilder builder = new StringBuilder();
                for (int i = start; i < lines.length; i += 1) {
                    if (builder.length() > 0) {
                        builder.append('\n');
                    }
                    builder.append(lines[i]);
                }
                return builder.toString();
            } catch (Exception ignored) {
                return "No session log available.";
            }
        }
    }

    static String path(Context context) {
        return logFile(context).getAbsolutePath();
    }

    private static File logFile(Context context) {
        return new File(context.getFilesDir(), FILE_NAME);
    }

    private static void trimToTail(File file) {
        try (FileInputStream inputStream = new FileInputStream(file)) {
            byte[] data = new byte[(int) Math.min(Integer.MAX_VALUE, file.length())];
            int read = inputStream.read(data);
            if (read <= 0) {
                return;
            }
            String raw = new String(data, 0, read, StandardCharsets.UTF_8);
            String[] lines = raw.split("\\r?\\n");
            int start = Math.max(0, lines.length - MAX_TAIL_LINES);
            StringBuilder builder = new StringBuilder();
            for (int i = start; i < lines.length; i += 1) {
                if (lines[i] == null || lines[i].trim().isEmpty()) {
                    continue;
                }
                if (builder.length() > 0) {
                    builder.append('\n');
                }
                builder.append(lines[i]);
            }
            try (FileOutputStream outputStream = new FileOutputStream(file, false)) {
                outputStream.write(builder.toString().getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception ignored) {
        }
    }

    private static String timestamp() {
        return new SimpleDateFormat(TIMESTAMP_PATTERN, Locale.US).format(new Date());
    }

    private static String suffix(String reason) {
        if (reason == null || reason.trim().isEmpty()) {
            return "";
        }
        return " :: " + reason.trim();
    }
}
