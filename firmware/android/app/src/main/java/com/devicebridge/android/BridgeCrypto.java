package com.devicebridge.android;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * SMS payload crypto (AND-04).
 *
 * v2 format: "gcm1:" + Base64(12-byte IV || AES-256-GCM ciphertext+tag).
 * AES-GCM provides integrity — the legacy AES-CFB payloads were malleable
 * (bit-flips in ciphertext silently changed message text).
 *
 * Legacy payloads (no "gcm1:" prefix) are still decrypted with AES-CFB so
 * ciphertext persisted before the upgrade remains readable.
 */
final class BridgeCrypto {
    private static final String V2_PREFIX = "gcm1:";
    private static final int LEGACY_IV_SIZE = 16;
    private static final int GCM_IV_SIZE = 12;
    private static final int GCM_TAG_BITS = 128;
    private static final SecureRandom RANDOM = new SecureRandom();

    private BridgeCrypto() {
    }

    static String encrypt(String key, String plainText) throws Exception {
        byte[] keyBytes = deriveKey(key);
        byte[] iv = new byte[GCM_IV_SIZE];
        RANDOM.nextBytes(iv);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(keyBytes, "AES"), new GCMParameterSpec(GCM_TAG_BITS, iv));
        byte[] encrypted = cipher.doFinal((plainText == null ? "" : plainText).getBytes(StandardCharsets.UTF_8));
        byte[] output = new byte[iv.length + encrypted.length];
        System.arraycopy(iv, 0, output, 0, iv.length);
        System.arraycopy(encrypted, 0, output, iv.length, encrypted.length);
        // java.util.Base64 (minSdk 26): identical wire format to the previous
        // android.util.Base64 NO_WRAP output, and pure-JVM unit-testable.
        return V2_PREFIX + Base64.getEncoder().encodeToString(output);
    }

    static String decrypt(String key, String encryptedText) throws Exception {
        String normalized = encryptedText == null ? "" : encryptedText.trim();
        if (normalized.startsWith(V2_PREFIX)) {
            byte[] input = Base64.getDecoder().decode(normalized.substring(V2_PREFIX.length()));
            if (input.length <= GCM_IV_SIZE) {
                throw new IllegalArgumentException("encrypted_payload_invalid");
            }
            byte[] iv = new byte[GCM_IV_SIZE];
            byte[] payload = new byte[input.length - GCM_IV_SIZE];
            System.arraycopy(input, 0, iv, 0, GCM_IV_SIZE);
            System.arraycopy(input, GCM_IV_SIZE, payload, 0, payload.length);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(deriveKey(key), "AES"), new GCMParameterSpec(GCM_TAG_BITS, iv));
            return new String(cipher.doFinal(payload), StandardCharsets.UTF_8);
        }
        // Legacy AES-CFB payload (pre-GCM versions).
        byte[] input = Base64.getDecoder().decode(normalized);
        if (input.length <= LEGACY_IV_SIZE) {
            throw new IllegalArgumentException("encrypted_payload_invalid");
        }
        byte[] iv = new byte[LEGACY_IV_SIZE];
        byte[] payload = new byte[input.length - LEGACY_IV_SIZE];
        System.arraycopy(input, 0, iv, 0, LEGACY_IV_SIZE);
        System.arraycopy(input, LEGACY_IV_SIZE, payload, 0, payload.length);
        Cipher cipher = Cipher.getInstance("AES/CFB/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(deriveKey(key), "AES"), new IvParameterSpec(iv));
        return new String(cipher.doFinal(payload), StandardCharsets.UTF_8);
    }

    private static byte[] deriveKey(String key) throws Exception {
        if (key == null || key.trim().isEmpty()) {
            throw new IllegalArgumentException("encryption_key_required");
        }
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        return digest.digest(key.trim().getBytes(StandardCharsets.UTF_8));
    }
}
