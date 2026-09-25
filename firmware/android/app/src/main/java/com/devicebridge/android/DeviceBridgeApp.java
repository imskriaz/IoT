package com.devicebridge.android;

import android.app.Application;

public class DeviceBridgeApp extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        BridgeSessionLog.reset(this, "process_create");
        installCrashLogging();
    }

    private void installCrashLogging() {
        Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            BridgeSessionLog.appendCrash(this, error, thread == null ? "unknown-thread" : thread.getName());
            if (previous != null) {
                previous.uncaughtException(thread, error);
            }
        });
    }
}
