package com.devicebridge.android;

import org.junit.Test;

import java.io.File;
import java.io.FileWriter;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/** Pure-JVM coverage for the crash-safe Android bridge outbox contract. */
public class BridgeOutboxTest {
    private static File tempFile() throws Exception {
        File file = File.createTempFile("bridge-outbox-", ".json");
        assertTrue(file.delete());
        return file;
    }

    @Test
    public void publishSurvivesReloadAndIsRemovedOnlyByExactAck() throws Exception {
        File file = tempFile();
        try {
            assertTrue(BridgeOutbox.recordPublish(file, "device/d1/status", "{\"n\":1}"));
            List<BridgeOutbox.PublishEntry> entries = BridgeOutbox.loadPublishes(file);
            assertEquals(1, entries.size());
            assertFalse(BridgeOutbox.acknowledgePublish(file, "wrong-id"));
            assertEquals(1, BridgeOutbox.loadPublishes(file).size());
            assertTrue(BridgeOutbox.acknowledgePublish(file, entries.get(0).id));
            assertEquals(0, BridgeOutbox.loadPublishes(file).size());
        } finally {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
        }
    }

    @Test
    public void terminalActionIsIdempotentAndBounded() throws Exception {
        File file = tempFile();
        try {
            assertTrue(BridgeOutbox.recordTerminalResult(file, "a-1", "{\"result\":\"completed\"}"));
            assertTrue(BridgeOutbox.recordTerminalResult(file, "a-1", "{\"result\":\"completed\"}"));
            assertFalse(BridgeOutbox.recordTerminalResult(file, "a-1", "{\"result\":\"failed\"}"));
            assertEquals(1, BridgeOutbox.peekTerminalResults(file).size());
            assertTrue(BridgeOutbox.acknowledgeTerminal(file, BridgeOutbox.peekTerminalResults(file).get(0).id));
            assertEquals(0, BridgeOutbox.peekTerminalResults(file).size());
        } finally {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
        }
    }

    @Test
    public void liveTerminalPublishAcknowledgesStableActionIdentity() throws Exception {
        File file = tempFile();
        try {
            assertTrue(BridgeOutbox.recordTerminalResult(file, "action-live-1", "{\"result\":\"completed\"}"));
            BridgeOutbox.TerminalEntry persisted = BridgeOutbox.peekTerminalResults(file).get(0);
            assertFalse(persisted.id.equals(persisted.actionId));
            assertFalse(BridgeOutbox.acknowledgeTerminalByActionId(file, "wrong-action"));
            assertEquals(1, BridgeOutbox.peekTerminalResults(file).size());
            assertTrue(BridgeOutbox.acknowledgeTerminalByActionId(file, "action-live-1"));
            assertEquals(0, BridgeOutbox.peekTerminalResults(file).size());
        } finally {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
        }
    }

    @Test
    public void deliveryTerminalUsesSeparateJournalIdentityFromSendResult() throws Exception {
        File file = tempFile();
        try {
            assertTrue(BridgeOutbox.recordTerminalResult(file, "send-1", "{\"result\":\"completed\"}"));
            assertTrue(BridgeOutbox.recordTerminalResult(file, "delivered_send-1", "{\"type\":\"sms_delivered\"}"));
            assertEquals(2, BridgeOutbox.peekTerminalResults(file).size());
            assertTrue(BridgeOutbox.acknowledgeTerminalByActionId(file, "delivered_send-1"));
            assertEquals(1, BridgeOutbox.peekTerminalResults(file).size());
            assertEquals("send-1", BridgeOutbox.peekTerminalResults(file).get(0).actionId);
        } finally {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
        }
    }

    @Test
    public void corruptOrFullJournalFailsClosed() throws Exception {
        File corrupt = tempFile();
        try (FileWriter writer = new FileWriter(corrupt)) {
            writer.write("{not-json");
        }
        assertFalse(BridgeOutbox.recordPublish(corrupt, "device/d1/status", "{}"));
        //noinspection ResultOfMethodCallIgnored
        corrupt.delete();

        File full = tempFile();
        try {
            for (int i = 0; i < BridgeOutbox.MAX_PUBLISH_ENTRIES; i++) {
                assertTrue(BridgeOutbox.recordPublish(full, "device/d1/status/" + i, "{}"));
            }
            assertFalse(BridgeOutbox.recordPublish(full, "device/d1/status/overflow", "{}"));
            assertEquals(BridgeOutbox.MAX_PUBLISH_ENTRIES, BridgeOutbox.loadPublishes(full).size());
        } finally {
            //noinspection ResultOfMethodCallIgnored
            full.delete();
        }
    }
}
