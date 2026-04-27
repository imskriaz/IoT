# A76XX_Series_Audio_Application_Note_V1.00

Source PDF: [A76XX_Series_Audio_Application_Note_V1.00.pdf](./A76XX_Series_Audio_Application_Note_V1.00.pdf)

Total pages: 15

> Auto-generated from the PDF text layer. Layout-heavy pages may lose table, column, and diagram fidelity.

## PDF Page 1

A7600 Series_
Audio_Application Note

SIMCom Wireless Solutions Limited
Building B, SIM Technology Building, No.633, Jinzhong Road
Changning District, Shanghai P.R. China
Tel: 86-21-31575100
support@simcom.com
www.simcom.com
LTE Module

## PDF Page 2

- **Document Title:** A7600 Series_Audio_Application Note
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
A5360E, sand A7670X.

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
- 1.4 The process of Using Audio AT Commands (page 4)
The process of TTS function ............................................................................................ 5 1.4.1
The process of audio file playback function ...................................................................... 5 1.4.2
The process of record function ......................................................................................... 6 1.4.3
## 1.5 Error Handling.................................................................................................................................. 7
Executing Audio AT Commands Fails ............................................................................... 7 1.5.1
- 2 AT Commands for Audio (page 8)
- 2.1 Overview of AT Commands for Audio (page 8)
- 3 Audio Examples (page 9)
- 3.1 TTS Function (page 9)
Set TTS parameters ......................................................................................................... 9 3.1.1
Playing UCS2 text or ASCII text ....................................................................................... 9 3.1.2
Playing UCS2 text or ASCII text and saving to WAV file ................................................. 10 3.1.3
TS remote playback ....................................................................................................... 10 3.1.4
Playing UCS2 text or ASCII text and saving to WAV file ................................................. 10 3.1.5
- 3.2 Audio Function (page 11)
Play AMR file and WAV file ............................................................................................. 11 3.2.1
Play audio file to the remote ........................................................................................... 11 3.2.2
Stop audio file playback .................................................................................................  12 3.2.3
- 3.3 Record Function (page 12)
Local recording ............................................................................................................... 12 3.3.1
Remote recording ........................................................................................................... 12 3.3.2
Stop recording ................................................................................................................ 13 3.3.3
- 4 Appendix (page 14)
- 4.1 Summary of Error Codes (page 14)

## PDF Page 5

1 Introduction

## 1.1 Purpose of the document

Based on module AT command manual, this document will introduce Audio application process.
Developers could understand and develop application quickly and efficiently based on this document.This
document gives the usage of A7600 TTS functions , Audio file playback functions and record functions .
User can get useful information about these functions quickly through this document.
The functions are provided in AT command format, and they are designed for customers to design their
audio applications easily. User can access these Audio AT commands through UART/ USB interface which
communicates with A7600 module. Now Chinese and English languages can be supported in TTS funciotns.
And Audio file playback support to play WAV and AMR files. On the other hand, the record file are saved as
WAV files.

## 1.2 Related documents

[1] A7600 Series_AT Command Manual

## 1.3 Conventions and abbreviations

In this document, the GSM engines are referred to as following term:
AMR (Adaptive Multi-Rate);
TTS (Text to Speech);

## 1.4 The process of Using Audio AT Commands

## PDF Page 6

The process of TTS function 1.4.1

AT+CTTS=1,"6B228FCE4F7F"
（play UCS2 text）
URC:"+CTTS: 0"
(TTS play end )
AT+CTTS=1,"6B228FCE4F7F","C
:/123"
（play UCS2 text and save to
C:/123.wav）
TTS data write file or not
N
Y
Power on the module
Save wav file with 3td to show path and
filename , do not save with just tow
parameters .
Mode 1 means UC S2 text, mode 2 means
ASCII text.
Stop actively by AT +CTTS=0 AT+CTTS=0
(stop TTS playing )
AT+CTTSPARAM=1,3,0,1,1
(set TTS parameters)

The process of audio file playback function 1.4.2

## PDF Page 7

AT+CCMXPLAY ="C:/
3034.amr",0,1（play AM R
file）
URC:"+AUDIOSTATE : audio play
stop"
(audio file play end )
Power on the module
Audio file playback function
Support file type : AMR,WAV; Support  file
storage :C:(file system),D:(SD card).2th
paramter is playing mode (0:local
1:remote).  Last parameter is the number
of cycles.
Stop actively by AT +CCMXPLAY
AT+CCMXSTOP
(stop audio file playing )

The process of record function 1.4.3

## PDF Page 8

AT+CREC=1,"C:/
recording.wav"
(record to C:/recording.wav )
URC:"+CREC: file full"
(audio file play end )
Power on the module
Record function
1st paramter is playing mode (1:local
2:remote).  Support  file
storage :C:/recording.wav(file
system),D:/recording.wav(SD card).
Stop actively by AT +CREC=0
AT+CREC=0
(stop recording function )
(audio file play end )

## 1.5 Error Handling

Executing Audio AT Commands Fails 1.5.1

When executing Audio AT commands, if ERROR response is received from the module, please check
whether the version is supporting it when executing.

## PDF Page 9

2 AT Commands for Audio

