# A76XX_Series_GNSS_Application_Note_V1.03

Source PDF: [A76XX_Series_GNSS_Application_Note_V1.03.pdf](./A76XX_Series_GNSS_Application_Note_V1.03.pdf)

Total pages: 18

> Auto-generated from the PDF text layer. Layout-heavy pages may lose table, column, and diagram fidelity.

## PDF Page 1

A76XX Series_
GNSS_Application Note
LTE Module
SIMCom Wireless Solutions Limited
SIMCom Headquarters Building, Building 3, No. 289 Linhong
Road, Changning District, Shanghai P.R. China
Tel: 86-21-31575100
support@simcom.com
www.simcom.com

## PDF Page 2

- **Document Title:** A76XX Series_GNSS_Application Note
- **Version:** 1.03
- **Date:** 2022.05.24
- **Status:** Released
## General Notes
SIMCOM OFFERS THIS INFORMATION AS A SERVICE TO ITS CUSTOMERS, TO SUPPORT
APPLICATION AND ENGINEERING EFFORTS THAT USE THE PRODUCTS DESIGNED BY SIMCOM.
THE INFORMATION PROVIDED IS BASED UPON REQUIREMENTS SPECIFICALLY PROVIDED TO
SIMCOM BY THE CUSTOMERS. SIMCOM HAS NOT UNDERTAKEN ANY INDEPENDENT SEARCH
FOR ADDITIONAL RELEVANT INFORMATION, INCLUDING ANY INFORMATION THAT MAY BE IN THE
CUSTOMER'S POSSESSION. FURTHERMORE, SYSTEM VALIDATION OF THIS PRODUCT
DESIGNED BY SIMCOM WITHIN A LARGER ELECTRONIC SYSTEM REMAINS THE RESPONSIBILITY
OF THE CUSTOMER OR THE CUSTOMER'S SYSTEM INTEGRATOR. ALL SPECIFICATIONS
SUPPLIED HEREIN ARE SUBJECT TO CHANGE.
## Copyright
THIS DOCUMENT CONTAINS PROPRIETARY TECHNICAL INFORMATION WHICH IS THE PROPERTY
OF SIMCOM WIRELESS SOLUTIONS LIMITED COPYING, TO OTHERS AND USING THIS DOCUMENT,
ARE FORBIDDEN WITHOUT EXPRESS AUTHORITY BY SIMCOM. OFFENDERS ARE LIABLE TO THE
PAYMENT OF INDEMNIFICATIONS. ALL RIGHTS RESERVED BY SIMCOM IN THE PROPRIETARY
TECHNICAL INFORMATION ，INCLUDING BUT NOT LIMITED TO REGISTRATION GRANTING OF A
PATENT , A UTILITY MODEL OR DESIGN. ALL SPECIFICATION SUPPLIED HEREIN ARE SUBJECT TO
CHANGE WITHOUT NOTICE AT ANY TIME.
SIMCom Wireless Solutions Limited
SIMCom Headquarters Building, Building 3, No. 289 Linhong Road, Changning District, Shanghai P.R.
China
Tel: +86 21 31575100
Email: simcom@simcom.com
For more information, please visit:
https://www.simcom.com/download/list-863-en.html
For technical support, or to report documentation errors, please visit:
https://www.simcom.com/ask/ or email to: support@simcom.com
Copyright © 2022 SIMCom Wireless Solutions Limited All Rights Reserved.

## PDF Page 3

### About Document
### Version History
Version Date Owner What is new
V1.00 2020.09.02 jian.ni/Tao.huang New version
V1.01 2021.02.03 Tao.huang Add support on A7678 Series
V1.02 2021.11.08 Wenjun.cai Modify some descriptions.
V1.03 2022.3.24 Wenjun.cai Add chapter 5

## PDF Page 4

Scope
Based on module AT command manual, this document will introduce GNSS application process.
Developers could understand and develop application quickly and efficiently based on this document.
This document applies to A1803S Series, A1603 Series, A1601 Series and A1802 Series.

## PDF Page 5

