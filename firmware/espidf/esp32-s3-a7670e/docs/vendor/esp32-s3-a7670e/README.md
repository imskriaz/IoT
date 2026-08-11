# ESP32-S3-A7670E Vendor Bundle

This folder contains the restored vendor reference bundle for the board.

## What Is Here

- [manuals](./manuals)
- [hardware](./hardware)
- [demo](./demo)

## Read These First

For modem and network behavior:

- [A76XX_Series_AT_Command_Manual_V1.09.md](./manuals/A76XX_Series_AT_Command_Manual_V1.09.md)
- [A76XX_Series_TCPIP_Application_Note_V1.00.md](./manuals/A76XX_Series_TCPIP_Application_Note_V1.00.md)
- [A76XX_Series_MQTT(S)_Application_Note_V1.00.md](<./manuals/A76XX_Series_MQTT(S)_Application_Note_V1.00.md>)

For module and board hardware behavior:

- [A7672X_A7670X_Series_Hardware_Design_V1.03.md](./manuals/A7672X_A7670X_Series_Hardware_Design_V1.03.md)
- [Schematic_Diagram.md](./hardware/Schematic_Diagram.md)
- [Schematic_Diagram_V2.md](./hardware/Schematic_Diagram_V2.md)

## What The PDFs Confirm

- The modem family supports USB network mode control and USB network IP queries.
- The modem family supports raw TCP/IP sockets directly on the module.
- The modem family documents modem-side MQTT commands.
- These PDFs document modem capability, not a complete production firmware for this repo.

## Demo Bundle Notes

The vendor `demo/` tree includes prebuilt images and example code, including the prebuilt hotspot/USB 4G CDC image:

- [ESP32-S3-A7670E_USB_4G_CDC.zip](./demo/Demo_V1/bin/ESP32-S3-A7670E_USB_4G_CDC.zip)

Treat vendor demos as baseline references and A/B comparison material, not direct merge sources.
