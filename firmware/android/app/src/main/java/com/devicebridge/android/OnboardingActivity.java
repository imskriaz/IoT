package com.devicebridge.android;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

public class OnboardingActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        BridgeEventLog.append(this, "Onboarding redirect opened");

        Intent next = new Intent(this, HomeActivity.class);
        next.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);

        String inboundToken = BridgeProvisioning.extractSetupToken(getIntent());
        if (!inboundToken.isEmpty()) {
            next.putExtra("setup_token", inboundToken);
        }

        startActivity(next);
        finish();
    }
}
