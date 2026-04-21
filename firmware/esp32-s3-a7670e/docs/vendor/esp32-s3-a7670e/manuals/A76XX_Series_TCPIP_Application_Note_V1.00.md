# A76XX_Series_TCPIP_Application_Note_V1.00

Source PDF: [A76XX_Series_TCPIP_Application_Note_V1.00.pdf](./A76XX_Series_TCPIP_Application_Note_V1.00.pdf)

Total pages: 25

> Auto-generated from the PDF text layer. Layout-heavy pages may lose table, column, and diagram fidelity.

## PDF Page 1

A7600 Series_
TCPIP_Application Note

SIMCom Wireless Solutions Limited
Building B, SIM Technology Building, No.633, Jinzhong Road
Changning District, Shanghai P.R. China
Tel: 86-21-31575100
support@simcom.com
www.simcom.com
LTE Module

## PDF Page 2

- **Document Title:** A7600 Series_TCPIP_Application Note
- **Version:** 1.00
- **Date:** 2020.6.19
- **Status:** Released

## General Notes

SIMCOM OFFERS THIS INFORMATION AS A SERVICE TO ITS CUSTOMERS, TO SUPPORT
APPLICATION AND ENGINEERING EFFORTS THAT USE THE PRODUCTS DESIGNED BY SIMCOM.
THE INFORMATION PROVIDED IS BASED UPON REQUIREMENTS SPECIFICALLY PROVIDED TO
SIMCOM BY THE CUSTOMERS. SIMCOM HAS NOT UNDERTAKEN ANY INDEPENDENT SEARCH
FOR ADDITIONAL RELEVANT INFORMATION, INCLUDING ANY INFORMATION THAT MAY BE IN THE
CUSTOMER'S POSSESSION. FURT HERMORE, SYSTEM VALIDATION OF THIS PRODUCT
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
Revision Date Chapter Description
V1.00 2020.6.19 Songtao.Luo New version

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
- 1.4 The process of Using TCPIP AT Commands (page 5)
- 1.5 Error Handling (page 8)
- 1.5.1 Executing FTP(S) AT Commands Fails (page 8)
- 1.5.2 PDP Activation Fails (page 8)
- 1.5.3 Error Response of TCPIP Server (page 8)
- 1.6 Description of Data Access Mode (page 8)
- 2 AT Commands for TCPIP (page 10)
- 2.1 TCPIP Services AT (page 10)
- 3 TCPIP Examples (page 11)
- 3.1 Configure and Activate context (page 11)
- 3.1.1 Network Environment (page 11)
- 3.1.2 Configure Context (page 11)
- 3.1.3 Activate context (page 11)
- 3.1.4 Deactivate Context (page 12)
- 3.2 TCP Client (page 12)
- 3.2.1 TCP Client Works in Direct Push Mode (page 12)
- 3.2.2 TCP Client Works in Buffer Access Mode (page 13)
- 3.2.3 TCP Client Works in Buffer Access Mode (page 14)
- 3.3 UDP Client (page 16)
- 3.3.1 UDP Client Works in Direct Push Mode (page 16)
- 3.3.2 UDP Client Works in Buffer Access Mode (page 17)
- 3.3.3 UDP Client Works in Transparent Access Mode (page 18)
- 3.4 TCP Server (page 19)
- 3.4.1 Transparent Mode (page 19)
- 3.4.2 Non-Transparent Mode (page 20)
- 3.4.3 Query Connection Status (page 21)
- 4 Appendix (page 22)
- 4.1 Summary of Error Codes (page 22)
- 4.2 Unsolicited Result Codes (page 23)

## PDF Page 5

1 Introduction

## 1.1 Purpose of the document

Based on module AT command manual, this document will introduce TCPIP application process.
Developers could understand and develop application quickly and efficiently based on this document.

## 1.2 Related documents

[1] A7600 Series_AT Command Manual

## 1.3 Conventions and abbreviations

