#include <assert.h>
#include <direct.h>
#include <stdbool.h>
#include <stdio.h>
#include <stddef.h>
#include <string.h>
#include "storage_mgr.h"

#define PAYLOAD_LEN 8192U
#define SLOT_COUNT 16U
void storage_result_journal_test_reboot(const char *directory);

static const char *test_dir = "result-journal-data";

/* Independent frozen old-image fixture, not the implementation record type. */
typedef struct {
    uint32_t magic, version, generation, checksum, state;
    unified_action_response_t response;
    char payload[4096];
} legacy_record_t;

static uint32_t legacy_checksum(const legacy_record_t *record) {
    const unsigned char *bytes = (const unsigned char *)&record->state;
    uint32_t hash = 2166136261U;
    for (size_t index = 0; index < sizeof(*record) - offsetof(legacy_record_t, state); ++index)
        hash = (hash ^ bytes[index]) * 16777619U;
    return (hash ^ record->generation) * 16777619U;
}

static void write_legacy(unsigned slot, unsigned bank, uint32_t generation,
                         uint32_t state, unified_action_response_t response,
                         const char *payload) {
    legacy_record_t record = {0};
    char path[128];
    assert(sizeof(record) == 4256U);
    record.magic = 0x52534c54U;
    record.version = 1;
    record.generation = generation;
    record.state = state;
    record.response = response;
    snprintf(record.payload, sizeof(record.payload), "%s", payload);
    record.checksum = legacy_checksum(&record);
    snprintf(path, sizeof(path), "%s/r%02u%c", test_dir, slot, bank ? 'b' : 'a');
    FILE *file = fopen(path, "wb");
    assert(file);
    assert(fwrite(&record, 1, sizeof(record), file) == sizeof(record));
    assert(fclose(file) == 0);
}

static void assert_disk_format(unsigned slot, unsigned bank, uint32_t version, long size) {
    char path[128];
    uint32_t header[2] = {0};
    snprintf(path, sizeof(path), "%s/r%02u%c", test_dir, slot, bank ? 'b' : 'a');
    FILE *file = fopen(path, "rb");
    assert(file);
    assert(fread(header, sizeof(header), 1, file) == 1);
    assert(header[0] == 0x52534c54U && header[1] == version);
    assert(fseek(file, 0, SEEK_END) == 0);
    assert(ftell(file) == size);
    if (version == 1U) {
        legacy_record_t legacy = {0};
        assert(fseek(file, 0, SEEK_SET) == 0);
        assert(fread(&legacy, sizeof(legacy), 1, file) == 1);
        assert(legacy.checksum == legacy_checksum(&legacy));
    }
    assert(fclose(file) == 0);
}

static void clear_journal(void) {
    char path[128];
    (void)_mkdir(test_dir);
    for (unsigned slot = 0; slot < SLOT_COUNT; ++slot) {
        for (unsigned bank = 0; bank < 2; ++bank) {
            snprintf(path, sizeof(path), "%s/r%02u%c", test_dir, slot, bank ? 'b' : 'a');
            (void)remove(path);
        }
    }
    storage_result_journal_test_reboot(test_dir);
}

static unified_action_envelope_t action(const char *id) {
    unified_action_envelope_t value = {0};
    snprintf(value.correlation.device_id, sizeof(value.correlation.device_id), "device-a");
    snprintf(value.correlation.correlation_id, sizeof(value.correlation.correlation_id), "%s", id);
    value.command = UNIFIED_ACTION_CMD_SEND_SMS;
    value.timeout_ms = 30000U;
    return value;
}

static unified_action_response_t terminal(unified_action_envelope_t envelope) {
    unified_action_response_t response = {0};
    response.action = envelope;
    response.result = UNIFIED_ACTION_RESULT_COMPLETED;
    snprintf(response.detail, sizeof(response.detail), "submitted");
    return response;
}

static void corrupt(const char *name) {
    FILE *file = fopen(name, "wb");
    assert(file);
    assert(fwrite("torn", 1, 4, file) == 4);
    assert(fclose(file) == 0);
}

