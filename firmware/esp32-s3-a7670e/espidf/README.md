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

## Design Boundary

- runtime operations should flow through MQTT
- Wi-Fi is preferred before modem data
- modem MQTT is used as the fallback path when Wi-Fi is not carrying the session
- USB is reserved for debug, provisioning, config, or PC-side sharing support, not the normal device runtime transport
- credentials are not meant to be hardcoded into firmware
- vendor references for modem and board behavior live under `firmware/esp32-s3-a7670e/docs/`
- heavy orchestration, retries, scheduling, and derived state belong on the dashboard
- firmware should process only hardware-local work and should stay selective
- device-side execution must be queue-driven and race-aware
- resource-heavy work should be delegated to the dashboard whenever safe

## Build Status

- `idf.py` build passes on ESP-IDF `v5.3.1`
- current artifact: repo-root `build/unified_firmware_main.bin`
- preferred scripts:
  - `.\.toolchain\build-firmware.ps1`
  - `.\.toolchain\flash-firmware.ps1 -Port COM5`

These scripts resolve the current repo layout at `firmware/esp32-s3-a7670e/espidf`. No folder move is required.

## References

- use the repo [Docs Index](/d:/Projects/IoT/firmware/docs/README.md)
- use the repo [Runtime Rulebook](/d:/Projects/IoT/firmware/esp32-s3-a7670e/docs/RULEBOOK.md)
- use the repo [Runtime Implementation Plan](/d:/Projects/IoT/firmware/esp32-s3-a7670e/docs/RUNTIME_IMPLEMENTATION_PLAN.md)
- use the vendor bundle [README](/d:/Projects/IoT/firmware/esp32-s3-a7670e/docs/vendor/esp32-s3-a7670e/README.md)

## Practical Note

This lane is the single active firmware path. If a module is not needed for the active dashboard, MQTT, SMS, Wi-Fi, modem, or provisioning flow, it should not be carried here.
