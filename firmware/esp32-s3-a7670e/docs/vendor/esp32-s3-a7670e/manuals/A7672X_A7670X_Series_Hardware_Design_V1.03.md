# A7672X_A7670X_Series_Hardware_Design_V1.03

Source PDF: [A7672X_A7670X_Series_Hardware_Design_V1.03.pdf](./A7672X_A7670X_Series_Hardware_Design_V1.03.pdf)

Total pages: 74

> Auto-generated from the PDF text layer. Layout-heavy pages may lose table, column, and diagram fidelity.

## PDF Page 1

A7672X/A7670X Series
Hardware Design
SIMCom Wireless Solutions Limited
SIMCom Headquarters Building, Building 3, No. 289 Linhong
Road, Changning District, Shanghai P.R. China
Tel: 86-21-31575100
support@simcom.com
www.simcom.com
LTE Module

## PDF Page 2

- **Document Title:** A7672X/A7670X Series Hardware Design
- **Version:** V1.03
- **Date:** 2022-11-02
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
https://www.simcom.com/ask/or email to: support@simcom.com
Copyright © 2021 SIMCom Wireless Solutions Limited All Rights Reserved.

## PDF Page 3

### Version History
Date Version Description of change Author
2021-03-30 1.00 Initial Zhongyou.chen
Xuefeng.liu
2021-09-28 1.01
Add part of description for A7672
Add GNSS_VBKP data consumption
Modified schematic diagrams of two GNSS
recommended wiring schemes
Add the options of AP-Flash software hot start
/GNSS_VBKP hardware hot start
Zhongyou
Chen/Junxi Liu
2021-12-27 1.02 Update recommended footprint
Update Pin assignment overview Zhongyou.chen
2022-11-02 1.03 GNSS_PWRCTL line adds a series 10K resistor Hao.li

## PDF Page 4

### Contents
1 Introduction.............................................................................................................................................. 10
## 1.1 Product Outline......................................................................................................................................... 10
## 1.2 Hardware Interface Overview.................................................................................................................11
## 1.3 Hardware Block Diagram........................................................................................................................ 11
## 1.4 Functional Overview................................................................................................................................ 12
2 Package Information.............................................................................................................................14
## 2.1 Pin Assignment Overview....................................................................................................................... 14
## 2.2 Pin Description..........................................................................................................................................16
## 2.3 Mechanical Information........................................................................................................................... 23
## 2.4 Footprint Recommendation.................................................................................................................... 24
## 2.5 Recommend Stencil Size........................................................................................................................25
3 Interface Application.............................................................................................................................26
## 3.1 Power Supply............................................................................................................................................ 26
### 3.1.1 Power Supply Design Guide.......................................................................................................... 27
### 3.1.2 Recommended Power Supply Circuit.......................................................................................... 28
### 3.1.3 Voltage Monitor................................................................................................................................ 29
## 3.2 Power On/ Off and Reset........................................................................................................................29
### 3.2.1 Power on........................................................................................................................................... 29
### 3.2.2 Power off............................................................................................................................................30
### 3.2.3 Reset Function................................................................................................................................. 32
## 3.3 UART Interface......................................................................................................................................... 33
### 3.3.1 UART Design Guide........................................................................................................................ 33
### 3.3.2 RI and DTR Behavior...................................................................................................................... 34
## 3.4 USB Interface............................................................................................................................................35
### 3.4.1 USB Reference Design...................................................................................................................35
### 3.4.2 USB_BOOT Interface......................................................................................................................36
## 3.5 USIM Interface.......................................................................................................................................... 37
### 3.5.1 SIM Application Guide.....................................................................................................................37
### 3.5.2 Recommend USIM Card Holder................................................................................................... 38
## 3.6 Analog audio interface.............................................................................................................................39
### 3.6.1 Analog audio reference design......................................................................................................39
## 3.7 Matrix keyboard interface........................................................................................................................40
## 3.8 GPIO Interface.......................................................................................................................................... 41
## 3.9 I2C Bus.......................................................................................................................................................41
## 3.10 Network status.......................................................................................................................................... 42
## 3.11 GNSS interface.........................................................................................................................................43

## PDF Page 5

## 3.12 SPI LCD interface.....................................................................................................................................46
## 3.13 SPI camera interface............................................................................................................................... 47
## 3.14 Bluetooth interface................................................................................................................................... 48
## 3.15 Another interface...................................................................................................................................... 48
### 3.15.1 ADC..................................................................................................................................................48
### 3.15.2 LDO..................................................................................................................................................49
4 RF Specifications................................................................................................................................... 50
## 4.1 GSM/LTE Specifications......................................................................................................................... 50
## 4.2 GSM/LTE Antenna Requirements......................................................................................................... 52
## 4.3 GNSS Specifications............................................................................................................................... 52
## 4.4 GNSS Antenna Requirements............................................................................................................... 53
## 4.5 Bluetooth specifications.......................................................................................................................... 53
## 4.6 Antenna Reference Design.................................................................................................................... 54
### 4.6.1 Passive Antenna for GSM/LTE/GNSS/Bluetooth....................................................................... 54
### 4.6.2 Active Antenna for GNSS............................................................................................................... 55
## 4.7 PCB layout.................................................................................................................................................55
5 Electrical Specifications..................................................................................................................... 56
## 5.1 Absolute maximum ratings..................................................................................................................... 56
## 5.2 Operating conditions................................................................................................................................56
## 5.3 Operating Mode........................................................................................................................................ 57
### 5.3.1 Operating Mode Definition..............................................................................................................57
### 5.3.2 Sleep mode....................................................................................................................................... 58
### 5.3.3 Minimum functionality mode and Flight mode............................................................................ 59
## 5.4 Current Consumption...............................................................................................................................59
## 5.5 ESD Notes.................................................................................................................................................60
6 SMT Production Guide.........................................................................................................................61
## 6.1 Top and Bottom View of A7672X/A7670X............................................................................................61
## 6.2 Label Information......................................................................................................................................62
## 6.3 Typical SMT Reflow Profile.....................................................................................................................63
## 6.4 Moisture Sensitivity Level (MSL)........................................................................................................... 64
7 Packaging..................................................................................................................................... 66
8 Appendix....................................................................................................................................... 69
## 8.1 Coding Schemes and Maximum Net Data Rates over Air Interface............................................... 69
## 8.2 Related Documents................................................................................................................................. 70
## 8.3 Terms and Abbreviations.........................................................................................................................72
## 8.4 Safety Caution.......................................................................................................................................... 74

## PDF Page 6

Table Index
Table 1: Module frequency bands.............................................................................................................................. 10
Table 2: General features............................................................................................................................................ 12
Table 3: Pin Description............................................................................................................................................... 15
Table 4: Pin parameter abbreviation..........................................................................................................................16
Table 5: 1.8V IO parameters definition......................................................................................................................17
Table 6: 3.3V IO parameters definition......................................................................................................................17
Table 7: Pin description................................................................................................................................................ 18
Table 8: VBAT pins electronic characteristic............................................................................................................ 26
Table 9: Recommended TVS diode list..................................................................................................................... 27
Table 10: Power on timing and electronic characteristic........................................................................................ 30
Table 11: Power off sequence parameters............................................................................................................... 31
Table 12: RESET pin electronic characteristic......................................................................................................... 32
Table 13: USB_BOOT description..............................................................................................................................36
Table 14: USIM electronic characteristic in 1.8V mode (USIM_VDD=1.8V)...................................................... 37
Table 15: USIM electronic characteristic 3.0V mode (USIM_VDD=3V).............................................................. 37
Table 16: Amphenol USIM socket pin description................................................................................................... 39
Table 17: MIC input ADC parameter list....................................................................................................................39
Table 18: Analog audio Parameter.............................................................................................................................39
Table 19: matrix keyboard PIN description............................................................................................................... 40
Table 20: Standard GPIO Resources of A7672X/A7670X.....................................................................................41
Table 21: 2G mode NETLIGHT pin status................................................................................................................ 43
Table 22: LTE mode NETLIGHT pin status.............................................................................................................. 43
Table 23: GNSS interface description........................................................................................................................ 43
Table 24: LCD interface description...........................................................................................................................46
Table 25: SPI camera interface description..............................................................................................................47
Table 26: General ADC electronic characteristics................................................................................................... 48
Table 27: VBAT_ADC electronic characteristics......................................................................................................48
Table 28: VDD_1V8 Electrical characteristics..........................................................................................................49
Table 29: VDD_2V8 Electrical characteristics..........................................................................................................49
Table 30: Conducted transmission power.................................................................................................................50
Table 31: GSM Operating bands................................................................................................................................ 50
Table 32: E-UTRA operating bands........................................................................................................................... 51
Table 33: Conducted receive sensitivity....................................................................................................................51
Table 34: Reference sensitivity (QPSK)....................................................................................................................51
Table 35: GSM/LTE antenna requirements.............................................................................................................. 52
Table 36: GNSS operating bands...............................................................................................................................52
Table 37: GNSS performance..................................................................................................................................... 53
Table 38: Recommended Antenna Characteristics (GNSS)..................................................................................53

## PDF Page 7

Table 39: Bluetooth performance............................................................................................................................... 53
Table 40: TVS part number list................................................................................................................................... 54
Table 41: Absolute maximum ratings.........................................................................................................................56
Table 42: Recommended operating ratings..............................................................................................................56
Table 43: 1.8V Digital I/O characteristics*................................................................................................................ 56
Table 44: Operating temperature................................................................................................................................57
Table 45: Operating mode Definition......................................................................................................................... 57
Table 46: Current consumption on VBAT Pins (VBAT=3.8V)................................................................................ 59
Table 47: The ESD performance measurement table (Temperature: 25℃, Humidity: 45%.)..........................60
Table 48: The description of label information......................................................................................................... 63
Table 49: Moisture Sensitivity Level and Floor Life.................................................................................................64
Table 50: Tray size........................................................................................................................................................ 66
Table 51: Small Carton size.........................................................................................................................................67
Table 52: Big Carton size.............................................................................................................................................68
Table 53: Coding Schemes and Maximum Net Data Rates over Air Interface...................................................69
Table 54: Related Documents.....................................................................................................................................70
Table 55: Terms and Abbreviations............................................................................................................................ 72
Table 56: Safety Caution..............................................................................................................................................74

## PDF Page 8

