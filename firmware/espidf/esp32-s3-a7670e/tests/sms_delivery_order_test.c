static void reset_mocks(void) {
    storage_exists = false;
    storage_result = ESP_OK;
    publish_result = ESP_OK;
    delete_result = ESP_OK;
    append_calls = 0U;
    publish_calls = 0U;
    record_calls = 0U;
    clear_calls = 0U;
    delete_calls = 0U;
}

int main(void) {
    unified_sms_payload_t payload = {0};
    strcpy_s(payload.from, sizeof(payload.from), "+8801000000000");
    strcpy_s(payload.text, sizeof(payload.text), "durability test");

    reset_mocks();
    storage_result = ESP_FAIL;
    assert(sms_service_settle_consumed(&payload, "test") == ESP_FAIL);
    assert(append_calls == 1U);
    assert(publish_calls == 0U);
    assert(record_calls == 0U);
    assert(clear_calls == 1U);
    assert(delete_calls == 0U);

    reset_mocks();
    assert(sms_service_settle_consumed(&payload, "test") == ESP_OK);
    assert(append_calls == 1U);
    assert(publish_calls == 1U);
    assert(record_calls == 1U);
    assert(clear_calls == 0U);
    assert(delete_calls == 1U);

    reset_mocks();
    storage_exists = true;
    publish_result = ESP_FAIL;
    assert(sms_service_settle_consumed(&payload, "test") == ESP_FAIL);
    assert(append_calls == 0U);
    assert(publish_calls == 1U);
    assert(record_calls == 0U);
    assert(clear_calls == 1U);
    assert(delete_calls == 0U);

    reset_mocks();
    storage_exists = true;
    delete_result = ESP_FAIL;
    assert(sms_service_settle_consumed(&payload, "test") == ESP_FAIL);
    assert(append_calls == 0U);
    assert(publish_calls == 1U);
    assert(record_calls == 1U);
    assert(clear_calls == 0U);
    assert(delete_calls == 1U);

    puts("SMS persist/publish/delete ordering: all checks passed");
    return 0;
}
