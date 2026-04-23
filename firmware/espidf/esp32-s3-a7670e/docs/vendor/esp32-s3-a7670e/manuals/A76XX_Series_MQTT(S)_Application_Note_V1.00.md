# A76XX_Series_MQTT(S)_Application_Note_V1.00

Source PDF: [A76XX_Series_MQTT(S)_Application_Note_V1.00.pdf](./A76XX_Series_MQTT(S)_Application_Note_V1.00.pdf)

Total pages: 21

> Auto-generated from the PDF text layer. Layout-heavy pages may lose table, column, and diagram fidelity.

## PDF Page 1

A7600 Series_
MQTT(S)_Application Note

SIMCom Wireless Solutions Limited
Building B, SIM Technology Building, No.633, Jinzhong Road
Changning District, Shanghai P.R. China
Tel: 86-21-31575100
support@simcom.com
www.simcom.com
LTE Module

## PDF Page 2

- **Document Title:** A7600 Series_MQTT(S)_Application Note
- **Version:** 1.00
- **Date:** 2020.6.19
- **Status:** Released

## General Notes

SIMCOM OFFERS THIS INFORMATION AS A SERVICE TO ITS CUSTOMERS, TO SUPPORT
APPLICATION AND ENGINEERING EFFORTS THAT USE THE PRODUCTS DESIGNED BY SIMCOM.
THE INFORMATION PROVIDED IS BASED UPON REQUIREMENTS SPECIFICALLY PROVIDED TO
SIMCOM BY THE CUSTOMERS. SIMCOM HAS NOT UNDERTAKEN ANY INDEPENDENT SEARCH
FOR ADDITIONAL RELEVANT INFORMATION, INCLUDING ANY INFORMATION THAT MAY BE IN THE
CUSTOMER'S POSSESSION. FURTHERMORE, SYSTEM VALIDATION OF THIS PRODUCT DESIGNED
BY SIMCOM WITHIN A LARGER ELECTRONIC SYSTEM REMAINS THE RESPONSIBILITY OF THE
CUSTOMER OR THE CUSTOMER'S SYSTEM INTEGRATOR. ALL SPECIFICATIONS SUPPLIED
HEREIN ARE SUBJECT TO CHANGE.

## Copyright

THIS DOCUMENT CONTAINS PROPRIETARY TECHNICAL INFORMATION WHICH IS THE PROPERTY
OF SIMCOM LIMITED., COPYING OF THIS DOCUMENT AND GIVING IT TO OTHERS AND THE USING
OR COMMUNICATION OF THE CONTENTS THEREOF, ARE FORBIDDEN WITHOUT EXPRESS
AUTHORITY. OFFENDERS ARE LIABLE TO THE PAYMENT OF DAMAGES. ALL RIGHTS RESERVED IN
THE EVENT OF GRANT OF A PATENT OR THE REGISTRATION OF A UTILITY MODEL OR DESIGN.
ALL SPECIFICATION SUPPLIED HEREIN ARE SUBJECT TO CHANGE WITHOUT NOTICE AT ANY
TIME.

SIMCom Wireless Solutions Limited
Building B, SIM Technology Building, No.633 Jinzhong Road, Changning District, Shanghai P.R.China
Tel: +86 21 31575100
Email: simcom@simcom.com

For more information, please visit:
https://www.simcom.com/download/list-863-en.html

For technical support, or to report documentation errors, please visit:
https://www.simcom.com/ask/ Or email to: support@simcom.com

Copyright © 2020 SIMCom Wireless Solutions Limited All Rights Reserved.

## PDF Page 3

### About Document

### Version History

Revision Date Chapter Description
V1.00 2020-06-19 All New version

Scope

This document applies to the following products

Name Type Size(mm) Comments
A7600XX-XXXX LTE 30.0*30.0*2.5 N/A
A7620 CAT1/LTE 24.0*24.0*2.5 N/A
A7670X CAT1/LTE 24.0*24.0*2.5 N/A
A5360E CAT4/WCDMA 30.0*30.0*2.5 N/A

## PDF Page 4

### Contents

- About Document (page 1)
- Version History (page 1)
- Scope (page 1)
- Contents (page 2)
- 1 Introduction (page 3)
- 1.1 Purpose of the document (page 3)
- 1.2 Related documents (page 3)
- 1.3 Conventions and abbreviations (page 3)
- 1.4 The process of Using MQTT(S) AT Command (page 4)
## 1.5 Error Handling.................................................................................................................................. 5
- 2 AT Commands for MQTT(S) (page 6)
- 2.1 Overview of AT Commands for MQTT(S) (page 6)
- 3 MQTT Examples (page 7)
- 3.1 Access to MQTT server not SSL/TLS (page 7)
- 3.2 Connect to SSL/TLS MQTT server (not verify server) (page 10)
- 3.3 Access to SSL/TLS MQTT server (only verify the server) (page 11)
- 3.4 Access to SSL/TLS MQTT server (verify server and client) (page 14)
- 3.5 Access to MQTT server without checking UTF8 coding (page 16)
- 4 Appendix (page 18)
- 4.1 Summary of Error Codes (page 18)

