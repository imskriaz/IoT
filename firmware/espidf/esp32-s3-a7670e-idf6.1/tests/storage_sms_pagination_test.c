#include <assert.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    char json[8192] = {0};
    storage_blob_t blob = {0};

    s_blob = &blob;
    blob.version = STORAGE_BLOB_VERSION;
    blob.head = 11U;
    blob.count = 10U;
    for (uint32_t index = 0U; index < blob.count; ++index) {
        blob.records[index].type = STORAGE_MGR_RECORD_SMS;
        blob.records[index].timestamp_ms = index + 1U;
        /* Two messages may share the same modem/event second. Pagination must
         * use the durable storage ID, not payload timestamp or message text. */
        blob.records[index].payload.sms.timestamp_ms = 1700000000U;
        blob.records[index].payload.sms.storage_index = (int16_t)(index + 1U);
        snprintf(blob.records[index].payload.sms.from,
                 sizeof(blob.records[index].payload.sms.from), "+880%u", (unsigned)index);
        snprintf(blob.records[index].payload.sms.text,
                 sizeof(blob.records[index].payload.sms.text), "message-%u", (unsigned)index);
    }
    strcpy_s(blob.records[0].payload.sms.from,
             sizeof(blob.records[0].payload.sms.from), "+880-identical");
    strcpy_s(blob.records[1].payload.sms.from,
             sizeof(blob.records[1].payload.sms.from), "+880-identical");
    strcpy_s(blob.records[0].payload.sms.text,
             sizeof(blob.records[0].payload.sms.text), "same-second");
    strcpy_s(blob.records[1].payload.sms.text,
             sizeof(blob.records[1].payload.sms.text), "same-second");

    assert(storage_mgr_build_sms_history_json(json, sizeof(json), 8U, 0U) == ESP_OK);
    assert(strstr(json, "\"total\":10") != NULL);
    assert(strstr(json, "\"count\":8") != NULL);
    assert(strstr(json, "\"storage_id\":10") != NULL);
    assert(strstr(json, "\"storage_id\":3") != NULL);
    assert(strstr(json, "\"storage_id\":2") == NULL);
    assert(strstr(json, "\"has_more\":true") != NULL);
    assert(strstr(json, "\"next_cursor\":3") != NULL);

    memset(json, 0, sizeof(json));
    assert(storage_mgr_build_sms_history_json(json, sizeof(json), 8U, 3U) == ESP_OK);
    assert(strstr(json, "\"count\":2") != NULL);
    assert(strstr(json, "\"storage_id\":2") != NULL);
    assert(strstr(json, "\"storage_id\":1") != NULL);
    assert(strstr(json, "same-second") != NULL);
    assert(strstr(json, "\"storage_id\":3") == NULL);
    assert(strstr(json, "\"has_more\":false") != NULL);
    assert(strstr(json, "\"next_cursor\":0") != NULL);

    puts("storage_sms_pagination_test: PASS");
    return 0;
}