static void test_commit_reboot_and_exact_ack(void) {
    char payload[PAYLOAD_LEN] = {0};
    unified_action_response_t replay = {0};
    unified_action_envelope_t envelope = action("job-1");
    unified_action_response_t response = terminal(envelope);
    clear_journal();
    assert(storage_mgr_result_reserve(&envelope) == ESP_OK);
    assert(storage_mgr_result_reserve(&envelope) == ESP_ERR_NOT_FINISHED);
    assert(storage_mgr_result_commit(&response, "{\"mr\":17}") == ESP_OK);
    assert(storage_mgr_result_reserve(&envelope) == ESP_ERR_NOT_ALLOWED);
    memset(&replay, 0, sizeof(replay));
    memset(payload, 0, sizeof(payload));
    assert(storage_mgr_result_get(&envelope, &replay, payload, sizeof(payload)) == ESP_OK);
    assert(replay.result == UNIFIED_ACTION_RESULT_COMPLETED);
    assert(strcmp(payload, "{\"mr\":17}") == 0);
    storage_result_journal_test_reboot(test_dir);
    assert(storage_mgr_result_next(&replay, payload, sizeof(payload)) == ESP_OK);
    assert(strcmp(replay.action.correlation.correlation_id, "job-1") == 0);
    assert(strcmp(payload, "{\"mr\":17}") == 0);
    assert(storage_mgr_result_ack("wrong-device", "job-1", UNIFIED_ACTION_CMD_SEND_SMS) == ESP_ERR_NOT_FOUND);
    assert(storage_mgr_result_ack("device-a", "wrong-job", UNIFIED_ACTION_CMD_SEND_SMS) == ESP_ERR_NOT_FOUND);
    assert(storage_mgr_result_ack("device-a", "job-1", UNIFIED_ACTION_CMD_GET_STATUS) == ESP_ERR_NOT_FOUND);
    assert(storage_mgr_result_next(&replay, payload, sizeof(payload)) == ESP_OK);
    assert(storage_mgr_result_ack("device-a", "job-1", UNIFIED_ACTION_CMD_SEND_SMS) == ESP_OK);
    storage_result_journal_test_reboot(test_dir);
    assert(storage_mgr_result_next(&replay, payload, sizeof(payload)) == ESP_ERR_NOT_FOUND);
    assert(storage_mgr_result_reserve(&envelope) == ESP_ERR_NOT_ALLOWED);
    assert(storage_mgr_result_get(&envelope, &replay, payload, sizeof(payload)) == ESP_OK);
    assert(strcmp(payload, "{\"mr\":17}") == 0);
}

static void test_full_is_bounded_and_ack_releases_one(void) {
    char id[20];
    char payload[PAYLOAD_LEN] = {0};
    bool observed[SLOT_COUNT] = {false};
    unified_action_response_t replay = {0};
    clear_journal();
    for (unsigned index = 0; index < SLOT_COUNT; ++index) {
        snprintf(id, sizeof(id), "full-%u", index);
        unified_action_envelope_t envelope = action(id);
        unified_action_response_t response = terminal(envelope);
        assert(storage_mgr_result_reserve(&envelope) == ESP_OK);
        assert(storage_mgr_result_commit(&response, NULL) == ESP_OK);
    }
    unified_action_envelope_t overflow = action("overflow");
    assert(storage_mgr_result_reserve(&overflow) == ESP_ERR_NO_MEM);
    for (unsigned index = 0; index < SLOT_COUNT; ++index) {
        unsigned parsed = SLOT_COUNT;
        assert(storage_mgr_result_next(&replay, payload, sizeof(payload)) == ESP_OK);
        assert(sscanf(replay.action.correlation.correlation_id, "full-%u", &parsed) == 1);
        assert(parsed < SLOT_COUNT && !observed[parsed]);
        observed[parsed] = true;
    }
    assert(storage_mgr_result_ack("device-a", "full-5", UNIFIED_ACTION_CMD_SEND_SMS) == ESP_OK);
    assert(storage_mgr_result_reserve(&overflow) == ESP_OK);
}