In this document, the GSM engines are referred to as following term:
ME (Mobile Equipment);
MS (Mobile Station);
TA (Terminal Adapter);
DCE (Data Communication Equipment) or facsimile DCE (FAX modem, FAX board);

In application, controlling device controls the GSM engine by sending AT Comm and via its serial interface.
The controlling device at the other end of the serial line is referred to as following term:
TE (Terminal Equipment);
DTE (Data Terminal Equipment) or plainly "the application" which is running on an embedded system;

Other Conventions:
PDP(Packet Data Protocol);
TCP(Terminal Control Protocol);
UDP(User Datagram Protocol);

## PDF Page 6

## 1.4 The process of Using TCPIP AT Commands

Figure illustrates how to use TCP/IP AT commands:

## PDF Page 7

## PDF Page 8

## PDF Page 9

## 1.5 Error Handling

### 1.5.1 Executing FTP(S) AT Commands Fails

When executing TCPIP AT commands, if ERROR response is received from the module, please check
whether the U(SIM) card is inserted and whether it is +CPIN: READY returned when executing AT+CPIN?.

### 1.5.2 PDP Activation Fails

If it is failed to activate a PDP context with AT+NETOPEN command, please make sure the PDP is not
activated. You can use AT+NETOPEN? to query it.
If all above configurations are correct, but activating the PDP context by AT+NETOPEN command still fails,
please reboot the module to resolve this issue. After rebooting the module, please check the
configurations mentioned above for at least.

### 1.5.3 Error Response of TCPIP Server

If you encounter other errors, please refer to chapter 4 to correct them.

## 1.6 Description of Data Access Mode

Transparent Mode
(Data Mode)
Access Mode                                  Direct Push Mode
Non-Transparent Mode
(Command Mode)          Buffer Access Mode

The default mode is direct push mode.

1. Direct Push Mode
In direct push mode, user can send data by AT+CIPSEND. The received data will be outputted to COM port

## PDF Page 10

directly byURC as "+RECV FROM:<IP ADDRESS>:<PORT><CR><LF>+IPD(data
length)<CR><LF><data>".

2. Buffer Access Mode
AT+CIPRXGET=1 is used to enter into buffer access mode. In buffer access mode, user sends data by
##### AT+CIPSEND. After receiving data, the module will buffer it and report a URC as "+CIPRXGET:
1,<link_num>" to notify the host. Then host can retrieve data by AT+CIPRXGET.

3. Transparent Access Mode
AT+CIPMODE=1 is used to enter into transparent access mode. In transparent mode, the data received
from COM port will be sent to internet directly, and the received data from Internet will be output to COM
port directly as well. "+++" is used to exit from trans parent access mode. When "+++" returns OK, the
module will be switched to command mode. In transparent access mode, host cannot execute any AT
command.Note: Currently, only one socket is available under transparent mode, either TCP client or TCP
server.In transparent mode, the first server (<server_index> = 0) and the first client socket(<link_num> = 0)
are used for transparent mode operation. Other servers (<server_index> = 1- 3) and other client sockets
(<link_num> = 1-9) are still used in command mode.

4. Switch Between Data Mode and Command Mode
(1) Data mode -> Command mode
Software switching: escape sequence +++. Please take care, this is a complete command, do not
separate each character. And the time delay before and after this sequence should be more than 1000
milliseconds, the interval of each character should not be more than 900 milliseconds.
Hardware switching: DTR pin could be used to trigger data mode and command mode.Command AT&D1
should be configured before application.
(2) Command Mode -> Data Mode
ATO is used to enter into transparent access mode from command mode. If it enters into transparent
access mode successfully, CONNECT<text> will be returned.

## PDF Page 11

2 AT Commands for TCPIP

## 2.1 TCPIP Services AT