### Contents
- About Document (page 3)
- Version History (page 3)
- Scope (page 4)
- Contents (page 5)
- 1 Introduction (page 6)
- 1.1 Purpose of the document (page 6)
- 1.2 Related documents (page 6)
- 1.3 Conventions and abbreviations (page 6)
- 2 GNSS Introduction (page 7)
- 2.1 Overview (page 7)
- 2.2 GNSS (page 7)
- 3 NMEA Messages (page 9)
- 3.1 Standard NMEA Output Messages (page 9)
- 3.2 Message ID GGA: Global Positioning System Fixed Data (page 9)
- 3.3 Message ID GLL: Geographic Position - Latitude/Longitude (page 11)
- 3.4 Message ID GSA: GNSS DOP and Active Satellites (page 11)
- 3.5Message ID GSV: GNSS Satellites in View (page 12)
- 3.6 Message ID RMC: Recommended Minimum Specific GNSS Data (page 13)
- 3.7 Message ID GSA: GNSS DOP and Active Satellites (page 14)
- 4 GNSS Parser (page 15)
- 5 AT Command for GNSS (page 16)
- 5.1 Start GNSS (page 16)
- 5.2 Get GPS fixed position information (page 16)
- 5.3 Get GNSS fixed position information (page 17)

## PDF Page 6

1 Introduction
## 1.1 Purpose of the document
This document describes the usage of the GNSS module, and describes some NMEA format statements.
## 1.2 Related documents
[1] A76XX Series_AT Command Manual
## 1.3 Conventions and abbreviations
In this document, the GNSS engines are referred to as following terms:
 GP/GPS (Global navigation system);
 GB/BD/BDS (BEIDOU global navigation system);
 GL/GLNASS (GLONASS global navigation system);
 GN/GNSS (All kinds of global navigation system, include GPS, BDS and GLNASS);
 GNSS (Global Navigation Satellite System);
 GGA (Global positioning system fix data)
 GSA (GPS DOP and active satellites)
 GSV (GPS satellites in view)
 RMC (recommended minimum specific GPS/TRANSIT data)
 VTG (Track made good and ground speed)
 GLL (geographic position)

## PDF Page 7

2 GNSS Introduction
## 2.1 Overview
Customer can get useful information about A76XX GNSS functions quickly through this document.
GNSS function could be easily realized by AT command interface provided in A76XX module.
The GNSS features of the A76XX series of the ASR1601 platform:
 Support GPS, GLONASS and BEIDOU satellite system.
 Support standalone mode.
 Support cold start and hot start.
 Support a subset of the NMEA-0183 standard.
 Support NMEA sentences output in NMEA port .
 Support GNSS starts automatically when module powers on.
 Support maximum positioning update rate up to 10Hz.
The GNSS features of the A76XX series of the ASR1601 and ASR1803 platform:
 Supports GPS (L1), BDS (B1) and QZSS satellite systems, in the domestic version.
 Supports GPS (L1), BDS (B1), GLONASS, GALILEO, SBAS and QZSS satellite systems, in the
foreign version.
 Support BDS standalone mode.
 Support cold start, warm start and hot start.
 Support a subset of the NMEA-0183 standard.
 Support NMEA sentences output in NMEA port .
 Support GNSS starts automatically when module powers on.
 Support maximum positioning update rate up to 10Hz.
## 2.2 GNSS
The working principle is the positioning principle. GPS positioning is divided into single-point positioning
(absolute positioning) and relative positioning (differential positioning). Using the precise position of each
GPS satellite and the navigation information generated by the continuously transmitted on-board atomic
clock to obtain the time difference of arrival from the satellite to the receiver.

## PDF Page 8

The basic principle of BD work is to measure the distance between a satellite with a known position and a
user receiver, and then integrate the data of multiple satellites to know the specific position of the receiver.
Due to technical reasons, GPS can use the atomic clock on each satellite for precise positioning, but BD is
different. Due to the limited technology, China still cannot reach every satellite with an atomic clock, so the
development of BD-1 Soon, the accuracy is much lower. And GPS is active positioning, which means that
GPS can use 4 satellites to observe and position, while BD-1 is passive positioning and 3 satellites to
position, so the accuracy is relatively low. The current working principle of BD-2 is similar to that of GPS,
both are single-point positioning (absolute positioning) and relative positioning.

## PDF Page 9

