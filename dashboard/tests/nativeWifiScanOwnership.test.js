'use strict';
const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.resolve(__dirname,
    '../../firmware/espidf/esp32-s3-a7670e-idf6.1/components/wifi_mgr/src/wifi_mgr_scan.c'), 'utf8');

// Structural guard for ownership ordering, not a simulated RTOS stress test.
test('preconnect scratch is untouched until the state lock and busy check', () => {
    const body = source.slice(source.indexOf('static esp_err_t wifi_mgr_prepare_connect_config('));
    const lock = body.indexOf('if (xSemaphoreTake(s_lock, pdMS_TO_TICKS(100)) != pdTRUE)');
    const busy = body.indexOf('if (s_scan_in_progress)');
    const clear = body.indexOf('memset(scratch, 0, sizeof(*scratch))');
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(busy).toBeGreaterThan(lock);
    expect(clear).toBeGreaterThan(busy);
});

test('both scan owners wait for their cleanup lock instead of leaking busy state', () => {
    const clears = [...source.matchAll(/if \(([^\n]+)\) \{\s*s_scan_in_progress = false;/g)];
    expect(clears).toHaveLength(2);
    for (const match of clears) expect(match[1]).toContain('portMAX_DELAY');
});
