package com.devicebridge.android;

import android.telephony.SmsMessage;

/**
 * Multipart (concatenated) SMS header info extracted from the receive PDU.
 *
 * The PDU user-data header (UDH) is parsed manually because the OEM
 * SmsMessage.getUserDataHeader() path is unreliable across Android versions.
 * IEI 0x00 is the 8-bit-reference concatenated SMS information element and
 * IEI 0x08 is the 16-bit-reference variant.
 */
final class SmsMultipartInfo {
    final String reference;
    final int partIndex;
    final int partCount;

    SmsMultipartInfo(String reference, int partIndex, int partCount) {
        this.reference = reference == null ? "" : reference.trim();
        this.partIndex = partIndex;
        this.partCount = partCount;
    }

    boolean isMultipart() {
        return !reference.isEmpty() && partCount > 1 && partIndex > 0 && partIndex <= partCount;
    }

    static SmsMultipartInfo fromMessage(SmsMessage message) {
        if (message == null) {
            return null;
        }
        return fromPdu(message.getPdu());
    }

    /**
     * Pure byte-level PDU walker (unit-testable without Android runtime).
     * Returns null when the PDU is malformed, too short, or has no
     * concatenated-SMS information element.
     */
    static SmsMultipartInfo fromPdu(byte[] pdu) {
        if (pdu == null || pdu.length < 2) {
            return null;
        }

        try {
            int cursor = 0;
            int scAddressLength = pdu[cursor++] & 0xFF;
            cursor += scAddressLength;
            if (cursor >= pdu.length) {
                return null;
            }

            int firstOctet = pdu[cursor++] & 0xFF;
            if ((firstOctet & 0x40) == 0) {
                // No user-data header present: not a multipart message.
                return null;
            }

            int originAddressDigits = pdu[cursor++] & 0xFF;
            cursor += 1; // TOA
            cursor += (originAddressDigits + 1) / 2;
            cursor += 1; // PID
            cursor += 1; // DCS
            cursor += 7; // SCTS
            if (cursor >= pdu.length) {
                return null;
            }

            cursor += 1; // UDL
            if (cursor >= pdu.length) {
                return null;
            }

            int userDataHeaderLength = pdu[cursor] & 0xFF;
            int headerCursor = cursor + 1;
            int headerEnd = Math.min(pdu.length, headerCursor + userDataHeaderLength);

            while (headerCursor + 1 < headerEnd) {
                int iei = pdu[headerCursor++] & 0xFF;
                int ieLength = pdu[headerCursor++] & 0xFF;
                if (headerCursor + ieLength > headerEnd) {
                    break;
                }

                if (iei == 0x00 && ieLength >= 3) {
                    int ref = pdu[headerCursor] & 0xFF;
                    int total = pdu[headerCursor + 1] & 0xFF;
                    int seq = pdu[headerCursor + 2] & 0xFF;
                    return new SmsMultipartInfo(String.valueOf(ref), seq, total);
                }
                if (iei == 0x08 && ieLength >= 4) {
                    int ref = ((pdu[headerCursor] & 0xFF) << 8) | (pdu[headerCursor + 1] & 0xFF);
                    int total = pdu[headerCursor + 2] & 0xFF;
                    int seq = pdu[headerCursor + 3] & 0xFF;
                    return new SmsMultipartInfo(String.valueOf(ref), seq, total);
                }

                headerCursor += ieLength;
            }
        } catch (RuntimeException ignored) {
            return null;
        }

        return null;
    }
}