Figure Index
Figure 1: A7672X/A7670X block diagram................................................................................................................ 12
Figure 2: Pin assignment overview for A7672X/A7670X....................................................................................... 14
Figure 3: Dimensions (Unit: mm)................................................................................................................................23
Figure 4: Footprint recommendation (Unit: mm)..................................................................................................... 24
Figure 5: Recommend stencil dimension (Unit: mm)..............................................................................................25
Figure 6: VBAT voltage drop during burst emission (EDGE/GPRS)................................................................... 26
Figure 7: Power supply application circuit................................................................................................................ 27
Figure 8: Linear regulator reference circuit.............................................................................................................. 28
Figure 9: power supply reference circuit................................................................................................................... 29
Figure 10: Reference power on/off circuit.................................................................................................................29
Figure 11: Power on timing sequence.......................................................................................................................30
Figure 12: Power off timing sequence.......................................................................................................................31
Figure 13: Reference reset circuit.............................................................................................................................. 32
Figure 14: Serial port connection diagram (full-function mode)............................................................................33
Figure 15: Serial port connection diagram (NULL mode)...................................................................................... 33
Figure 16: Triode level conversion circuit................................................................................................................. 34
Figure 17: RI behaviour (SMS and URC report)..................................................................................................... 34
Figure 18: USB circuit diagram...................................................................................................................................35
Figure 19: Reference USB_BOOT circuit.................................................................................................................36
Figure 20: Force-download port................................................................................................................................. 36
Figure 21: SIM interface reference circuit.................................................................................................................37
Figure 22: SIM interface reference circuit (8PIN).................................................................................................... 38
Figure 23: Amphenol C707 10M006 512 USIM card socket.................................................................................38
Figure 24: Analog audio interface reference circuit................................................................................................ 40
Figure 25: Matrix keyboard interface reference circuit........................................................................................... 41
Figure 26: I2C reference circuit.................................................................................................................................. 42
Figure 27: NETLIGHT reference circuit.....................................................................................................................42
Figure 28: GNSS reference design（Non-standalone GNSS solution）............................................................44
Figure 29: GNSS reference design（standalone GNSS solution）.................................................................... 45
Figure 30: SPI LCD reference design....................................................................................................................... 47
Figure 31: SPI camera reference design.................................................................................................................. 47
Figure 32: VBAT_ADC reference design..................................................................................................................49
Figure 33: Passive antenna reference...................................................................................................................... 54
Figure 34: Active antenna reference..........................................................................................................................55
Figure 35: Reference PCB layout.............................................................................................................................. 55
Figure 36: Top and bottom view of A7672X.............................................................................................................61
Figure 37: Top and bottom view of A7670X.............................................................................................................61
Figure 38: Label information for A7672X.................................................................................................................. 62
Figure 39: Label information for A7670X.................................................................................................................. 63

## PDF Page 9

Figure 40: The ramp-soak-spike reflow profile of A7672X/A7670X..................................................................... 64
Figure 41: packaging diagram.................................................................................................................................... 66
Figure 42: Tray drawing............................................................................................................................................... 66
Figure 43: Small carton drawing.................................................................................................................................67
Figure 44: Big carton drawing..................................................................................................................................... 67

## PDF Page 10

1 Introduction
This document describes the hardware interface of the module, which can help users quickly understand
the interface definition, electrical performance and structure size of the module. Combined with this
document and other application documents, users can understand and use A7672X/A7670X module to
design and develop applications quickly. SIMCom provides a set of evaluation boards to facilitate
A7672X/A7670X module testing and use. The evaluation board tools include an EVB board, a USB cable,
an antenna, and other peripherals.
## 1.1 Product Outline
Aimed at the global market, the module supports GSM, LTE-TDD and LTE-FDD. Users can choose the
module according to the wireless network configuration. The supported radio frequency bands are
described in the following table.
Table 1: Module frequency bands
Standard Frequency A7672S A7672E
## A7670E
## A7672Sa
## A7670Sa
GSM GSM850 
EGSM900   
DCS1800   
PCS1900 
LTE-FDD LTE-FDD B1   
LTE-FDD B2 
LTE-FDD B3   
LTE-FDD B4 
LTE-FDD B5   
LTE-FDD B7  
LTE-FDD B8   
LTE-FDD B20 
LTE-FDD B28 
LTE-FDD B66 
LTE-TDD LTE TDD B34 
LTE TDD B38 
LTE TDD B39 
LTE TDD B40 
LTE TDD B41 
Category CAT1 CAT1 CAT1

## PDF Page 11

GNSS Optional Optional Optional
BlueTooth Optional Optional Optional
With a small physical dimension of 24*24*2.4mm and with the functions integrated, the module can meet
almost any space requirement in users' applications, such as smart phone, PDA, industrial handhold,
machine-to-machine and vehicle application, etc.
A7672X/A7670X provides 124 pins, including 80 LCC pins in the outer ring and 44 LGA pins in the inner
ring. This document will introduce all the functional pins.
## 1.2 Hardware Interface Overview
The interfaces are described in detail in the next chapters include:
● Power Supply
● USB 2.0 Interface
● Three UART Interface, one full function serial port, one ordinary serial port and one debug serial port
● USIM Interface
● General ADC Interface
● VBAT ADC Interface
● 4*4 matrix keyboard
● Analog audio MIC input interface
● Analog audio SPK output interface
● SPI Interface
● LDO Power Output
● I2C Interface
● General input and output interfaces (GPIO)
● SPI LCD Interface
● SPI Camera Interface
● Antenna Interface
● USB_BOOT interface
● Network status indication interface
● Module operation status indication interface
## 1.3 Hardware Block Diagram
The block diagram of the A7672X/A7670X module is shown in the figure below.

## PDF Page 12

Figure 1: A7672X/A7670X block diagram
## 1.4 Functional Overview
Table 2: General features
Feature Implementation
Power supply VBAT: 3.4V ~4.2V, Recommended VBAT: 3.8V
Power saving Current in sleep mode: TBD
Radio frequency bands Please refer to the table 1
Transmitting power
GSM/GPRS power level:
-- GSM850/900: 4 (33dBm±2dB)
-- DCS1800/PCS1900: 1 (30dBm±2dB)
EDGE power level:
-- GSM850/900: E2 (27dBm±3dB)
-- DCS1800/PCS1900: E1 (26dBm+3dB/-4dB)
LTE power level: 3 (23dBm±2.7dB)
Data Transmission
Throughput
GPRS Multiple time slot level 12
EDGE Multiple time slot level 12
TDD/FDD-LTE category 1 : 10 Mbps (DL),5 Mbps (UL)
Antenna
GSM/LTE antenna interface
GNSS antenna interface(optional)
Bluetooth antenna interface(optional)
## Sms
MT, MO, CB, Text, PDU mode
Short Message (SMS)storage device: USIM Card, CB does not
support saving in SIM Card

## PDF Page 13

Module is able to make and receive voice calls, data calls, SMS and make GPRS/LTE traffic in -40℃ ~
+85 ℃ . The performance will be reduced slightly from the 3GPP specifications if the temperature is
outside the normal operating temperature range and still within the extreme operating temperature
range.
Support CS domain and PS domain SMS
USIM interface Support identity card: 1.8V/ 3V
USIM application toolkit Support SAT class 3, GSM 11.14 Release 98
Support USAT
Phonebook management Support phonebook types: SM/FD/ON/AP/SDN
Audio feature Support analog audio interface
UART interface
●Full function serial port
Baud rate support from 300bps to 3686400bps
AT command and data can be sent through serial port
Support RTS/CTS Hardware flow control
Support serial port multiplexing function conforming to GSM 07.10
protocol
●Debug serial port
Support debug usage
●UART3 serial port
Ordinary serial port
## Usb
USB 2.0 compliant, host mode not supported.
This interface can be used for AT command sending, data
transmission, software debugging and upgrading.
Firmware upgrade Firmware upgrade over USB interface
Physical characteristics Size:24*24*2.4m
Weight:2.8±0.1g
Temperature range
Normal operation temperature: -30°C to +80°C
Extended operation temperature: -40°C to +85°C*
Storage temperature -45°C to +90°C
## Note

## PDF Page 14

2 Package Information
## 2.1 Pin Assignment Overview
The following Figure is a high-level view of the pin assignment of the module for A7672X/A7670X.
Figure 2: Pin assignment overview for A7672X/A7670X

## PDF Page 15

Table 3: Pin Description
## Pin No Pin Name Pin No Pin Name
1 PWRKEY 2 GND
3 DTR 4 RI
5 DCD 6 USB_BOOT●
7 CTS 8 RTS
9 TXD 10 RXD
11 SPI_CLK 12 SPI_CS
13 SPI_MOSI 14 SPI_MISO
15 VDD _1V8 16 RESET
17 GND 18 GND
19 GPIO1 20 MK_IN_3
21 MK_OUT_3 22 UART_LOG_RX
23 UART_LOG_TX 24 VBUS
25 ADC 26 GPIO2
27 USB_DP 28 USB_DM
29 GND 30 USIM1_VDD
31 USIM1_DATA 32 USIM1_CLK
33 USIM1_RST 34 USIM1_DET
35 MK_OUT_6/I2C3_SDA 36 MK_IN_6/I2C3_SCL
37 I2C_SDA 38 I2C_SCL
39 GND 40 EAR_P
41 EAR_N 42 MIC_P
43 MIC_N 44 MK_OUT_2
45 GND 46 GND
47 MK_IN_2 48 GPIO3
49 UART3_RXD 50 UART3_TXD
51 VBAT_ADC 52 NETLIGHT
53 GPIO4 54 GND
55 VBAT 56 VBAT
57 VBAT 58 GND
59 GND 60 RF_ANT
61 GND 62 GND
63 GND 64 GND
65 GND 66 STATUS
67 MK_OUT_5 68 MK_IN_5
69 GND 70 GND
71 GND 72 GND
73 GND 74 GND
75 GND 76 GND

## PDF Page 16

77 GND 78 GND
79 GND 80 GND
81 GND 82 GND
83 GND 84 GND
85 GND 86 GND
87 GND 88 GND
89 GND 90 GNSS_ANT
91 GND 92 GND
93 BT_ANT 94 GND
95 GNSS_TXD 96 GNSS_RXD
97 1V8_GNSS 98 GNSS_PWRCTL
99 VDD_2V8 100 1PPS
101 LCD_BL_PWM 102 LCD_SPI_CLK
103 LCD_SPI_TXD 104 LCD_SPI_RXD
105 LCD_SPI_CS 106 LCD_RST
107 LCD_DCX 108 USIM2_DATA
109 USIM2_CLK 110 USIM2_VDD
111 USIM2_RST 112 USIM2_DET
113 NC 114 NC
115 NC 116 GNSS_VBKP
117 CAM_I2C_SDA 118 CAM_I2C_SCL
119 CAM_PWDN 120 CAM_RST
121 CAM_MCLK 122 CAM_SPI_D0
123 CAM_SPI_D1 124 CAM_SPI_CLK
' ● ' Indicates that these Pins cannot be pulled down before the module powered up, otherwise it will
affect the normal start-up of the module.
## 2.2 Pin Description
Table 4: Pin parameter abbreviation
Pin type Description
PI Power input
PO Power output
AI Analog input
AIO Analog input/output
## Note

## PDF Page 17

