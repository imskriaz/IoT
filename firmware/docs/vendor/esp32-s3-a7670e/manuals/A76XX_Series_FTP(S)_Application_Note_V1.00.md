# A76XX_Series_FTP(S)_Application_Note_V1.00

Source PDF: [A76XX_Series_FTP(S)_Application_Note_V1.00.pdf](./A76XX_Series_FTP(S)_Application_Note_V1.00.pdf)

Total pages: 18

> Auto-generated from the PDF text layer. Layout-heavy pages may lose table, column, and diagram fidelity.

## PDF Page 1

A7600 Series_
FTP(S)_Application Note

SIMCom Wireless Solutions Limited
Building B, SIM Technology Building, No.633, Jinzhong Road
Changning District, Shanghai P.R. China
Tel: 86-21-31575100
support@simcom.com
www.simcom.com
LTE Module

## PDF Page 2

- **Document Title:** A7600 Series_FTP(S)_Application Note
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
PAYMENT OF INDEMNIFICATION S. ALL RIGHTS RESERVED  BY SIMCOM IN THE PROPRIETARY
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
- 1.4 The process of Using FTP(S) AT Commands (page 5)
## 1.5 Error Handling.................................................................................................................................. 6
- 1.5.1 Executing FTP(S) AT Commands Fails (page 6)
- 1.5.2 PDP Activation Fails (page 6)
- 1.5.3 Error Response of FTP(S) Server (page 6)
- 2 AT Commands for FTP(S) (page 7)
- 3 FTP(S) Examples (page 8)
- 3.1 FTP Function (page 8)
- 3.1.1 Download a file from FTP server to module/Upload a file to FTP server from module (page 9)
### 3.1.2 Download a file from FTP server to serial port/Upload a file from serial port to FTP server
10
- 3.1.3 Directory Operations (page 11)
- 3.2 FTPS Function (page 12)
### 3.2.1 Download a file from FTPS server to module/Upload a file to FTPS server from module
12
### 3.2.2 Download a file from FTPS server to serial port/Upload a file from serial port to FTPS
server 13
- 3.2.3 Directory Operations (page 15)
- 4 Appendix (page 17)
- 4.1 Summary of Error Codes (page 17)

## PDF Page 5

1 Introduction

## 1.1 Purpose of the document

Based on module AT command manual, this document will introduce FTP(S) application process.
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
PDP(Packet Data Protocol);
FTP(File Transfer Protocol);
SSL(Secure Sockets Layer);
TLS(Transport Layer Security);

## PDF Page 6

## 1.4 The process of Using FTP(S) AT Commands

