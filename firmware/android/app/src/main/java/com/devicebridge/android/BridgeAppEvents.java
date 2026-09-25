package com.devicebridge.android;

import android.content.Context;
import android.content.Intent;

final class BridgeAppEvents {
    static final String ACTION_STATE_CHANGED = "com.devicebridge.android.STATE_CHANGED";
    static final String EXTRA_REASON = "reason";

    private BridgeAppEvents() {
    }

    static void notifyStateChanged(Context context, String reason) {
        if (context == null) {
            return;
        }
        Intent intent = new Intent(ACTION_STATE_CHANGED);
        intent.setPackage(context.getPackageName());
        intent.putExtra(EXTRA_REASON, reason == null ? "" : reason.trim());
        context.sendBroadcast(intent);
    }
}