Command Description
##### AT+NETOPEN Start Socket Service
##### AT+NETCLOSE Stop Socket Service
##### AT+CIPOPEN Establish Connection in Multi-Socket Mode
##### AT+CIPSEND Send data through TCP or UDP Connection
##### AT+CIPRXGET Set the Mode to Retrieve Data
##### AT+CIPCLOSE Close TCP or UDP Socket
##### AT+IPADDR Inquire Socket PDP address
##### AT+CIPHEAD Add an IP Header When Receiving Data
##### AT+CIPSRIP Show Remote IP Address and Port
##### AT+CIPMODE Set TCP/IP Application Mode
##### AT+CIPSENDMODE Set Sending Mode
##### AT+CIPTIMEOUT Set TCP/IP Timeout Value
##### AT+CIPCCFG Configure Parameters of Socket
##### AT+SERVERSTART Startup TCP Server
##### AT+SERVERSTOP Stop TCP Server
##### AT+CIPACK Query TCP Connection Data Transmitting Status
##### AT+CDNSGIP Query the IP Address of Given Domain Name

## PDF Page 12

3 TCPIP Examples

## 3.1 Configure and Activate context

### 3.1.1 Network Environment

TCP/IP application is based on GPRS network. Please make sure that GPRS network is available before
TCP/IP setup.

AT+CSQ
+CSQ: 23,0

OK

AT+CREG?
+CREG: 0,1

OK

AT+CGREG?
+CGREG: 0,1

OK

### 3.1.2 Configure Context

AT+CGDCONT=1,"IP","CMNET"
OK

### 3.1.3 Activate context

## PDF Page 13

AT+NETOPEN
OK

+NETOPEN: 0

AT+IPADDR
+IPADDR: 10.148.0.17

OK

### 3.1.4 Deactivate Context

AT+NETCLOSE
OK

+NETCLOSE: 0

AT+IPADDR
+IPADDR: Network not opened

ERROR

## 3.2 TCP Client

### 3.2.1 TCP Client Works in Direct Push Mode

//Set up TCP Client Connection
AT+NETOPEN
OK

+NETOPEN: 0

AT+CIPOPEN=1,"TCP","117.131.85.139",5253
OK

+CIPOPEN: 1,0
// set up a TCP connection, <link_num> is 1.
Before using AT+CIPOPEN, host should activate
PDP Context with AT+NETOPEN first.

//Send Data To Server
AT+CIPSEND=1,5  // send data with fixed length

## PDF Page 14

>HELLO
OK

+CIPSEND: 1,5,5

//Receive Data From Server
RECV FROM:117.131.85.139:5253
+IPD16
data from server
// data from server directly output to COM

//Close TCP Connection
AT+CIPCLOSE=1
OK

+CIPCLOSE: 1,0

### 3.2.2 TCP Client Works in Buffer Access Mode

//Set up TCP Client Connection
AT+NETOPEN
OK

+NETOPEN: 0

AT+CIPRXGET=1
OK
// buffer access mode, get data by AT+CIPRXGET
AT+CIPOPEN=1,"TCP","117.131.85.139",5253
OK

+CIPOPEN: 1,0

//Send Data to Server
AT+CIPSEND=1,5
>hello
OK

+CIPSEND: 1,5,5
// send data with fixed length

//Receive Data from Server

## PDF Page 15

+CIPRXGET: 1,1 // URC to notify host of data from server
AT+CIPRXGET=4,1
+CIPRXGET: 4,1,16

OK
// query the length of data in the buffer of socket
with
// <link_num>=1
AT+CIPRXGET=2,1,5
+CIPRXGET: 2,1,5,11data

OK
// get data in ASCII form
// read 5 bytes data and left 11 bytes
AT+CIPRXGET=3,1,5
+CIPRXGET: 3,1,5,6
66726F6D20

OK
// get data in hex form
AT+CIPRXGET=4,1
+CIPRXGET: 4,1,6

OK
// read the length of unread data in buffer
AT+CIPRXGET=2,2
+IP ERROR: No data