I/O Bidirectional input /output
DI Digital input
DO Digital output
DOH Digital output with high level
DOL Digital output with low level
PU Pull up
PD Pull down
Table 5: 1.8V IO parameters definition
Power
Domain Parameter Description Min Typ. Max
VIH High level input VCC * 0.7 1.8V VCC + 0.2
VIL Low level input -0.3V 0V VCC *0.3
Rpu Pull up resistor 55KΩ 79 KΩ 121 KΩ
Rpd Pull down resistor 51 KΩ 87 KΩ 169 KΩ
IIL Input leakage
current - - 10uA
VOH Output level range VCC - 0.2 - -
VOL Output low range - - 0.2V
## Iol
Maximum current
driving capacity at
low level output
- - 13mA
## Ioh
Maximum current
driving capacity at
high level output
Vpad=VCC-0.2V
- - 11mA
Table 6: 3.3V IO parameters definition
Power
Domain Parameter Description Min Typ. Max
3.3V
VIH High level input 2V 1.8V VCC + 0.3
VIL Low level input -0.3V 0V 0.8V
Rpu Pull up resistor 26KΩ 47 KΩ 72 KΩ
Rpd Pull down resistor 27 KΩ 54 KΩ 267 KΩ
IIL Input leakage
current - - 10uA
VOH Output level range 2.4V - -
VOL Output low range - - 0.4V
## Iol
Maximum current
driving capacity at
low level output
- - 7mA
## Ioh
Maximum current
driving capacity at
high level output
Vpad=VCC-0.5V
- - 7mA

## PDF Page 18

Table 7: Pin description
Pin name Pin
No.
Pin parameter
Description NotePower
domain Type
Power supply
## Vbat 55,56,
57 - PI
Module input voltage
ranges from 3.4V to 4.2V,
Typical values is 3.8V.
and the peak current
value can reach 2A.
VDD_1V8 15 - PO
1.8V power output, output
current up to 50 mA.
Cannot provide to high
power load, can provide
power for level conversion
circuit, etc.
Can provide 1V8
power supply for
GNSS. If unused,
keep it open.
VDD_2V8 99 - PO Internal 2.8V power
output, output current up
to 50 mA. Cannot
provide to high power
load.
Can provide 2V8
power supply for LCD
VCC_2V8. If unused,
keep it open.
## Gnd
2,17,18,
29,39,
45,46,
54,58,
59,61,
62,63,
64,65,
69,70,
71,72,
73,74,
75,76,
77,78,
79,80,
81,82,
83,84,
85,86,
87,88,
89,91,
92,94
- - Ground
System Control
## Pwrkey 1 - Di,Pu
Power ON/OFF input,
active low.
VIH: 0.7*VBAT
VIL: 0.3*VBAT
PWRKEY has been
internally pulled-up to
VBAT with 50KΩ
resistor, default high.
## Reset 16 - Di,Pu
System reset control
input, active low.
VIH: 0.7*VBAT
VIL: 0.3*VBAT
RESET has been
pulled-up to VBAT
with 50KΩ (typical)
resistor, default high.
USIM interface
USIM1_DATA 31 1.8/3.0V I/O,PU USIM bus data, this pin

## PDF Page 19

has been pull-up with
4.7KΩ resistor to
USIM1_VDD.
USIM1_RST 33 1.8/3.0V I/O,PU USIM bus reset output.
USIM1_CLK 32 1.8/3.0V I/O,PU USIM bus clock output.
USIM1_VDD 30 1.8/3.0V PO
USIM card power supply
output, supports 1.8v/3.0v
output according to the
card type, its output
current is up to 50mA.
USIM1_DET 34 1.8V I/O,PU
USIM insert detect, it can
be set to high/low active
with the AT command,
refer to Document [25]
USIM2_DATA 108 1.8/3.0V I/O,PU USIM bus data, this pin
need pull-up with 4.7KΩ
resistor to USIM2_VDD
externally.
USIM2_RST 111 1.8/3.0V I/O,PU USIM bus reset output.
USIM2_CLK 109 1.8/3.0V I/O,PU USIM bus clock output.
USIM2_VDD 110 1.8/3.0V PO USIM card power supply
output, supports 1.8v/3.0v
output according to the
card type, its output
current is up to 50mA.
USIM2_DET 112 1.8V DI,PD USIM insert detect, it can
be set to high/low active
with the AT command,
refer to Document [25]
USB interface
## Vbus 24 - Ai
Valid USB detection input.
Active high,
Vmax(valid)=3.0V,
Vmax(detection)=5.2V
USB_DM 28 - I/O
Negative line of the
differential, bi-directional
USB signal.
USB_DP 27 - I/O
Positive line of the
differential, bi-directional
USB signal.
Full function UART interface
RTS 8 1.8V DI RTS input
If unused, keep it
open.
CTS 7 1.8V DO CTS output
RXD 10 1.8V DI Data input
TXD 9 1.8V DOH Data output
RI 4 1.8V DO Ringing indicator
DCD 5 1.8V DO Carrier detection
DTR 3 1.8V DI DTE Ready
Debug UART
UART_LOG_TX
D 23 1.8V DOH Log output Default used as

## PDF Page 20

debug port.UART_LOG_RX
D 22 1.8V DI Log input
Serial Port UART3
UART3_TXD 50 1.8V DOH Log output
Two-wire serial port
UART3_RXD 49 1.8V DI Log input
I2C interface
I2C_SCL 38 1.8V DO I2C clock output If unused, keep it
open. Need pull up to
VDD_1V8 externally.I2C_SDA 37 1.8V I/O I2C data I/O
SPI interface
SPI_CLK 11 1.8V I/O,PD SPI clock
If unused, keep it
open.
SPI_CS 12 1.8V I/O,PD SPI chip selection
SPI_MOSI 13 1.8V DO,PD SPI Main output slave input
SPI_MISO 14 1.8V DI,PD SPI Main input slave output
Analog audio interface
EAR_P 40 1.8V AIO Earphone output positive
If unused, keep it
open.
EAR_N 41 1.8V AIO Earphone output negative
MIC_P 42 1.8V AIO MIC input positive
MIC_N 43 1.8V AIO MIC input negative
## Gpio
GPIO1 19 1.8V IO,PU General purple I/O If unused, keep it
open.
GPIO2 26 1.8V IO,PD General purple I/O If unused, keep it
open.
GPIO3 48 1.8V IO,PD General purple I/O If unused, keep it
open.
GPIO4 53 1.8V IO,PU General purple I/O If unused, keep it
open.
GNSS Interface
GNSS_PWRCT
L
98 1.8V DI The enable control PIN of
GNSS power supply. Active high.
1V8_GNSS 97 - PI
The power input for GNSS,
the input voltage must not
be less than 1.8V.
Module VDD_1V8
(PIN 15) can be used
for this power supply
GNSS_VBKP 116 - PI GNSS VRTC power input,
input voltage 1.4V~3.6V
If unused, keep it
open.
1PPS 100 1.8V DO 1PPS signal output If unused, keep it
open.
GNSS_RXD 96 1.8V DI GNSS UART RX
Connect to MCU
UART_TX;
Or use 1K resistors in
series in module

## PDF Page 21

UART3_TX (pin 50).
GNSS_TXD 95 1.8V DO GNSS UART TX
Connect to MCU
UART_RX;
Or use 1K resistors in
series in module
UART3_RX (pin 49).
SPI LCD Interface
LCD_BL_PWM 101 1.8V DO LCD backlight adjusting
## Pwm
If unused, keep it
open.
LCD_SPI_CLK 102 1.8V DO SPI clock
LCD_SPI_TXD 103 1.8V DI，DO SPI DATA(Bidirectional)
LCD_SPI_RXD 104 1.8V DI SPI DATA
LCD_SPI_CS 105 1.8V DO SPI CS
LCD_RST 106 1.8V DO LCD Reset
LCD_DCX 107 1.8V DO Command/parameter
selection
SPI CAMERA Interface
CAM_I2C_SDA 117 1.8V DI, DO Camera I2C data
If unused, keep it
open.
CAM_I2C_SCL 118 1.8V DO Camera I2C clock
CAM_PWDN 119 1.8V DO Camera power down
CAM_RST 120 1.8V DO Camera reset
CAM_MCLK 121 1.8V DO Camera main clock
CAM_SPI_D0 122 1.8V DI Camera SPI D0
CAM_SPI_D1 123 1.8V DI Camera SPI D1
CAM_SPI_CLK 124 1.8V DO Camera SPI clock
ANT interface
RF_ANT 60 - AIO Main antenna
GNSS_ANT 90 - AIO GNSS antenna
BT_ANT 93 - AIO Bluetooth antenna
Keyboard interface
MK_IN2 47 1.8V DI Keyboard input If unused, keep it
MK_IN3 20 1.8V DI Keyboard input If unused, keep it
MK_IN5 68 1.8V DI Keyboard input If unused, keep it
MK_IN6 36 1.8V DI Keyboard input If unused, keep it
MK_OUT2 44 1.8V DO Keyboard output If unused, keep it
MK_OUT3 21 1.8V DO Keyboard output If unused, keep it
MK_OUT5 67 1.8V DO Keyboard output If unused, keep it
MK_OUT6 35 1.8V DO Keyboard output If unused, keep it
Other pins
ADC 25 - AI General Purpose ADC If unused, keep it

## PDF Page 22

Please reserve a test point for USB_BOOT, VDD_EXT and UART_LOG_TX. If there is no USB
connector, please also reserve a test point for USB_VBUS, USB_DP, and USB_DM for Firmware
upgrade.
open.
VBAT_ADC 51 - AI VBAT ADC If unused, keep it
open.
NETLIGHT 52 1.8V DO
Network registration status
indicator (LED).
For more detail, please
refer the chapter 3.12.
STATUS 66 1.8V DO Module status indicator
(LED).
USB_BOOT 6 1.8V DI
Firmware download guide
control input. when pull-up
to GND and press
PWRKEY,module will
access in USB download
mode.
Do place 2 test points
for debug.
Do not pull down
USB_BOOT during
normal power up !
## Note

## PDF Page 23

## 2.3 Mechanical Information
The following figure shows the package outline drawing of A7672X/A7670X.
Figure 3: Dimensions (Unit: mm)
The side length dimension is 24.00±0.15mm excluding the burr area.
## Note

## PDF Page 24

## 2.4 Footprint Recommendation
Figure 4: Footprint recommendation (Unit: mm)

## PDF Page 25

## 2.5 Recommend Stencil Size
Recommend stencil thickness≥0.12mm and <0.15mm.
Figure 5: Recommend stencil dimension (Unit: mm)

## PDF Page 26

3 Interface Application
## 3.1 Power Supply
A7672X/A7670X offers 3 power supply pins (55, 56, 57) as VBAT power input pin. A7672X/A7670X use
these three pins supply the internal RF and baseband circuit.
When the module is at the maximum power in GSM TX mode, the peak current can reach 2A (peak
current), which results in a large voltage drop on Vbat. In order to ensure that the voltage drop is less than
300mV, the power supply capacity of external power supply must be no less than 2A.
Figure 6: VBAT voltage drop during burst emission (EDGE/GPRS)
Test condition: VBAT power supply 3.8V, the module is tested on EVB board, and the power input has a
330UF tantalum capacitor.
Table 8: VBAT pins electronic characteristic
Parameter Description Min Typ. Max Unit
VBAT Module supply voltage 3.4 3.8 4.2 V
IVBAT (peak) Module consumption peak current - 2 - A
## Ivbat
(average)
Module average consumption current (normal
mode) Refer to Table 46
IVBAT (sleep) Module average consumption current (sleep
mode)
## Ivbat
(power-off)
Module average consumption current (off leakage
current) - 20 - uA
## Note