static void test_torn_terminal_reports_and_reclaims_uncertain_result(void) {
    char payload[PAYLOAD_LEN] = {0};
    unified_action_response_t replay = {0};
    unified_action_envelope_t envelope = action("torn-terminal");
    unified_action_response_t response = terminal(envelope);
    clear_journal();
    assert(storage_mgr_result_reserve(&envelope) == ESP_OK); /* bank a generation 1 */
    assert(storage_mgr_result_commit(&response, "{}") == ESP_OK); /* bank b generation 2 */
    corrupt("result-journal-data/r00b");
    storage_result_journal_test_reboot(test_dir);
    assert(storage_mgr_result_next(&replay, payload, sizeof(payload)) == ESP_OK);
    assert(replay.result == UNIFIED_ACTION_RESULT_FAILED);
    assert(replay.result_code == ESP_ERR_INVALID_STATE);
    assert(strcmp(replay.detail, "action_outcome_uncertain_after_reboot") == 0);
    assert(strcmp(payload, "{\"outcome_uncertain\":true,\"replay_safe\":false}") == 0);
    assert(storage_mgr_result_reserve(&envelope) == ESP_ERR_NOT_ALLOWED);
    assert(storage_mgr_result_ack("device-a", "torn-terminal", UNIFIED_ACTION_CMD_SEND_SMS) == ESP_OK);
    assert(storage_mgr_result_reserve(&envelope) == ESP_ERR_NOT_ALLOWED);
}

static void test_torn_ack_replays_previous_terminal(void) {
    char payload[PAYLOAD_LEN] = {0};
    unified_action_response_t replay = {0};
    unified_action_envelope_t envelope = action("torn-ack");
    unified_action_response_t response = terminal(envelope);
    clear_journal();
    assert(storage_mgr_result_reserve(&envelope) == ESP_OK); /* a, generation 1 */
    assert(storage_mgr_result_commit(&response, "{\"ok\":true}") == ESP_OK); /* b, generation 2 */
    assert(storage_mgr_result_ack("device-a", "torn-ack", UNIFIED_ACTION_CMD_SEND_SMS) == ESP_OK); /* a, generation 3 */
    corrupt("result-journal-data/r00a");
    storage_result_journal_test_reboot(test_dir);
    assert(storage_mgr_result_next(&replay, payload, sizeof(payload)) == ESP_OK);
    assert(strcmp(replay.action.correlation.correlation_id, "torn-ack") == 0);
    assert(strcmp(payload, "{\"ok\":true}") == 0);
}

static void test_legacy_upgrade_preserves_terminal_and_reservation(void) {
    char payload[PAYLOAD_LEN] = {0};
    unified_action_response_t replay = {0};
    unified_action_envelope_t completed = action("old-terminal");
    unified_action_envelope_t reserved = action("old-reservation");
    unified_action_envelope_t acked = action("old-acked");
    clear_journal();
    write_legacy(0, 0, 1, 1, terminal(completed), "");
    write_legacy(0, 1, 2, 2, terminal(completed), "{\"legacy\":true}");
    write_legacy(1, 0, 5, 1, terminal(reserved), "");
    write_legacy(2, 0, 10, 2, terminal(acked), "{}");
    write_legacy(2, 1, 11, 3, terminal(acked), "");
    storage_result_journal_test_reboot(test_dir);
    assert(storage_mgr_result_get(&completed, &replay, payload, sizeof(payload)) == ESP_OK);
    assert(replay.result == UNIFIED_ACTION_RESULT_COMPLETED);
    assert(strcmp(payload, "{\"legacy\":true}") == 0);
    assert(storage_mgr_result_reserve(&completed) == ESP_ERR_NOT_ALLOWED);
    assert(storage_mgr_result_get(&reserved, &replay, payload, sizeof(payload)) == ESP_OK);
    assert(replay.result == UNIFIED_ACTION_RESULT_FAILED);
    assert(strstr(payload, "\"outcome_uncertain\":true"));
    assert(storage_mgr_result_reserve(&reserved) == ESP_ERR_NOT_ALLOWED);
    assert(storage_mgr_result_get(&acked, &replay, payload, sizeof(payload)) == ESP_OK);
    assert(storage_mgr_result_ack("device-a", "old-terminal", UNIFIED_ACTION_CMD_SEND_SMS) == ESP_OK);
    assert_disk_format(0, 0, 1, 4256);
    storage_result_journal_test_reboot(test_dir);
    assert(storage_mgr_result_get(&completed, &replay, payload, sizeof(payload)) == ESP_OK);
    assert(strcmp(payload, "{\"legacy\":true}") == 0);
}

