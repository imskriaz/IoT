#include <assert.h>
#include <direct.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include "storage_mgr.h"

#define PAYLOAD_LEN 4096U
#define SLOT_COUNT 16U
void storage_result_journal_test_reboot(const char *directory);

static const char *test_dir = "result-journal-data";

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
    assert(storage_mgr_result_reserve(&envelope) == ESP_OK);
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
    assert(storage_mgr_result_reserve(&envelope) == ESP_OK);
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

int main(void) {
    test_commit_reboot_and_exact_ack();
    test_full_is_bounded_and_ack_releases_one();
    test_torn_terminal_reports_and_reclaims_uncertain_result();
    test_torn_ack_replays_previous_terminal();
    puts("result journal host tests passed");
    return 0;
}
