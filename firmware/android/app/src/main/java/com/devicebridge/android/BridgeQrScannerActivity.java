package com.devicebridge.android;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.google.zxing.BarcodeFormat;
import com.journeyapps.barcodescanner.BarcodeCallback;
import com.journeyapps.barcodescanner.BarcodeResult;
import com.journeyapps.barcodescanner.DecoratedBarcodeView;
import com.journeyapps.barcodescanner.DefaultDecoderFactory;

import java.util.Collections;

public class BridgeQrScannerActivity extends Activity {
    static final String EXTRA_SCAN_RESULT = "scan_result";

    private DecoratedBarcodeView barcodeView;
    private boolean delivered;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout shell = new LinearLayout(this);
        shell.setOrientation(LinearLayout.VERTICAL);
        shell.setBackgroundColor(Color.parseColor("#eef3f8"));
        shell.setPadding(
                BridgeUi.dp(this, 14),
                BridgeUi.dp(this, 14),
                BridgeUi.dp(this, 14),
                BridgeUi.dp(this, 14)
        );

        shell.addView(BridgeUi.hero(this, "Device Bridge", "Scan Setup QR", "Point the camera at the onboarding QR."));
        shell.addView(BridgeUi.sectionSpacing(this));

        TextView helper = BridgeUi.textBlock(this, 12, false);
        helper.setText("Scan the secure setup QR from the dashboard.");
        helper.setTextColor(Color.parseColor("#475569"));
        shell.addView(helper, BridgeUi.fullWidth(this));

        barcodeView = new DecoratedBarcodeView(this);
        barcodeView.getBarcodeView().setDecoderFactory(new DefaultDecoderFactory(Collections.singletonList(BarcodeFormat.QR_CODE)));
        barcodeView.setStatusText("Scanning for Device Bridge QR");
        LinearLayout.LayoutParams scannerParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f
        );
        scannerParams.bottomMargin = BridgeUi.dp(this, 10);
        shell.addView(barcodeView, scannerParams);

        LinearLayout footer = new LinearLayout(this);
        footer.setOrientation(LinearLayout.VERTICAL);

        Button cancelButton = BridgeUi.smallButton(this, "Back To Onboarding", "#e2e8f0", Color.parseColor("#0f172a"));
        cancelButton.setOnClickListener(v -> finish());
        footer.addView(cancelButton, BridgeUi.fullWidth(this));

        shell.addView(footer, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        ));

        setContentView(shell);
        barcodeView.decodeContinuous(callback);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (barcodeView != null) {
            barcodeView.resume();
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (barcodeView != null) {
            barcodeView.pause();
        }
    }

    private final BarcodeCallback callback = new BarcodeCallback() {
        @Override
        public void barcodeResult(BarcodeResult result) {
            if (delivered || result == null || result.getText() == null || result.getText().trim().isEmpty()) {
                return;
            }
            delivered = true;
            if (barcodeView != null) {
                barcodeView.pause();
            }
            Intent data = new Intent().putExtra(EXTRA_SCAN_RESULT, result.getText().trim());
            setResult(RESULT_OK, data);
            finish();
        }
    };
}