static void test_payload_boundaries_reboot_and_ack(void) {
    static const size_t lengths[] = {4095U, 4096U, 8191U};
    char input[PAYLOAD_LEN + 1U];
    char output[PAYLOAD_LEN];
    unified_action_response_t replay = {0};
    for (size_t index = 0; index < sizeof(lengths) / sizeof(lengths[0]); ++index) {
        unified_action_envelope_t envelope = action("boundary");
        unified_action_response_t response = terminal(envelope);
        size_t length = lengths[index];
        clear_journal();
        memset(input, 's', length);
        input[0] = '"';
        input[length - 1] = '"';
        input[length] = '\0';
        assert(storage_mgr_result_reserve(&envelope) == ESP_OK);
        assert_disk_format(0, 0, 1, 4256);
        assert(storage_mgr_result_commit(&response, input) == ESP_OK);
        assert_disk_format(0, 1, length < 4096U ? 1U : 2U, length < 4096U ? 4256 : 8352);
        storage_result_journal_test_reboot(test_dir);
        assert(storage_mgr_result_get(&envelope, &replay, output, sizeof(output)) == ESP_OK);
        assert(strcmp(input, output) == 0);
        assert(storage_mgr_result_next(&replay, output, sizeof(output)) == ESP_OK);
        assert(strcmp(input, output) == 0);
        assert(storage_mgr_result_commit(&response, "{}") == ESP_ERR_INVALID_STATE);
        assert(storage_mgr_result_ack("wrong-device", "boundary", UNIFIED_ACTION_CMD_SEND_SMS) == ESP_ERR_NOT_FOUND);
        assert(storage_mgr_result_ack("device-a", "boundary", UNIFIED_ACTION_CMD_SEND_SMS) == ESP_OK);
        assert_disk_format(0, 0, length < 4096U ? 1U : 2U, length < 4096U ? 4256 : 8352);
        storage_result_journal_test_reboot(test_dir);
        assert(storage_mgr_result_get(&envelope, &replay, output, sizeof(output)) == ESP_OK);
        assert(strcmp(input, output) == 0);
    }
    clear_journal();
    unified_action_envelope_t envelope = action("oversize");
    unified_action_response_t response = terminal(envelope);
    memset(input, 'x', PAYLOAD_LEN);
    input[PAYLOAD_LEN] = '\0';
    assert(storage_mgr_result_reserve(&envelope) == ESP_OK);
    assert(storage_mgr_result_commit(&response, input) == ESP_ERR_INVALID_ARG);
    assert(storage_mgr_result_commit(&response, "{}") == ESP_OK);
}

static void test_large_torn_terminal_and_ack(void) {
    char input[PAYLOAD_LEN];
    char output[PAYLOAD_LEN];
    unified_action_response_t replay = {0};
    unified_action_envelope_t envelope = action("large-torn");
    unified_action_response_t response = terminal(envelope);
    memset(input, 'x', sizeof(input) - 1U);
    input[sizeof(input) - 1U] = '\0';
    clear_journal();
    assert(storage_mgr_result_reserve(&envelope) == ESP_OK);
    assert(storage_mgr_result_commit(&response, input) == ESP_OK);
    assert(storage_mgr_result_ack("device-a", "large-torn", UNIFIED_ACTION_CMD_SEND_SMS) == ESP_OK);
    corrupt("result-journal-data/r00a");
    storage_result_journal_test_reboot(test_dir);
    assert(storage_mgr_result_get(&envelope, &replay, output, sizeof(output)) == ESP_OK);
    assert(strcmp(input, output) == 0);
    clear_journal();
    assert(storage_mgr_result_reserve(&envelope) == ESP_OK);
    assert(storage_mgr_result_commit(&response, input) == ESP_OK);
    corrupt("result-journal-data/r00b");
    storage_result_journal_test_reboot(test_dir);
    assert(storage_mgr_result_get(&envelope, &replay, output, sizeof(output)) == ESP_OK);
    assert(replay.result == UNIFIED_ACTION_RESULT_FAILED);
    assert(strstr(output, "\"outcome_uncertain\":true"));
    assert(storage_mgr_result_reserve(&envelope) == ESP_ERR_NOT_ALLOWED);
}

static void test_large_checksum_failure_preserves_reservation(void) {
    char input[PAYLOAD_LEN];
    char output[PAYLOAD_LEN];
    unified_action_response_t replay = {0};
    unified_action_envelope_t envelope = action("large-corrupt");
    unified_action_response_t response = terminal(envelope);
    clear_journal();
    memset(input, 'x', sizeof(input) - 1U);
    input[sizeof(input) - 1U] = '\0';
    assert(storage_mgr_result_reserve(&envelope) == ESP_OK);
    assert(storage_mgr_result_commit(&response, input) == ESP_OK);
    FILE *file = fopen("result-journal-data/r00b", "r+b");
    assert(file);
    assert(fseek(file, 160 + 6000, SEEK_SET) == 0);
    assert(fputc('y', file) == 'y');
    assert(fclose(file) == 0);
    storage_result_journal_test_reboot(test_dir);
    assert(storage_mgr_result_get(&envelope, &replay, output, sizeof(output)) == ESP_OK);
    assert(replay.result == UNIFIED_ACTION_RESULT_FAILED);
    assert(strstr(output, "\"outcome_uncertain\":true"));
}

