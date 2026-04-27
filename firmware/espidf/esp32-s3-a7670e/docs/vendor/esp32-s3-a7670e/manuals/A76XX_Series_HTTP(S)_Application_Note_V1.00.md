# A76XX_Series_HTTP(S)_Application_Note_V1.00

Source PDF: [A76XX_Series_HTTP(S)_Application_Note_V1.00.pdf](./A76XX_Series_HTTP(S)_Application_Note_V1.00.pdf)

Total pages: 21

> Auto-generated from the PDF text layer. Layout-heavy pages may lose table, column, and diagram fidelity.

## PDF Page 1

A7600 Series_
HTTP(S)_Application Note

SIMCom Wireless Solutions Limited
Building B, SIM Technology Building, No.633, Jinzhong Road
Changning District, Shanghai P.R. China
Tel: 86-21-31575100
support@simcom.com
www.simcom.com
LTE Module

## PDF Page 2

- **Document Title:** A7600 Series_HTTP(S)_Application Note
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

Version Date Chapter Description
V1.00 2020.06.19   New version

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
- 1.4 The process of Using HTTP(S) AT Commands (page 5)
## 1.5 Error Handling.................................................................................................................................. 6
### 1.5.1 Executing HTTP(S) AT Commands Fails.......................................................................... 6
- 1.5.2 PDP Activation Fails (page 6)
### 1.5.3 Error Response of HTTP(S) Server.................................................................................. 6
- 2 AT Commands for HTTP(S) (page 7)
- 2.1 Overview of AT Commands for HTTP(S) (page 7)
- 3 HTTP(S) Examples (page 8)
- 3.1 Access to HTTP server (page 8)
- 3.2 Access to HTTPS server (page 13)
- 4 Appendix (page 18)
- 4.1 Summary of Error Codes (page 18)
- 4.2 Unsolicited Result Codes (page 19)

## PDF Page 5

1 Introduction

## 1.1 Purpose of the document

Based on module AT command manual, this document will introduce HTTP application process.
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

## 1.4 The process of Using HTTP(S) AT Commands

