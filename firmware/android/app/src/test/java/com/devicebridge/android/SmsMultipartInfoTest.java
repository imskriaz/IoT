package com.devicebridge.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * SMS-DELIVER PDU user-data-header parsing for concatenated SMS
 * (pure JVM — fromPdu operates on raw bytes).
 */
public class SmsMultipartInfoTest {

    /**
     * Builds a minimal SMS-DELIVER PDU with a user-data header.
     *
     * @param firstOctet       PDU first octet (0x40 = UDHI set)
     * @param udhLength        UDH total length byte
     * @param informationBytes the UDH information elements (IEI + length + data)
     */
    private static byte[] buildPdu(int firstOctet, int udhLength, byte[] informationBytes) {
        int pduLength = 14 + 1 + 1 + informationBytes.length + 1; // headers + UDL + UDH len + IE + user byte
        byte[] pdu = new byte[pduLength];
        pdu[0] = 0x00;              // SMSC length 0
        pdu[1] = (byte) firstOctet; // SMS-DELIVER flags
        pdu[2] = 0x00;              // originating address digit count 0
        pdu[3] = (byte) 0x81;       // TOA
        pdu[4] = 0x00;              // PID
        pdu[5] = 0x00;              // DCS
        for (int i = 0; i < 7; i++) {
            pdu[6 + i] = 0x21;      // SCTS (7 bytes)
        }
        pdu[13] = (byte) (1 + udhLength + 1); // UDL (approximate; parser only needs presence)
        pdu[14] = (byte) udhLength;
        System.arraycopy(informationBytes, 0, pdu, 15, informationBytes.length);
        pdu[15 + informationBytes.length] = 0x41; // one user data byte
        return pdu;
    }

    @Test
    public void parsesEightBitReferenceConcatenatedSms() {
        byte[] ie = {0x00, 0x03, 0x27, 0x02, 0x01}; // IEI 0x00, len 3, ref 39, total 2, seq 1
        SmsMultipartInfo info = SmsMultipartInfo.fromPdu(buildPdu(0x40, 5, ie));

        assertEquals("39", info.reference);
        assertEquals(1, info.partIndex);
        assertEquals(2, info.partCount);
        assertTrue(info.isMultipart());
    }

    @Test
    public void parsesSixteenBitReferenceConcatenatedSms() {
        byte[] ie = {0x08, 0x04, 0x12, 0x34, 0x03, 0x02}; // IEI 0x08, len 4, ref 0x1234, total 3, seq 2
        SmsMultipartInfo info = SmsMultipartInfo.fromPdu(buildPdu(0x40, 6, ie));

        assertEquals(String.valueOf(0x1234), info.reference);
        assertEquals(2, info.partIndex);
        assertEquals(3, info.partCount);
        assertTrue(info.isMultipart());
    }

    @Test
    public void returnsNullWhenNoUserDataHeader() {
        byte[] ie = {0x00, 0x03, 0x27, 0x02, 0x01};
        assertNull(SmsMultipartInfo.fromPdu(buildPdu(0x00, 5, ie))); // UDHI bit clear
    }

    @Test
    public void returnsNullForNullOrShortPdus() {
        assertNull(SmsMultipartInfo.fromPdu(null));
        assertNull(SmsMultipartInfo.fromPdu(new byte[0]));
        assertNull(SmsMultipartInfo.fromPdu(new byte[]{0x00, 0x40}));
    }

    @Test
    public void returnsNullWhenInformationElementExceedsHeader() {
        // UDH length says 2 but the IE claims 3 data bytes: inconsistent.
        byte[] ie = {0x00, 0x03, 0x27, 0x02, 0x01};
        assertNull(SmsMultipartInfo.fromPdu(buildPdu(0x40, 2, ie)));
    }

    @Test
    public void nonConcatenatedInformationElementsAreIgnored() {
        // IEI 0x05 (application port addressing 16-bit): not a concat marker.
        byte[] ie = {0x05, 0x02, 0x0B, (byte) 0x84};
        assertNull(SmsMultipartInfo.fromPdu(buildPdu(0x40, 4, ie)));
    }

    @Test
    public void isMultipartRejectsInconsistentSequences() {
        byte[] ie = {0x00, 0x03, 0x27, 0x02, 0x05}; // seq 5 of total 2
        SmsMultipartInfo info = SmsMultipartInfo.fromPdu(buildPdu(0x40, 5, ie));
        assertEquals(5, info.partIndex);
        assertFalse(info.isMultipart());
    }

    @Test
    public void singlePartConcatenationIsNotMultipart() {
        byte[] ie = {0x00, 0x03, 0x27, 0x01, 0x01}; // total 1
        SmsMultipartInfo info = SmsMultipartInfo.fromPdu(buildPdu(0x40, 5, ie));
        assertFalse(info.isMultipart());
    }

    @Test
    public void constructorNormalizesNullReference() {
        SmsMultipartInfo info = new SmsMultipartInfo(null, 1, 2);
        assertFalse(info.isMultipart());
        assertEquals("", info.reference);
    }
}