3 NMEA Messages
## 3.1 Standard NMEA Output Messages
Message Description Possible Talker Identifiers
GGA Time, position and fix type data GP,GN,GL,BD/GB,GA
GSA GNSS receiver operating mode, satellites used in the
position solution, and DOP values
## Gp, Gl,Bd/Gb,Ga
GSV Number of GNSS satellites in view satellite ID
numbers, elevation, azimuth, & SNR values
## Gp,Gl,Bd/Gb,Ga
RMC Time, date, position, course and speed data GP,GN,GL,BD/GB,GA
VTG Course and speed information relative to the ground GP,GN,GL,BD/GB,GA
GLL Latitude, longitude, UTC time of position fix and status GP,GN,BD/GB,GA
ZDA PPS timing message (synchronized to PPS) GP,GN, BD/GB,GA
 The prefix "GP" refers to the GPS global navigation system;
 The prefix "GN" refers to the GNSS global navigation system(All kinds of global navigation
systems);
 The prefix "GL" refers to the GLONASS global navigation system;
 The prefix "BD/GB " refers to the BEIDOU global navigation system.
 The prefix " GA " refers to the GALILEO global navigation system.
A full description of the listed NMEA messages is provided in the following sections.
## 3.2 Message ID GGA: Global Positioning System Fixed Data
Example:
$GPGGA,091926.000,3113.3166,N,12121.2682,E,1,09,0.9,36.9,M,7.9,M,,0000*56<CR><LF>
## Note

## PDF Page 10

Name Example Unit Description
Message ID $GPGGA GGA protocol header
UTC Time 091926.000 hhmmss.sss
Latitude 3113.3166 ddmm.mmmm
N/S Indicator N N=north or S=south
Longitude 12121.2682 dddmm.mmmm
E/W Indicator E E=east or W=west
Position Fix Indicator 1 See Table 2.4
Satellites Used 09 Range 0 to 12
HDOP 0.9 Horizontal Dilution of Precision
MSL Altitude 36.9 meters
Units M meters
Geoid Separation 7.9 meters Geoid-to-ellipsoid separation.
Ellipsoid altitude = MSL Altitude + Geoid Separation.
Units M meters
Age of Diff. Corr. sec Null fields when DGPS is not used
Diff. Ref. Station ID 0000
Checksum *56 Xor check results
<CR><LF> End of message termination
Table 2.4 Position Fix Indicator
Value Description
0 Fix not available or invalid
1 GPS SPS Mode, fix valid
2 Differential GPS, SPS Mode, fix valid
3-5 Not supported
6 Dead Reckoning Mode, fix valid
 A valid status is derived from all the parameters set in the software. This includes the minimum
number of satellites required, any DOP mask setting, presence of DGPS corrections, etc. If the
default or current software setting requires that a factor is met, then if that factor is not met, the
solution will be marked as invalid.
## Note

## PDF Page 11

## 3.3 Message ID GLL: Geographic Position - Latitude/Longitude
Example:
$GPGLL,3113.3157,N,12121.2684,E,094051.000,A,A*59<CR><LF>
Name Example Unit Description
Message ID $GPGLL GLL protocol header
Latitude 3113.3157 ddmm.mmmm
N/S Indicator N N=north or S=south
Longitude 12121.2684 dddmm.mmmm
E/W Indicator E E=east or W=west
UTC Time 094051.000 hhmmss.sss
Status A A=data valid or V=data not valid
Mode A A=Autonomous,
D=DGPS,
Checksum *59 Xor check results
<CR><LF> End of message termination
 Position was calculated based on one or more of the SVs having their states derived from almanac
parameters, as opposed to ephemerides.
## 3.4 Message ID GSA: GNSS DOP and Active Satellites
Example:
$GPGSA,A,3,07,02,26,27,09,04,15, , , , , ,1.8,1.0,1.5*33<CR><LF>
Name Example Unit Description
Message ID $GPGSA GGA protocol header
Mode 1 A Table 2.6.1
Mode 2 3 Table 2.6.2
Satellite Used [1] 07 SV on Channel 1
Satellite Used [1] 02 SV on Channel 2
.... ....
Satellite Used [1] SV on Channel 12
PDOP[2] 1.8 Position Dilution of Precision
## Note