static void test_generation_wrap_and_failed_write(void) {
    char payload[PAYLOAD_LEN];
    unified_action_response_t replay = {0};
    unified_action_envelope_t envelope = action("wrap");
    unified_action_response_t response = terminal(envelope);
    clear_journal();
    write_legacy(0, 0, UINT32_MAX, 1, response, "");
    assert(storage_mgr_result_commit(&response, "{\"wrapped\":true}") == ESP_OK);
    storage_result_journal_test_reboot(test_dir);
    assert(storage_mgr_result_get(&envelope, &replay, payload, sizeof(payload)) == ESP_OK);
    assert(strcmp(payload, "{\"wrapped\":true}") == 0);
    clear_journal();
    assert(storage_mgr_result_reserve(&envelope) == ESP_OK);
    assert(_mkdir("result-journal-data/r00b") == 0);
    assert(storage_mgr_result_commit(&response, "{}") == ESP_FAIL);
    assert(storage_mgr_result_reserve(&envelope) == ESP_ERR_NOT_FINISHED);
    assert(_rmdir("result-journal-data/r00b") == 0);
    assert(storage_mgr_result_commit(&response, "{\"retry\":true}") == ESP_OK);
    storage_result_journal_test_reboot(test_dir);
    assert(storage_mgr_result_get(&envelope, &replay, payload, sizeof(payload)) == ESP_OK);
    assert(strcmp(payload, "{\"retry\":true}") == 0);
}

static void test_rejected_unknown_ack_unblocks_next_result(void) {
    char payload[PAYLOAD_LEN];
    unified_action_response_t replay = {0};
    unified_action_envelope_t rejected = action("unknown-rejected");
    unified_action_envelope_t next = action("next-status");
    rejected.command = UNIFIED_ACTION_CMD_NONE;
    unified_action_response_t response = terminal(rejected);
    response.result = UNIFIED_ACTION_RESULT_REJECTED;
    clear_journal();
    assert(storage_mgr_result_reserve(&rejected) == ESP_OK);
    assert(storage_mgr_result_commit(&response, "{}") == ESP_OK);
    assert(storage_mgr_result_reserve(&next) == ESP_OK);
    response = terminal(next);
    assert(storage_mgr_result_commit(&response, "{\"next\":true}") == ESP_OK);
    storage_result_journal_test_reboot(test_dir);
    assert(storage_mgr_result_next(&replay, payload, sizeof(payload)) == ESP_OK);
    assert(replay.action.command == UNIFIED_ACTION_CMD_NONE);
    assert(storage_mgr_result_ack("device-a", "unknown-rejected", UNIFIED_ACTION_CMD_SEND_SMS) == ESP_ERR_NOT_FOUND);
    assert(storage_mgr_result_ack("device-a", "unknown-rejected", UNIFIED_ACTION_CMD_NONE) == ESP_OK);
    storage_result_journal_test_reboot(test_dir);
    assert(storage_mgr_result_next(&replay, payload, sizeof(payload)) == ESP_OK);
    assert(strcmp(replay.action.correlation.correlation_id, "next-status") == 0);
    assert(storage_mgr_result_get(&rejected, &replay, payload, sizeof(payload)) == ESP_OK);
    assert(replay.result == UNIFIED_ACTION_RESULT_REJECTED);
}

int main(void) {
    test_commit_reboot_and_exact_ack();
    test_full_is_bounded_and_ack_releases_one();
    test_torn_terminal_reports_and_reclaims_uncertain_result();
    test_torn_ack_replays_previous_terminal();
    test_legacy_upgrade_preserves_terminal_and_reservation();
    test_payload_boundaries_reboot_and_ack();
    test_large_torn_terminal_and_ack();
    test_large_checksum_failure_preserves_reservation();
    test_generation_wrap_and_failed_write();
    test_rejected_unknown_ack_unblocks_next_result();
    puts("result journal host tests passed: 10 scenarios, V1 migration and V2 8191-byte replay");
    return 0;
}