AT+CFTPSSTART
（PDP active and initialize
FTP(S) serv ice）
AT+CFTPSSTOP
（PDP deactive and stop
FTP(S) serv ice）
AT+CFTPSLOGIN
（Login to a FTP (S) serv er）
AT+CFTPSLOGOUT
（Logout a FTP (S) serv er）
AT+CFTPSLIST
（List the items in the directory
on FTP(S) serv er）
AT+CFTPSMKD
（Create a new directory on
FTP(S) serv er）
AT+CFTPSRMD
（Delete a directory on FTP (S)
serv er）
AT+CFTPSCWD
（Change the current directory
on FTP(S) serv er）
AT+CFTPSPWD
（Get the current directory on
FTP(S) serv er）
AT+CFTPSPUTFILE
（Upload a file from
module to FTP (S) serv er）
##### AT+CFTPSP UT
（Put a file to FTP(S) server
through serial port）
AT+CFTPSSIZE
（Get the file size on FTP (S)
serv er）
AT+CFTPSTYPE
（Set the transfer type on
FTP(S) serv er）
AT+CFTPSSLCFG
（Set the SSL context id for
FTPS session ）
FTP or FTPS ?
Power on the module
Query SIM card status by AT+CPIN?
Query CS service by AT+CREG?
Query PS service by AT+CGREG?
Query UE information by AT+CP SI?
Configure the PDP context by
##### AT+CGDC ONT
Active the PDP context by
AT+CGA CT=<state>,[<cid>] and
AT+CGA CT?
Query signal quality by AT+CSQ
CS Service:
If <stat> of AT+CREG? equal to 1,it means
that the module has registered on CS
domain service .Reboot the module if it
fails to registered on CS domain .
PS Serivce:
If <stat> of AT+CGREG? equals to 1,it
means that the module has registered on
PS domain service .
SIM Card Status :
Execute AT +CPIN?,if response is
+CPIN:READ Y,means SIM Card Status is
normal.Reboot the module or check SIM
card status if AT +CPIN? Fails to identify
SIM card in 20s.
Signal quality :
Execute AT +CSQ to query signal quality .If
rssi is equal to 99,please check SIM card
status or reboot the module .
UE system information :
If <System Mode > is "NO S ERVICE",it
means network status has some problem .
PDP Context :
1.Configure PDP Context by
AT+CGDCONT=<cid>,<PDP_ty pe>,<APN>
2.Activate the PDP Context by
AT+CGACT=<state>,[<cid>]
3.Query IP address of the PDP context by
AT+CGACT?
##### AT+CFTPSSTART :
##### AT+CFTPSSTART also  can activate the PDP
Context.But It can not customize PDP
activation parameters .
##### AT+CFTPSSLCFG :
Login to the FTPS server ,you should use
##### AT+CFTPSSLCFG to select the SSL
context.Before using AT +CFTPSSLCFG ,you
should use AT +CSSLCFG to configure SSL
context.
##### AT+CFTPSLOGIN :
You can change the parameter
<serv er_ty pe> to login a FTP server /FTPS
serv er. FTP(S) Operation:
For details,please refer to A7600
Series_AT Command Manual  and A7600
Series_FTP(S)_Application Note
+CPIN: READY
+CSQ: <rssi>,<ber>,0 <= rssi <= 31
+CRE G: 0,1
Check the status of SIM card or
Reboot the module
## No Service
## Pdp Active Fail
Select operation
AT+CFTPSTYPE
（Set the transfer type on
FTP(S) serv er）
AT+CFTPSGET
（Get a file from FTP (S)
server to serial port ）
AT+CFTPSGETFILE
（Download a file from
FTP(S) server to module ）
Downl oa d fil e f rom FTP(S) server Directory operations Upl oad fil e to FTP(S) server
## Ftp
## Ftps
Query the  ME functi onali ty by
AT+C FUN?
+C FUN: 1
Phone functionality :
Execute AT +CFUN? to query the level of
functionality in the ME .If <fun> is not
equal to 1,please execute AT +CFUN = 1 to
make ME come to full funtionality and
onlinemode
+CGREG: 0,1

## PDF Page 7

## 1.5 Error Handling

### 1.5.1 Executing FTP(S) AT Commands Fails

When executing FTP(S) AT commands, if ERROR response is received from the module, please check
whether the U(SIM) card is inserted and whether it is +CPIN: READY returned when executing
AT+CPIN?.

### 1.5.2 PDP Activation Fails

If it is failed to activate a PDP context with AT+CGACT command, please check the following
configurations:
1. Query the PS domain status by AT+CGREG? and make sure the PS domain has been registered.
2. Query the PDP context parameters by AT+CGDCONT? and make sure the APN of the specified PDP
context has been set.
3. Make sure the specified PDP context ID is neither used by PPP nor activated by AT+CGACT
command.
If all above configurations are correct, but activating the PDP context by AT+CGACT command still fails,
please reboot the module to resolve this issue. After rebooting the module, please check the
configurations mentioned above for at least.

### 1.5.3 Error Response of FTP(S) Server

When the CFTPSXXX: <errorcode> is not 0, it indicates an error code replied from FTP(S) server.
For example, if <errorcode> is 1, ssl configure may be wrong. If <errorcode> is 17,the file or directory may
not exist. For more details, please refer to A7600 Series_AT Command Manual _V1.01.08.

## PDF Page 8