## 2.1 Overview of AT Commands for Audio

Command Description
##### AT+CTTS TTS operation
##### AT+CTTSPARAM Set TTS parameters
##### AT+CDTAM Set local or remote audio play
##### AT+CCMXPLAY Play an audio file
##### AT+CCMXSTOP Stop playing audio file
##### AT+CREC Record WAV audio file

## PDF Page 10

3 Audio Examples

## 3.1 TTS Function

Set TTS parameters 3.1.1

//Example of TTS parameters setting
AT+CTTSPARAM=?
+CTTSPARAM:(0-2),(0-3),(0-3),(0-2),(0-2)

OK
//read parameters scale
AT+CTTSPARAM=1,3,0,1,1
OK
//set
parameters(volume,sysvolume,digitmode,pitch,sp
eed)
AT+CTTSPARAM?
+CTTSPARAM:1,3,0,1,1

OK
//read TTS parameters

Playing UCS2 text or ASCII text 3.1.2

//Example of TTS play
AT+CTTS=1,"6B228FCE4F7F75288BED97F35
40862107CFB7EDF"
+CTTS:

OK
+CTTS: 0
//synth and play UCS2 text
//playing end
AT+CTTS=2,"1234567890"
+CTTS:

OK
+CTTS: 0
//synth and play ASCII text

//playing end

## PDF Page 11

Playing UCS2 text or ASCII text and saving to WAV file 3.1.3

//Example of TTS play
AT+CTTS=4,"6B228FCE4F7F75288BED97F35
40862107CFB7EDF","C:/123"
+CTTS:

OK
+CTTS: 0
//synth and play UCS2 text,save to "C:/123.wav"

//playing end
AT+CTTS=3,"123456789012345678","D:/123"
+CTTS:

OK
+CTTS: 0
//synth and play UCS2 text,save to "D:/123.wav"

//playing end

TS remote playback 3.1.4

//Example of TTS play to the remote
AT+CDTAM=1
OK
//set remote playback
ATD199XXXXXXXX;
OK
//start call and stay on call
AT+CTTS=1,"6B228FCE4F7F75288BED97F35
40862107CFB7EDF"
+CTTS:

OK
+CTTS: 0
//synth and play UCS2 text to the remote

//playing end

Playing UCS2 text or ASCII text and saving to WAV file 3.1.5

//Example of TTS play
AT+CTTS=1,"6B228FCE4F7F75288BED97F35
40862107CFB7EDF"
+CTTS:

OK
//synth and play UCS2 text to the remote

## PDF Page 12

AT+CTTS=0
+CTTS: 0

OK
//stop playback

## 3.2 Audio Function

Play AMR file and WAV file 3.2.1

//Example of Audio file playback
AT+CFTRANRX="C:/3034.amr",24742
>

OK
//import audio file to "C:/3034.amr" and file size is
24742 bytes.
AT+CCMXPLAY="C:/3034.amr",0,3
+CCMXPLAY:

OK
+AUDIOSTATE: audio play

+AUDIOSTATE: audio play stop
//play "C:/3034.amr" and repeat 3 times

//start playback

//playing end
AT+CCMXPLAY="C:/recording.wav",0,0
+CCMXPLAY:

OK
+AUDIOSTATE: audio play

+AUDIOSTATE: audio play stop
//play the recorded file"C:/recording.wav"

//start playback

//playing end

Play audio file to the remote 3.2.2

//Example of Audio file playback
ATD199XXXXXXXX;
OK
//start call and stay on call
AT+CCMXPLAY="C:/3034.amr",1,0
+CCMXPLAY:

//play "C:/3034.amr" to the remote

## PDF Page 13

OK
+AUDIOSTATE: audio play

+AUDIOSTATE: audio play stop

//start playback

//playing end

Stop audio file playback 3.2.3

//Example of Audio file playback
AT+CCMXPLAY="C:/3034.amr",1,0
+CCMXPLAY:

OK
+AUDIOSTATE: audio play
//play "C:/3034.amr" to the remote

//start playback
AT+CCMXSTOP
+CCMXSTOP:

OK
+AUDIOSTATE: audio play stop
//stop file playback

## 3.3 Record Function

Local recording 3.3.1

//Example of recording
AT+CREC=1,"C:/recording.wav"
+CREC: 1

OK
+CREC: file full
//start recording and save to "C:/recording.wav"

//recording time is about 40s and recording end

Remote recording 3.3.2

//Example of recording
ATD199XXXXXXXX;
OK
//start call and stay on call

## PDF Page 14

AT+CREC=2,"C:/recording.wav"
+CREC: 2

OK
+CREC: file full
//start recording and save to "C:/recording.wav"

//recording time is about 80s and recording end

Stop recording 3.3.3

//Example of recording
AT+CREC=1,"C:/recording.wav"
+CREC: 1

OK
//start recording and save to "C:/recording.wav"
AT+CREC=0
+CREC: 0

OK
//stop recording

## PDF Page 15

4 Appendix

## 4.1 Summary of Error Codes

Code of <errcode> Meaning
0 Success
2 Unknown error
3 Busy
7 File not exists or any other memory error
8 Invalid parameter
9 Operation rejected by server
11 State error
17 File error, file not exist or other error.
