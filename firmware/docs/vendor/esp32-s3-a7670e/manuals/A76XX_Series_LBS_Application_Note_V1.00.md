# A76XX_Series_LBS_Application_Note_V1.00

Source PDF: [A76XX_Series_LBS_Application_Note_V1.00.pdf](./A76XX_Series_LBS_Application_Note_V1.00.pdf)

Total pages: 12

> Auto-generated from the PDF text layer. Layout-heavy pages may lose table, column, and diagram fidelity.

## PDF Page 1

A7600 Series_
LBS_Application Note

SIMCom Wireless Solutions Limited
Building B, SIM Technology Building, No.633, Jinzhong Road
Changning District, Shanghai P.R. China
Tel: 86-21-31575100
support@simcom.com
www.simcom.com
LTE Module

## PDF Page 2

- **Document Title:** A7600 Series_LBS_Application Note
- **Version:** 1.00
- **Date:** 2020.6.19
- **Status:** Released

## General Notes

SIMCOM OFFERS THIS INFORMATION AS A SERVICE TO ITS CUSTOMERS, TO SUPPORT
APPLICATION AND ENGINEERING EFFORTS THAT USE THE PRODUCTS DESIGNED BY SIMCOM.
THE INFORMATION PROVIDED IS BASED UPON REQUIREMENTS SPECIFICALLY PROVIDED TO
SIMCOM BY THE CUSTOMERS. SIMCOM HAS NOT UNDERTAKEN ANY INDEPENDENT SEARCH
FOR ADDITIONAL RELEVANT INFORMATION, INCLUDING ANY INFORMATION THAT MAY BE IN THE
CUSTOMER'S POSSESSION. FURTHERMORE, SYS TEM VALIDATION OF THIS PRODUCT
DESIGNED BY SIMCOM WITHIN A LARGER ELECTRONIC SYSTEM REMAINS THE RESPONSIBILITY
OF THE CUSTOMER OR THE CUSTOMER'S SYSTEM INTEGRATOR. ALL SPECIFICATIONS
SUPPLIED HEREIN ARE SUBJECT TO CHANGE.

## Copyright

THIS DOCUMENT CONTAINS PROPRIETARY TECHNICAL INFORMATION WHICH IS THE PROPERTY
OF SIMCOM WIRELESS SOLUTIONS LIMITED COPYING, TO OTHERS AND USING THIS DOCUMENT,
ARE FORBIDDEN WITHOUT EXPRESS AUTHORITY BY SIMCOM. OFFENDERS ARE LIABLE TO THE
PAYMENT OF INDEMN IFICATIONS. ALL RIGHTS RESERVED  BY SIMCOM IN THE PROPRIETARY
TECHNICAL INFORMATION ，INCLUDING BUT NOT LIMITED TO REGISTRATION GRANTING OF A
PATENT , A UTILITY MODEL OR DESIGN. ALL SPECIFICATION SUPPLIED HEREIN ARE SUBJECT TO
CHANGE WITHOUT NOTICE AT ANY TIME.

SIMCom Wireless Solutions Limited
Building B, SIM Technology Building, No.633 Jinzhong Road, Changning District, Shanghai P.R. China
Tel: +86 21 31575100
Email: simcom@simcom.com

For more information, please visit:
https://www.simcom.com/download/list-863-en.html

For technical support, or to report documentation errors, please visit:
https://www.simcom.com/ask/ or email to: support@simcom.com

Copyright © 2020 SIMCom Wireless Solutions Limited All Rights Reserved.

## PDF Page 3

### About Document

### Version History

Version Date Chapter What is new
V1.00 2020.06.19  New version

Scope

This document presents the AT Command Set for SIMCom A7600 Series, including A7600XX -XXXX,
A5360E, and A7670X.

## PDF Page 4

### Contents