2 AT Commands for FTP(S)

Command Description
##### AT+CFTPSSTART Start FTP(S) service
##### AT+CFTPSSTOP Stop FTP(S) Service
##### AT+CFTPSLOGIN Login to a FTP(S)server
##### AT+CFTPSLOGOUT Logout a FTP(S) server
##### AT+CFTPSLIST List the items in the directory on FTP(S) server
##### AT+CFTPSMKD Create a new directory on FTP(S) server
##### AT+CFTPSRMD Delete a directory on FTP(S) server
##### AT+CFTPSCWD Change the current directory on FTP(S) server
##### AT+CFTPSPWD Get the current directory on FTP(S) server
##### AT+CFTPSDELE Delete a file on FTP(S) server
##### AT+CFTPSGETFILE Download a file from FTP(S) server to module
##### AT+CFTPSPUTFILE Upload a file from module to FTP(S) server
##### AT+CFTPSGET Get a file from FTP(S) server to serial port
##### AT+CFTPSPUT Put a file to FTP(S) server through serial port
##### AT+CFTPSSIZE Get the file size on FTP(S) server
##### AT+CFTPSSINGLEIP Set FTP(S) data socket address type
##### AT+CFTPSTYPE Set the transfer type on FTP(S) server
##### AT+CFTPSSLCFG Set the SSL context id for FTPS session

For more detailed information, please refer to A7600 Series_AT Command Manual.

## PDF Page 9

3 FTP(S) Examples

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

## 3.1 FTP Function

## PDF Page 10

### 3.1.1 Download a file from FTP server to module/Upload a file to FTP server from
module

//Example of FTP upload/download
AT+CFTPSSTART
OK

+CFTPSSTART: 0
//Start FTP service
AT+CFTPSLOGIN="255.255.255.255",21,"user
name","password",0
OK

+CFTPSLOGIN: 0
//Login to a FTP server
AT+CFTPSLIST="/"
OK

+CFTPSLIST: DATA,175
-rw-r--r-- 1 ftp ftp            121 Mar 11 16:24
124.txt
drwxr-xr-x 1 ftp ftp              0 Jan 13
2020 TEST113
drwxr-xr-x 1 ftp ftp              0 Jan 19
2020 TEST1155

+CFTPSLIST: 0
//List all ms of directory "/"
AT+CFTPSPWD
OK

+CFTPSPWD: "/"
//Get current directory of FTP server
AT+CFTPSGETFILE="124.txt"
OK

+CFTPSGETFILE: 0
//Download a file from FTP server to module.
AT+CFTPSPUTFILE="124.TXT"
OK

+CFTPSPUTFILE: 0
//Upload a file to FTP server from module
AT+CFTPSLOGOUT
OK

+CFTPSLOGOUT: 0
//Logout FTP server
AT+CFTPSSTOP
OK

+CFTPSSTOP: 0
//Stop FTP server

## PDF Page 11

### 3.1.2 Download a file from FTP server to serial port /Upload a file from serial port to
FTP server

//Example of FTP upload/download
AT+CFTPSSTART
OK

+CFTPSSTART: 0
//Start FTP service
AT+CFTPSLOGIN="255.255.255.255",21,"user
name","password",0
OK

+CFTPSLOGIN: 0
//Login to a FTP server
AT+CFTPSLIST="/"
OK

+CFTPSLIST: DATA,175
-rw-r--r-- 1 ftp ftp            121 Mar 11 16:24
124.txt
-rw-r--r-- 1 ftp ftp              3 Mar 19 17:10
test1131.txt
drwxr-xr-x 1 ftp ftp              0 Jan 13
2020 TEST113
drwxr-xr-x 1 ftp ftp              0 Jan 19
2020 TEST1155

+CFTPSLIST: 0
//List all ms of directory "/"
AT+CFTPSPWD
OK

+CFTPSPWD: "/"
//Get current directory of FTP server
AT+CFTPSGET="test1131.txt"
OK

