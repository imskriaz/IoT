#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "../components/modem_a7670/src/modem_sms_cmgr.h"

int main(void) {
    char recipient[64];
    unsigned reference = 999, status = 999;
    const char *report = "\r\n+CMGR: \"REC READ\",6,145,\"+8801000000000\",145,\"26/09/13,09:21:36+24\",\"26/09/13,09:27:31+24\",0\r\n\r\nOK\r\n";
    assert(!modem_sms_cmgr_is_message(report));
    assert(modem_sms_cmgr_parse_report(report, recipient, sizeof(recipient), &reference, &status));
    assert(reference == 145 && status == 0);
    assert(strcmp(recipient, "+8801000000000") == 0);

    const char *ascii = "\r\n+CMGR: \"REC UNREAD\",\"+8801000000000\",,\"26/09/13,09:21:36+24\"\r\nIoT self test\r\n\r\nOK\r\n";
    const char *ucs2 = "\r\n+CMGR: \"REC READ\",\"002B00380038\",,\"26/09/13,09:21:36+24\"\r\n09AC09BE098209B209BE\r\n\r\nOK\r\n";
    const char *empty = "\r\n+CMGR: \"REC UNREAD\",\"+8801000000000\",,\"26/09/13,09:21:36+24\"\r\n\r\nOK\r\n";
    assert(modem_sms_cmgr_is_message(ascii));
    assert(modem_sms_cmgr_is_message(ucs2));
    assert(modem_sms_cmgr_is_message(empty));
    assert(!modem_sms_cmgr_parse_report(ascii, recipient, sizeof(recipient), &reference, &status));
    assert(!modem_sms_cmgr_parse_report(ucs2, recipient, sizeof(recipient), &reference, &status));

    const char *failed = "+CMGR: \"REC READ\",2,255,\"002B00380038\",145,\"26/09/13,09:21:36+24\",\"26/09/13,09:27:31+24\",64\r\nOK\r\n";
    assert(modem_sms_cmgr_parse_report(failed, recipient, sizeof(recipient), &reference, &status));
    assert(reference == 255 && status == 64 && strcmp(recipient, "002B00380038") == 0);
    assert(!modem_sms_cmgr_parse_report(report, recipient, 4U, &reference, &status));
    const char *invalid[] = {
        NULL, "", "OK\r\n", "+CMGR: \"REC READ\",", "+CMGR: \"REC READ\",6,145,\"x\",145,\"time\",\"time\",0",
        "+CMGR: \"REC READ\",1,145,\"x\",145,\"time\",\"time\",0\r\nOK\r\n",
        "+CMGR: \"REC READ\",6,256,\"x\",145,\"time\",\"time\",0\r\nOK\r\n",
        "+CMGR: \"REC READ\",6,145,\"x\",145,\"time\",\"time\",256\r\nOK\r\n",
        "+CMGR: \"REC READ\",6,145,\"x\",145,\"time\",\"time\",\r\nOK\r\n",
        "+CMGR: \"REC READ\",6,145,\"x\",145,\"time\",\"time\",0\r\nERROR\r\n",
        "+CMGR: \"REC READ\",6,145,\"x\",145,\"time\",\"time\",0junk\r\nOK\r\n"
    };
    for (size_t i = 0; i < sizeof(invalid) / sizeof(invalid[0]); ++i) {
        assert(!modem_sms_cmgr_parse_report(invalid[i], recipient, sizeof(recipient), &reference, &status));
    }
    puts("CMGR report/message discrimination: all checks passed");
    return 0;
}
