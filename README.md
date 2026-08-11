# IoT repository

This repository contains the dashboard, the active ESP32-S3/A7670E firmware,
and the Android device bridge.

Current online dashboard: [https://device.madebydevs.com/](https://device.madebydevs.com/)

## Start with the knowledge base

Read [the consolidated project knowledge base](firmware/docs/PROJECT_KNOWLEDGE.md)
before changing firmware, device contracts, provisioning, or dashboard runtime
behavior. It contains the current architecture, ownership rules, commands,
failure diagnosis, and completion gates.

The [documentation index](firmware/docs/README.md) explains source-of-truth
order and the open Markdown format used for project knowledge.

## Active paths

- ESP32-S3 firmware: `firmware/espidf/esp32-s3-a7670e`
- Dashboard: `dashboard`
- Android bridge: `firmware/android`
- Public access/tunnel tools: `server`
- Local toolchain: `.toolchain`

## Runtime boundary

- MQTT is the normal device command and event path.
- Wi-Fi is the ESP32 primary internet path; A7670 modem data is fallback.
- The dashboard owns durable queues, retries, scheduling, history, and
  operator workflows.
- Firmware owns bounded hardware execution and compact status/events.
- Serial/USB is for provisioning, debug, recovery, and controlled config only.

## Quick validation

```powershell
.\.toolchain\doctor.ps1
Push-Location dashboard
npm test
Pop-Location
.\.toolchain\build-firmware.ps1
```

Flash only after the build passes and the intended serial port is verified:

```powershell
.\.toolchain\flash-firmware.ps1 -Port COM5
```

Replace `COM5` with the actual board port.

## Important references

- [ESP32 runtime rulebook](firmware/espidf/esp32-s3-a7670e/docs/RULEBOOK.md)
- [ESP32 implementation plan](firmware/espidf/esp32-s3-a7670e/docs/RUNTIME_IMPLEMENTATION_PLAN.md)
- [Android bridge contract](firmware/android/docs/ANDROID_SMS_BRIDGE.md)
- [Cloudflare tunnel guide](server/CLOUDFLARE_TUNNEL.md)