+CFTPSGET: DATA,3
321
+CFTPSGET: 0
//Downloda a file from FTP server to serial port
AT+CFTPSPUT="test1131.txt"
> (input the data,and use ctrl+Z  to complete
upload)
OK

+CFTPSPUT: 0
//Upload a file to FTP server from serial port

## PDF Page 12

AT+CFTPSPUT="test1131.txt",3
> (input the data,when the length is 3,Upload
will complete automatically)
OK

+CFTPSPUT: 0

//Upload a file to FTP server from serial po rt by
limiting the length.
AT+CFTPSLOGOUT
OK

+CFTPSLOGOUT: 0
//Logout FTP server
AT+CFTPSSTOP
OK

+CFTPSSTOP: 0
//Stop FTP server

### 3.1.3 Directory Operations

//Example of FTP directory operations
AT+CFTPSSTART
OK

+CFTPSSTART: 0
//Start FTP service
AT+CFTPSLOGIN="255.255.255.255",21,"user
name","password",0
OK

+CFTPSLOGIN: 0
//Login to a FTP server
AT+CFTPSLIST="/"
OK

+CFTPSLIST: DATA,175
-rw-r--r-- 1 ftp ftp            121 Mar 11 16:24
124.txt
-rw-r--r-- 1 ftp ftp              3 Mar 19 17:10
test1131.txt
drwxr-xr-x 1 ftp ftp              0 Jan 13
2020 TEST113
drwxr-xr-x 1 ftp ftp              0 Jan 19
2020 TEST1155

+CFTPSLIST: 0
//List all ms of directory "/"
##### AT+CFTPSPWD //Get current directory of FTP server

## PDF Page 13

OK

+CFTPSPWD: "/"
AT+CFTPSMKD="TEST1129"
OK

+CFTPSMKD: 0
//Create a new directory
AT+CFTPSCWD="TEST1129"
OK

+CFTPSCWD: 0
//Change to the specified directory

AT+CFTPSPWD
OK

+CFTPSPWD: "/TEST1129"
//Get current directory of FTP server
AT+CFTPSCWD
OK

+CFTPSCWD: "/"
//Change to the specified directory

AT+CFTPSRMD="/TEST1129"
OK

+CFTPSRMD: 0
//Delete the specified directory
AT+CFTPSLOGOUT
OK
+CFTPSLOGOUT: 0
//Logout FTP server
AT+CFTPSSTOP
OK

+CFTPSSTOP: 0
//Stop FTP server

## 3.2 FTPS Function

### 3.2.1 Download a file from FTPS server to module/Upload a file to FTPS server from
module

//Example of FTP(S) upload/download
AT+CFTPSSTART
OK

///Start FTP service

## PDF Page 14

+CFTPSSTART: 0
AT+CFTPSLOGIN="255.255.255.255",990,"use
rname","password"
OK

+CFTPSLOGIN: 0
//Login to a Implicit FTPS server.
AT+CFTPSLIST="/"
OK

+CFTPSLIST: DATA,175
-rw-r--r-- 1 ftp ftp            121 Mar 11 16:24
124.txt
drwxr-xr-x 1 ftp ftp              0 Jan 13
2020 TEST113
drwxr-xr-x 1 ftp ftp              0 Jan 19
2020 TEST1155

+CFTPSLIST: 0
//List all ms of directory "/"
AT+CFTPSPWD
OK

+CFTPSPWD: "/"
//Get current directory of FTP server
AT+CFTPSGETFILE="124.txt"
OK

+CFTPSGETFILE: 0
//Download a file from FTP server to module.
AT+CFTPSPUTFILE="124.TXT"
OK

+CFTPSPUTFILE: 0
//Upload a file to FTP server from module
AT+CFTPSLOGOUT
OK

+CFTPSLOGOUT: 0
//Logout FTP server
AT+CFTPSSTOP
OK

+CFTPSSTOP: 0
//Stop FTP server

### 3.2.2 Download a file from FTP S server to serial port /Upload a file from serial port to
FTPS server

