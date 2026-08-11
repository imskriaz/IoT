---
title: ESP32-S3/A7670E documentation
status: active
last_reviewed: 2026-08-11
source_of_truth: vendor and firmware implementation
---

# ESP32-S3/A7670E documentation

This directory contains the active firmware design references and the vendor
bundle for the Waveshare ESP32-S3-A7670E-4G board.

Start with the repository [project knowledge base](../../../docs/PROJECT_KNOWLEDGE.md)
for the build, flash, recovery, and end-to-end validation workflow.

## Runtime references

- [Runtime rulebook](./RULEBOOK.md) — ownership, queues, races, memory, and
  network rules.
- [Runtime implementation plan](./RUNTIME_IMPLEMENTATION_PLAN.md) — phased
  file-level work and acceptance gates.
- [Firmware README](../README.md) — active firmware lane and supported surface.

## Vendor source bundle

- [Vendor bundle README](./vendor/esp32-s3-a7670e/README.md)
- [Modem AT command manual](./vendor/esp32-s3-a7670e/manuals/A76XX_Series_AT_Command_Manual_V1.09.md)
- [Modem TCP/IP application note](./vendor/esp32-s3-a7670e/manuals/A76XX_Series_TCPIP_Application_Note_V1.00.md)
- [Modem MQTT application note](<./vendor/esp32-s3-a7670e/manuals/A76XX_Series_MQTT(S)_Application_Note_V1.00.md>)
- [A7670X hardware design](./vendor/esp32-s3-a7670e/manuals/A7672X_A7670X_Series_Hardware_Design_V1.03.md)
- [Board schematic V2](./vendor/esp32-s3-a7670e/hardware/Schematic_Diagram_V2.md)

The vendor files establish board wiring, modem command behavior, timing, and
hardware limits. They do not prove that a feature is implemented in this
repository.

## Documentation rule

For every new or changed modem, Wi-Fi, SMS, USSD, or hardware command:

1. Read the matching vendor reference.
2. Run the exact command sequence directly on the serial/terminal path.
3. Record expected response, timing, and failure behavior.
4. Implement it in the serialized firmware lane.
5. Verify the real MQTT/dashboard path separately.
