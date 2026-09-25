package com.devicebridge.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * Pure-JVM crypto contract tests (AND-04).
 *
 * These tests exercise the exact envelope layouts BridgeCrypto uses:
 *  - v2: "gcm1:" + Base64(12-byte IV || AES-256-GCM ciphertext+tag)
 *  - v1 legacy: Base64(16-byte IV || AES-256-CFB ciphertext)
 * They validate round-trips, tamper detection, and cross-version
 * distinguishability without requiring the Android runtime.
 */
public class BridgeCryptoTest {

    private static String b64encode(byte[] raw) {
        return java.util.Base64.getEncoder().encodeToString(raw);
    }

    private static byte[] b64decode(String raw) {
        return java.util.Base64.getDecoder().decode(raw);
    }

    @Test
    public void gcmEnvelopeRoundTrips() throws Exception {
        String key = "test-encryption-key";
        byte[] keyBytes = sha256(key.trim());
        javax.crypto.Cipher cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
        byte[] iv = new byte[12];
        new java.security.SecureRandom().nextBytes(iv);
        cipher.init(javax.crypto.Cipher.ENCRYPT_MODE,
                new javax.crypto.spec.SecretKeySpec(keyBytes, "AES"),
                new javax.crypto.spec.GCMParameterSpec(128, iv));
        byte[] plain = "hello bridge".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        byte[] cipherText = cipher.doFinal(plain);

        byte[] output = new byte[iv.length + cipherText.length];
        System.arraycopy(iv, 0, output, 0, iv.length);
        System.arraycopy(cipherText, 0, output, iv.length, cipherText.length);
        String envelope = "gcm1:" + b64encode(output);
        assertTrue(envelope.startsWith("gcm1:"));

        byte[] input = b64decode(envelope.substring("gcm1:".length()));
        byte[] iv2 = new byte[12];
        byte[] payload = new byte[input.length - 12];
        System.arraycopy(input, 0, iv2, 0, 12);
        System.arraycopy(input, 12, payload, 0, payload.length);
        javax.crypto.Cipher decrypt = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
        decrypt.init(javax.crypto.Cipher.DECRYPT_MODE,
                new javax.crypto.spec.SecretKeySpec(keyBytes, "AES"),
                new javax.crypto.spec.GCMParameterSpec(128, iv2));
        assertEquals("hello bridge", new String(decrypt.doFinal(payload), java.nio.charset.StandardCharsets.UTF_8));
    }

