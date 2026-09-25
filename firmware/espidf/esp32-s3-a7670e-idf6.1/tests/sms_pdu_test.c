#define _CRT_SECURE_NO_WARNINGS
#include <assert.h>
#include <stdio.h>
#include "../components/modem_a7670/src/modem_sms_pdu.h"

static char pdu[520], sender[32], text[1024];
static modem_sms_pdu_t meta;
static void make(unsigned fo, unsigned dcs, unsigned udl, const char *body) {
    snprintf(pdu, sizeof(pdu), "00%02X0491214300%02X62903101815542%02X%s", fo,dcs,udl,body);
}
static bool parse(void) { return modem_sms_pdu_parse(pdu, strlen(pdu), &meta, sender, sizeof(sender), text, sizeof(text)); }
static void invalid(void) { assert(!parse()); assert(!text[0] && !sender[0] && !meta.has_concat); }
int main(void) {
    make(0x40, 8, 16, "0500032C020109AC09BE098209B209BE");
    assert(parse()); assert(strcmp(sender,"+1234")==0);
    assert(strcmp(text,"\xE0\xA6\xAC\xE0\xA6\xBE\xE0\xA6\x82\xE0\xA6\xB2\xE0\xA6\xBE")==0);
    assert(meta.has_concat && meta.concat_reference==44 && meta.part_index==1 && meta.part_count==2 && meta.concat_reference_bits==8);
    assert(strcmp(meta.scts,"26/09/13,10:18:55+24")==0);
    make(0x40,8,11,"0608041234020200410042");
    assert(parse()); assert(strcmp(text,"AB")==0 && meta.concat_reference==0x1234 && meta.concat_reference_bits==16 && meta.part_index==2);
    make(0,8,4,"D83DDE00"); assert(parse()); assert(strcmp(text,"\xF0\x9F\x98\x80")==0);
    make(0,0,5,"E8329BFD06"); assert(parse()); assert(strcmp(text,"hello")==0);
    strcpy(pdu,"000009D0E8329BFD060000629031018155420141");
    assert(parse()); assert(strcmp(sender,"hello")==0 && strcmp(text,"A")==0);
    /* Pack seven UDH septets + GSM escapes, checking non-byte-aligned start. */
    uint8_t ud[140] = {5,0,3,99,2,1};
    const uint8_t septets[] = {'A',27,20,27,101};
    for (size_t i=0;i<sizeof(septets);++i) {
        size_t bit=49U+i*7U;
        ud[bit/8U] |= (uint8_t)(septets[i] << (bit%8U));
        if (bit%8U>1U) ud[bit/8U+1U] |= (uint8_t)(septets[i] >> (8U-bit%8U));
    }
    char body[281];
    for(size_t i=0;i<11U;++i) snprintf(body+i*2U,3,"%02X",ud[i]);
    make(0x40,0,12,body); assert(parse()); assert(strcmp(text,"A^\xE2\x82\xAC")==0);
    /* Every truncation must fail without a partially usable result. */
    size_t length=strlen(pdu);
    for(size_t i=0;i<length;++i) {
        assert(!modem_sms_pdu_parse(pdu,i,&meta,sender,sizeof(sender),text,sizeof(text)));
        assert(!sender[0] && !text[0]);
    }
    make(0x40,8,8,"0500030102000041"); invalid(); /* zero index */
    make(0x40,8,8,"0500030102030041"); invalid(); /* index > count */
    make(0x40,8,8,"0500030100010041"); invalid(); /* zero count */
    make(0x40,8,8,"0900030102010041"); invalid(); /* UDH overrun */
    make(0x40,8,8,"0500030102010041FF"); invalid(); /* trailing data */
    make(0x40,8,8,"0504040102010041"); invalid(); /* unsupported port IE */
    make(0,8,2,"D800"); invalid();
    make(0,8,2,"DC00"); invalid();
    make(0,8,2,"0000"); invalid(); /* cannot represent NUL in text contract */
    make(0,8,1,"00"); invalid();
    make(0,4,1,"41"); invalid(); /* binary */
    make(0,0x20,1,"41"); invalid(); /* compressed */
    make(2,8,2,"0041"); invalid(); /* status reports not incoming text */
    make(1,8,2,"0041"); invalid(); /* submit */
    make(0,0,1,"1B"); invalid(); /* incomplete escape */
    make(0,8,2,"0041");
    assert(!modem_sms_pdu_parse(pdu,strlen(pdu),&meta,sender,2,text,sizeof(text)));
    assert(!modem_sms_pdu_parse(pdu,strlen(pdu),&meta,sender,sizeof(sender),text,1));
    pdu[10]='X'; invalid();
    /* Deterministic malformed traffic: bounds and atomic failure outputs. */
    uint32_t seed = 7U;
    for (size_t trial=0; trial<5000U; ++trial) {
        make(0x40,8,8,"0500030102010041");
        seed = seed * 1664525U + 1013904223U;
        size_t at = seed % strlen(pdu);
        pdu[at] = "0123456789ABCDEFX"[(seed >> 16U) & 15U];
        if (!parse()) assert(!sender[0] && !text[0] && !meta.has_concat);
    }
    puts("PDU GSM7/UCS2, UDH 8/16-bit, truncation and bounds checks passed");
    return 0;
}