//Example of FTP(S) upload/download

## PDF Page 15

AT+CFTPSSTART
OK

+CFTPSSTART: 0
//Start FTP service
AT+CFTPSLOGIN="255.255.255.255",990,"use
rname","password"
OK

+CFTPSLOGIN: 0
//Login to a Implicit FTPS server.
AT+CFTPSLIST="/"
OK

+CFTPSLIST: DATA,175
-rw-r--r-- 1 ftp ftp            121 Mar 11 16:24
124.txt
-rw-r--r-- 1 ftp ftp              3 Mar 19 17:10
test1131.txt
drwxr-xr-x 1 ftp ftp              0 Jan 13
2020 TEST113
drwxr-xr-x 1 ftp ftp              0 Jan 19
2020 TEST1155

+CFTPSLIST: 0
//List all ms of directory "/"
AT+CFTPSPWD
OK

+CFTPSPWD: "/"
//Get current directory of FTP server
AT+CFTPSGET="test1131.txt"
OK

+CFTPSGET: DATA,3
321
+CFTPSGET: 0
//Downloda a file from FTP server to serial port
AT+CFTPSPUT="test1131.txt"
> (input the data,and use ctrl+Z to complete
upload)
OK

+CFTPSPUT: 0
AT+CFTPSPUT="test1131.txt",3
> (input the data,when the length is 3,Upload
will complete automatically)
OK

+CFTPSPUT: 0

//Upload a file to FTP server from serial port

//Upload a file to FTP server from serial port by
limiting the length.

## PDF Page 16

AT+CFTPSLOGOUT
OK

+CFTPSLOGOUT: 0
//Logout FTP server
AT+CFTPSSTOP
OK

+CFTPSSTOP: 0
//Stop FTP server

### 3.2.3 Directory Operations

//Example of FTP(S) directory operations
AT+CFTPSSTART
OK

+CFTPSSTART: 0
//Start FTP service
AT+CFTPSLOGIN="255.255.255.255",660,"use
rname","password"
OK

+CFTPSLOGIN: 0
//Login to a Implicit FTPS server
AT+CFTPSLIST="/"
OK

+CFTPSLIST: DATA,175
-rw-r--r-- 1 ftp ftp            121 Mar 11 16:24
124.txt
-rw-r--r-- 1 ftp ftp              3 Mar 19 17:10
test1131.txt
drwxr-xr-x 1 ftp ftp              0 Jan 13
2020 TEST113
drwxr-xr-x 1 ftp ftp              0 Jan 19
2020 TEST1155

+CFTPSLIST: 0
//List all ms of directory "/"
AT+CFTPSPWD
OK

+CFTPSPWD: "/"
//Get current directory of FTP server
AT+CFTPSMKD="TEST1129"
OK

+CFTPSMKD: 0
//Create a new directory

## PDF Page 17

AT+CFTPSCWD="TEST1129"
OK

+CFTPSCWD: 0
//Change to the specified directory

AT+CFTPSPWD
OK

+CFTPSPWD: "/TEST1129"
//Get current directory of FTP server
AT+CFTPSCWD
OK

+CFTPSCWD: "/"
//Change to the specified directory

AT+CFTPSRMD="/TEST1129"
OK

+CFTPSRMD: 0
//Delete the specified directory
AT+CFTPSLOGOUT
OK
+CFTPSLOGOUT: 0
//Logout FTP server
AT+CFTPSSTOP
OK

+CFTPSSTOP: 0
//Stop FTP server

## PDF Page 18

4 Appendix

## 4.1 Summary of Error Codes

Code of <errcode> Description
0 Success
1 SSL alert
2 Unknown error
3 Busy
4 Connection closed by server
5 Timeout
6 Transfer failed
7 File not exists or any other memory error
8 Invalid parameter
9 Operation rejected by server
10 Network error
11 State error
12 Failed to parse server name
13 Create socket error
14 Connect socket failed
15 Close socket failed
16 SSL session closed
17 File error, file not exist or other error.