AT+HTTPINIT
（PDP active and initialize HTTP(S)
serv ice）
AT+HTTPPARA="READ MODE",<readmode>
AT+HTTPPARA="URL","<url>"
AT+HTTPPARA="SSLCFG",<sslcfg_id>HTTPS?
AT+HTTPINIT:
##### AT+HTTPINIT also can activate the PDP
Context.But It can not customize PDP
activation parameters .
AT+HTTPPARA="CONNECTTO ",<conn_ti me
out>
AT+HTTPPARA="RECVTO",<recv_ti meout>
AT+HTTPPARA="CONTENT","<content_ty pe>"
AT+HTTPPARA="ACCEPT","<accept-ty pe>"
AT+HTTPPARA="USERDATA ","<user_data>"
AT+HTTPACTION =<method>
AT+HTTPHEAD
AT+HTTPREAD?
AT+HTTPREAD=[<start_offset>,]<byte_size>
AT+HTTPDATA=<size>,<ti me>
AT+HTTPTERM
AT+HTTPREADFILE =<filename>[,<path>]
AT+HTTPPOSTFILE =<filename>[,<path>]
Y
N
Power on the module
Query SIM card status by AT+CPIN?
Query CS service by AT+CREG?
Query PS service by
AT+CGREG?/AT+CEREG?
Query UE information by AT+CP SI?
Configure the PDP context by
##### AT+CGDC ONT
Active the PDP context by
AT+CGA CT=<state>,[<cid>] and
AT+CGA CT?
Query signal quality by AT+CSQ
CS Service:
If <stat> of AT+CREG? equals to 1,it means
that the module has registered on CS
domain service .Reboot the module if fals
to registered on CS domain .
PS Serivce:
If <stat> of AT+CGREG?/AT+CEREG? equals
to 1,it means that the module has
registered on PS domain service .
SIM Card Status :
Execute AT +CPIN?,if response is
+CPIN:READ Y,means SIM Card Status is
normal.Reboot the module or check SIM
card status if AT +CPIN? Fails to identify
SIM card in 20s.
Signal quality :
Execute AT +CSQ to query signal quality .If
rssi is equals to 99,please check SIM card
status or reboot the module
UE system information :
If <System Mode > is "NO S ERVICE",it
means network status has some problem .
PDP Context :
1.Configure PDP Context by
AT+CGDCONT=<cid>
2.Activate the PDP Context by
AT+CGACT=<state>,[<cid>]
3.Query IP address of the PDP context by
AT+CGACT?
+CPIN: READY
+CSQ: <rssi>,<ber>,0 < rssi < 31
+CRE G: 0,1
Check the status of SIM card or
Reboot the module
## No Service
## Pdp Active Fail
Select operation
Select operation
If you want to access https server ,
'SSLCFG' should be set, but it's
optional according to https server .
Set the URL of network resource that
you want to access .
Set the parameter of readmode ,
(optional)
Set HTTP(S) connect timeout ,
(optional)
Set HTTP(S) receive timeout
( optional)
Set HTTP(S) "Content-Ty pe" HTTP
header information , default value is
'text/plain'.
( optional)
Set HTTP(S) "Accept" HTTP header
information , default value is '*/*'.
(optional)
Set HTTP(S) customized HTTP header
information
(optional)
Set HTTP(s) request body content
(optional)
Send HTTP(s) request
Read HTTP (s) response header , when
you want to see response header .
Get HTTP(s) resp onse content length,
when you want to see that .
Customer can read http content from
AT port or read HTTP (s) content to
store in file .
Read HTTP (s) resp onse content from
AT port, you can either read all at a
time or partial per time repeatly .
Read all HTTP (s) response content and
store to file .
PDP deactive and terminate HTTP(S)
serv ice.
Send HTTP (S) request with the
content of the file .
Set the SSL context id for HTTPS
session.
(optional)
Customer can send http request with
multi AT command or  with the
content of the file .

## PDF Page 7

## 1.5 Error Handling

### 1.5.1 Executing HTTP(S) AT Commands Fails

When executing HTTP(S) AT commands, if ERROR response is received from the module, please check
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

### 1.5.3 Error Response of HTTP(S) Server

When the < errcode > of +HTTPACTION: <method>,<errcode>,<datalen> or +HTTPPOSTFILE:
<errcode>,<datalen> is not 200, it indicates an error code replied from HTTP(S) server.
For example, if < errcode > is 404, the URL can't be found. If <  errcode > is 301, the URL is redirect ,
please refer to A7600 Series_AT Command Manual_V1.01.

## PDF Page 8

2 AT Commands for HTTP(S)

## 2.1 Overview of AT Commands for HTTP(S)

Command Description
##### AT+HTTPINIT Start HTTP service
##### AT+HTTPTERM Stop HTTP Service
##### AT+HTTPPARA Set HTTP Parameters value
##### AT+HTTPACTION HTTP Method Action
##### AT+HTTPHEAD Read the HTTP Header Information of Server Respons
##### AT+HTTPREAD Read the response information of HTTP Server
##### AT+HTTPDATA Input HTTP Data
##### AT+HTTPPOSTFILE Send HTTP Request to HTTP(S) server by File
##### AT+HTTPREADFILE Receive HTTP Response Content to a file

## PDF Page 9

3 HTTP(S) Examples

Before all HTTP(S) related operations, we should ensure the following:
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

AT+CGACT=?
+CGACT: 1,1

OK

## 3.1 Access to HTTP server

// Send HTTP GET Request
##### AT+HTTPINIT //start HTTP service, activate PDP context

## PDF Page 10

OK //set the URL which will be accessed, for HTTP,
the request URL begins with "HTTP://"
AT+HTTPPARA="URL","http://opinion.people.
com.cn/GB/n1/2018/0815/c1003-30228758.html
"