## PDF Page 27

### 3.1.1 Power Supply Design Guide
In the user's design, special attention must be paid to the design of the power supply. If the voltage drops
below 3.4V, the RF performance of the module will be affected, the module will shut down if the voltage is
too low. It is recommended to select an LDO or DC-DC chip with an enable pin, and the enable pin is
controlled by the MCU.
When the power supply can provide a peak current of 2A, the total capacity of the external power
supply capacitance is recommended to be no less than 300uf. If the peak current of 2A cannot be
provided, the total capacity of the external capacitance is recommended to be no less than 600uf to
ensure that the voltage drop on the Vbat pin at any time is not more than 300mV.
It is recommended to place four 33PF/10PF/0.1UF/1UF ceramic capacitors near Vbat to improve RF
performance and system stability. At the same time, it is recommended that the Vbat layout routing width
from the power supply on the PCB to the module be at least 3mm. Reference design recommendations are
as follows:
If the Vbat input contains high-frequency interference, it is recommended to add magnetic beads for filtering.
The recommended types of magnetic beads are BLM21PG300SN1D and MPZ2012S221A.
Figure 7: Power supply application circuit
In addition, in order to prevent the damage of A7672X/A7670X caused by surge and overvoltage, it is
recommended to parallel one TVS on the Vbat pin of the module.
Table 9: Recommended TVS diode list
No. Manufacturer Part Number VRWM Package
1 JCET ESDBW5V0A1 5V DFN1006-2L
## Note

## PDF Page 28

When selecting TVS by customer, it is necessary to pay attention to the clamping voltage in the case of
surge protection. The clamping voltage should not be higher than 10V when 100V surge input.
### 3.1.2 Recommended Power Supply Circuit
The MCU must have the function to power off the module, but the module cannot be shut down or restarted
normally. Only when the module is abnormal and cannot be shut down or restarted normally can the module
be powered off. When the input power is greater than 9V, the DCDC chip is recommended. When the input
is less than 9V, it is recommended to use LDO power supply. If you use the module's OPEN LINUX
secondary development function, because there is no MCU, you can add a low-cost single-chip
microcomputer to play the role of hardware watchdog to pull POWERKEY to boot and can be powered off.
It is recommended that a switching mode power supply or a linear regulator power supply is used. The
following figure shows the linear regulator reference circuit:
Figure 8: Linear regulator reference circuit
The following figure shows the DC-DC regulator reference circuit:
2 WAYON WS05DPF-B 5V DFN1006-2L
3 WILL ESD5611N 5V DFN1006-2L
4 WILL ESD56151W05 5V SOD-323
## Note

## PDF Page 29

Figure 9: power supply reference circuit
### 3.1.3 Voltage Monitor
AT command 'AT+CBC' can be used to monitor VBAT voltage.
AT command 'AT+CVALARM' can be used to set high/low voltage alarm, When the actual voltage
exceeds the preset range, a warning message will be reported through the AT port.
AT command 'AT+CPMVT' can be used to set high/low voltage power off, When the actual voltage
exceeds the preset range, the module will shut down automatically.
Voltage monitor function under debugging, Overvoltage alarm and overvoltage shutdown are off by
default. For details of at commands, please refer to document [1].
## 3.2 Power On/ Off and Reset
### 3.2.1 Power on
Customer can power on the module by pulling down the PWRKEY pin. This pin has been pulled up inside
the module to Vbat.
It is recommended that when using the module, adding TVS diode at the module pin can effectively
enhance the ESD performance.
The recommended circuit is as follows:
Figure 10: Reference power on/off circuit
## Note

## PDF Page 30

Do not parallel capacitors which the value is exceed 100nF on PWRKEY or RESET pin. It will cause
module power on automatically when VBAT powered.
It is forbidden to pull down both RESET key and PWRKEY to power on the module at the same time.
Figure 11: Power on timing sequence
Table 10: Power on timing and electronic characteristic
Symbol Parameter Min. Typ. Max. Unit
Ton The time of active low-level impulse of PWRKEY pin
to power on module - 50 - ms
Ton(status) The time from power-on issue to STATUS pin output
high level (indicating power up ready) - 7 - s
Ton(uart) The time from power-on issue to UART port ready - 8 - s
Ton(usb) The time from power-on issue to USB port ready - 9 - s
VIH Input high level voltage on PWRKEY pin 0.7*
## Vabt - Vbat V
VIL Input low level voltage on PWRKEY pin 0 0 0.3*
## Vbat V
### 3.2.2 Power off
A7672X/A7670X has the following shutdown methods:
● Power off by pulling the PWRKEY# pin down to a low level.
● Power off Module by AT command 'AT+CPOF'.
● Over-voltage or under-voltage automatic power off.
● Over-temperature or under-temperature automatic power off.
It is strongly recommended that the customer use PWRKEY or 'AT+CPOF' to shut down, and then power off
## Note

## PDF Page 31

Vbat (especially when the module does not need to work). In addition, the customer cannot shut down Vbat
by disconnecting it, which may cause damage to flash.
when the temperature exceeds the range of - 30 ~ + 80 ℃ , A7672X/A7670X will report warning
information through AT port. When the temperature exceeds the range of - 40 ~ + 85 ℃ ,
A7672X/A7670X will shut down automatically. For a detailed description of 'AT+ CPOF' and 'AT+
CPMVT', please refer to document [1].
PWRKEY can be used to power off the module, power off sequence see the following figure:
Figure 12: Power off timing sequence
Table 11: Power off sequence parameters
The status pin can be used to judge whether the module is powered on or not. When the module is
Symbol Parameter Min. Typ. Max. Unit
Toff Power off low level pulse width 2.5 - - s
Toff(status) Power off time (according to status
interface) - 2 - s
Toff(uart) Power off time (according to UART
interface) - 2 - s
Toff(usb) Power off time (according to USB
interface) - 2 - s
Toff-on Power off - power on buffer time 2 - - s
## Note
## Note

## PDF Page 32

powered on and initialization is completed, the status outputs a high level, otherwise the low level will
be maintained all the time.
### 3.2.3 Reset Function
A7672X/A7670X can restart the module by pulling down the reset pin of the module. Reset pin also has
the function of power on when PMU first time be given a valid supply voltage (active low, but this key has
no shutdown function). After first time power on, some register of this pin will be written then it will lose this
function, so it is recommended to use PWRKEY to power on the module and RESET key only used as
reset function.
A 50K Ω resistor is used to pull-up to VBAT inside the module, so it is no need to add pull-up resistor
outside. The recommended circuit is showed as follows:
Figure 13: Reference reset circuit
Table 12: RESET pin electronic characteristic
Symbol Description Min. Typ. Max. Unit
Treset The active low level time impulse on RESET pin to
reset module 2 2.5 - S
VIH Input high level voltage 0.7*
## Vbat - Vbat V
VIL Input low level voltage 0 0 0.3*
## Vbat V
It is recommended to use the reset pin only in case of emergency, such as the module is not
responding. The reset time is recommended to be 2.5s.
## Note

## PDF Page 33

## 3.3 UART Interface
A7672X/A7670X provides three serial ports, the main communication serial port is UART, one ordinary
serial port, and the UART_LOG dedicate to printing log.
### 3.3.1 UART Design Guide
When using uses full-function serial port, please refer to the following connection mode:
Figure 14: Serial port connection diagram (full-function mode)
When using 2-wire serial port, please refer to the following connection mode:
Figure 15: Serial port connection diagram (NULL mode)
The following figure shows the use of triode for level shifter circuits. The circuit with dotted line can refer to
the circuit with solid line TXD and RXD, and attention shall be paid to the direction of signal.
The recommended triode model is MMBT3904.

## PDF Page 34

Figure 16: Triode level conversion circuit
1. Main UART supports the following baud rates: 300, 600, 1200, 2400, 4800, 9600, 19200, 38400,
57600, 115200, 230400, 460800, 921600, 1842000, 3686400. The default baud rate is 115200bps.
2. The maximum baud rate supported by A7672X/A7670X ordinary serial port is 921600.
3. The parasitic capacitance of the transistor will affect the edge of the high-speed digital signal. It is
not recommended to use this circuit when the signal speed is higher than 115200bps.
### 3.3.2 RI and DTR Behavior
RI usually keeps high level output. When receiving a short message or URC report, RI outputs a low level
for 120ms (short message)/60ms (URC), and then returns to a high-level state; RI will output a low level,
when receiving a phone call as the called party. After outputting low level, RI will remain low until the host
accepts the call using the "ATA" command or the caller stops calling RI, in the end, it will become high level.
Figure 17: RI behaviour (SMS and URC report)
After setting the AT command "AT+CSCLK=1", and then pulling up the DTR pin, Module will enter sleep
## Note

## PDF Page 35

mode when module is in idle mode. In sleep mode, the UART is unavailable. When A7672X/ enters sleep
mode, pulling down DTR can wakeup module.
After setting the AT command "AT+CSCLK=0", A7672X/A7670X Series will do nothing when the DTR pin is
pulling up.
## 3.4 USB Interface
The A7672X/7670X contains a USB interface compliant with the USB2.0 specification as a peripheral, but
does not support USB charging function and does not support USB HOST mode.
USB is the main debugging port and software upgrade interface. It is recommended that customers reserve
USB test points during design. If a main control chip is connected, 0R resistors must be reserved for
switching external test points during design, as shown in the figure below.
### 3.4.1 USB Reference Design
A7672X/7670X can be used as a USB slave device. The recommended connection circuit diagram is as
follows:
Figure 18: USB circuit diagram
Because of the high bit rate on USB bus, more attention should be paid to the influence of the junction
capacitance of the ESD component on USB data lines. On USB_VBUS line, customers should pay
attention to the selection of the D3 device when using it. It is recommended to choose an anti-static and
anti-surge two-in-one device.
1. The USB data cable must be strictly routed in 90Ω +/- 10% differential. The TVS devices D1 and D2
on the data line must be selected with equivalent capacitance less than 1pF. The TVS device should be
placed near the USB connector or test point, recommended models ESD73011N and WS05DUCFM.
## Note

## PDF Page 36

2. The detection of USB2.0 speed is determined automatically by the USB protocol. The customer does
not need to pull up the DP external, otherwise it may affect the device USB enumeration.
### 3.4.2 USB_BOOT Interface
A7672X/7670X provides one forced download boot interface 'USB_BOOT'.
Table 13: USB_BOOT description
If the module upgrade fails to boot, you can force upgrade through the USB_BOOT port.
Before the module is powered on, pull the USB_BOOT pin to GND, then apply VBAT power to the module,
and press RESET to enter the download mode. After entering the download mode, you need to release
USB_BOOT and remove the pull-up.
Figure 19: Reference USB_BOOT circuit
Customers will see the download port in the device manager port of the windows system.
Figure 20: Force-download port
USB_BOOT only has the function of forcing download and booting before booting (it cannot be pulled
down).
Pin
number Pin name I/O Description Power
domain
Default
state Remark
6 USB_BOOT DI Force downloads
boot port 1.8V B-PU
## Note

## PDF Page 37

