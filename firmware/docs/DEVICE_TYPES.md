# Device Types

This repo supports two device families.

## 1. ESP32 Firmware Devices

Use this lane for hardware devices that run the repo firmware.

Examples:

- `esp32-s3-a7670e`
- other ESP32 firmware boards using the same dashboard contract

Expected characteristics:

- hardware-first onboarding
- Wi-Fi and APN provisioning
- MQTT heartbeat/status
- GPIO and board capabilities
- firmware and OTA lifecycle

## 2. Android Device Bridge

Use this lane for phones running the first-party Android app in [firmware/android](/d:/Projects/IoT/firmware/android).

Model:

- `android-sms-bridge`

Supported transports:

- `MQTT`
- `HTTP API`

Expected characteristics:

- QR or token provisioning from the dashboard
- SMS send/receive bridge
- delivery events
- battery, storage, network, IMEI, and device identity status
- dual-SIM reporting and SIM-aware sending
- app-side diagnostics, recovery, and support tools

## Removed Lane

The repo no longer supports `httpSMS` as a separate device type.

Reason:

- it duplicated Android bridge behavior
- it complicated provisioning and contracts
- it created a parallel adapter path the dashboard no longer needs

If a device needs HTTP transport, use the Android Device Bridge in `HTTP API` mode.

## Contract Rule

Device family and transport are different concerns.

- `ESP32` is a device family
- `Android` is a device family
- `MQTT` and `HTTP API` are transport choices

Do not introduce a new device type just because the transport changes.
