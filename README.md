# IoT Repo

This repo currently supports two active device families:

- `ESP32-S3` firmware devices
- `Android` bridge devices

Current transport rule:

- `ESP32-S3` uses `MQTT` as the active runtime lane today.
- `Android` also has an `HTTP API` transport mode, but the preferred active lane is still `MQTT`.
- this matrix lists the main runtime lane for each feature, not every fallback or onboarding option.
- use `HTTP` only where payload, file, or media transfer materially benefits from it.
- browser `WebSocket` means dashboard live updates and signaling through Socket.IO, not a direct device transport.

## Repo Paths

- ESP32 active firmware: [firmware/espidf/esp32-s3-a7670e](D:/Projects/IoT/firmware/espidf/esp32-s3-a7670e)
- Android bridge app: [firmware/android](D:/Projects/IoT/firmware/android)
- Flutter UI: [firmware/android/flutter_ui](D:/Projects/IoT/firmware/android/flutter_ui)
- Dashboard server: [dashboard](D:/Projects/IoT/dashboard)
- Source docs index: [firmware/docs/README.md](D:/Projects/IoT/firmware/docs/README.md)

## Feature Review Matrix

Legend:

- `Live`: implemented and used now
- `Partial`: some runtime path exists, but not full end-to-end behavior
- `Planned`: dashboard surface or command model exists, but active device runtime is not complete
- `No`: not supported in the active lane

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
- Keep SMS orchestration on the dashboard: Unicode/Bangla analysis, multipart selection, scheduling, templates, import/export, and thread logic should stay off the ESP32 whenever hardware-local execution is not required.
- Use browser `WebSocket` for live dashboard updates, GPS map refresh, and call/intercom signaling to the UI.
- Use `HTTP` only for heavier transfers such as OTA binaries, file manager payloads, camera capture, and future media streams.

## ESP32-S3 Load Boundary

- Yes, one unified ESP32-S3 firmware is reasonable for the current control-plane scope: `MQTT`, status, SMS, USSD, Wi-Fi, modem data, storage stats, and light GPIO/GPS work.
- The hard limit is internal SRAM, not just flash or PSRAM size. Wi-Fi, modem control, `esp-mqtt`, and several task stacks still need internal memory.
- `PSRAM` is useful for large buffers, JSON scratch space, optional caches, and some non-critical task stacks, but it does not remove all runtime pressure.
- Keep `ESP32-S3` as one firmware target, but make heavier modules selective and cold by default.
- For camera, live audio/intercom, heavier storage transfer, and richer automation, keep one firmware and use feature flags, lazy allocation, shared buffers, and on-demand activation so inactive features do not tax the baseline runtime.

## Practical Use

- Use `MQTT` as the control plane for both families.
- Use `HTTP` as the heavier payload plane when a feature genuinely benefits from upload, download, file, or media transfer.
- For messaging, keep text SMS on `MQTT`; use `HTTP` only for attachment-style transfer.
- For `ESP32-S3`, MQTT is the active runtime lane and HTTP is a future complement.
- For `Android`, MQTT is the preferred runtime lane and HTTP remains an optional transport mode.
- Use browser `WebSocket` as the live dashboard layer on top of MQTT or HTTP, not as a separate device family.

## Build Notes

- Keep the current firmware folder layout as-is: `firmware/espidf/esp32-s3-a7670e`.
- Use `.\.toolchain\build-firmware.ps1` to build the ESP32 firmware.
- Use `.\.toolchain\flash-firmware.ps1 -Port COM5` to flash it.
- Dashboard status validation uses `firmware/espidf/esp32-s3-a7670e/verify-status-payload.js`.
- For firmware behavior, the vendor bundle under `firmware/espidf/esp32-s3-a7670e/docs/vendor/` is the source of truth.

## Dashboard Flow Audit

The current ESP32 dashboard audit was reviewed in this order: `SMS`, `Call`, `Modem`, `Internet`.

- `SMS`: supported on the active ESP32 lane through MQTT-backed actions and modem telephony. Firmware covers send, multipart send, inbox consumption, and incoming publish. Dashboard orchestration such as scheduling, queueing, templates, import/export, and thread UX stays on the server side.
- `Call`: supported for dial and hangup on the active ESP32 lane. Treat advanced in-call controls such as hold, resume, mute, or answer/reject as unsupported on this firmware unless the vendor-backed modem lane is implemented and verified for them.
- `Modem`: supported for modem readiness, SIM/operator state, signal, mobile-data enable or disable, APN updates, and MQTT session health. Keep modem capability decisions aligned with the status payload and device capability profile.
- `Internet`: Wi-Fi is the preferred internet path. The modem data lane is the fallback path when Wi-Fi is unavailable. Dashboard actions should assume support for Wi-Fi status, scan, reconnect, disconnect, toggle, and modem-data routing rather than direct browser-to-device internet control.

These support statements are intentionally constrained to the active firmware under `firmware/espidf/esp32-s3-a7670e` and the vendor references under `firmware/espidf/esp32-s3-a7670e/docs/vendor/`.

## More Detail

- Device families and transport rules: [firmware/docs/DEVICE_TYPES.md](D:/Projects/IoT/firmware/docs/DEVICE_TYPES.md)
- Android bridge contract: [firmware/android/docs/ANDROID_SMS_BRIDGE.md](D:/Projects/IoT/firmware/android/docs/ANDROID_SMS_BRIDGE.md)
- Docs index and vendor references: [firmware/docs/README.md](D:/Projects/IoT/firmware/docs/README.md)
