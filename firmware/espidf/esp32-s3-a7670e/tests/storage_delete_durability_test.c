static void reset_delete_storage(void) {
    memset(&test_blob, 0, sizeof(test_blob));
    memset(&candidate_blob, 0, sizeof(candidate_blob));
    memset(&s_status, 0, sizeof(s_status));
    s_blob = &test_blob;
    s_persist_dirty = false;
    persist_result = ESP_OK;
    persist_calls = 0U;
}

int main(void) {
    reset_delete_storage();
    test_blob.version = 7U;
    test_blob.count = 3U;
    test_blob.head = 100U;
    test_blob.records[0].value = 30;
    test_blob.records[1].value = 10;
    test_blob.records[2].value = 20;
    s_status.record_count = 3U;
    candidate_blob.version = 7U;
    candidate_blob.count = 2U;
    candidate_blob.head = 100U;
    candidate_blob.records[0].value = 10;
    candidate_blob.records[1].value = 30;
    persist_result = ESP_FAIL;
    assert(storage_mgr_commit_replacement_locked(&candidate_blob) == ESP_FAIL);
    assert(persist_calls == 1U);
    assert(s_blob == &test_blob);
    assert(test_blob.count == 3U);
    assert(test_blob.head == 100U);
    assert(test_blob.records[0].value == 30);
    assert(test_blob.records[1].value == 10);
    assert(test_blob.records[2].value == 20);
    assert(s_status.record_count == 3U);
    assert(!s_persist_dirty);

    s_persist_dirty = true;
    persist_result = ESP_FAIL;
    assert(storage_mgr_commit_replacement_locked(&candidate_blob) == ESP_FAIL);
    assert(s_persist_dirty);
    assert(test_blob.count == 3U);

    persist_result = ESP_OK;
    assert(storage_mgr_commit_replacement_locked(&candidate_blob) == ESP_OK);
    assert(s_blob == &test_blob);
    assert(test_blob.version == 7U);
    assert(test_blob.count == 2U);
    assert(test_blob.head == 100U);
    assert(test_blob.records[0].value == 10);
    assert(test_blob.records[1].value == 30);
    assert(s_status.record_count == 2U);
    assert(!s_persist_dirty);

    puts("Storage delete durability rollback: all checks passed");
    return 0;
}
