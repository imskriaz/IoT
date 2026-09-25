int main(void) {
    int indexes[24] = {0};

    const char *report_then_parts =
        "\r\n+CMGL: 5,\"REC UNREAD\",6,145,\"+8801000000000\",145,\"26/09/13,09:21:36+24\",\"26/09/13,09:27:31+24\",0\r\n"
        "\r\n"
        "+CMGL: 17,\"REC UNREAD\",\"+8801000000000\",,\"26/09/13,09:21:37+24\"\r\n"
        "part one\r\n"
        "+CMGL: 18,\"REC READ\",\"+8801000000000\",,\"26/09/13,09:21:38+24\"\r\n"
        "part two\r\n\r\nOK\r\n";
    size_t count = modem_a7670_parse_sms_list_indexes(
        report_then_parts,
        indexes,
        sizeof(indexes) / sizeof(indexes[0])
    );
    assert(count == 3U);
    assert(indexes[0] == 5);
    assert(indexes[1] == 17);
    assert(indexes[2] == 18);

    memset(indexes, 0, sizeof(indexes));
    const char *duplicates =
        "+CMGL: 2,\"STO SENT\",\"+8801000000000\"\r\n"
        "+CMGL: 2,\"STO SENT\",\"+8801000000000\"\r\n"
        "+CMGL: 7,\"STO UNSENT\",\"+8801000000000\"\r\n";
    count = modem_a7670_parse_sms_list_indexes(duplicates, indexes, 24U);
    assert(count == 2U);
    assert(indexes[0] == 2);
    assert(indexes[1] == 7);

    memset(indexes, 0, sizeof(indexes));
    const char *header_shaped_body =
        "+CMGL: 4,\"REC UNREAD\",\"+8801000000000\"\r\n"
        "body +CMGL: 80,\"REC UNREAD\",not-a-record\r\n"
        "+CMGL: 81,\"ordinary body text\"\r\n"
        "+CMGL: 9,\"REC READ\",\"+8801000000000\"\r\n";
    count = modem_a7670_parse_sms_list_indexes(header_shaped_body, indexes, 24U);
    assert(count == 2U);
    assert(indexes[0] == 4);
    assert(indexes[1] == 9);

    memset(indexes, 0, sizeof(indexes));
    const char *malformed_then_valid =
        "+CMGL: 65536,\"REC UNREAD\",\"x\"\r\n"
        "+CMGL: -1,\"REC UNREAD\",\"x\"\r\n"
        "+CMGL: 23,\"REC UNREAD\"\r\n"
        "+CMGL: 24,\"REC UNREAD\",\"x\"\r\n";
    count = modem_a7670_parse_sms_list_indexes(malformed_then_valid, indexes, 24U);
    assert(count == 1U);
    assert(indexes[0] == 24);

    memset(indexes, 0, sizeof(indexes));
    count = modem_a7670_parse_sms_list_indexes(report_then_parts, indexes, 2U);
    assert(count == 2U);
    assert(indexes[0] == 5 && indexes[1] == 17);

    assert(modem_a7670_parse_sms_list_indexes(NULL, indexes, 24U) == 0U);
    assert(modem_a7670_parse_sms_list_indexes("OK\r\n", indexes, 24U) == 0U);
    assert(modem_a7670_parse_sms_list_indexes(report_then_parts, NULL, 24U) == 0U);
    assert(modem_a7670_parse_sms_list_indexes(report_then_parts, indexes, 0U) == 0U);

    puts("Pending CMGL multi-index parsing: all checks passed");
    return 0;
}