- About Document (page 2)
- Version History (page 2)
- Scope (page 2)
- Contents (page 3)
- 1 Introduction (page 4)
- 1.1 Purpose of the document (page 4)
- 1.2 Related documents (page 4)
- 1.3 Conventions and abbreviations (page 4)
- 1.4 The process of LBS AT Commands (page 5)
## 1.5 Error Handling.................................................................................................................................. 6
- 1.5.1 Failed to Get Location (page 6)
- 2 AT Commands for LBS (page 7)
- 2.1 Overview of AT Commands for LBS (page 7)
- 2.2 Detailed Description of AT Commands for LBS (page 7)
- 2.2.1 AT+CLBS  Base station location (page 7)
- 3 LBS Examples (page 10)
- 3.1 Get location (page 10)

## PDF Page 5

1 Introduction

## 1.1 Purpose of the document

Based on module AT command manual, this document will introduce LBS application process.

Developers could understand and develop application quickly and efficiently based on this document.

## 1.2 Related documents

[1] A7600 Series_AT Command Manual

## 1.3 Conventions and abbreviations

PDP  Packet Data Protocol;
LBS  Location Based Services;
URC  Unsolicited result codes;
DNS  Domain Name Server;
UTC  Coordinated Universal Time;
YYYY/MM/DD  Year/Month/Day;
HH:MM:SS  Hour:Minute:Second;
IMEI  International M obile Equipment Identity;
UCS2  Unicode

## PDF Page 6

## 1.4 The process of LBS AT Commands

Power on the module
Query SIM card status by AT+CPIN?
Query CS service by AT+CREG?
Query PS service by
AT+CGREG?/AT+CEREG?
Query UE information by
AT+CPSI?
Configure the PDP context by
AT+CGDCONT
Active the PDP context by
AT+CGACT=<state>,[<cid>] and
AT+CGACT?
Query signal quality by AT+CSQ
CS Service:
If <stat> of AT+CREG? equals to 1,it means that
the module has registered on CS domain
service.Reboot the module if it fails to
registered on CS domain.
PS Serivce:
If <stat> of AT+CGREG?/AT+CEREG? equals to
1,it means that the module has registered on
PS domain service.
SIM Card Status:
Execute AT+CPIN?,if response is
+CPIN:READY,means SIM Card Status is
normal.Reboot the module or check SIM card
status if AT+CPIN? Fails to identify SIM card in
20s.
Signal quality:
Execute AT+CSQ to query signal quality.If rssi is
equals to 99,please check SIM card status or
reboot the module
UE system information:
If <System Mode> is "NO SERVICE",it means
network status has some problem.
PDP Context:
1.Configure PDP Context by
AT+CGDCONT=<cid>,<PDP_type>,<APN>
2.Activate the PDP Context by
AT+CGACT=<state>,[<cid>]
3.Query IP address of the PDP context by
AT+CGACT?
+CPIN: READY
+CSQ: <rssi>,<ber>,0 < rssi < 31
+CREG: 0,1
Check the status of SIM card or
Reboot the module
## No Service
## Pdp Active Fail
Configure the IMEI by
AT+SIMEI=<imei>
Get location by
AT+CLBS=<type>
Get location by the CLBS and before CLBS,the
IMEI must set

## PDF Page 7

## 1.5 Error Handling

### 1.5.1 Failed to Get Location

If it is failed to get location, please check the following aspects:
1. Query the status of the specified PDP context by AT+CGACT? command to check whether the
specified PDP context has been activated.
2.When the <ret_code> in the URC :+CLBS: <ret_code>[,<longitude>,<latitude>,<acc>,<date>,<time>]
is not 0, it indicates an error code,please refer to the chapter 2.2.1.
For more details, please refer to the chapter 2.2

## PDF Page 8

2 AT Commands for LBS

## 2.1 Overview of AT Commands for LBS

Command Description
##### AT+CLBS Base station location

## 2.2 Detailed Description of AT Commands for LBS

