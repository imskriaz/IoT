package com.devicebridge.android;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

public class MainActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        launchNext();
    }

    @Override
    protected void onResume() {
        super.onResume();
        launchNext();
    }

    private void launchNext() {
        if (BridgeAppGate.routeFromStartup(this)) {
            return;
        }
        startActivity(new Intent(this, FlutterHomeActivity.class));
        finish();
    }
}