ERROR
// the connection identified by link_num=2 has not
been established
AT+CIPRXGET=2,1
+CIPRXGET: 2,1,6,0
server

OK

AT+CIPRXGET=4,1
+CIPRXGET: 4,1,0

OK
// all the data in buffer has been read, the rest_len
is 0.

//Close TCP Connection
AT+CIPCLOSE=1
OK

+CIPCLOSE: 1,0

### 3.2.3 TCP Client Works in Buffer Access Mode

//Set up TCP Client Connection
AT+CIPMODE=1
OK
// Enter into transparent mode by at+cipmode=1

## PDF Page 16

AT+NETOPEN
OK

+NETOPEN: 0

AT+CIPOEPN=0,"TCP","117.131.85.139",5253
## Connect 115200
// only <link_num>=0 is allowed to operate with
transparent mode.

//Send Data to Server
All data got from com port will be sent to
internet directly

//Receive Data From Server
## Data From Serverdata From Server
OK

//all the received data from server will be output to
com port directly
//sequence of +++ to quit transparent mode
AT+CIPOPEN?
+CIPOPEN: 0,"TCP","117.131.85.139",5253,-1
+CIPOPEN: 1
+CIPOPEN: 2
+CIPOPEN: 3
+CIPOPEN: 4
+CIPOPEN: 5
+CIPOPEN: 6
+CIPOPEN: 7
+CIPOPEN: 8
+CIPOPEN: 9

OK

## Ato
## Connect 115200
## Hello Client
OK

//ATO to enter transparent mode again

//Close TCP Connection
AT+CIPCLOSE=0
OK

## Closed
+CIPCLOSE: 0,0
/

## PDF Page 17

## 3.3 UDP Client

### 3.3.1 UDP Client Works in Direct Push Mode

//Set up UDP Client Connection
AT+NETOPEN
OK

+NETOPEN: 0

AT+CIPOPEN=1,"UDP",,,5000
+CIPOPEN: 1,0

OK
// when set a UDP connection, the remote IP
address and port is not necessary, but the local
port
must be specified.

//Send data to Server
AT+CIPSEND=1,,"117.131.85.139",5254
>HELLOSERVER
OK   <CTRL+Z>

+CIPSEND: 1,11,11
// for UDP connection, when sending data, user
must specify the remote IP address and port
//send data with changeable length, <CTRL+Z> to
end
AT+CIPSEND=1,5,"117.131.85.139",5254
>HELLO
OK

+CIPSEND: 1,5,5
//send data with fixed length

//Receive Data From Server
RECV FROM:117.131.85.139:5254
+IPD14
## Hello Client
//data from server output to COM port directly

//Close UDP Connection
AT+CIPCLOSE=1
+CIPCLOSE: 1,0

OK

## PDF Page 18

### 3.3.2 UDP Client Works in Buffer Access Mode

//Set up UDP Client Connection
AT+NETOPEN
OK

+NETOPEN: 0

AT+CIPRXGET=1
OK
// buffer access mode, get data by AT+CIPRXGET
AT+CIPOPEN=1,"UDP",,,5000
+CIPOPEN: 1,0

OK
// when set a UDP connection, the remote IP
address and port is not necessary, but the local
port
must be specified.

//Send Data to Server
AT+CIPSEND=1,,"117.131.85.139",5254
>HELLOSERVER
OK   <CTRL+Z>

+CIPSEND: 1,11,11
// for UDP connection, when sending data, user
must specify the remote IP address and port
//send data with changeable length, <CTRL+Z> to
end
AT+CIPSEND=1,5,"117.131.85.139",5254
>HELLO
OK

+CIPSEND: 1,5,5
//send data with fixed length

//Receive Data From Server
+CIPRXGET: 1,1 // URC to notify host of data from server
AT+CIPRXGET=4,1
+CIPRXGET: 4,1,16