## PDF Page 12

HDOP[2] 1.0 Horizontal Dilution of Precision
VDOP[2] 1.5 meters Vertical Dilution of Precision
Checksum *33 Xor check results
<CR><LF> End of message termination
 Satellite used in solution.
 Maximum DOP value reported is 50. When value 50 is reported, the actual DOP may be much
larger.
Table 2.6.1 Mode1
Value Description
M Manual - Forced to operate in 2D or 3D mode
A 2D Automatic - Allowed to automatically switch 2D/3D
Table 2.6.2 Mode2
Value Description
1 Fix not available
2 2D (<4 SVs used)
3 3D (>3 SVs used)
## 3.5 Message ID GSV: GNSS Satellites in View
Example:
$GPGSV,3,1,11,26,68,023,37,15,64,251,33,05,45,058,34,29,33,253,33*75<CR><LF>
$GPGSV,3,2,11,27,32,164,30,21,25,315,29,02,24,140,31,08,19,048,29*70<CR><LF>
$GPGSV,3,3,11,09,16,180,25,18,08,284,27,10,08,085,18*4E<CR><LF>
Name Example Unit Description
Message ID $GPGSV GSV protocol header
Number of Messages [1] 2 Total number of GSV messages to be sent in this
group
Message Number[1] 1 Message number in this group of GSV messages
Satellites in View[1] 11
Satellite ID 26 Channel 1 (Range 1 to 32)
Elevation 68 degrees Channel 1 (Maximum 90)
Azimuth 023 degrees Channel 1 (True, Range 0 to 359)
## Note

## PDF Page 13

SNR (C/N0) 37 dBHz Range 0 to 99, null when not tracking
Satellite ID 29 Channel 4 (Range 1 to 32)
Elevation 33 degrees Channel 4 (Maximum 90)
Azimuth 253 degrees Channel 4 (True, Range 0 to 359)
SNR (C/N0) 33 dBHz Range 0 to 99, null when not tracking
Checksum *75 Xor check results
<CR><LF> End of message termination
 Depending on the number of satellites tracked, multiple messages of GSV data may be required.
In some software versions, the maximum number of satellites reported as visible is limited to 12,
even though more may be visible.
## 3.6 Message ID RMC: Recommended Minimum Specific GNSS Data
Example:
$GPRMC,094330.000,A,3113.3156,N,12121.2686,E,0.51,193.93,171210,,,A*68<CR><LF>
Name Example Unit Description
Message ID $GPRMC RMC protocol header
UTC Time 094330.000 hhmmss.sss
Status [1] A A=data valid or V=data not valid
Latitude 3113.3156 ddmm.mmmm
N/S Indicator N N=north or S=south
Longitude 12121.2686 dddmm.mmmm
E/W Indicator E E=east or W=west
Speed Over Ground 0.51 knots
Course Over Ground 193.93 degrees True
Date 171210 ddmmyy
Magnetic Variation [2] degrees E=east or W=west
East/West Indicator[2] E=east
Mode A A=Autonomous,
D=DGPS
Checksum *68 Xor check results
<CR><LF> End of message termination
## Note
## Note

## PDF Page 14

 A valid status is derived from all the parameters set in the software. This includes the minimum
number of satellites required, any DOP mask setting, presence of DGPS corrections, etc. If the
default or current software setting requires that a factor is met, then if that factor is not met, the
solution will be marked as invalid.
 Does not support magnetic declination. All "course over ground" data are geodetic WGS84
directions relative to true North.
## 3.7 Message ID GSA: GNSS DOP and Active Satellites
Example:
$GPVTG,83.37,T,,M,0.00,N,0.0,K,A*32<CR><LF>
Name Example Unit Description
Message ID $GPVTG VTG protocol header
Course 83.37 degrees Measured heading
- **Reference:** T True
Course degrees Measured heading
- **Reference:** M Magnetic1 [1]
Speed 0.00 knots Measured horizontal speed
Units N Knots
Speed 0.0 km/hr Measured horizontal speed
Units K Kilometers per hour
Mode A A=Autonomous
D=DGPS
Checksum *32 Xor check results
<CR><LF> End of message termination
 Does not support magnetic declination. All "course over ground" data are geodetic WGS84