## 3.5 USIM Interface
A7672X/A7670X supports both 1.8V and 3.0V USIM Cards. The interface power of the USIM card is
provided by the voltage regulator inside the module, and the normal voltage value is 3V or 1.8V.
Table 14: USIM electronic characteristic in 1.8V mode (USIM_VDD=1.8V)
Table 15: USIM electronic characteristic 3.0V mode (USIM_VDD=3V)
### 3.5.1 SIM Application Guide
It is recommended to use an ESD protection component such as ESDA6V1W5 produced by ST
(www.st.com) or SMF15C produced by ON SEMI (www.onsemi.com). Note that the USIM peripheral
circuit should be close to the USIM card socket. The following figure shows the 6-pin SIM card holder
reference circuit.
The following figure shows the 6-pin SIM card holder reference circuit.
Figure 21: SIM interface reference circuit
Symbol Parameter Min. Typ. Max. Unit
USIM_VDD LDO power output voltage 1.62 1.8 1.98 V
VIH High-level input voltage 0.7*USIM_VDD - USIM_VDD +0.4 V
VIL Low-level input voltage -0.4 0 0.25*USIM_VDD V
VOH High-level output voltage USIM_VDD -0.4 - USIM_VDD V
VOL Low-level output voltage 0 0 0.2 V
Symbol Parameter Min. Typ. Max. Unit
USIM_VDD LDO power output voltage 2.7 3 3.3 V
VIH High-level input voltage 0.7*USIM_VDD - USIM_VDD +0.4 V
VIL Low-level input voltage -0.4 0 0.25*USIM_VDD V
VOH High-level output voltage USIM_VDD -0.45 - USIM_VDD V
VOL Low-level output voltage 0 0 0.3 V

## PDF Page 38

Figure 22: SIM interface reference circuit (8PIN)
1. USIM1_DATA has been pulled up with a 4.7KΩ resistor to USIM1_VDD in module. A 100nF
capacitor on USIM_VDD is used to reduce interference. For more details of AT commands about
USIM, please refer to document [1].
2. USIM2_DATA has no pull resistor, need to add 4.7KΩ resistor pulled up to USIM2_VDD externally.
### 3.5.2 Recommend USIM Card Holder
It is recommended to use the 6-pin USIM socket such as C707 10M006 512 produced by Amphenol. User
can visit http://www.amphenol.com for more information about the holder.
Figure 23: Amphenol C707 10M006 512 USIM card socket
## Note

## PDF Page 39

Table 16: Amphenol USIM socket pin description
## 3.6 Analog audio interface
A7672X/7670X modules integrate audio codec and audio front end, provide 1 channel of analog audio MIC
input interface and 1 channel of analog audio SPK output interface, customers can connect to the external
phone handle for voice calls.
ADC: 90dB SNR@20~20kHz
DAC: 95dB SNR@20~20kHz
(Class-AB): THD<-85dB@32-ohm
Table 17: MIC input ADC parameter list
Parameter MIN Type MAX Unit
Clock frequency - 6.144 - MHz
Table 18: Analog audio Parameter
### 3.6.1 Analog audio reference design
The analog audio recommendation circuit is as follows:
Pin Signal Description
C1 USIM_VDD USIM Card Power supply.
C2 USIM_RST USIM Card Reset.
C3 USIM_CLK USIM Card Clock.
C5 GND Connect to GND.
## C6 Vpp Nc
C7 USIM_DATA USIM Card data I/O.
Parameter 条件 DR（Type.） THD+N（Type.） MAX Power
DAC RL=10K 101dBA -96dB(@vout
-2dBv) 1.59Vp
Class-AB Mono,32Ω
Difference 100dBA -90dB(0.00316%)
(@20mW output) 37mW

## PDF Page 40

Figure 24: Analog audio interface reference circuit
## 3.7 Matrix keyboard interface
A7672X/7670X provides a 4*4 matrix keyboard interface.
Table 19: matrix keyboard PIN description
PIN Name PIN NO. I/O Description Note
MK_IN2 47 DI Matrix keyboard input If unused, keep it open.
MK_IN3 20 DI
MK_IN5 68 DI
MK_IN6 36 DI
MK_OUT2 44 DO Matrix keyboard output If unused, keep it open.
MK_OUT3 21 DO
MK_OUT5 67 DO
MK_OUT6 35 DO
The matrix keyboard interface recommendation circuit is as follows:

## PDF Page 41

Figure 25: Matrix keyboard interface reference circuit
## 3.8 GPIO Interface
A7672X/A7670X module provides multiple GPIOs.
Table 20: Standard GPIO Resources of A7672X/A7670X
## 3.9 I2C Bus
The module provides two sets of I2C interfaces, support standard speed clock frequency 100Kbps, support
high speed clock frequency 400Kbps, its operation voltage is 1.8V.
Pin No. Pin
name
AT command
operation GPIO
number
Pin
typ.
Power
domain
Default
function
Pad
Edge
wakeup
19 GPIO1 GPIO1 IO 1.8V PU Yes
26 GPIO2 GPIO2 IO 1.8V PD Yes
48 GPIO3 GPIO3 IO 1.8V PD No
53 GPIO4 GPIO4 IO 1.8V PU Yes

## PDF Page 42

Figure 26: I2C reference circuit
SCL and SDA have no pull-up resistor inside, external resistor is needed and the pulled power source
must be VDD_1V8 output from the module.
## 3.10 Network status
The NETLIGHT pin is used to control Network Status LED, its reference circuit is shown in the following
figure.
Figure 27: NETLIGHT reference circuit
## Note

## PDF Page 43

The value of the resistor named "R" depends on the LED characteristic.
The NETLIGHT signal is used to control the LED lights that indicate the status of the network. The working
status of this pin is shown in the table below.
Table 21: 2G mode NETLIGHT pin status
Table 22: LTE mode NETLIGHT pin status
## 3.11 GNSS interface
A7672X/A7670X support GNSS function interface. GNSS provides 2 power supply input interfaces, 1
GNSS power enable control switch, 1 UART interface and 1 pulse synchronous clock signal interface,
which are described in detail as follows.
Table 23: GNSS interface description
PIN Name PIN
NO I/O Description Note
GNSS_VBKP 116 PI GNSS backup power input
Power supply ranges from 1.4V
to 3.6V. If you need to use hot
start when the module is shut
down, you are advised to use an
external normal power supply.
1V8_GNSS 97 PI GNSS Vcore、VDDIO input
The power supply voltage must
be no less than 1.8V and no
more than 1.9V. The cable must
be as short as possible, with a
cable width of more than 0.3mm.
GNSS_PWRCTL 98 DI
GNSS Vcore 、 VDDIO power
enable control
Active high。
Solution 1：Use 10K resistor to
NETLIGHT pin status Module status
Always On Searching Network
200ms ON, 200ms OFF Data Transmit
800ms ON, 800ms OFF Registered network
OFF Power off / Sleep
NETLIGHT pin status Module status
Always On Searching Network
200ms ON, 200ms OFF Data Transmit/Registered
OFF Power off / Sleep
## Note

## PDF Page 44

Connect to GPIO，recommend
use MK_IN_3(PIN20)。
Solution 2：Use 10K resistor to
Connect to MCU GPIO。
GNSS_RXD 96 DI GNSS UART RX
1.8V power domain。
Solution 1：Use 1K resistor to
connect UART3_TXD（PIN50）
of the module in series。
Solution2: Use 1K resistor to
Connect to MCU UART_TX。
GPS_TXD 95 DO GNSS UART TX
1.8V power domain。
Solution 1：Use 1K resistor to
connect UART3_RXD（PIN49）
of the module in series。
Solution2 ： Use 1K resistor to
Connect to MCU UART_RX
1PPS 100 DO GNSS pulse synchronous
clock signal If unused, keep it open.
GNSS recommended reference design solution 1:
A7672X/A7670X module itself provides power, power enable and UART transmission to GNSS, the
recommended reference design as follow:
Figure 28: GNSS reference design（Non-standalone GNSS solution）
GNSS recommended reference design solution 2:
The external MCU provides power, power enable and UART transmission to GNSS, this solution is used for
scenarios where GNSS can work standalone without the module powering up. The recommended
reference design as follow:

## PDF Page 45

Figure 29: GNSS reference design（standalone GNSS solution）
1. Please series in 1K resistors for serial communication lines with non-standalone GNSS solution to
prevent leakage current to the serial ports of GNSS chip.
2. The standalone GNSS reference design is only applicable to 1.8V power domain MCU. If the MCU
is not 1.8V power domain, a level shift circuit should be added.
3. The Vcore power for GNSS 1V8_GNSS has higher requirements for power supply, PCB routing
should as short as possible, and the routing width is required to be at least 0.3mm
4. In some condition, it may be necessary to send dynamic loading code to GNSS chip through serial
port. If having dynamic loading requirement, it is recommended to use reference design solution
1(non-standalone GNSS solution). Customers should let MCU realize the dynamic loading process
by yourself if used reference design solution 2(standalone GNSS solution).
5. GNSS_VBKP power supply input is a necessary condition for hardware hot start, which can ensure
the performance index of GNSS hot start to reach the optimal state, but when 1.8V input, the typical
current consumption value is 1mA; Customers can choose the software AP-Flash hot start scheme,
GNSS_VBKP can remain suspended; Compared with GNSS_VBKP hardware hot boot, AP-Flash
has lower performance indicators.
6. The principle of the hot startup of AP-Flash software is that GNSS will download the located
ephemeris data to the internal FLASH of the module before the module shutdown . GNSS will
download the relevant ephemeris data of the last location to achieve rapid positioning when it is
powered on next time. Detailed usage method reference document [1].
7. Make sure to connect a 10K resistor to the GNSS_PWRCTL pin in series and then to the external
enable signal.
## Note

## PDF Page 46

## 3.12 SPI LCD interface
A7672X/A7670X module provides a set of SPI LCD interface, which only supports LCD module of 1 data
line. The LCD interface of the module does not have specified LCD_TE signal pin. If necessary, you can
choose GPIO to simulate the use of LCD_TE signal. It is recommended to use module pin 44 (MK_OUT_2)
as the LCD_TE signal.
It is recommended to reserve decoupling capacitor on the power supply for LCD, and reserve 0 Ω resistor in
series for debugging. At the same time, 0 Ω in series is reserved on the data line to facilitate the adjustment
of signal quality and prevent signal reflection, overshoot.
Table 24: LCD interface description
PIN Name PIN NO I/O Description Note
LCD_BL_PWM 101 DO LCD backlight PWM signal
LCD_SPI_CLK 102 DO SPI clock
LCD_SPI_TXD 103 DO, DI SPI data (Bidirectional)
LCD_SPI_RXD 104 DI SPI data
LCD_SPI_CS 105 DO SPI CS
LCD_RST 106 DO LCD reset
LCD_DCX 107 DO LCD command/parameter
selection
The recommended reference design of SPI LCD as follow:

## PDF Page 47