OK
// query the length of data in the buffer of socket
with <link_num>=1
AT+CIPRXGET=2,1,5
+CIPRXGET: 2,1,5,11
data

OK
// get data in ASCII form

AT+CIPRXGET=3,1,5
+CIPRXGET: 3,1,5,6
66726F6D20

OK
// get data in hex form

## PDF Page 19

AT+CIPRXGET=4,1
+CIPRXGET: 4,1,6

OK
// read the length of unread data in buffer
AT+CIPRXGET=2,2
+IP ERROR: No data

ERROR
// the connection identified by link_num=2 has not
been established
AT+CIPRXGET=2,1
+CIPRXGET: 2,1,6,0
server

OK

AT+CIPRXGET=4,1
+CIPRXGET: 4,1,0

OK
// all the data in buffer has been read, the rest_len
is 0.

//Close UDP Connection
AT+CIPCLOSE=1
OK

+CIPCLOSE: 1,0

### 3.3.3 UDP Client Works in Transparent Access Mode

//Set up UDP Client Connection
AT+CIPMODE=1
OK

AT+NETOPEN
OK

+NETOPEN: 0

AT+CIPOPEN=0,"UDP","117.131.85.139",5254,
5000
## Connect 115200
//only <link_num>=0 is allowed to operate with
transparent mode.

//Send Data to Server
All data got from com port will be sent to
internet directly

## PDF Page 20

//Receive Data From Server
## Hello Client
## Hello Client
///data
from server output to COM port directly
OK // sequence of +++ to quit transparent mode
AT+CIPOPEN?
+CIPOPEN: 0,"UDP","117.131.85.139",5254,-1
+CIPOPEN: 1
+CIPOPEN: 2
+CIPOPEN: 3
+CIPOPEN: 4
+CIPOPEN: 5
+CIPOPEN: 6
+CIPOPEN: 7
+CIPOPEN: 8
+CIPOPEN: 9

OK

AT+CIPOPEN=0,"UDP","117.131.85.139",5254,
5000

## Connect 115200
//only <link_num>=0 is allowed to operate with
transparent mode.

## 3.4 TCP Server

### 3.4.1 Transparent Mode

AT+CIPMODE=1
OK

AT+NETOPEN
OK

+NETOPEN: 0

AT+SERVERSTART=8080, 0
OK
//only <server_index>=0 is allowed to operate with
transparent mode.
+CLIENT: 0,0,192.168.108.5:57202
## Connect 115200

//only <link_num> 0 can be used for transparent
mode operation.
OK // sequence of +++ to quit data mode
AT+CIPCLOSE=0
OK

## Closed
+CIPCLOSE: 0,0
// close client connection

## PDF Page 21

AT+SERVERSTOP=0
+SERVERSTOP: 0,0

OK
// close server socket

### 3.4.2 Non-Transparent Mode

AT+NETOPEN
OK

+NETOPEN: 0

AT+SERVERSTART=8080, 0
OK
//only <server_index>=0 is allowed to operate with
transparent mode.
AT+SERVERSTART=9090, 1
OK

AT+SERVERSTART=7070, 2
OK

AT+SERVERSTART=6060, 3
OK

+CLIENT: 0,0,192.168.108.5:57202 //If a socket is accepted, the following URC will be
reported:
AT+CIPOPEN?
+CIPOPEN: 0,"TCP","192.168.108.5",57202,1
+CIPOPEN: 1
+CIPOPEN: 2
+CIPOPEN: 3
+CIPOPEN: 4
+CIPOPEN: 5
+CIPOPEN: 6
+CIPOPEN: 7
+CIPOPEN: 8
+CIPOPEN: 9

OK
//User can use AT+CIPOPEN? to check the
accepted socket
//last parameter of 1 indicates this is an accepted
socket, this server index is 1
AT+CIPSEND=0,5
>HELLO
OK

+CIPSEND: 0,5,5
// only supports fixed-length to send
AT+SERVERSTOP=0
+SERVERSTOP: 0,0
OK
// if unspecified, it will close 0 channel

