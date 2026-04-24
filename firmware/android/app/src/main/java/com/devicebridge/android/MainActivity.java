package com.devicebridge.android;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

public class MainActivity extends Activity {
    static final String EXTRA_RUN_SELF_SMS_TEST = "run_self_sms_test";
    private boolean launchedNext;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        launchNext();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        launchedNext = false;
        launchNext();
    }

    private void launchNext() {
        if (launchedNext || isFinishing()) {
            return;
        }
        launchedNext = true;
        if (BridgeAppGate.routeFromStartup(this)) {
            launchedNext = false;
            return;
        }
        Intent intent = new Intent(this, HomeActivity.class);
        if (getIntent() != null && getIntent().getBooleanExtra(EXTRA_RUN_SELF_SMS_TEST, false)) {
            intent.putExtra(EXTRA_RUN_SELF_SMS_TEST, true);
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        startActivity(intent);
        finish();
    }
}
