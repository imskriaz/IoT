static void reset_storage(void) {
    memset(&test_blob, 0, sizeof(test_blob));
    memset(&s_status, 0, sizeof(s_status));
    s_status.enabled = true;
    s_blob = &test_blob;
    test_blob.version = STORAGE_BLOB_VERSION;
    test_blob.head = STORAGE_SMS_ID_FIRST;
    s_persist_dirty = false;
    persist_result = ESP_OK;
    persist_calls = 0U;
}

int main(void) {
    storage_mgr_record_t record = { .value = 42, .type = STORAGE_MGR_RECORD_CALL };

    reset_storage();
    test_blob.count = 1U;
    test_blob.records[0].value = 7;
    s_status.record_count = 1U;
    persist_result = ESP_FAIL;
    assert(storage_mgr_append_record_durable_locked(&record) == ESP_FAIL);
    assert(persist_calls == 1U);
    assert(test_blob.count == 1U);
    assert(test_blob.head == STORAGE_SMS_ID_FIRST);
    assert(test_blob.records[0].value == 7);
    assert(test_blob.records[1].value == 0);
    assert(s_status.record_count == 1U);
    assert(s_status.dropped_count == 0U);
    assert(!s_persist_dirty);

    reset_storage();
    test_blob.count = CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY;
    test_blob.head = STORAGE_SMS_ID_FIRST;
    test_blob.records[0].value = 10;
    test_blob.records[1].value = 11;
    test_blob.records[2].value = 12;
    s_status.record_count = CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY;
    s_status.dropped_count = 5U;
    s_persist_dirty = true;
    persist_result = ESP_FAIL;
    assert(storage_mgr_append_record_durable_locked(&record) == ESP_ERR_NO_MEM);
    assert(persist_calls == 0U);
    assert(test_blob.count == CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY);
    assert(test_blob.head == STORAGE_SMS_ID_FIRST);
    assert(test_blob.records[1].value == 11);
    assert(s_status.record_count == CONFIG_UNIFIED_STORAGE_RECORD_CAPACITY);
    assert(s_status.dropped_count == 5U);
    assert(s_persist_dirty);

    reset_storage();
    assert(storage_mgr_append_record_durable_locked(&record) == ESP_OK);
    assert(persist_calls == 1U);
    assert(test_blob.count == 1U);
    assert(test_blob.records[0].value == 42);
    assert(s_status.record_count == 1U);
    assert(!s_persist_dirty);

    puts("Storage append durability rollback: all checks passed");
    return 0;
}
