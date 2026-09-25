#include <assert.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    storage_blob_t legacy = {0};
    storage_blob_t migrated = {0};

    legacy.version = STORAGE_BLOB_LEGACY_VERSION;
    legacy.count = 3U;
    legacy.head = 2U;
    legacy.records[2].type = STORAGE_MGR_RECORD_SMS;
    legacy.records[2].timestamp_ms = 1700000000U;
    legacy.records[2].payload.sms.timestamp_ms = 1700000000U;
    strcpy_s(legacy.records[2].payload.sms.text,
             sizeof(legacy.records[2].payload.sms.text), "first-identical");
    legacy.records[2].payload.sms.storage_index = 12;
    legacy.records[3].type = STORAGE_MGR_RECORD_CALL;
    legacy.records[3].timestamp_ms = 1700000001U;
    legacy.records[0].type = STORAGE_MGR_RECORD_SMS;
    legacy.records[0].timestamp_ms = 1700000002U;
    legacy.records[0].payload.sms.timestamp_ms = 1700000002U;
    strcpy_s(legacy.records[0].payload.sms.text,
             sizeof(legacy.records[0].payload.sms.text), "first-identical");
    legacy.records[0].payload.sms.storage_index = 13;

    assert(storage_mgr_blob_layout_valid(&legacy));
    assert(storage_mgr_migrate_legacy_blob(&migrated, &legacy) == ESP_OK);
    assert(migrated.version == STORAGE_BLOB_VERSION);
    assert(migrated.count == 3U);
    assert(migrated.records[0].type == STORAGE_MGR_RECORD_SMS);
    assert(migrated.records[0].timestamp_ms == STORAGE_SMS_MIGRATED_ID_FIRST);
    assert(migrated.records[0].payload.sms.timestamp_ms == 1700000000U);
    assert(migrated.records[0].payload.sms.storage_index == -2);
    assert(strcmp(migrated.records[0].payload.sms.text, "first-identical") == 0);
    assert(migrated.records[1].type == STORAGE_MGR_RECORD_CALL);
    assert(migrated.records[1].timestamp_ms == 1700000001U);
    assert(migrated.records[2].type == STORAGE_MGR_RECORD_SMS);
    assert(migrated.records[2].timestamp_ms == STORAGE_SMS_MIGRATED_ID_FIRST + 1U);
    assert(migrated.records[2].payload.sms.storage_index == -2);
    assert(migrated.head == STORAGE_SMS_ID_FIRST);

    puts("storage_sms_migration_test: PASS");
    return 0;
}