## PDF Page 5

1 Introduction

## 1.1 Purpose of the document

Based on module AT command manual, this document will introduce MQTTS application process.

Developers could understand and develop application quickly and efficiently based on this document.

## 1.2 Related documents

[1] A7600 Series_AT Command Manual

## 1.3 Conventions and abbreviations

In this document, the GSM engines are referred to as following term:
ME (Mobile Equipment);
MS (Mobile Station);
TA (Terminal Adapter);
DCE (Data Communication Equipment) or facsimile DCE (FAX modem, FAX board);

In application, controlling device controls the GSM engine by sending AT Command via its serial interface.
The controlling device at the other end of the serial line is referred to as following term:
TE (Terminal Equipment);
DTE (Data Terminal Equipment) or plainly "the application" which is running on an embedded system;

Other Conventions:
MQTT(Message Queuing Telemetry Transport);
SSL(Secure Sockets Layer);
PDP(Packet Data Protocol);

## PDF Page 6

## 1.4 The process of Using MQTT(S) AT Command

AT+CMQTTSTART
（PDP active and initialize
MQTT(S) service ）
AT+CMQTTCONNECT
（Connect to a MQTT(S)
serv er）
AT+CMQTTTOPIC
（Set the topic for
publish）
AT+CMQTTSUB
（Subscribe a
message to  server）
AT+CSSLCFG
（Set the SSL context id for
MQTTS session ）
AT+CMQTTACCQ
(MQTTS or MQTT?)
Power on the module
Query SIM card status by AT+CPIN?
Query CS service by AT+CREG?
Query PS service by
AT+CGREG?/AT+CEREG?
Query UE information by AT+CPSI?
Configure the PDP context by
##### AT+CG DC ONT
Active the PDP context by
AT+CGACT=<state>,[<cid>] and
AT+CGACT?
Query signal quality by AT+CSQ
CS Service:
If <stat> of AT+CR EG? equals to  1,it means
that the module has registered on CS
domain service.Reboot the module if fals
to registered on CS domain.
PS Serivce:
If <stat> of AT+CGREG?/AT+CEREG? equals
to 1,it means that the module has
registered on PS domain service.
SIM Card Status:
Execute AT+CPIN?,if response is
+CPIN:READY,means SIM Card Status is
normal.Reboot the module or check SIM
card status if AT+CPIN? Fails to identify
SIM card in 20s.
Signal quality:
Execute AT+CSQ to query signal quality.If
rssi is equals to 99,please check SIM card
status or reboot the module
UE system information:
If <System Mode> is "NO S ERVICE",it
means network status has some problem.
PDP Context:
1.Configure PDP Context by
AT+CGDCONT=<cid>,<pdp_type>,<apn>
2.Activate the PDP Context by
AT+CGACT= <state>,[<cid>]
3.Query IP address of the PDP context by
AT+CGACT?
AT+CMQTTSTART:
##### AT+CMQTTSTART also can activate the
PDP Context. But It can not customize PDP
activation parameters .
AT+CSSLCFG:
If choosing MQTTS,you should use
##### AT+CSSLCFG to select the SSL context.
##### AT+CFTPS LOGI N:
You can change the parameter
<server_type> to login a FTP server/FTPS
serv er.
+CPIN: REA DY
+CSQ: <rssi>,<ber>,0 < rssi < 31
+CREG: 0,1
Check the status of SIM card or
Reboot the module
## No Service
## Pdp Active Fail
AT+CMQTTSUBTOPIC
（Set the topic for
subscribe）
AT+CMQTTUNSUB
（Unsubscribe a
message to  server）
AT+CMQTTSUB
（subscribe a
message to  server）
AT+CMQTTPAYLOAD
（Set the message body
of a publish message ）
AT+CMQTTPUB
（Publish a message to
serv er）
AT+CMQTTDISC
（Disconnect from the
serv er）
AT+CMQTTSTOP
（stop MQTT service ）
Yes
No
AT+CMQTTUNSUBTOPIC
（Set the topic for
unsubscribe ）
AT+CMQTTUNSUB
（Unsubscribe a message
to server）
CMQTTSUBTOPIC can
set up to ten topic
## Cmqttunsubtopic
can set up to ten topic

