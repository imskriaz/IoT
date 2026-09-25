'use strict';

const fs = require('fs');
const path = require('path');

const firmwareRoot = path.resolve(__dirname, '../../firmware/espidf/esp32-s3-a7670e-idf6.1');

test('firmware reports PDP identity separately from socket bearer readiness', () => {
    const modemHeader = fs.readFileSync(
        path.join(firmwareRoot, 'components/modem_a7670/include/modem_a7670.h'),
        'utf8'
    );
    const modemSource = fs.readFileSync(
        path.join(firmwareRoot, 'components/modem_a7670/src/modem_a7670.c'),
        'utf8'
    );
    const statusHeader = fs.readFileSync(
        path.join(firmwareRoot, 'components/device_status/include/device_status.h'),
        'utf8'
    );
    const statusSource = fs.readFileSync(
        path.join(firmwareRoot, 'components/device_status/src/device_status.c'),
        'utf8'
    );

    expect(modemHeader).toContain('char pdp_ip_address[UNIFIED_IPV4_ADDR_LEN];');
    expect(modemSource).toContain('AT+CGPADDR=1');
    expect(modemSource).toContain('modem_a7670_parse_cgpaddr_response');
    expect(statusHeader).toContain('bool modem_data_session_open;');
    expect(statusHeader).toContain('char modem_pdp_ip_address[UNIFIED_IPV4_ADDR_LEN];');
    expect(statusSource).toContain('modem_data_session_open\\\":%s');
    expect(statusSource).toContain('modem_pdp_ip_address\\\":\\\"%s');
    expect(statusSource).toContain('modem->data_session_open &&');
    expect(statusSource).toContain('modem->ip_bearer_ready &&');
    expect(statusSource).not.toContain('state->data_mode_enabled ||');
});
