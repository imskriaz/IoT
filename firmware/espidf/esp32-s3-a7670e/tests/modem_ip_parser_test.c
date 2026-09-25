#include <assert.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    char ip[UNIFIED_IPV4_ADDR_LEN] = {0};

    assert(modem_a7670_parse_ipaddr_response("\r\n+IPADDR: 10.175.163.107\r\nOK\r\n", ip, sizeof(ip)));
    assert(strcmp(ip, "10.175.163.107") == 0);

    assert(modem_a7670_parse_cgpaddr_response("\r\n+CGPADDR: 1,10.175.163.107\r\nOK\r\n", ip, sizeof(ip)));
    assert(strcmp(ip, "10.175.163.107") == 0);

    assert(modem_a7670_parse_cgpaddr_response("\r\n+CGPADDR: 1,\"100.65.1.2\"\r\nOK\r\n", ip, sizeof(ip)));
    assert(strcmp(ip, "100.65.1.2") == 0);

    assert(!modem_a7670_parse_ipaddr_response("\r\n+IPADDR: 0.0.0.0\r\nOK\r\n", ip, sizeof(ip)));
    assert(!modem_a7670_parse_cgpaddr_response("\r\n+CGPADDR: 1,999.1.2.3\r\nOK\r\n", ip, sizeof(ip)));
    assert(!modem_a7670_parse_cgpaddr_response("\r\n+CGPADDR: 1\r\nOK\r\n", ip, sizeof(ip)));
    assert(!modem_a7670_parse_cgpaddr_response("\r\nERROR\r\n", ip, sizeof(ip)));

    puts("modem IPADDR/CGPADDR parser tests passed");
    return 0;
}