## PDF Page 7

## 1.5 Error Handling

For more details, please refer to A7600 Series_AT Command Manual.

## PDF Page 8

2 AT Commands for MQTT(S)

## 2.1 Overview of AT Commands for MQTT(S)

Command Description
##### AT+CMQTTSTART Start MQTT service
##### AT+CMQTTSTOP Stop MQTT service
##### AT+CMQTTACCQ Acquire a client
##### AT+CMQTTREL Release a client
##### AT+CMQTTSSLCFG Set the SSL context (only for SSL/TLS MQTT)
##### AT+CMQTTWILLTOPIC Input the topic of will message
##### AT+CMQTTWILLMSG Input the will message
##### AT+CMQTTCONNECT Connect to MQTT server
##### AT+CMQTTDISC Disconnect from server
##### AT+CMQTTTOPIC Input the topic of publish message
##### AT+CMQTTPAYLOAD Input the publish message
##### AT+CMQTTPUB Publish a message to server
##### AT+CMQTTSUBTOPIC Input the topic of subscribe message
##### AT+CMQTTSUB Subscribe a message to server
##### AT+CMQTTUNSUBTOPIC Input the topic of unsubscribe message
##### AT+CMQTTUNSUB Unsubscribe a message to server
##### AT+CMQTTCFG Configure the MQTT Context

For detail information, please refer to "A7600 Series_AT Command Manual".

## PDF Page 9

3 MQTT Examples

Before all FTP(S) related operations, we should ensure the following:
Ensure network is available:

AT+CSQ
+CSQ: 23,0

OK
AT+CREG?
+CREG: 0,1

OK

AT+CGREG?
+CGREG: 0,1

OK

AT+CPSI?
+CPSI:
LTE,Online,460-00,0x333C,39589680,308,EUT
## Ran-Band3,1350,5,0,0,54,0,22

OK

//In WCDMA/GSW,you need to continue to
execute the following instructions
AT+CGDCONT=cid,"ip","APN"
OK

AT+CGACT=1,cid
OK

AT+CGACT?
+CGACT: 1,1

OK

## 3.1 Access to MQTT server not SSL/TLS

Following commands shows how to communicate with a MQTT server.

## PDF Page 10

// start MQTT service, activate PDP context
AT+CMQTTSTART
OK

+CMQTTSTART: 0

// Acquire one client which will connect to a MQTT server not SSL/TLS
AT+CMQTTACCQ=0,"client test0"
OK
// Set the will topic for the CONNECT message
AT+CMQTTWILLTOPIC=0,10
>

OK

// Set the will message for the CONNECT message
AT+CMQTTWILLMSG=0,6,1
>

OK

// Connect to a MQTT server
AT+CMQTTCONNECT=0,"tcp://test.mosquitto.
org:1883",60,1
OK

+CMQTTCONNECT: 0,0

// Subscribe one topic from the server
AT+CMQTTSUB=0,9,1
>

OK

+CMQTTSUB: 0,0

// Set the topic for the PUBLISH message
AT+CMQTTTOPIC=0,9
>

OK

// Set the payload for the PUBLISH message
AT+CMQTTPAYLOAD=0,60
>

OK

// Publish a message
AT+CMQTTPUB=0,1,60
OK

## PDF Page 11

+CMQTTPUB: 0,0
//receive publish message from server
+CMQTTRXSTART: 0,9,60
+CMQTTRXTOPIC: 0,9
simcommsg
+CMQTTRXPAYLOAD: 0,60
012345678901234567890123456789012345678
901234567890123456789
+CMQTTRXEND: 0

// Set one topic for the SUBSCRIBE message
AT+CMQTTSUBTOPIC=0,9,1
>

OK

// Subscribe a message
AT+CMQTTSUB=0
OK

+CMQTTSUB: 0,0

// Unsubscribe one topic from the server
AT+CMQTTUNSUB=0,9,0
>

OK

+CMQTTUNSUB: 0,0

// Disconnect from server
AT+CMQTTDISC=0,120
OK

+CMQTTDISC: 0,0

//Release the client
AT+CMQTTREL=0
OK

//stop MQTT Service
AT+CMQTTSTOP
OK

+CMQTTSTOP: 0

## PDF Page 12

## 3.2 Connect to SSL/TLS MQTT server (not verify server)

Following commands shows how to access to a MQTT server without verifying the server. It needs to
configure the authentication mode to 0, and then it will connect to the server successfully.

// start MQTT service, activate PDP context
AT+CMQTTSTART
OK