Figure 30: SPI LCD reference design
## 3.13 SPI camera interface
A7672X/A7670X only supports SPI camera interface, supports up to 0.3MP pixel encoding, does not
support video mode.
Table 25: SPI camera interface description
PIN Name PIN NO I/O Description Note
CAM_I2C_SDA 117 DI, DO CAM I2C data
CAM_I2C_SCL 118 DO CAM I2C clock
CAM_PWDN 119 DO CAM power down
CAM_RST 120 DO CAM reset
CAM_MCLK 121 DO CAM main clock
CAM_SPI_D0 122 DI CAM SPI DATA 0
CAM_SPI_D1 123 DI CAM SPI DATA 1
CAM_SPI_CLK 124 DO CAM SPI clock
The recommended reference design of SPI camera as follow:
Figure 31: SPI camera reference design

## PDF Page 48

## 3.14 Bluetooth interface
A7672X/A7670X module has integrated Bluetooth function inside, and only one BT antenna is left on the
module interface. A7672X/A7670X Support BT5.0 protocol specification, compatible with BLE low power
mode and traditional BT mode; It only supports Bluetooth data transmission and does not support
VoiceOverPCM & VoHCI.
## 3.15 Another interface
### 3.15.1 ADC
A7672X/A7670X have 1 general ADC and 1 dedicated VBAT_ADC pins.
For A7672X/A7670X GPADC, the input voltage range is 0~1.8V, It is recommended to connect the analog
interface directly for analog-to-digital conversion, and do not perform partial pressure externally. If the
partial pressure must be performed externally, the resistance value of the partial pressure resistance should
not be too large, and it is recommended not to exceed 10K. At the same time, when selecting resistance,
the amplification factor should not be too large, it is recommended not to exceed 30 times. Otherwise, the
ADC read value may be offset.
For A7672X/A7670X VBAT_ADC, the VBAT voltage range is 0~4.2V and the VBAT_ADC is used to read
the battery voltage by default. The hardware design of the VBAT_ADC must use 680K_1% and 470K_1%
resistors for voltage division.
Its electrical characteristics are as follows:
Table 26: General ADC electronic characteristics
Characteristics Min. Typ. Max. Unit
Resolution - 9 - Bits
Input Range 0 - 1.8 V
Table 27: VBAT_ADC electronic characteristics
Characteristics Min. Typ. Max. Unit
Resolution - 9 - Bits
Input Range 0 - 1.8 V
"AT+CADC=2" can be used to read the voltage of the ADC pin.
Use "AT+CBC" to read the voltage value of VBAT (0-4.2V). Note that it is not the voltage value on the
VBAT_ADC pins. Design should be carried out strictly according to VBAT_ADC reference schematic
diagram.
For more details, please refer to document [1].
## Note

## PDF Page 49

The recommended reference design of VBAT_ADC as follow:
Figure 32: VBAT_ADC reference design
### 3.15.2 LDO
A7672X/A7670X has 2 LDO outputs：VDD_1V8 and VDD_2V8.
VDD_1V8 is the module's system IO power supply, which can only provide a current capacity of 50mA. It
cannot be used as a high current drive source. It can be used as a power supply for module 1V8_GNSS
（PIN97）.
VDD_2V8 is the module 2.8V LDO power output, which can only provide a current capacity of 50mA. It
cannot be used as a high current drive source. It can be used as a power supply for LCD VCC_2V8.
Table 28: VDD_1V8 Electrical characteristics
Symbol Description Min. Typ. Max. Unit
VDD_1V8 Output voltage - 1.8 - V
IO Output current - - 50 mA
Table 29: VDD_2V8 Electrical characteristics
Symbol Description Min. Typ. Max. Unit
VDD_2V8 Output voltage - 2.8 - V
IO Output current - - 50 mA
VDD_1V8 is the system power supply. If the damage will affect the system startup, it is recommended
that customers add TVS protection. The recommended model is ESD56051N.
## Note

## PDF Page 50

4 RF Specifications
## 4.1 GSM/LTE Specifications
Table 30: Conducted transmission power
Frequency Power Min.
GSM850(GMSK) 33dBm ±2dB 5dBm ± 5dB
EGSM900(GMSK) 33dBm ±2dB 5dBm ± 5dB
DCS1800(GMSK) 30dBm ±2dB 0dBm ± 5dB
PCS1900(GMSK) 30dBm ±2dB 0dBm ± 5dB
GSM850 (8-PSK) 27dBm ±3dB 5dBm ± 5dB
EGSM900 (8-PSK) 27dBm ±3dB 5dBm ± 5dB
DCS1800 (8-PSK) 26dBm +3/-4dB 0dBm ±5dB
PCS1900 (8-PSK) 26dBm +3/-4dB 0dBm ±5dB
LTE-FDD B1 23dBm +/-2.7dB <-40dBm
LTE-FDD B2 23dBm +/-2.7dB <-40dBm
LTE-FDD B3 23dBm +/-2.7dB <-40dBm
LTE-FDD B4 23dBm +/-2.7dB <-40dBm
LTE-FDD B5 23dBm +/-2.7dB <-40dBm
LTE-FDD B7 23dBm +/-2.7dB <-40dBm
LTE-FDD B8 23dBm +/-2.7dB <-40dBm
LTE-FDD B20 23dBm +/-2.7dB <-40dBm
LTE-FDD B28 23dBm +/-2.7dB <-40dBm
LTE-FDD B66 23dBm +/-2.7dB <-40dBm
LTE-TDD B34 23dBm +/-2.7dB <-40dBm
LTE-TDD B38 23dBm +/-2.7dB <-40dBm
LTE-TDD B39 23dBm +/-2.7dB <-40dBm
LTE-TDD B40 23dBm +/-2.7dB <-40dBm
LTE-TDD B41 23dBm +/-2.7dB <-40dBm
Table 31: GSM Operating bands
Frequency Receiving Transmission
GSM850 869～894MHz 824～849 MHz
EGSM900 925～960MHz 880～915 MHz
DCS1800 1805～1880 MHz 1710～1785 MHz

## PDF Page 51

PCS1900 1930～1990 MHz 1850～1910 MHz
Table 32: E-UTRA operating bands
E-UTRA UL Freq. DL Freq. Duplex Mode
1 1920~1980 MHz 2110~2170 MHz FDD
2 1850~1910MHz 1930~1990MHz FDD
3 1710~1785 MHz 1805~1880 MHz FDD
4 1710~1755MHz 2110~2155MHZ FDD
5 824～849 MHz 869～894MHz FDD
7 2500~2570MHz 2620~2690MHz FDD
8 880~915 MHz 925~960 MHz FDD
20 832~862MHz 791~821MHz FDD
28 703~748MHz 758~803MHz FDD
66 1710~1780MHz 2110~2200MHz FDD
34 2010~2025MHz 2010~2025MHz TDD
38 2570~2620 MHz 2570~2620 MHz TDD
39 1880~1920 MHz 1880~1920 MHz TDD
40 2300~2400 MHz 2300~2400 MHz TDD
41 2535~2655 MHz 2535~2655 MHz TDD
Table 33: Conducted receive sensitivity
Frequency Receive sensitivity(Typical) Receive sensitivity(MAX)
GSM850 < -109dBm 3GPP
EGSM900 < -109dBm 3GPP
DCS1800 < -108dBm 3GPP
PCS1900 < -107dBm 3GPP
LTE FDD/TDD See table 34. 3GPP
Table 34: Reference sensitivity (QPSK)
## E-Utra
Band
3GPP standard Actual Duplex
Mode1.4 MHz 3MHz 5MHz 10MHz 15 MHz 20 MHz 10 MHz
1 -100 -97 -95.2 -94 TBD FDD
2 -102.7 -99.7 -98 -95 -93.2 -92 TBD FDD
3 -101.7 -98.7 -97 -94 -92.2 -91 TBD FDD
4 -104.7 -101.7 -100 -97 -95.2 -94 TBD FDD
5 -103.2 -100.2 -98 -95 TBD FDD
7 -98 -95 -93.2 -92 TBD FDD

## PDF Page 52

8 -102.2 -99.2 -97 -94 TBD FDD
20 -97 -94 -91.2 -90 TBD FDD
28 -100.2 -98.5 -95.5 -93.7 -91 TBD FDD
66 -104.2 -101.2 -99.5 -96.5 -94.7 -93.5 TBD FDD
34 -100 -97 -95.2 TBD TDD
38 -100 -97 -95.2 -94 TBD TDD
39 -100 -97 -95.2 -94 TBD TDD
40 -100 -97 -95.2 -94 TBD TDD
41 -98 -95 -93.2 -92 TBD TDD
## 4.2 GSM/LTE Antenna Requirements
For better overall performance, it is recommended that the antenna design refer to the index requirements
in the following table.
Table 35: GSM/LTE antenna requirements
Passive Recommended standard
operating band See table 31 and table 32
Direction omnidirectional
Gain > -3dBi (Avg)
Input impedance 50 ohm
Efficiency > 50 %
Maximum input power 50W
VSWR < 2
Isolation >20dB
PCB insertion loss(<1GHz) <0.5dB
PCB insertion loss(1GHz~2.2GHz) <1dB
PCB insertion loss(2.3GHz~2.7GHz) <1.5dB
## 4.3 GNSS Specifications
Table 36: GNSS operating bands
Type Frequecy
GPS 1575.42±1.023MHz

## PDF Page 53

GLONASS 1597.5~1605.8MHz
BeiDou 1561.098±2.046MHz
Table 37: GNSS performance
GNSS GPS BeiDou GLONASS
Tracking sensitivity TBD TBD TBD
Capture sensitivity TBD TBD TBD
Hot start TTFF <1s
Cold start TTFF <40s
Accuracy <2m
## 4.4 GNSS Antenna Requirements
Table 38: Recommended Antenna Characteristics (GNSS)
Passive Recommended standard
operating band L1: 1559~1609MHZ
Direction Hemisphere, face to sky
Input impedance 50 ohm
Maximum input power 50W
VSWR < 2
Plan category RHCP or Linear
Passive antenna gain 0dBi
Active antenna gain -2dBi
Active antenna noise figure < 1.5
Built-in antenna LNA gain 20dB(Typ.)
Total antenna gain < 18 dB
Coaxial insertion loss <1.5dB
## 4.5 Bluetooth specifications
A7672X/A7670X Support BT5.0 protocol specification, compatible with BLE low power mode and traditional
BT mode.
Table 39: Bluetooth performance
Frequency

## PDF Page 54

## 4.6 Antenna Reference Design
### 4.6.1 Passive Antenna for GSM/LTE/GNSS/Bluetooth
Figure 33: Passive antenna reference
GNSS active antenna design is default solution. Strongly suggest to cut off GNSS active antenna
supply by AT+CVAUXS=0, if customer design is passive antenna for GNSS.
In above figure, the component R1/R2/C1/C2 is reserved for antenna matching, the value of components
can only be got after the antenna tuning, usually provided by the antenna factory. Among them, R1 and R2
paste 0Ω, C1 and C2 do not paste by default. The component D1 is a Bidirectional ESD Protection device,
which is suggested to add to protection circuit, the recommended Part Numbers of the TVS are listed in the
following table:
Table 40: TVS part number list
Package Type Supplier
2.402GHz~2.483GHz
TX performance
TX Power DH5 2DH5 3DH5
TBD TBD TBD dBm
RX performance
RX sensitivity DH5 2DH5 3DH5
TBD TBD TBD dBm
## Note