### 2.2.1 AT+CLBS  Base station location

The write command is used to base station location.

AT+ CLBS  Base station location
### Test Command
AT+CLBS=?
### Response
1)
+CLBS:
(1,2,3,4,9),(1-15),(-180.000000-180.000000),(-90.000000-90.000
000),(0,1)

OK
### Write Command
AT+CLBS=<type>[,<cid>[,
[<longitude>,<latitude>],[<lon_t
ype>]]]
### Response
OK

1)type = 1,get longitude and latitude
+CLBS: <ret_code>[,<longitude>,<latitude>,<acc>]

2)type = 2,get detail address
+CLBS: <ret_code>[,<detail_addr>]

3)type = 3,get access times
+CLBS: <ret_code>[,<times>]

## PDF Page 9

4)type = 4,get longitude latitude and date time
+CLBS:
<ret_code>[,<longitude>,<latitude>,<acc>,<date>,<time>]

5)type = 9, report positioning error
+CLBS: <ret_code>

6)
+CLBS: <ret_code>

ERROR
- **Parameter Saving Mode:** NO_SAVE
- **Maximum Response Time:** 9S
- **Reference:** 3GPP TS 27.007

### Defined Values

<type> A numeric parameter which specifies the location type.
1  use 3 cell's information
2  get detail address
3  get access times
4  get longitude latitude and date time
9  report positioning error
<cid> A numeric parameter which specifies a particular PDP context
definition (see AT+CGDCONT command).
1…15
<longitude> Current longitude in degrees.
<latitude> Current latitude in degrees.
<detail_addr> Current detail address. It based the UCS2 coding. Each 4 characters
in the URC is for one UCS2 character.
<acc> Positioning accuracy.
<lon_type> The type of longitude and latitude
0  WGS84，the default type
1  GCJ02.
<times> access service times.
<data> service date(UTC, the format is YYYY/MM/DD).
<time> service time(UTC, the format is HH:MM:SS).
<ret_code> The result code.
0   Success
1  Parameter error returned by server.
2  Service out  of time returned by server.
3  Location failed returned by server.
4  Query timeout returned by server.
5  Certification failed returned by server.

## PDF Page 10

6  Server LBS error success.
7  Server LBS error failed.
80  Report LBS to server success
81  Report LBS to server parameter error
82  Report LBS to server failed
110  Other Error

8   LBS is busy.
9   Open network error.
10  Close network error.
11  Operation timeout.
12  DNS  error.
13  Create socket error.
14  Connect socket error.
15  Close socket error.
16  Get cell info error.
17  Get IMEI error.
18  Send data error.
19  Receive data error.
20  NONET error.
21  Net not opened.

The LBS is only support in GSM/WCDMA /LTE net mode.It needs to make sure the network available
before executing the AT+CLBS write command.

## Note

## PDF Page 11

3 LBS Examples

Before LBS related operations, we should ensure the following:
Ensure GPRS network is available:

AT+CSQ
+CSQ: 23,0

OK
AT+CREG?
+CREG: 0,1

OK
AT+CGREG?
+CGREG: 0,1

OK

## 3.1 Get location

Following commands shows how to get location

AT+SIMEI=864424040019280 //set IMEI first if no IMEI
OK
AT+CLBS=1 //type = 1,get longitude and latitude
OK

+CLBS: 0,106.638084,29.489428,550

AT+CLBS=2 // type = 2,get detail address
OK

+CLBS:
0,91cd5e865e02002053575cb8533a002073899
a6c8def002097608fd15de54e1a548c4fe1606f5
31690e875354fe178147a7696620028897f90e8
520696620029

## PDF Page 12

AT+CLBS=3 // type = 3,get access times
OK

+CLBS: 0,0

AT+CLBS=4 // type = 4,get longitude latitude and date time
OK

+CLBS:
0,106.638084,29.489428,550,2020/6/17,9:34:16