OK
AT+HTTPACTION=0                             //send HTTP GET request
OK

+HTTPACTION: 0,200,22505
//22505 is the length of HTTP response
information

##### AT+HTTPHEAD //read the HTTP response header
+HTTPHEAD: 387

HTTP/1.1 200 OK
Server: nginx
Content-Type: text/html
Connection: close
- **Date:** Thu, 16 Aug 2018 05:13:36 GMT
Powered-By-ChinaCache: MISS from
06053423gG.15
ETag: W/"5b7379f5-57e9"
Last-Modified: Wed, 15 Aug 2018 00:55:17
## Gmt
Expires: Thu, 16 Aug 2018 05:18:36 GMT
Vary: Accept-Encoding
X-Cache-Hits: 14
Content-Length: 22505
CC_CACHE: TCP_REFRESH_HIT
Accept-Ranges: bytes

OK
//387 is the length of response header

// Content -Length indicates the length of HTTP
response information is 22505 bytes

//read the response information of HTTP server,
the length to read is 500 bytes
AT+HTTPREAD=0,500
OK

+HTTPREAD: 500
<!DOCTYPE html PUBLIC " -//W3C//DTD
XHTML 1.0 Transitional//EN"
"http://www.w3.org/TR/xhtml1/DTD/xhtml1-tra
nsitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta http -equiv="content-type"
content="text/html;charset=GB2312"/>
<meta http -equiv="Content-Language"

## PDF Page 11

content="utf-8" />
<meta content="all" name="robots" />
<title>人民日报钟声：牢记历史是为了更好开创未
来--观点--人民网 </title>
<meta name="keywords" content="" />
<meta name="description" content="   日方
应在正确对待历史?
+HTTPREAD: 0

##### AT+HTTPTERM //stop HTTP Service
OK

Send HTTP POST Request

##### AT+HTTPINIT //start HTTP service, activate PDP context
OK
AT+HTTPPARA="URL","http://api.efxnow.com/
DEMOWebServices2.8/Service.asmx/Echo?"
//set the URL which will be accessed, for HTTP, the
request URL begins with "HTTP://"
OK
AT+HTTPDATA=18,1000 //send data to post, the length is 18 bytes
## Download
Message=helloworld
OK

AT+HTTPACTION=1 //send HTTP POST request
OK

+HTTPACTION: 1,500,30

AT+HTTPHEAD
+HTTPHEAD: 258
HTTP/1.1 500 Internal Server Error
Cache-Control: private
Content-Type: text/plain; charset=utf-8
Server: Microsoft-IIS/7.0
X-AspNet-Version: 2.0.50727
X-Powered-By: ASP.NET
- **Date:** Mon, 20 Aug 2018 04:18:58 GMT
Connection: close
Content-Length: 30

OK
AT+HTTPREAD=0,30
OK

+HTTPREAD: 30

## PDF Page 12

Request format is invalid: .
+HTTPREAD: 0
AT+HTTPTERM
OK

Send HTTP HEAD Request

##### AT+HTTPINIT //start HTTP service, activate PDP context
OK
AT+HTTPPARA="URL","http://opinion.people.c
om.cn/GB/n1/2018/0815/c1003-30228758.html"

OK
AT+HTTPACTION=2 //send a HEAD request to server to only get header
of HTTP response
OK

+HTTPACTION: 2,200,387

+HTTP_PEER_CLOSED

//server disconnect
AT+HTTPHEAD
+HTTPHEAD: 387

HTTP/1.1 200 OK
Server: nginx
Content-Type: text/html
Connection: close
Vary: Accept-Encoding
Powered-By-ChinaCache: MISS from
06053423gG.15
ETag: W/"5b7379f5-57e9"
Last-Modified: Wed, 15 Aug 2018 00:55:17 GMT
Content-Length: 22505
X-Cache-Hits: 14
- **Date:** Thu, 16 Aug 2018 10:58:00 GMT
Expires: Thu, 16 Aug 2018 11:03:00 GMT
CC_CACHE: TCP_REFRESH_HIT
Accept-Ranges: bytes