## PDF Page 55

0201 CE0201S05G01R SOCAY
0402 PESD0402-03 PRISEMI
### 4.6.2 Active Antenna for GNSS
Default power supply value is controlled by AT+CVAUXV, default is 3V, which should meet the antenna
requirement. For example, "AT+CVAUXV=2800" sets power supply 2.8V.
Figure 34: Active antenna reference
## 4.7 PCB layout
Users should pay attention to the impedance design of PCB layout from the module ANT port to the
antenna connector, and the length of the PCB trance should be within 20 mm, and far away from
interference signals such as power & clock. It is recommended to reserve RF Switch Connector for
conduction test. The reference model of RF Switch Connector is: ECT 818011998.
Figure 35: Reference PCB layout

## PDF Page 56

5 Electrical Specifications
## 5.1 Absolute maximum ratings
Absolute maximum rating for digital and analog pins of A7672X/A7670X are listed in the following table,
exceeding these limits may cause permanent damage to the module.
Table 41: Absolute maximum ratings
Parameter Min. Typ. Max. Unit
Voltage on VBAT -0.5 - 4.8 V
Voltage on USB_VBUS -0.5 - 5.4 V
Voltage at digital pins
(GPIO, I2C, UART,PCM) -0.3 - 2.0 V
Voltage at lO pins
(USIM)
-0.3 - 2.0 V
-0.3 - 3.9 V
Voltage at PWRKEY, RESET -0.3 - 4.8 V
## 5.2 Operating conditions
Table 42: Recommended operating ratings
Parameter Min. Typ. Max. Unit
Voltage at VBAT 3.4 3.8 4.2 V
Voltage at USB_VBUS 3.0 5.0 5.4 V
Table 43: 1.8V Digital I/O characteristics*
Parameter Description Min. Typ. Max. Unit
VIH High-level input voltage VCC*0.7 1.8 VCC+0.2 V
VIL Low-level input voltage -0.3 0 VCC*0.3 V
VOH High-level output voltage VCC-0.2 - - V
VOL Low-level output voltage 0 - 0.2 V
IOH High-level output current (no pull
down resistor) - - 13 mA
IOL Low-level output current (no pull
up resistor) - - 13 mA
IIH Input high leakage current (no
pull-down resistor) - - 10 uA

## PDF Page 57

IIL Input low leakage current (no pull
up resistor) -10 - - uA
These parameters are for digital interface pins, such as GPIO, I2C, UART, and USB_BOOT.
The operating temperature of A7672X/A7670X is listed in the following table.
Table 44: Operating temperature
Parameter Min. Typ. Max. Unit
Normal operation temperature -30 25 80 ℃
Extended operation temperature* -40 25 85 ℃
Storage temperature -45 25 90 ℃
The performance will be reduced slightly from the 3GPP specifications if the temperature is outside the
normal operating temperature range and still within the extreme operating temperature range.
## 5.3 Operating Mode
### 5.3.1 Operating Mode Definition
The table below summarizes the various operating modes of A7672X/A7670X product.
Table 45: Operating mode Definition
Mode Function
Normal
operation
GSM/ LTE Sleep
In this case, the current consumption of module will be reduced
to the minimal level and the module can still receive paging
message and SMS.
GSM/LTE Idle Software is active. Module is registered to the network, and the
module is ready to communicate.
GSM/ LTE Talk
Connection between two subscribers is in progress. In this
case, the power consumption depends on network settings
such as DTX off/on, FR/EFR/HR, hopping sequences, and
## Note
## Note

## PDF Page 58

antenna.
GSM/LTE Standby
Module is ready for data transmission, but no data is currently
sent or received. In this case, power consumption depends on
network settings.
## Gprs/Edge/Lte
Data transmission
There is data transmission in progress. In this case, power
consumption is related to network settings (e.g., power control
level); uplink/downlink data rates, etc.
Minimum functionality mode
AT command 'AT+CFUN=0' AT+CSCLK=1 can be used to set
the module to a minimum functionality mode without removing
the power supply. In this mode, the RF part of the module will
not work and the USIM card will not be accessible, but the
serial port and USB port are still accessible. The power
consumption in this mode is lower than normal mode.
Flight mode
AT command 'AT+CFUN=4' or pulling down the
FLIGHTMODE pin can be used to set the module to flight
mode without removing the power supply. In this mode, the RF
part of the module will not work, but the serial port and USB
port are still accessible. The power consumption in this mode
is lower than normal mode.
Power off
Module will go into power off mode by sending the AT
command 'AT+CPOF' or pull down the PWRKEY pin, normally.
In this mode the power management unit shuts down the
power supply, and software is not active. The serial port and
USB are is not accessible.
### 5.3.2 Sleep mode
In sleep mode, the current consumption of module will be reduced to the minimal level, and module can still
receive paging message and SMS.
Several hardware and software conditions must be satisfied together in order to let A7672X/A7670X enter
into sleep mode:
 USB condition
 Software condition
 UART condition
Before designing, pay attention to how to realize sleeping/waking function and refer to Document [24]
for more details.
## Note

## PDF Page 59

### 5.3.3 Minimum functionality mode and Flight mode
Minimum functionality mode ceases majority function of the module, thus minimizing the power
consumption. This mode is set by the AT command which provides a choice of the functionality levels.
 AT+CFUN=0: Minimum functionality
 AT+CFUN=1: Full functionality (Default)
 AT+CFUN=4: Flight mode
If A7672X/A7670X has been set to minimum functionality mode, the RF function and SIM card function will
be closed. In this case, the serial port and USB are still accessible, but RF function and SIM card will be
unavailable.
If A7672X/A7670X has been set to flight mode, the RF function will be closed. In this case, the serial port
and USB are still accessible, but RF function will be unavailable.
When A7672X/A7670X is in minimum functionality or flight mode, it can return to full functionality by the AT
command "AT+CFUN=1".
## 5.4 Current Consumption
The current consumption is listed in the table below.
Table 46: Current consumption on VBAT Pins (VBAT=3.8V)
GSM sleep/idle mode
Current under CFUN=0, CSCLK=1 TBD
GSM supply current
(GNSS off，without USB connection)
Sleep mode@BS_PA_MFRMS=2 Typical: TBD
Idle mode@BS_PA_MFRMS=2 Typical: TBD
LTE sleep/idle mode
LTE supply current
(GNSS off，without USB connection)
Sleep mode@DRX=0.32STypical: TBD
Idle mode @DRX=0.32STypical: TBD
GSM Talk
EGSM 900 @power level #5 Typical: 320 mA
DCS1800 @power level #5 Typical: 262 mA
## Gprs
EGSM900( 2 Rx,4 Tx ) @power level #5 Typical: 630mA
DCS1800( 2 Rx,4 Tx ) @power level #0Typical:395mA
EGSM900( 3Rx, 2 Tx ) @power level #5 Typical:370mA
DCS1800( 3Rx, 2 Tx ) @power level #0Typical:275mA
## Edge
EGSM900( 2 Rx,4 Tx ) @power level #8Typical:460mA
DCS1800( 2 Rx,4 Tx ) @power level #2Typical:300mA
EGSM900( 3Rx, 2 Tx ) @power level #8Typical: 336mA
DCS1800( 3Rx, 2 Tx ) @power level #2Typical:208mA

## PDF Page 60

LTE Cat1
LTE-FDD B1 @10MHz 23dBm Typical :600 mA
LTE-FDD B2 @10MHz 23dBm Typical :TBD
LTE-FDD B3 @10MHz 23dBm Typical :600 mA
LTE-FDD B4 @10MHz 23dBm Typical :TBD
LTE-FDD B5 @10MHz 23dBm Typical :580 mA
LTE-FDD B7 @10MHz 23dBm Typical :540mA
LTE-FDD B8 @10MHz 23dBm Typical :520mA
LTE-FDD B20 @10MHz 23dBm Typical :540mA
LTE-FDD B28 @10MHz 23dBm Typical :TBD
LTE-FDD B66 @10MHz 23dBm Typical :TBD
LTE-TDD B34 @10MHz 23dBm Typical :260mA
LTE-TDD B38 @10MHz 23dBm Typical :340 mA
LTE-TDD B39 @10MHz 23dBm Typical :260 mA
LTE-TDD B40 @10MHz 23dBm Typical :340mA
LTE-TDD B41 @10MHz 23dBm Typical :340mA
## 5.5 ESD Notes
A7672X/A7670X is sensitive to ESD in the process of storage, transporting, and assembling.
WhenA7672X/A7670X is mounted on the users' mother board, the ESD components should be placed
beside the connectors which human body may touch, such as SIM card holder, audio jacks, switches, keys,
etc. The following table shows the A7672X/A7670X ESD measurement performance without any external
ESD component.
Table 47: The ESD performance measurement table (Temperature: 25℃, Humidity: 45%.)
Part Contact discharge Air discharge
VBAT, GND +/-5K +/-10K
Antenna port +/-5K +/-10K
USB interface +/-4K +/-8K
UART interface +/-4K +/-6K
Other PADs +/-1K +/-2K
Test conditions: The module is on the SIMCom development board (the development board has the
necessary ESD protection devices)
## Note

## PDF Page 61

6 SMT Production Guide
## 6.1 Top and Bottom View of A7672X/A7670X
Figure 36: Top and bottom view of A7672X
Figure 37: Top and bottom view of A7670X

## PDF Page 62

The above is the design effect diagram of the module for reference. The actual appearance is subject to
the actual product.
## 6.2 Label Information
Figure 38: Label information for A7672X
## Note

## PDF Page 63

Figure 39: Label information for A7670X
Table 48: The description of label information
No. Description
A Project name
B Part number
C Serial number
D IMEI number
E QR code
## 6.3 Typical SMT Reflow Profile
SIMCom provides a typical soldering profile. Therefore, the soldering profile shown below is only a generic
recommendation and should be adjusted to the specific application and manufacturing constraints.

## PDF Page 64

Figure 40: The ramp-soak-spike reflow profile of A7672X/A7670X
For more details about secondary SMT, please refer to the document [21].
## 6.4 Moisture Sensitivity Level (MSL)
A7672X/A7670X is qualified to Moisture Sensitivity Level (MSL) 3 in accordance with JEDEC J-STD-033.
The following table shows the features of Moisture Sensitivity Level (MSL). After seal off, storage conditions
must meet the following table. If the storage time was expired, module must be baking before SMT.
Table 49: Moisture Sensitivity Level and Floor Life
Moisture Sensitivity
Level (MSL)
Floor Life (out of bag) at factory ambient≤30°C/60% RH or
as stated
1 Unlimited at ≦30℃/85% RH
2 1 year at≦30℃/60% RH
2a 4 weeks at ≦30℃/60% RH
3 168 hours at ≦30℃/60% RH
4 72 hours at ≦30℃/60% RH
5 48 hours at ≦30℃/60% RH
5a 24 hours at ≦30℃/60% RH
6 Mandatory bake before use. After bake, it must be reflowed within the
time limit specified on the label.
## Note

