package com.devicebridge.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.zip.Deflater;

import org.junit.Test;

/**
 * AND-03 provisioning input bounds (pure JVM).
 *
 * Setup codes are small deflated JSON documents carried as URL-safe base64,
 * optionally behind a `k:` scheme. These tests pin the three hard caps
 * (12KB code, 8KB compressed, 64KB decompressed) and the decode/inflate
 * failure behaviour so the deep-link import cannot be used as a decompression
 * bomb or an unbounded parse on the UI thread.
 */
public class BridgeProvisioningTest {

    private static String encodeSetupCode(String json) throws Exception {
        Deflater deflater = new Deflater(Deflater.BEST_COMPRESSION, true);
        deflater.setInput(json.getBytes(StandardCharsets.UTF_8));
        deflater.finish();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[256];
        while (!deflater.finished()) {
            int count = deflater.deflate(buffer);
            if (count > 0) {
                out.write(buffer, 0, count);
            }
        }
        deflater.end();
        return Base64.getUrlEncoder().withoutPadding().encodeToString(out.toByteArray());
    }

    @Test
    public void decodesValidSetupCode() throws Exception {
        String json = "{\"di\":\"dev-42\",\"tm\":\"mqtt\",\"mh\":\"broker.example.com\",\"mp\":1883}";
        String decoded = BridgeProvisioning.decodeProvisioningText(encodeSetupCode(json));
        assertEquals(json, decoded);
    }

    @Test
    public void stripsKSchemePrefix() throws Exception {
        String json = "{\"di\":\"dev-42\"}";
        assertEquals(json, BridgeProvisioning.decodeProvisioningText("k:" + encodeSetupCode(json)));
    }

    @Test
    public void rejectsMissingSetupCode() {
        try {
            BridgeProvisioning.decodeProvisioningText("");
            fail("expected IllegalArgumentException");
        } catch (IllegalArgumentException expected) {
            assertEquals("Missing setup code", expected.getMessage());
        }
    }

    @Test
    public void rejectsOversizeCodeText() {
        StringBuilder big = new StringBuilder();
        for (int i = 0; i < (12 * 1024 + 64) / 64; i++) {
            big.append("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
        }
        try {
            BridgeProvisioning.decodeProvisioningText(big.toString());
            fail("expected IllegalArgumentException");
        } catch (IllegalArgumentException expected) {
            assertEquals("Setup code too large", expected.getMessage());
        }
    }

    @Test
    public void rejectsOversizeCompressedPayload() {
        // A valid-base64 blob whose decoded size exceeds the 8KB compressed cap.
        byte[] raw = new byte[9 * 1024];
        String encoded = Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
        try {
            BridgeProvisioning.decodeProvisioningText(encoded);
            fail("expected IllegalArgumentException");
        } catch (IllegalArgumentException expected) {
            assertEquals("Setup code too large", expected.getMessage());
        }
    }

    @Test
    public void rejectsDecompressionBomb() throws Exception {
        // ~100KB of compressible text inside a tiny compressed payload.
        StringBuilder bomb = new StringBuilder();
        for (int i = 0; i < 2048; i++) {
            bomb.append("0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDE");
        }
        String encoded = encodeSetupCode(bomb.toString());
        assertNotNull(encoded);
        try {
            BridgeProvisioning.decodeProvisioningText(encoded);
            fail("expected IllegalArgumentException");
        } catch (IllegalArgumentException expected) {
            assertEquals("Setup code too large", expected.getMessage());
        }
    }

    @Test
    public void rejectsInvalidBase64() {
        try {
            BridgeProvisioning.decodeProvisioningText("!!!not-base64!!!");
            fail("expected IllegalArgumentException");
        } catch (IllegalArgumentException expected) {
            assertEquals("Invalid setup code.", expected.getMessage());
        }
    }

    @Test
    public void describeSummarizesValidPayloadWithoutSaving() throws Exception {
        String json = "{\"di\":\"dev-42\",\"tm\":\"mqtt\",\"mh\":\"broker.example.com\","
                + "\"su\":\"https://dashboard.example.com\",\"ek\":\"key\"}";
        String summary = BridgeProvisioning.describeProvisioningPayload(encodeSetupCode(json));

        assertTrue(summary.contains("Device: dev-42"));
        assertTrue(summary.contains("Transport: mqtt"));
        assertTrue(summary.contains("Broker: broker.example.com"));
        assertTrue(summary.contains("Server: https://…"));
        assertTrue(summary.contains("SMS encryption: enabled"));
        // A describe must never contain the raw secret material.
        assertTrue(!summary.contains("\"ek\""));
    }

    @Test
    public void describeMarksMissingFieldsExplicitly() throws Exception {
        String json = "{}";
        String summary = BridgeProvisioning.describeProvisioningPayload(encodeSetupCode(json));
        assertTrue(summary.contains("Device: (not set)"));
        assertTrue(summary.contains("Transport: auto"));
    }
}
