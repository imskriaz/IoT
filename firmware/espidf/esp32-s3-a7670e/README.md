# Unified Firmware Main Lane

This is the single active ESP-IDF firmware lane for the Waveshare ESP32-S3-A7670E-4G board.

## Hardware Note

- ESP32-S3R8 dual-core Xtensa LX7 MCU
- CPU up to 240MHz
- 512KB SRAM and 384KB ROM
- 8MB PSRAM
- 16MB flash
- 2.4GHz Wi-Fi and Bluetooth LE
- A7670E-FASE modem for 4G Cat-1, 2G, SMS, telephony, and GNSS
- USB switching path for modem/debug sharing
- battery charging, solar charging, power management, and battery measurement
- TF card, camera interface, speaker, and expansion headers for future modules

## Runtime Goal

- keep the product runtime small and maintainable
- keep only tested modules that support dashboard and SMS requirements
- use Wi-Fi as the primary internet path
- fall back to the A7670 modem when Wi-Fi is unavailable
- use MQTT for normal device operations
- keep provisioning and debug configuration on the serial/debug side

## Current Runtime Surface

- board bring-up
- config and state storage
- diagnostics, task registry, and health baseline
- storage and SMS persistence
- modem bring-up with telephony support
- Wi-Fi bring-up and scan support
- MQTT transport manager
- telemetry/status publishing
- slim API bridge for MQTT commands
- SMS service for send and inbox processing
- device status payload generation
- serial config path for provisioning/debug

## Dashboard Screen Support

Use this order when auditing the active dashboard against firmware: `SMS`, `Call`, `Modem`, `Internet`.

- `SMS`: supported. Firmware exposes send, multipart send, modem inbox consumption, storage append, and incoming MQTT publish. Dashboard-side scheduling, retries, template logic, and conversation UX remain server concerns.
- `Call`: supported only for telephony actions that are present in the active firmware lane today: dial and hangup. Do not assume hold, resume, mute, answer, or reject support unless they are explicitly implemented and validated against the vendor modem references.
- `Modem`: supported for modem readiness, SIM presence, operator details, signal reporting, telephony capability flags, mobile-data enable or disable, APN changes, and MQTT/runtime status reporting.
- `Internet`: supported as a two-lane policy. Wi-Fi is primary. Mobile data on the A7670 modem is fallback. The active firmware exposes Wi-Fi status, reconnect, toggle, disconnect, and scan commands, plus modem data and APN controls.

## Design Boundary

- runtime operations should flow through MQTT
- Wi-Fi is preferred before modem data
- modem MQTT is used as the fallback path when Wi-Fi is not carrying the session
- USB is reserved for debug, provisioning, config, or PC-side sharing support, not the normal device runtime transport
- credentials are not meant to be hardcoded into firmware
- vendor references for modem and board behavior live under `firmware/espidf/esp32-s3-a7670e/docs/`
- heavy orchestration, retries, scheduling, and derived state belong on the dashboard
- firmware should process only hardware-local work and should stay selective
- device-side execution must be queue-driven and race-aware
- resource-heavy work should be delegated to the dashboard whenever safe
- vendor docs under `firmware/espidf/esp32-s3-a7670e/docs/vendor/` are the firmware source of truth for modem AT behavior, board wiring, and hardware limits

## Build Status

- `idf.py` build passes on ESP-IDF `v5.3.1`
- current artifact: `firmware/espidf/esp32-s3-a7670e/build/unified_firmware_main.bin`
- preferred scripts:
  - `.\.toolchain\build-firmware.ps1`
  - `.\.toolchain\flash-firmware.ps1 -Port COM5`

These scripts resolve the active repo layout at `firmware/espidf/esp32-s3-a7670e`.

## References

- use the repo [Docs Index](/d:/Projects/IoT/firmware/espidf/esp32-s3-a7670e/docs/README.md)
- use the repo [Runtime Rulebook](/d:/Projects/IoT/firmware/espidf/esp32-s3-a7670e/docs/RULEBOOK.md)
- use the repo [Runtime Implementation Plan](/d:/Projects/IoT/firmware/espidf/esp32-s3-a7670e/docs/RUNTIME_IMPLEMENTATION_PLAN.md)
- use the vendor bundle [README](/d:/Projects/IoT/firmware/espidf/esp32-s3-a7670e/docs/vendor/esp32-s3-a7670e/README.md)

## Practical Note

This lane is the single active firmware path. If a module is not needed for the active dashboard, MQTT, SMS, Wi-Fi, modem, or provisioning flow, it should not be carried here.