## PDF Page 65

IPC / JEDEC J-STD-033standard must be followed for production and storage.
## Note

## PDF Page 66

7 Packaging
A7672X/A7670X module support tray packaging.
Figure 41: packaging diagram
Module tray drawing：
Figure 42: Tray drawing
Table 50: Tray size
Length（±3mm） Width（±3mm） Module number
## 242.0 161.0 20

## PDF Page 67

Small carton drawing：
Figure 43: Small carton drawing
Table 51: Small Carton size
Length（±10mm） Width（±10mm） Height（±10mm） Module number
270 180 120 20*20=400
Big carton drawing：
Figure 44: Big carton drawing

## PDF Page 68

Table 52: Big Carton size
Length（±10mm） Width（±10mm） Height（±10mm） Module number
380 280 280 400*4=1600

## PDF Page 69

8 Appendix
## 8.1 Coding Schemes and Maximum Net Data Rates over Air Interface
Table 53: Coding Schemes and Maximum Net Data Rates over Air Interface
Multislotdefinition(GPRS/EDGE)
Slot class DL slot number UL slot number Active slot
number
1 1 1 2
2 2 1 3
3 2 2 3
4 3 1 4
5 2 2 4
6 3 2 4
7 3 3 4
8 4 1 5
9 3 2 5
10 4 2 5
11 4 3 5
12 4 4 5
GPRS coding scheme Max data rata（4 slots） Modulation type
CS 1 = 9.05 kb/s / time slot 36.2 kb/s GMSK
CS 2 = 13.4 kb/s / time slot 53.6 kb/s GMSK
CS 3 = 15.6 kb/s / time slot 62.4 kb/s GMSK
CS 4 = 21.4 kb/s / time slot 85.6 kb/s GMSK
EDGE coding scheme Max data rata（4 slots） Modulation type
MCS 1 = 8.8 kb/s/ time slot 35.2 kb/s GMSK
MCS 2 = 11.2 kb/s/ time slot 44.8 kb/s GMSK
MCS 3 = 14.8 kb/s/ time slot 59.2 kb/s GMSK
MCS 4 = 17.6 kb/s/ time slot 70.4 kb/s GMSK
MCS 5 = 22.4 kb/s/ time slot 89.6 kb/s 8PSK
MCS 6 = 29.6 kb/s/ time slot 118.4 kb/s 8PSK
MCS 7 = 44.8 kb/s/ time slot 179.2 kb/s 8PSK
MCS 8 = 54.4 kb/s/ time slot 217.6 kb/s 8PSK
MCS 9 = 59.2 kb/s/ time slot 236.8 kb/s 8PSK
LTE-FDD device category Max data rate（peak） Modulation type

## PDF Page 70

(Downlink)
Category M1 1Mbps QPSK/16QAM
LTE-FDD device category
(Uplink) Max data rate（peak） Modulation type
Category M1 375kbps QPSK/16QAM
## 8.2 Related Documents
Table 54: Related Documents
NO. Title Description
[1] A7600 Series AT Command
Manual _V1.00.04 AT Command Manual
[2] ITU-T Draft new
recommendationV.25ter Serial asynchronous automatic dialing and control
[3] GSM 07.07 Digital cellular telecommunications (Phase 2+); AT command
set for GSM Mobile Equipment (ME)
[4] GSM 07.10 Support GSM 07.10 multiplexing protocol
[5] GSM 07.05
Digital cellular telecommunications (Phase 2+); Use of Data
Terminal Equipment - Data Circuit terminating Equipment
(DTE - DCE) interface for Short Message Service (SMS) and
Cell Broadcast Service (CBS)
[6] GSM 11.14
Digital cellular telecommunications system (Phase 2+);
Specification of the SIM Application Toolkit for the Subscriber
Identity Module - Mobile Equipment (SIM - ME) interface
[7] GSM 11.11
Digital cellular telecommunications system (Phase 2+);
Specification of the Subscriber Identity Module - Mobile
Equipment (SIM - ME) interface
[8] GSM 03.38 Digital cellular telecommunications system (Phase 2+);
Alphabets and language-specific information
[9] GSM 11.10
Digital cellular telecommunications system (Phase 2) ；
Mobile Station (MS) conformance specification ； Part 1:
Conformance specification
[10] 3GPP TS 51.010-1 Digital cellular telecommunications system (Release 5);
Mobile Station (MS) conformance specification
[11] 3GPP TS 34.124 Electromagnetic Compatibility (EMC) for mobile terminals and
ancillary equipment.
[12] 3GPP TS 34.121 Electromagnetic Compatibility (EMC) for mobile terminals and
ancillary equipment.
[13] 3GPP TS 34.123-1
Technical Specification Group Radio Access Network;
Terminal conformance specification; Radio transmission and
reception (FDD)
[14] 3GPP TS 34.123-3 User Equipment (UE) conformance specification; Part 3:
Abstract Test Suites.
[15] EN 301 908-02 V2.2.1
Electromagnetic compatibility and Radio spectrum Matters
(ERM); Base Stations (BS) and User Equipment (UE) for
IMT-2000. Third Generation cellular networks; Part 2:
Harmonized EN for IMT-2000, CDMA Direct Spread
(UTRA FDD) (UE) covering essential requirements of article
## 3.2 of the R&TTE Directive
[16] EN 301 489-24 V1.2.1 Electromagnetic compatibility and Radio Spectrum Matters
(ERM); Electromagnetic Compatibility (EMC) standard for

## PDF Page 71

radio equipment and services; Part 24: Specific conditions for
IMT-2000 CDMA Direct Spread (UTRA) for Mobile and
portable (UE) radio and ancillary equipment
[17] IEC/EN60950-1(2001) Safety of information technology equipment (2000)
[18] 3GPP TS 51.010-1 Digital cellular telecommunications system (Release 5);
Mobile Station (MS) conformance specification
[19] GCF-CC V3.23.1 Global Certification Forum - Certification Criteria
[20] 2002/95/EC
Directive of the European Parliament and of the Council of 27
January 2003 on the restriction of the use of certain
hazardous substances in electrical and electronic equipment
(RoHS)
[21] Module
secondary-SMT-UGD-V1.xx Module secondary SMT Guidelines
[22] A7600Series_UART_Applicati
on Note_V1.xx
This document describes how to use UART interface of
SIMCom modules.
[23] Antenna design guidelines for
diversity receiver system Antenna design guidelines for diversity receiver system
[24]
## A7600
Series_SleepMode_Applicatio
n Note_V1.xx
Sleep Mode Application Note
[25]
A7600 Series_UIM HOT
SWAP_Application
Note_V1.00
This document introduces UIM card detection and UIM hot
swap.

## PDF Page 72

## 8.3 Terms and Abbreviations
Table 55: Terms and Abbreviations
Abbreviation Description
ADC Analog-to-Digital Converter
ARP Antenna Reference Point
BER Bit Error Rate
BD BeiDou
BTS Base Transceiver Station
CS Coding Scheme
CSD Circuit Switched Data
CTS Clear to Send
DAC Digital-to-Analog Converter
DSP Digital Signal Processor
DTE Data Terminal Equipment (typically computer, terminal, printer)
DTR Data Terminal Ready
DTX Discontinuous Transmission
DAM Downloadable Application Module
DPO Dynamic Power Optimization
EFR Enhanced Full Rate
EGSM Enhanced GSM
EMC Electromagnetic Compatibility
ESD Electrostatic Discharge
ETS European Telecommunication Standard
FCC Federal Communications Commission (U.S.)
FD SIM fix dialing phonebook
FDMA Frequency Division Multiple Access
FR Full Rate
GMSK Gaussian Minimum Shift Keying
GNSS Global Navigation Satellite System
GPRS General Packet Radio Service
GPS Global Positioning System
GSM Global Standard for Mobile Communications
HR Half Rate
I2C Inter-Integrated Circuit
IMEI International Mobile Equipment Identity
LTE Long Term Evolution
MO Mobile Originated
MS Mobile Station (GSM engine), also referred to as TE
MT Mobile Terminated

## PDF Page 73

NMEA National Marine Electronics Association
PAP Password Authentication Protocol
PBCCH Packet Switched Broadcast Control Channel
PCB Printed Circuit Board
PCS Personal Communication System, also referred to as GSM 1900
RF Radio Frequency
RMS Root Mean Square (value)
RTC Real Time Clock
SIM Subscriber Identification Module
SMS Short Message Service
SMPS Switched-mode power supply
TDMA Time Division Multiple Access
TE Terminal Equipment, also referred to as DTE
TX Transmit Direction
UART Universal Asynchronous Receiver & Transmitter
VSWR Voltage Standing Wave Ratio
SM SIM phonebook
NC Not connect
EDGE Enhanced data rates for GSM evolution
ZIF Zero intermediate frequency
WCDMA Wideband Code Division Multiple Access
VCTCXO Voltage control temperature-compensated crystal oscillator
SIM Universal subscriber identity module
UMTS Universal mobile telecommunications system
UART Universal asynchronous receiver transmitter
PSM Power saving mode
FD SIM fix dialing phonebook
LD SIM last dialing phonebook (list of numbers most recently dialed)
MC Mobile Equipment list of unanswered MT calls (missed calls)
ON SIM (or ME) own numbers (MSISDNs) list
RC Mobile Equipment list of received calls
SM SIM phonebook
NC Not connect

## PDF Page 74

## 8.4 Safety Caution
Table 56: Safety Caution
Marks Requirements
When in a hospital or other health care facility, observe the restrictions about the use
of mobiles. Switch the cellular terminal or mobile off, medical equipment may be
sensitive and not operate normally due to RF energy interference.
Switch off the cellular terminal or mobile before boarding an aircraft. Make sure it is
switched off. The operation of wireless appliances in an aircraft is forbidden to prevent
interference with communication systems. Forgetting to think much of these
instructions may impact the flight safety, or offend local legal action, or both.
Do not operate the cellular terminal or mobile in the presence of flammable gases or
fumes. Switch off the cellular terminal when you are near petrol stations, fuel depots,
chemical plants or where blasting operations are in progress. Operation of any
electrical equipment in potentially explosive atmospheres can constitute a safety
hazard.
Your cellular terminal or mobile receives and transmits radio frequency energy while
switched on. RF interference can occur if it is used close to TV sets, radios,
computers or other electric equipment.
Road safety comes first! Do not use a hand-held cellular terminal or mobile when
driving a vehicle, unless it is securely mounted in a holder for hands free operation.
Before making a call with a hand-held terminal or mobile, park the vehicle.
GSM cellular terminals or mobiles operate over radio frequency signals and cellular
networks and cannot be guaranteed to connect in all conditions, especially with a
mobile fee or an invalid SIM card. While you are in this condition and need emergent
help, please remember to use emergency calls. In order to make or receive calls, the
cellular terminal or mobile must be switched on and in a service area with adequate
cellular signal strength.
Some networks do not allow for emergency call if certain network services or phone
features are in use (e.g. lock functions, fixed dialing etc.). You may have to deactivate
those features before you can make an emergency call.
Also, some networks require that a valid SIM card be properly inserted in the cellular
terminal or mobile.