+CMQTTSTART: 0

// Acquire one client which will connect to a SSL/TLS MQTT server
AT+CMQTTACCQ=0,"client test0",1
OK

// Set the will topic for the CONNECT message
AT+CMQTTWILLTOPIC=0,10
>

OK

// Set the will message for the CONNECT message
AT+CMQTTWILLMSG=0,6,1
>

OK

// Connect to a MQTT server
AT+CMQTTCONNECT=0,"tcp://test.mosquitto.o
rg:8883",60,1
OK

+CMQTTCONNECT: 0,0
// Set the topic for the PUBLISH message

AT+CMQTTTOPIC=0,13
>

OK

// Set the payload for the PUBLISH message
AT+CMQTTPAYLOAD=0,60
>

OK

// Publish a message
AT+CMQTTPUB=0,1,60
OK

+CMQTTPUB: 0,0

## PDF Page 13

// Set one topic for the SUBSCRIBE message
AT+CMQTTSUBTOPIC=0,9,1
>

OK

// Subscribe a message
AT+CMQTTSUB=0
OK

+CMQTTSUB: 0,0

// Subscribe one topic from the server
AT+CMQTTSUB=0,9,1
>

OK

+CMQTTSUB: 0,0

// Unsubscribe one topic from the server
AT+CMQTTUNSUB=0,9,0
>

OK

+CMQTTUNSUB: 0,0

// Disconnect from server
AT+CMQTTDISC=0,120
OK

+CMQTTDISC: 0,0

//Release the client
AT+CMQTTREL=0
OK

//stop MQTT Service
AT+CMQTTSTOP
OK

+CMQTTSTOP: 0

## 3.3 Access to SSL/TLS MQTT server (only verify the server)

Following commands shows how to access to a SSL/TLS MQTT server with verifying the server. It needs to
configure the authentication mode to 1 and the right server root CA, and then it will connect to the server

## PDF Page 14

successfully.

// Set the SSL version of the first SSL context
AT+CSSLCFG="sslversion",0,4
OK

// Set the authentication mode(verify server) of the first SSL context
AT+CSSLCFG="authmode",0,1
OK

// Set the server root CA of the first SSL context
AT+CSSLCFG="cacert",0,"server_ca.pem"
OK

// start MQTT service, activate PDP context
AT+CMQTTSTART
OK

+CMQTTSTART: 0

// Acquire one client which will connect to a SSL/TLS MQTT server
AT+CMQTTACCQ=0,"client test0",1
OK

// Set the first SSL context to be used in the SSL connection
AT+CMQTTSSLCFG=0,0
OK

// Set the will topic for the CONNECT message
AT+CMQTTWILLTOPIC=0,10
>

OK

// Set the will message for the CONNECT message
AT+CMQTTWILLMSG=0,6,1
>

OK

// Connect to a MQTT server, input the right server and port
AT+CMQTTCONNECT=0,"tcp://mqtts_server:p
ort",60,1
OK

+CMQTTCONNECT: 0,0

// Set the topic for the PUBLISH message
AT+CMQTTTOPIC=0,13
>

OK

// Set the payload for the PUBLISH message
AT+CMQTTPAYLOAD=0,60

## PDF Page 15

>

OK
// Publish a message
AT+CMQTTPUB=0,1,60
OK

+CMQTTPUB: 0,0

// Set one topic for the SUBSCRIBE message
AT+CMQTTSUBTOPIC=0,9,1
>

OK

// Subscribe a message
AT+CMQTTSUB=0
OK

+CMQTTSUB: 0,0

// Subscribe one topic from the server
AT+CMQTTSUB=0,9,1
>

OK

+CMQTTSUB: 0,0

// Unsubscribe one topic from the server
AT+CMQTTUNSUB=0,9,0
>

OK

+CMQTTUNSUB: 0,0

// Disconnect from server
AT+CMQTTDISC=0,120
OK

+CMQTTDISC: 0,0

//Release the client
AT+CMQTTREL=0
OK

//stop MQTT Service
AT+CMQTTSTOP
OK

+CMQTTSTOP: 0

## PDF Page 16

## 3.4 Access to SSL/TLS MQTT server (verify server and client)

Following commands shows how to access to a SSL/TLS MQTT server with verifying the server and client.
It needs to configure the authentication mode to 2, the right server root CA, the right client certificate and
key, and then it will connect to the server successfully.

// Set the SSL version of the first SSL context
AT+CSSLCFG="sslversion",0,4
OK

// Set the authentication mode(verify server and client) of the first SSL context
AT+CSSLCFG="authmode",0,2
OK

