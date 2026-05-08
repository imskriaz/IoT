package com.devicebridge.android;

import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;

import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

final class BridgeCrypto {
    private static final int IV_SIZE = 16;
    private static final SecureRandom RANDOM = new SecureRandom();

    private BridgeCrypto() {
    }

    static String encrypt(String key, String plainText) throws Exception {
        byte[] iv = new byte[IV_SIZE];
        RANDOM.nextBytes(iv);
        Cipher cipher = cipher(key, iv, Cipher.ENCRYPT_MODE);
        byte[] encrypted = cipher.doFinal((plainText == null ? "" : plainText).getBytes(StandardCharsets.UTF_8));
        byte[] output = new byte[iv.length + encrypted.length];
        System.arraycopy(iv, 0, output, 0, iv.length);
        System.arraycopy(encrypted, 0, output, iv.length, encrypted.length);
        return Base64.encodeToString(output, Base64.NO_WRAP);
    }

    static String decrypt(String key, String encryptedText) throws Exception {
        byte[] input = Base64.decode(encryptedText == null ? "" : encryptedText, Base64.DEFAULT);
        if (input.length <= IV_SIZE) {
            throw new IllegalArgumentException("encrypted_payload_invalid");
        }
        byte[] iv = new byte[IV_SIZE];
        byte[] payload = new byte[input.length - IV_SIZE];
        System.arraycopy(input, 0, iv, 0, IV_SIZE);
        System.arraycopy(input, IV_SIZE, payload, 0, payload.length);
        Cipher cipher = cipher(key, iv, Cipher.DECRYPT_MODE);
        return new String(cipher.doFinal(payload), StandardCharsets.UTF_8);
    }

    private static Cipher cipher(String key, byte[] iv, int mode) throws Exception {
        if (key == null || key.trim().isEmpty()) {
            throw new IllegalArgumentException("encryption_key_required");
        }
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] keyBytes = digest.digest(key.trim().getBytes(StandardCharsets.UTF_8));
        SecretKeySpec secretKey = new SecretKeySpec(keyBytes, "AES");
        Cipher cipher = Cipher.getInstance("AES/CFB/NoPadding");
        cipher.init(mode, secretKey, new IvParameterSpec(iv));
        return cipher;
    }
}
