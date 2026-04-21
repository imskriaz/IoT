# Docs Index

This `firmware/esp32-s3-a7670e/docs/` folder is for source references, not implementation history.

## Source Of Truth

For the Waveshare `ESP32-S3-A7670E-4G` board, use the vendor PDFs first:

- [A76XX AT Command Manual](/d:/Projects/IoT/firmware/esp32-s3-a7670e/docs/vendor/esp32-s3-a7670e/manuals/A76XX_Series_AT_Command_Manual_V1.09.pdf)
- [A76XX TCPIP Application Note](/d:/Projects/IoT/firmware/esp32-s3-a7670e/docs/vendor/esp32-s3-a7670e/manuals/A76XX_Series_TCPIP_Application_Note_V1.00.pdf)
- [A76XX MQTT(S) Application Note](/d:/Projects/IoT/firmware/esp32-s3-a7670e/docs/vendor/esp32-s3-a7670e/manuals/A76XX_Series_MQTT(S)_Application_Note_V1.00.pdf)
- [A7670X Hardware Design](/d:/Projects/IoT/firmware/esp32-s3-a7670e/docs/vendor/esp32-s3-a7670e/manuals/A7672X_A7670X_Series_Hardware_Design_V1.03.pdf)
- [Board Schematics](/d:/Projects/IoT/firmware/esp32-s3-a7670e/docs/vendor/esp32-s3-a7670e/hardware)

## Vendor Bundle

- [vendor/esp32-s3-a7670e](/d:/Projects/IoT/firmware/esp32-s3-a7670e/docs/vendor/esp32-s3-a7670e)
  - `manuals/`: modem and hardware PDFs
  - `hardware/`: board schematic PDFs
  - `demo/`: vendor demo bundles and prebuilt images
  - [manuals/A76XX_AT_CUSD.md](/d:/Projects/IoT/firmware/esp32-s3-a7670e/docs/vendor/esp32-s3-a7670e/manuals/A76XX_AT_CUSD.md): extracted `AT+CUSD` quick reference with session notes

Generated reference copies:

- vendor PDFs under `vendor/esp32-s3-a7670e/` now have sibling `.md` files generated from the PDF text layer
- generator: [pdf_to_md.py](/d:/Projects/IoT/.toolchain/pdf_to_md.py)
- regenerate: `.\.toolchain\Python311\python.exe .\.toolchain\pdf_to_md.py firmware/esp32-s3-a7670e/docs/vendor/esp32-s3-a7670e --recursive --force`

## Network Notes

The vendor docs show that the module family supports:

- USB network commands like `AT$MYCONFIG`, `AT+DIALMODE`, and `AT+USBNETIP`
- raw packet-data and socket commands like `AT+NETOPEN`, `AT+CIPOPEN`, `AT+CIPSEND`, and `AT+CIPRXGET`
- modem-side MQTT commands like `AT+CMQTTSTART`, `AT+CMQTTACCQ`, and `AT+CMQTTCONNECT`

## Important Boundary

- Use `firmware/esp32-s3-a7670e/docs/` for vendor source material and board references.
- Keep implementation in the main firmware lane and use vendor docs here as the reference set.

## Repo Rulebook

- [Runtime Rulebook](/d:/Projects/IoT/firmware/esp32-s3-a7670e/docs/RULEBOOK.md)
  - defines dashboard-vs-device ownership
  - defines queue and race-control rules
  - defines the selective firmware redesign plan
- [Runtime Implementation Plan](/d:/Projects/IoT/firmware/esp32-s3-a7670e/docs/RUNTIME_IMPLEMENTATION_PLAN.md)
  - defines queue domains and execution lanes
  - defines file-level implementation phases
  - defines live validation gates and stop conditions
- [Device Types](/d:/Projects/IoT/firmware/docs/DEVICE_TYPES.md)
  - defines the supported device families
  - clarifies that Android `HTTP API` is a transport, not a separate device type
- [Android Device Bridge](/d:/Projects/IoT/firmware/android/docs/ANDROID_SMS_BRIDGE.md)
  - defines the current Android app contract
  - documents provisioning, permissions, and dual-SIM expectations

## Feature Review Matrix

This matrix reflects the current repo state, not the broadest possible UI plan.

Legend:

- `Live`: implemented and used now
- `Partial`: some runtime path exists, but not full end-to-end behavior
- `Planned`: dashboard surface or command model exists, but active device runtime is not complete
- `No`: not supported in the active lane

Important transport boundary:

- the current preferred runtime lane is `MQTT` for control/events
- use `HTTP` only where payload, file, or media transfer materially benefits from it
- `ESP32-S3 HTTP` is not an active device runtime lane in the current firmware today, but it is still a valid future complement for file-heavy work
- `WebSocket` here means browser-to-dashboard live updates and signaling through Socket.IO. It is not a direct device transport for ESP32 or Android today