// Set the server root CA of the first SSL context
AT+CSSLCFG="cacert",0,"ca_cert.pem"
OK

// Set the client certificate of the first SSL context
AT+CSSLCFG="clientcert",0,"cert.pem"
OK

// Set the client key of the first SSL context
AT+CSSLCFG="clientkey",0,"key_cert.pem"
OK

// start MQTT service, activate PDP context
AT+CMQTTSTART
OK

+CMQTTSTART: 0

// Acquire one client which will connect to a SSL/TLS MQTT server
AT+CMQTTACCQ=0,"client test0",1
OK

// Set the first SSL context to be used in the SSL connection
AT+CMQTTSSLCFG=0,0
OK

// Set the will topic for the CONNECT message
AT+CMQTTWILLTOPIC=0,10
>

OK

// Set the will message for the CONNECT message
AT+CMQTTWILLMSG=0,6,1
>

OK

## PDF Page 17

// Connect to a MQTT server
AT+CMQTTCONNECT=0,"tcp://hooleeping.co
m:8883",60,1
OK

+CMQTTCONNECT: 0,0

// Set the topic for the PUBLISH message
AT+CMQTTTOPIC=0,13
>

OK

// Set the payload for the PUBLISH message
AT+CMQTTPAYLOAD=0,60
>

OK

// Publish a message
AT+CMQTTPUB=0,1,60
OK

+CMQTTPUB: 0,0

// Set one topic for the SUBSCRIBE message
AT+CMQTTSUBTOPIC=0,9,1
>

OK

// Subscribe a message
AT+CMQTTSUB=0
OK

+CMQTTSUB: 0,0

// Subscribe one topic from the server
AT+CMQTTSUB=0,9,1
>

OK

+CMQTTSUB: 0,0

// Unsubscribe one topic from the server
AT+CMQTTUNSUB=0,9,0
>

OK

+CMQTTUNSUB: 0,0

// Disconnect from server

## PDF Page 18

AT+CMQTTDISC=0,120
OK

+CMQTTDISC: 0,0

//Release the client
AT+CMQTTREL=0
OK

//stop MQTT Service
AT+CMQTTSTOP
OK

+CMQTTSTOP: 0

## 3.5 Access to MQTT server without checking UTF8 coding

Following commands shows how to communicate with a MQTT server without checking UTF8 coding.

// start MQTT service, activate PDP context
AT+CMQTTSTART
OK

+CMQTTSTART: 0

// Acquire one client which will connect to a MQTT server not SSL/TLS
AT+CMQTTACCQ=0,"client test0"
OK

// Configure not checking UTF8 coding
AT+CMQTTCFG="checkUTF8",0,0
OK

// Connect to a MQTT server
AT+CMQTTCONNECT=0,"tcp://198.41.30.241:1
883",60,1
OK

+CMQTTCONNECT: 0,0

// Subscribe one topic which is not UTF8 coding string.
//The data can input by hexadecimal format.
AT+CMQTTSUB=0,9,1
>

OK

## PDF Page 19

+CMQTTSUB: 0,0
// Set the topic for the PUBLISH message
AT+CMQTTTOPIC=0,9
>

OK

// Publish a message
AT+CMQTTPUB=0,1,60
OK

+CMQTTPUB: 0,0

//receive publish message from server
+CMQTTRXSTART: 0,9,0
+CMQTTRXTOPIC: 0,9
鼢鼢鼢鼢?

+CMQTTRXEND: 0

// Disconnect from server
AT+CMQTTDISC=0,120
OK

+CMQTTDISC: 0,0

//Release the client
AT+CMQTTREL=0
OK

//stop MQTT Service
AT+CMQTTSTOP
OK

+CMQTTSTOP: 0

## PDF Page 20

4 Appendix

## 4.1 Summary of Error Codes

Code of <err> Meaning
0 operation succeeded
1 failed
2 bad UTF-8 string
3 sock connect fail
4 sock create fail
5 sock close fail
6 message receive fail
7 network open fail
8 network close fail
9 network not opened
10 client index error
11 no connection
12 invalid parameter
13 not supported operation
14 client is busy
15 require connection fail
16 sock sending fail
17 timeout
18 topic is empty
19 client is used
20 client not acquired
21 client not released
22 length out of range
23 network is opened
24 packet fail
25 DNS error
26 socket is closed by server
27 connection refused: unaccepted protocol version
28 connection refused: identifier rejected
29 connection refused: server unavailable

## PDF Page 21

30 connection refused: bad user name or password
31 connection refused: not authorized
32 handshake fail
33 not set certificate
34 Open session failed
35 Disconnect from server failed