OK

##### AT+HTTPTERM //stop HTTP Service
OK

POSTFILE to HTTP server and read HTTP response content to a file

##### AT+HTTPINIT //start HTTP service, activate PDP context
OK

## PDF Page 13

AT+HTTPPARA="URL","http://www.baidu.com" //set server URL
OK
AT+HTTPPOSTFILE="getbaidu.txt",1 //access server and send file getbaidu.txt to server
OK

+HTTPPOSTFILE: 200,14615

##### AT+HTTPHEAD //read the HTTP server response header
information.
+HTTPHEAD: 773
HTTP/1.1 200 OK
Accept-Ranges: bytes
Cache-Control: no-cache
Connection: Keep-Alive
Content-Length: 14615
Content-Type: text/html
- **Date:** Thu, 13 Sep 2018 05:14:30 GMT
Etag: "5b8641dc-3917"
Last-Modified: Wed, 29 Aug 2018 06:49:00 GMT
P3p: CP=" OTI DSP COR IVA OUR IND COM "
Pragma: no-cache
Server: BWS/1.1
Set-Cookie:
BAIDUID=A374BCFD28DFEEAF0BA0C4EEAC7
7B0B0:FG=1; expires=Thu, 31- Dec-37 23:55:55
GMT; max-age=2147483647; path=/;
domain=.baidu.com
Set-Cookie:
BIDUPSID=A374BCFD28DFEEAF0BA0C4EEAC
77B0B0; expires=Thu, 31-Dec-37 23:55:55 GMT;
max-age=2147483647; path=/;
domain=.baidu.com
Set-Cookie: PSTM=1536815670; expires=Thu,
31-Dec-37 23:55:55 GMT;
max-age=2147483647; path=/;
domain=.baidu.com
Vary: Accept-Encoding
X-Ua-Compatible: IE=Edge,chrome=1

OK

AT+HTTPREADFILE="readbaidu.dat" //read the HTTP server response content to a file
named readbaidu.dat, saved to local storage
OK

+HTTPREADFILE: 0

##### AT+HTTPTERM //stop HTTP Service
OK

## PDF Page 14

## 3.2 Access to HTTPS server

Send HTTPS GET Requst

##### AT+HTTPINIT //start HTTP service, activate PDP context
OK
AT+HTTPPARA="URL","https://ss0.bdstatic.co
m/5aV1bjqh_Q23odCf/static/mancard/css/card_
min_dee38e45.css"

OK
AT+HTTPACTION=0  // send HTTPS GET request
OK

+HTTPACTION: 0,200,52060

//52060 is the length of HTTPS response
information

##### AT+HTTPHEAD //read HTTPS response header .
+HTTPHEAD: 390

HTTP/1.1 200 OK
Server: bfe/1.0.8.13-sslpool-patch
- **Date:** Thu, 16 Aug 2018 11:38:08 GMT
Content-Type: text/css
Content-Length: 52060
Connection: close
ETag: "5a323f72-cb5c"
Last-Modified: Thu, 14 Dec 2017 09:08:02 GMT
Expires: Sat, 18 Aug 2018 09:50:53 GMT
Age: 2425635
Accept-Ranges: bytes
Cache-Control: max-age=2592000
Vary: Accept-Encoding
Ohc-Response-Time: 1 0 0 0 0 0

OK
//390 is the length of HTTPS response hreader
AT+HTTPREAD=0,500 //read the response information of HTTPS server,
the length to read is 500 bytes
OK

