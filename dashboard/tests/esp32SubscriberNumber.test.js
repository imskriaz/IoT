'use strict';

// Execute the actual firmware functions on the host; do not reimplement their
// parser in JavaScript or mistake source-string checks for behavior coverage.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const sourcePath = path.resolve(__dirname, '../../firmware/espidf/esp32-s3-a7670e-idf6.1/components/modem_a7670/src/modem_a7670.c');
let temporary;
let executable;

function sliceFunction(source, name, next) {
    return source.slice(source.indexOf(`static ${name}`), source.indexOf(next, source.indexOf(`static ${name}`)));
}

beforeAll(() => {
    const source = fs.readFileSync(sourcePath, 'utf8');
    const functions = [
        sliceFunction(source, 'bool modem_a7670_extract_subscriber_number_candidate', 'void modem_a7670_publish_status_locked'),
        sliceFunction(source, 'void modem_a7670_parse_subscriber_number_locked', 'static void modem_a7670_parse_cbc_locked')
    ].join('\n');
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'iot-subscriber-test-'));
    executable = path.join(temporary, process.platform === 'win32' ? 'subscriber.exe' : 'subscriber');
    const harness = `
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <assert.h>
#define ESP_OK 0
#define ESP_LOGW(...) ((void)0)
static struct { char subscriber_number[32]; char last_response[512]; } s_status;
static int modem_a7670_command(const char *, char *, size_t, uint32_t);
${functions}
typedef struct { const char *command; const char *response; int result; } step_t;
static step_t steps[12];
static size_t step_count, step_index;
static int modem_a7670_command(const char *command, char *out, size_t capacity, uint32_t timeout) {
    (void)timeout;
    assert(step_index < step_count);
    step_t step = steps[step_index++];
    if (strcmp(command, step.command)) { fprintf(stderr, "Unexpected command at step %zu\\n", step_index); exit(2); }
    snprintf(out, capacity, "%s", step.response);
    if (!strncmp(step.response, "+CNUM:", 6)) modem_a7670_parse_subscriber_number_locked(step.response);
    return step.result;
}
static void add(const char *command, const char *response, int result) {
    steps[step_count++] = (step_t){ command, response, result };
}
int main(int argc, char **argv) {
    assert(argc >= 2);
    if (!strcmp(argv[1], "parse")) {
        char output[32] = "old";
        assert(argc == 4);
        bool found = modem_a7670_extract_subscriber_number_candidate(argv[2], output, sizeof(output));
        assert(found == (argv[3][0] != 0));
        assert(!strcmp(output, argv[3]));
        return 0;
    }
    const char *scenario = argv[1];
    bool cnum = !strcmp(scenario, "cnum");
    bool original_on = !strcmp(scenario, "already-on");
    bool query_fail = !strcmp(scenario, "query-fail");
    bool select_fail = !strcmp(scenario, "select-fail");
    bool empty = !strcmp(scenario, "empty");
    bool read_fail = !strcmp(scenario, "read-fail");
    bool bad_range = !strcmp(scenario, "bad-range");
    bool restore_fail = !strcmp(scenario, "restore-fail");
    bool wide_range = !strcmp(scenario, "wide-range");
    add("AT+CNUM", cnum ? "+CNUM: \\"SIM1\\",\\"+8801700000000\\",145" : "OK", 0);
    if (!cnum) {
        add("AT+CPBS?", query_fail ? "OK" : original_on ? "+CPBS: \\"ON\\",1,3" : "+CPBS: \\"SM\\",1,500", 0);
        if (!query_fail) {
            if (!original_on) add("AT+CPBS=\\"ON\\"", "OK", select_fail ? -1 : 0);
            if (!select_fail) {
                add("AT+CPBS?", empty ? "+CPBS: \\"ON\\",0,3" : "+CPBS: \\"ON\\",1,3", 0);
                if (!empty) {
                    add("AT+CPBR=?", bad_range ? "+CPBR: (3-1),40,14" : wide_range ? "+CPBR: (1-100),40,14" : "+CPBR: (1-3),40,14", 0);
                    if (!bad_range) add(wide_range ? "AT+CPBR=1,20" : "AT+CPBR=1,3", read_fail ? "+CME ERROR: not found" : "\\r\\n+CPBR: 1,\\"+8801700000000\\",145,\\"SIM1\\"\\r\\nOK", read_fail ? -1 : 0);
                }
            }
            if (!original_on) add("AT+CPBS=\\"SM\\"", "OK", restore_fail ? -1 : 0);
        }
    }
    char response[512];
    modem_a7670_refresh_subscriber_number_locked(response, sizeof(response), 1000);
    assert(step_index == step_count);
    assert(!strcmp(s_status.subscriber_number, query_fail || select_fail || empty || read_fail || bad_range ? "" : "+8801700000000"));
    return 0;
}
`.replace(/\\\\"/g, '\\"');
    const harnessPath = path.join(temporary, 'subscriber.c');
    fs.writeFileSync(harnessPath, harness);
    if (process.platform === 'win32') {
        const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
        const installation = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8' }).trim();
        if (!installation) throw new Error('MSVC host compiler required for executable firmware parser regression');
        const setup = path.join(installation, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
        execFileSync('cmd.exe', ['/d', '/s', '/c', `""${setup}" >nul && cl /nologo /std:c11 /D_CRT_SECURE_NO_WARNINGS subscriber.c /Fe:subscriber.exe"`], { cwd: temporary, stdio: 'pipe', windowsVerbatimArguments: true });
    } else {
        execFileSync(process.env.CC || 'cc', ['-std=c11', '-Wall', '-Wextra', harnessPath, '-o', executable], { stdio: 'pipe' });
    }
}, 60000);

afterAll(() => {
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
});

test.each([
    ['+CNUM: "SIM1","+8801700000000",145', '+8801700000000'],
    ['+CNUM: "SIM1, 2","01700000000",129', '01700000000'],
    ['+CNUM: ,"01700000000",129', '01700000000'],
    ['+CPBR: 3,"+8801700000000",145,"Contact 2"', '+8801700000000'],
    ['+CNUM: "SIM1","",145', ''],
    ['+CNUM: "SIM1",,145', ''],
    ['+CNUM: "SIM1","abc12",145', ''],
    ['+CNUM: "SIM1","+",145', ''],
    ['+CNUM: "SIM1","+8801700000000', ''],
    ['+CNUM: "SIM1","1234567890123456789012345678901234567890",145', ''],
    ['+CPBR: 3,"",145,"Contact 2"', ''],
    ['+CPBR: 3,145,"Contact 2"', ''],
    ['+CSCA: "+8801700000000",145', ''],
    ['OK', '']
])('extracts only the number field: %s', (line, expected) => {
    expect(() => execFileSync(executable, ['parse', line, expected], { stdio: 'pipe' })).not.toThrow();
});

test.each(['cnum', 'already-on', 'query-fail', 'select-fail', 'empty', 'read-fail', 'bad-range', 'restore-fail', 'wide-range', 'found'])('safe own-number lookup: %s', scenario => {
    expect(() => execFileSync(executable, [scenario], { stdio: 'pipe' })).not.toThrow();
});
