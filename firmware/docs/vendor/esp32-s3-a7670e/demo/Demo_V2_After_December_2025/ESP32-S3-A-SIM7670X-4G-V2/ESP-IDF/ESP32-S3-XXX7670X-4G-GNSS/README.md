# ESP32-S3 + SIMCOM A7670E UART AT Demo

This project sends a few AT commands to a SIMCOM A7670E module over UART and prints responses to the USB serial monitor.

## Hardware

- ESP32-S3 board (download/monitor via USB)
- SIMCOM A7670E module (UART AT port, 3.3V logic)
- Common GND between ESP32-S3 and the module

### Default UART Pins (edit in `main/ESP-7670-call.c` if needed)

- ESP32-S3 TX (GPIO18) -> A7670E RX
- ESP32-S3 RX (GPIO17) -> A7670E TX
- GND -> GND

Baud rate: 115200, UART1.

## Build

```bash
idf.py set-target esp32s3
idf.py build
```

## Flash & Monitor (CH343)

Replace `COM240` with your actual port if different:

```bash
idf.py -p COM240 flash monitor
```

If flashing is stuck at `Connecting...`, manually enter download mode:
1) hold **BOOT**
2) tap **EN/RESET**
3) release **BOOT**

Exit monitor: `Ctrl + ]`

## Notes
Please plug the GNSS ceramic antenna into the GNSS antenna mount and place it in an open outdoor area (note that testing is not possible in cloudy or rainy weather). It will take approximately one minute after powering on to receive a positioning signal. Because GPS satellite acquisition is unstable indoors, please place the module or antenna on a balcony or near a window, or conduct the experiment directly outdoors under a visible sky.