+HTTPREAD: 500
.s-cardsetting{position:relative;text-align:left;p
adding:22px 25px 0 25px;border:1px solid

## PDF Page 15

#e3e3e3;width:843px}.main .sui-dialog-cardsett
ing{opacity:.98;filter:alpha(opacity=98);positio
n:absolute;border:none;display:none;_height:1
86px}.sui-dialog-cardsetting{opacity:.98!import
ant;filter:alpha(opacity=98)!important;border:n
one!important}.sui-dialog-cardsetting .sui-dialo
g-title{height:42px;line-height:42px;text-indent:
21px}.s-cardsetting-content .s- mod-item
b,.sui-dialog-cardsetting .sui-dialog-c
+HTTPREAD: 0
##### AT+HTTPTERM //stop HTTP Service
OK

Send HTTPS POST Requst

##### AT+HTTPINIT //start HTTP service, activate PDP context
OK
AT+HTTPPARA="URL","https://pv.csdn.net/csd
nbi"
//set the URL which will be accessed, for HTTPS,
the request URL begins with "HTTPS://"
OK
AT+HTTPDATA=465,1000 //send data to post, the length is 465 bytes
## Download
[{"headers":{"component":"enterprise","dataty
pe":"track","version":"v1"},"body":"{\"re\":\"ui
d=merry1996&ref=https%3A%2F%2Fpassport.c
sdn.net%2Faccount%2Fverify%3Bjsessionid%
3D7895A57BC64CE8616517F558940FD913.tom
cat2&pid=www&mod=&con=&ck=-&curl=https
%3A%2F%2Fwww.csdn.net%2F&session_id=1
0_1534696351647.160829&tos=12&referrer=htt
ps%3A%2F%2Fpassport.csdn.net%2Faccount
%2Fverify%3Bjsessionid%3D7895A57BC64CE8
616517F558940FD913.tomcat2&user_name=me
rry1996&type=pv\"}"}]
OK
//prompt string which indicates you can input data
here
AT+HTTPACTION=1 //send HTTPS post request
OK

+HTTPACTION: 1,200,2

+HTTP_PEER_CLOSED

// 2 is the length of HTTPS response information
##### AT+HTTPHEAD //read HTTPS response header .
+HTTPHEAD: 377
HTTP/1.1 200 OK
Server: openresty
- **Date:** Mon, 20 Aug 2018 03:20:30 GMT

## PDF Page 16

Content-Type: application/octet-stream
Connection: close
Set-Cookie:
uuid_tt_dd=10_37481894210-1534735230305-44
5993; Expires=Thu, 01 Jan 2025 00:00:00 GMT;
Path=/; Domain=.csdn.net;
Set-Cookie:
dc_session_id=10_1534735230305.501284;
Expires=Thu, 01 Jan 2025 00:00:00 GMT;
Path=/; Domain=.csdn.net;

OK
AT+HTTPREAD=0,10 //read the response information of HTTPS server,
the length to read is 10 bytes
OK

+HTTPREAD: 2
OK
+HTTPREAD: 0

//ok is the content of HTTPS response information,
2 bytes
##### AT+HTTPTERM //stop HTTP Service
OK

Send HTTPS HEAD Requst

##### AT+HTTPINIT //start HTTP service, activate PDP context
OK
AT+HTTPPARA="URL","https://ss0.bdstatic.co
m/5aV1bjqh_Q23odCf/static/mancard/css/card_
min_dee38e45.css"
//set the URL which will be accessed, for HTTPS,
the request URL begins with "HTTPS://"
OK
AT+HTTPACTION=2 // send HTTPS HEAD request
OK

+HTTPACTION: 2,200,390
+HTTP_PEER_CLOSED

// 390 is the length of HTTPS response header
##### AT+HTTPHEAD //read HTTPS response header .
+HTTPHEAD: 390

HTTP/1.1 200 OK
Server: bfe/1.0.8.13-sslpool-patch
- **Date:** Thu, 16 Aug 2018 11:46:22 GMT
Content-Type: text/css
Content-Length: 52060
Connection: close
ETag: "5a323f72-cb5c"
Last-Modified: Thu, 14 Dec 2017 09:08:02 GMT

## PDF Page 17

Expires: Sat, 18 Aug 2018 09:50:53 GMT
Age: 2426129
Accept-Ranges: bytes
Cache-Control: max-age=2592000
Vary: Accept-Encoding
Ohc-Response-Time: 1 0 0 0 0 0

OK
##### AT+HTTPTERM //stop HTTP Service
OK

POSTFILE to HTTPS server and read HTTPS response content to a file

##### AT+HTTPINIT //start HTTP service, activate PDP context
OK
AT+HTTPPARA="URL","https://www.baidu.com
"
//set server URL
OK
AT+HTTPPOSTFILE="getbaidu.txt",1 //access server and send file getbaidu.txt to server
OK

+HTTPPOSTFILE: 200,14615

##### AT+HTTPHEAD //read HTTPS response header .
+HTTPHEAD: 773
HTTP/1.1 200 OK
Accept-Ranges: bytes
Cache-Control: no-cache
Connection: Keep-Alive
Content-Length: 14615
Content-Type: text/html
- **Date:** Thu, 13 Sep 2018 05:14:30 GMT
Etag: "5b8641dc-3917"
Last-Modified: Wed, 29 Aug 2018 06:49:00 GMT
P3p: CP=" OTI DSP COR IVA OUR IND COM "
Pragma: no-cache
Server: BWS/1.1
Set-Cookie:
BAIDUID=A374BCFD28DFEEAF0BA0C4EEAC7
7B0B0:FG=1; expires=Thu, 31- Dec-37 23:55:55
GMT; max- age=2147483647; path=/;
domain=.baidu.com
Set-Cookie:
BIDUPSID=A374BCFD28DFEEAF0BA0C4EEAC
77B0B0; expires=Thu, 31-Dec-37 23:55:55 GMT;
max-age=2147483647; path=/;
domain=.baidu.com

## PDF Page 18

Set-Cookie: PSTM=1536815670; expires=Thu,
31-Dec-37 23:55:55 GMT;
max-age=2147483647; path=/;
domain=.baidu.com
Vary: Accept-Encoding
X-Ua-Compatible: IE=Edge,chrome=1

OK
AT+HTTPREADFILE="readbaidu.dat"
OK
##### AT+HTTPTERM //stop HTTP Service
OK

## PDF Page 19

4 Appendix

## 4.1 Summary of Error Codes

<statuscode> Meaning
100 Continue
101 Switching Protocols
200  OK
201 Created
202 Accepted
203 Non-Authoritative Information
204 No Content
205 Reset Content
206 Partial Content
300 Multiple Choices
301 Moved Permanently
302 Found
303 See Other
304 Not Modified
305 Use Proxy
307 Temporary Redirect
400 Bad Request
401 Unauthorized
402 Payment Required
403 Forbidden
404 Not Found
405 Method Not Allowed
406 Not Acceptable
407 Proxy Authentication Required
408 Request Timeout
409 Conflict
410 Gone
411 Lenth Required
412 Precondition Failed
413 Request Entity Too Large

## PDF Page 20

414 Request-URI Too Large
415 Unsupported Media Type
416 Requested range not satisfiable
417 Expectation Failed
500 Internal Server Error
501 Not Implemented
502 Bad Gateway
503 Service Unavailable
504 Gateway timeout
505 HTTP Version not supported
600 Not HTTP PDU
601 Network Error
602 No memory
603 DNS Error
604 Stack Busy

## 4.2 Unsolicited Result Codes

URC Meaning
+HTTP_PEER_CLOSED It's a notification message. While received, it means the connection has
been closed by server.
+HTTP_NONET_EVENT It's a notification message. While received, it means now the network is
unavailable.

<errcode> Meaning
0 Success
701 Alert state
702 Unknown error
703 Busy
704 Connection closed error
705 Timeout
706 Receive/send socket data failed
707 File not exists or other memory error
708 Invalid parameter
709 Network error
710 start a new ssl session failed
711 Wrong state

## PDF Page 21

712 Failed to create socket
713 Get DNS failed
714 Connect socket failed
715 Handshake failed
716 Close socket failed
717 No network error
718 Send data timeout
719 CA missed