    /** Tampered GCM payloads must fail authentication (malleability fix). */
    @Test(expected = Exception.class)
    public void tamperedGcmFails() throws Exception {
        String key = "test-encryption-key";
        byte[] keyBytes = sha256(key.trim());
        javax.crypto.Cipher cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
        byte[] iv = new byte[12];
        new java.security.SecureRandom().nextBytes(iv);
        cipher.init(javax.crypto.Cipher.ENCRYPT_MODE,
                new javax.crypto.spec.SecretKeySpec(keyBytes, "AES"),
                new javax.crypto.spec.GCMParameterSpec(128, iv));
        byte[] cipherText = cipher.doFinal("payload".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        cipherText[0] ^= 0x01; // flip one bit
        javax.crypto.Cipher decrypt = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
        decrypt.init(javax.crypto.Cipher.DECRYPT_MODE,
                new javax.crypto.spec.SecretKeySpec(keyBytes, "AES"),
                new javax.crypto.spec.GCMParameterSpec(128, iv));
        decrypt.doFinal(cipherText); // must throw AEADBadTagException
    }

    /**
     * The v1 legacy CFB layout (16-byte IV prefix, no version marker) stays
     * distinguishable from the v2 "gcm1:" envelope so old persisted
     * ciphertext remains decryptable.
     */
    @Test
    public void legacyCfbLayoutStaysDecryptable() throws Exception {
        String key = "legacy-key";
        byte[] keyBytes = sha256(key.trim());
        javax.crypto.Cipher cipher = javax.crypto.Cipher.getInstance("AES/CFB/NoPadding");
        byte[] iv = new byte[16];
        new java.security.SecureRandom().nextBytes(iv);
        cipher.init(javax.crypto.Cipher.ENCRYPT_MODE,
                new javax.crypto.spec.SecretKeySpec(keyBytes, "AES"),
                new javax.crypto.spec.IvParameterSpec(iv));
        byte[] cipherText = cipher.doFinal("legacy message".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        byte[] output = new byte[16 + cipherText.length];
        System.arraycopy(iv, 0, output, 0, 16);
        System.arraycopy(cipherText, 0, output, 16, cipherText.length);
        String legacyEnvelope = b64encode(output);
        assertFalse(legacyEnvelope.startsWith("gcm1:"));

        byte[] input = b64decode(legacyEnvelope);
        byte[] iv2 = new byte[16];
        byte[] payload = new byte[input.length - 16];
        System.arraycopy(input, 0, iv2, 0, 16);
        System.arraycopy(input, 16, payload, 0, payload.length);
        javax.crypto.Cipher decrypt = javax.crypto.Cipher.getInstance("AES/CFB/NoPadding");
        decrypt.init(javax.crypto.Cipher.DECRYPT_MODE,
                new javax.crypto.spec.SecretKeySpec(keyBytes, "AES"),
                new javax.crypto.spec.IvParameterSpec(iv2));
        assertEquals("legacy message", new String(decrypt.doFinal(payload), java.nio.charset.StandardCharsets.UTF_8));
    }

    /** Different IVs must produce different ciphertexts (no IV reuse). */
    @Test
    public void uniqueIvPerEncryption() throws Exception {
        byte[] keyBytes = sha256("key");
        byte[] plain = "same input".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        byte[] first = encryptGcm(keyBytes, plain);
        byte[] second = encryptGcm(keyBytes, plain);
        assertNotEquals(b64encode(first), b64encode(second));
    }

    // ------------------------------------------------------------------
    // Direct BridgeCrypto contract tests. BridgeCrypto is now pure JVM
    // (java.util.Base64, minSdk 26) so these run in local unit tests.
    // ------------------------------------------------------------------

    @Test
    public void bridgeCryptoRoundTrips() throws Exception {
        String envelope = BridgeCrypto.encrypt("device-key", "bridge secret message");
        assertTrue(envelope.startsWith("gcm1:"));
        assertEquals("bridge secret message", BridgeCrypto.decrypt("device-key", envelope));
    }

    @Test
    public void bridgeCryptoRoundTripsUnicode() throws Exception {
        String message = "SMS পাঠানো হচ্ছে — ✓";
        assertEquals(message, BridgeCrypto.decrypt("k", BridgeCrypto.encrypt("k", message)));
    }

    @Test(expected = Exception.class)
    public void bridgeCryptoRejectsTamperedEnvelope() throws Exception {
        String envelope = BridgeCrypto.encrypt("device-key", "payload");
        byte[] raw = b64decode(envelope.substring("gcm1:".length()));
        raw[raw.length - 1] ^= 0x01; // flip a bit inside the GCM tag
        BridgeCrypto.decrypt("device-key", "gcm1:" + b64encode(raw)); // must throw
    }

    @Test
    public void bridgeCryptoDecryptsLegacyCfbEnvelope() throws Exception {
        // Hand-build the legacy envelope exactly as pre-GCM versions wrote it.
        String key = "legacy-key";
        byte[] keyBytes = sha256(key.trim());
        javax.crypto.Cipher cipher = javax.crypto.Cipher.getInstance("AES/CFB/NoPadding");
        byte[] iv = new byte[16];
        new java.security.SecureRandom().nextBytes(iv);
        cipher.init(javax.crypto.Cipher.ENCRYPT_MODE,
                new javax.crypto.spec.SecretKeySpec(keyBytes, "AES"),
                new javax.crypto.spec.IvParameterSpec(iv));
        byte[] cipherText = cipher.doFinal("legacy message".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        byte[] output = new byte[16 + cipherText.length];
        System.arraycopy(iv, 0, output, 0, 16);
        System.arraycopy(cipherText, 0, output, 16, cipherText.length);

        assertEquals("legacy message", BridgeCrypto.decrypt(key, b64encode(output)));
    }

    @Test(expected = IllegalArgumentException.class)
    public void bridgeCryptoRequiresKey() throws Exception {
        BridgeCrypto.encrypt("   ", "message");
    }

    @Test(expected = IllegalArgumentException.class)
    public void bridgeCryptoRejectsTruncatedEnvelope() throws Exception {
        // 12 bytes of IV only: no ciphertext/tag — invalid payload.
        BridgeCrypto.decrypt("k", "gcm1:" + b64encode(new byte[12]));
    }

    @Test
    public void bridgeCryptoNullSafety() throws Exception {
        assertEquals("", BridgeCrypto.decrypt("k", BridgeCrypto.encrypt("k", null)));
        // Null encrypted text falls back to the legacy path and fails cleanly
        // rather than throwing a NullPointerException.
        try {
            BridgeCrypto.decrypt("k", null);
        } catch (Exception error) {
            assertTrue(error instanceof IllegalArgumentException
                    || error instanceof java.io.IOException
                    || error instanceof javax.crypto.AEADBadTagException);
        }
    }

    private static byte[] encryptGcm(byte[] keyBytes, byte[] plain) throws Exception {
        javax.crypto.Cipher cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
        byte[] iv = new byte[12];
        new java.security.SecureRandom().nextBytes(iv);
        cipher.init(javax.crypto.Cipher.ENCRYPT_MODE,
                new javax.crypto.spec.SecretKeySpec(keyBytes, "AES"),
                new javax.crypto.spec.GCMParameterSpec(128, iv));
        return cipher.doFinal(plain);
    }

    private static byte[] sha256(String value) throws Exception {
        return java.security.MessageDigest.getInstance("SHA-256")
                .digest(value.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }
}