Review categories:

- `ESP32-S3 - MQTT/HTTP`
- `Android - MQTT/HTTP`

The table below uses the preferred runtime lane for each feature.

| Feature | ESP32-S3 | Android | Protocol | Remarks |
|---|---|---|---|---|
| Status / heartbeat | Live | Live | `MQTT` | Socket.IO mirrors live status in the UI. |
| SMS | Live | Live | `MQTT` | Plain text SMS fits the active lane. |
| Wi-Fi scan / status | Live | Partial | `MQTT` | Android Wi-Fi detail/scan is permission-gated. |
| USSD single response | Live | Live | `MQTT` | Android needs `CALL_PHONE` and Android 8+. |
| Storage health | Live | Live | `MQTT` | Covers stats and queue depth. |
| Call records / state | Partial | Live | `MQTT` + `WebSocket` | Android call lane depends on phone permissions. |
| Mobile data / APN | Live | N/A | `MQTT` | ESP-only feature. |
| GPS / location | Partial | Planned | `MQTT` + `WebSocket` | `MQTT` for device updates, `WebSocket` for live tracking UI. |
| Storage file manager | Partial | No | `MQTT` + `HTTP` | Control plus file transfer. |
| USSD options / chained menus | Partial | Partial | `MQTT` | Continuation is still unreliable. |
| Call control | Partial | Live | `MQTT` | Android needs `CALL_PHONE` / `ANSWER_PHONE_CALLS`. |
| Call hold / resume / mute | No | Partial | `MQTT` | Android is still limited and permission-gated. |
| OTA update | Partial | No | `MQTT` + `HTTP` | Trigger over MQTT, binary over HTTP. |
| Camera capture | Planned | Planned | `MQTT` + `HTTP` | Android also needs `CAMERA` permission. |
| NFC / RFID | Planned | Planned | `MQTT` | Good fit for event publishing. |
| GPIO / automation | Planned | N/A | `MQTT` | ESP-only runtime target. |
| Touch / keyboard events | Planned | Planned | `MQTT` | Event lane only for now. |
| MMS / SMS attachments | No | No | `MQTT` + `HTTP` | Use `MQTT` for command/metadata and `HTTP` for attachment transfer. |
| Intercom signaling | Planned | Planned | `MQTT` + browser `WebSocket`/RTC | Android media side also needs mic/camera permissions. |
| Live camera stream | No | No | `HTTP` or RTC/WebSocket | Not a good MQTT fit. |
| Live call audio / VoIP bridge | No | No | Control + media lane | Needs more than MQTT alone. |
| Intercom live media | No | No | `HTTP` or RTC | End-to-end path is missing. |

## Optimized Runtime Fit

- Use `MQTT` for control, status, SMS, Wi-Fi, USSD, call state, GPS events, NFC/RFID, and GPIO actions.
- Keep plain text SMS on `MQTT`; use `HTTP` only when messaging needs attachment/media transfer.
- Use browser `WebSocket` for live dashboard updates, GPS map refresh, and call/intercom signaling to the UI.
- Use `HTTP` only for heavier transfers such as OTA binaries, file manager payloads, camera capture, and future media streams.

## ESP32-S3 Load Boundary

- Yes, one unified ESP32-S3 firmware is reasonable for the current control-plane scope: `MQTT`, status, SMS, USSD, Wi-Fi, modem data, storage stats, and light GPIO/GPS work.
- The hard limit is internal SRAM, not just flash or PSRAM size. Wi-Fi, modem control, `esp-mqtt`, and several task stacks still need internal memory.
- `PSRAM` is useful for large buffers, JSON scratch space, optional caches, and some non-critical task stacks, but it does not remove all runtime pressure.
- Keep `ESP32-S3` as one firmware target, but make heavier modules selective and cold by default.
- For camera, live audio/intercom, heavier storage transfer, and richer automation, keep one firmware and use feature flags, lazy allocation, shared buffers, and on-demand activation so inactive features do not tax the baseline runtime.

## Current Rule Of Thumb

- Use `MQTT` as the control plane for both families.
- Use `HTTP` as the heavier payload plane when a feature genuinely benefits from upload, download, file, or media transfer.
- For messaging, keep text SMS on `MQTT`; use `HTTP` only for attachment-style transfer.
- For `ESP32-S3`, MQTT is the active runtime lane and HTTP is a future complement.
- For `Android`, MQTT is the preferred runtime lane and HTTP remains an optional transport mode.
- Use browser `WebSocket` only as the live dashboard layer on top of MQTT or HTTP, not as a separate device family.
