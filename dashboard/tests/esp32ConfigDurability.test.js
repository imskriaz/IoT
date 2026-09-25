'use strict';

const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname,
    '../../firmware/espidf/esp32-s3-a7670e-idf6.1/components/config_mgr/src/config_mgr.c'), 'utf8');
const appMain = fs.readFileSync(path.join(__dirname,
    '../../firmware/espidf/esp32-s3-a7670e-idf6.1/main/app_main.c'), 'utf8');

describe('ESP32 config persistence source contract', () => {
    test('uses one bounded worker queue instead of a task per request', () => {
        expect(source).toContain('xQueueCreate(CONFIG_APPLY_QUEUE_DEPTH');
        expect(source).toContain('xQueueSend(s_apply_queue');
        expect(source).toContain('xSemaphoreTake(done, pdMS_TO_TICKS(CONFIG_APPLY_WAIT_MS))');
        expect(source.match(/xTaskCreatePinnedToCore\s*\(/g)).toHaveLength(1);
        expect(source).not.toContain('xSemaphoreTake(done, portMAX_DELAY)');
    });

    test('does not commit an unchanged config or request a restart', () => {
        expect(source).toContain('memcmp(&current, &next, sizeof(next)) == 0');
        expect(source).toContain('restart_required = false;');
    });

    test('enters a data-preserving recovery loop when NVS cannot initialize', () => {
        expect(appMain).toContain('RECOVERY_ONLY nvs_unavailable=');
        expect(appMain).toContain('data_preserved=yes');
        expect(appMain).not.toContain('ESP_ERROR_CHECK(init_nvs())');
    });
});