directions.
## Note

## PDF Page 15

4 GNSS Parser
Parse to get the correct value:
(1) Receive data from the GPS module and put it in our buffer, Data parse when the buffer is full
(2) Get a field that matches each NEMA field, Loop this operation until the buffer data is read
(3) Data parsing is successful, update global variables, and discard if unsuccessful

## PDF Page 16

5 AT Command for GNSS
## 5.1 Start GNSS
the GNSS is self-starting after power on, We can also restart by command:
(1) AT+CGPSCOLD
(2) AT+CGPSHOT
(3) AT+CGPSWARM (Only the A76XX series of ASR1603 and ASR1803 are supported)
COLD start GNSS:
 When first used;
 Loss of ephemeris information due to battery depletion;
 Move the receiver more than 200 km under shutdown.
HOT start GNSS:
 Boot less than two hours from the last location
WARM start GNSS:
 Boot more than two hours from the last location
 AT+CGNSSPWR=1 should be executed to let GNSS module power on firstly.
## 5.2 Get GPS fixed position information
AT+CGPSINFO:
+CGPSINFO:3113.343286,N,12121.234064,E,250311,072809.3,44.1,0.0,0
OK
Name Example Unit Description
lat 3113.343286 Latitude of current position. Output format is
ddmm.mmmmmm.
N/S N N/S Indicator, N=north or S=south.
## Note

## PDF Page 17

log 12121.234064 Longitude of current position. Output format is
dddmm.mmmmmm.
E/W E E/W Indicator, E=east or W=west.
date 250311 Date. Output format is ddmmyy.
UTC time 072809.3 UTC Time. Output format is hhmmss.s.
alt 44.1 MSL Altitude. Unit is meters.
speed 0.0 knots Speed Over Ground. Unit is knots.
course 0 Course. Degrees.
 AT+CGNSSPWR=1 should be executed to let GNSS module power on firstly.
 Location information will output to USB AT port after executing AT+CGPSINFO=<time>, scope of
time is 0-255, unit is second.
 If not fix information or have no signal, will output null data.
## 5.3 Get GNSS fixed position information
AT+CGNSSINFO:
2,09,05,00,3113.330650,N,12121.262554,E,131117,091918.0,32.9,0.0,255.0,1.1,0.8,0.7
OK
Name Example Unit Description
mode 2 Fix mode 2=2D fix 3=3D fix
GPS-SVs 09 GPS satellite valid numbers scope: 00-12
GLONASS-SVs 05 GLONASS satellite valid numbers scope: 00-12
(the A7678 SERIES project is not supported)
BEIDOU-SVs 00 BEIDOU satellite valid numbers scope: 00-12
lat 3113.330650 Latitude of current position. Output format is
ddmm.mmmmmm.
N/S N N/S Indicator, N=north or S=south.
log 12121.262554 Longitude of current position. Output format is
dddmm.mmmmmm.
E/W E E/W Indicator, E=east or W=west.
date 131117 Date. Output format is ddmmyy.
UTC-time 091918.0 UTC Time. Output format is hhmmss.s.
alt 32.9 meters MSL Altitude. Unit is meters.
speed 0.0 knots Speed Over Ground. Unit is knots.
## Note

## PDF Page 18

course 255.0 Course. Degrees.
PDOP 1.1 Position Dilution Of Precision.
HDOP 0.8 Horizontal Dilution Of Precision.
VDOP 0.7 Vertical Dilution Of Precision.
 AT+CGNSSPWR=1 should be executed to let GNSS module power on firstly.
 Location information will output to USB AT port after executing AT+CGNSSINFO=<time>, scope of
time is 0-255, unit is second, 0 means no output.
 If not fix information or have no signal, will output null data.
 The data obtained by AT+CGPSINFO and AT+CGNSSINFO is parsed, executing
##### AT+CGNSSPORTSWITCH can output data to USB AT port or UART port.
 If want to get raw NMEA data by USB NMEA port or UART port, AT+CGNSSPORTSWITCH = 0,0
or AT+CGNSSPORTSWITCH = 0,1 can be implemented.
## Note