AT+SERVERSTOP=1
+SERVERSTOP: 1,0
OK

## PDF Page 22

AT+SERVERSTOP=2
+SERVERSTOP: 2,0

OK

AT+SERVERSTOP=3
+SERVERSTOP: 3,0

OK

AT+NETCLOS
OK

+NETCLOSE: 0

### 3.4.3 Query Connection Status

AT+CIPOPEN=1,"TCP","117.131.85.139",5253
OK

+CIPOPEN: 1,0

AT+CIPOPEN?
+CIPOPEN: 0
+CIPOPEN: 1,"TCP","117.131.85.139",5253,-1
+CIPOPEN: 2
+CIPOPEN: 3
+CIPOPEN: 4
+CIPOPEN: 5
+CIPOPEN: 6
+CIPOPEN: 7
+CIPOPEN: 8
+CIPOPEN: 9

OK
// query the current state of all sockets
AT+CIPCLOSE?
+CIPCLOSE: 0,1,0,0,0,0,0,0,0,0

OK

AT+CIPCLOSE=1
OK

+CIPCLOSE: 1,0
AT+CIPCLOSE?
+CIPCLOSE: 0,0,0,0,0,0,0,0,0,0

OK

## PDF Page 23

4 Appendix

## 4.1 Summary of Error Codes

When you use these commands : AT+CIPACK  AT+CIPRXGET, If something goes wrong, they maybe
reported as  +IP ERROR: <err_info> .
The fourth parameter <errMode> of AT+CIPCCFG (TODO) is used to determine how <err_info>  is
displayed.
If <errMode> is set to 0, the <err_info> is displayed with numeric value.
If <errMode>is set to 1, the <err_info> is displsayed with string value.
The default is displayed with string value.

The following list is the description of the <err info>.

Numeric Value String Value
0 Connection time out
1 Bind port failed
2 Port overflow
3 Create socket failed
4 Network is already opened
5 Network is already closed
6 No clients connected
7 No active client
8 Network not opened
9 Client index overflow
10 Connection is already created
11 Connection is not created
12 Invalid parameter
13 Operation not supported
14 DNS query failed
15 TCP busy
16 Net close failed for socket opened
17 Sending time out
18 Sending failure for network error
19 Open failure for network error
20 Server is already listening

## PDF Page 24

21 Operation failed
22 No data

When you use these commands : AT+NETOPEN, AT+NETCLOSE, AT+CIPOPEN, AT+CIPSEND,
##### AT+CIPCLOSE, AT+SERVERSTART, AT+SERVERSTOP ,If something goes wrong, they will report the
wrong number

The following list is the description of the <err>.

<err> Description of <err>
0 operation succeeded
1 Network failure
2 Network not opened
3 Wrong parameter
4 Operation not supported
5 Failed to create socket
6 Failed to bind socket
7 TCP server is already listening
8 Busy
9 Sockets opened
10 Timeout
11 DNS parse failed for AT+CIPOPEN
12 Unknown error

## 4.2 Unsolicited Result Codes

Information Description
+CIPEVENT: NETWORK
## Closed Unexpectedly
Network is closed for network error(Out of service, etc). When
this event happens, user's application needs to check and close
all opened sockets, and then uses AT+NETCLOSE to release the
network library if AT+NETOPEN? shows the network library is still
opened.
+IPCLOSE:
<client_index>,<close_reason>
Socket is closed passively.
<client_index> is the link number.
<close_reason>:
0 - Closed by local, active
1 - Closed by remote, passive
2 - Closed for sending timeout or DTR off

## PDF Page 25

+CLIENT: <
link_num>,<server_index>,<clie
nt_IP>:<port>
TCP server accepted a new socket client, the index
is<link_num>, the TCP server index is <server_index>. The peer
IP address is <client_IP>, the peer port is <port>.
