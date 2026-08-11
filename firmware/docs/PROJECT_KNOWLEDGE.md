---
title: IoT project knowledge base
status: active
last_reviewed: 2026-08-11
source_of_truth: code, vendor, operational-test
---

# IoT project knowledge base

This page is the shortest reliable explanation of how this repository works.
It is intentionally operational: use it before changing firmware, device
contracts, dashboard behavior, or provisioning.

## 1. Current truth

- The current public dashboard URL is
  [https://device.madebydevs.com/](https://device.madebydevs.com/).
- The active ESP32 firmware is
  `firmware/espidf/esp32-s3-a7670e`.
- The dashboard is `dashboard`; it is the orchestration and durable-storage
  tier.
- The Android bridge is `firmware/android`; it is a second device family, not
  a replacement for the ESP32 firmware.
- MQTT is the normal runtime control/event path for both device families.
- Wi-Fi is the preferred ESP32 internet path; A7670 modem data is fallback.
- Serial/USB is for provisioning, debug, recovery, and controlled config. It is
  not proof that the MQTT runtime path works.
- The dashboard owns durable queues, retries, schedules, history, stale-state
  reconciliation, and operator workflows.
- Firmware owns bounded local execution: modem AT operations, SMS, Wi-Fi,
  local storage, path selection, and compact status/events.

## 2. Repository map

| Area | Path | Use it for |
|---|---|---|
| Documentation index | `firmware/docs/README.md` | Navigation and documentation rules |
| Consolidated knowledge | `firmware/docs/PROJECT_KNOWLEDGE.md` | Current operational truth |
| Device contract | `firmware/docs/DEVICE_TYPES.md` | Device-family boundaries |
| ESP32 firmware | `firmware/espidf/esp32-s3-a7670e` | Active ESP-IDF build |
| ESP32 vendor references | `firmware/espidf/esp32-s3-a7670e/docs/vendor/esp32-s3-a7670e` | Board, modem, and wiring evidence |
| Dashboard | `dashboard` | Web UI, API, queue, MQTT orchestration |
| Android bridge | `firmware/android` | Android SMS/status device client |
| Public access tools | `server` | Cloudflare tunnel and reachability checks |
| Toolchain | `.toolchain` | Environment, build, flash, and diagnostics |

## 3. Runtime architecture

```text
Operator browser
      |
      v
Dashboard/API + durable queue + SQLite history
      |
      v
MQTT broker <------ MQTT status/events ------ device
                                                |
                         +----------------------+------------------+
                         |                                         |
                    ESP32-S3                                  Android bridge
                         |                                         |
                   Wi-Fi -> A7670 modem                    Phone SMS/network APIs
```

The browser may receive live updates through Socket.IO, but Socket.IO is a
dashboard presentation layer, not a direct ESP32 transport.

## 4. Ownership rules

| Responsibility | Dashboard | Device |
|---|---:|---:|
| Durable command queue | Yes | No |
| Retry/backoff/scheduling | Yes | No |
| History, threads, search, import/export | Yes | No |
| Stale/offline reconciliation | Yes | No |
| MQTT command publication | Yes | Receives |
| Modem AT execution | No | Yes |
| SMS send/read/delete | No | Yes |
| Wi-Fi scan/connect state | No | ESP32 yes |
| Modem data/APN/path control | No | ESP32 yes |
| Local storage access | No | Device-local only |
| Compact status and event publication | Consumes | Publishes |
| Operator validation and UI | Yes | No |

Commands that touch the same hardware lane must serialize. A status refresh
must never starve or race a real command.

## 5. Supported behavior boundary

| Capability | ESP32-S3 active lane | Android active lane | Evidence rule |
|---|---|---|---|
| Heartbeat/status | Supported | Supported | MQTT event/status observed |
| Plain SMS | Supported | Supported | Send and incoming event verified |
| Wi-Fi status/scan | Supported | Permission-dependent | Device status and scan result |
| USSD single response | Supported | Permission-dependent | Direct modem/phone test plus MQTT path |
| Storage health | Supported | Supported | Status payload and dashboard view |
| Dial/hangup | Supported where implemented | Supported where permissioned | Vendor-backed command and runtime result |
| Hold/resume/mute/answer/reject | Do not assume | Permission/implementation-dependent | Must be explicitly implemented and tested |
| ESP32 mobile data/APN | Supported where implemented | Not applicable | Modem status and reconnect evidence |
| GPS, file transfer, OTA, camera, GPIO | Partial or planned | Partial or planned | Do not expose as complete without end-to-end proof |

“Supported” means the execution tier accepted and completed the operation. A
dashboard response saying “queued” is only pending state.

## 6. Safe working sequence

Use this order for any change that can affect a physical device:

1. Read this page and the relevant section of the [runtime rulebook](../espidf/esp32-s3-a7670e/docs/RULEBOOK.md).
2. Read the matching vendor document before changing board pins, power,
   modem AT behavior, timing, or hardware assumptions.
3. Inspect the existing command, status, queue, and tests before editing.
4. For a new or changed modem/Wi-Fi/SMS/USSD sequence, run the exact AT or
   terminal sequence directly first and record the response and timing.
5. Implement the smallest change with explicit timeout, failure result,
   idempotency behavior, and queue ownership.
6. Run automated tests and build the firmware.
7. Flash only the intended board and port; capture boot output.
8. Test the real MQTT/dashboard path separately from the serial test.
9. Verify reconnect, stale status, queue recovery, and the feature's failure
   path before calling it complete.

## 7. Local validation commands

Run from the repository root unless noted.

### Environment

```powershell
.\.toolchain\doctor.ps1
```

For a stricter dashboard environment check:

```powershell
.\.toolchain\doctor.ps1 -Strict
```

### Dashboard

```powershell
Push-Location dashboard
npm run env:doctor
npm test
Pop-Location
```

Start the dashboard:

```powershell
npm start
```

### Firmware

```powershell
.\.toolchain\build-firmware.ps1
.\.toolchain\list-serial-ports.ps1
.\.toolchain\flash-firmware.ps1 -Port COM5
```

Replace `COM5` with the verified port. The flash script can auto-select a
candidate, but an explicit port is safer when more than one serial device is
connected.

After entering the ESP-IDF environment with
`.\.toolchain\enter-iot-env.ps1`, use `idf.py -p COM5 monitor` from the active
firmware directory to capture boot and runtime output.

Validate a captured status JSON file with:

```powershell
node firmware/espidf/esp32-s3-a7670e/verify-status-payload.js .\status.json
```

## 8. Hardware preflight

Before debugging software, confirm:

- board power is stable and the modem has its antenna connected;
- the correct SIM is inserted, unlocked, registered, and has service/data;
- the USB cable supports data and the intended COM port is visible;
- no other serial monitor or application owns the port;
- the flashed image is the current active firmware build;
- required Wi-Fi test dependency `RiazM` is visible and available;
- dashboard MQTT host, port, credentials, and client ID are valid;
- device runtime Wi-Fi/APN/MQTT settings were provisioned and persisted.

If `RiazM` is not visible, stop Wi-Fi-dependent testing and ask for the
hotspot to be enabled. If it is visible but authentication/reconnect fails,
continue debugging the device/credentials path.

## 9. Failure diagnosis

| Symptom | First checks | Do not conclude yet |
|---|---|---|
| No serial port | Cable, driver, Device Manager, port ownership, `list-serial-ports.ps1` | Firmware is broken |
| Flash fails | Correct port, boot mode, cable, power, baud | MQTT is broken |
| Board boots but no dashboard status | Device config, broker reachability, MQTT auth, subscriptions, status logs | UI cache is current |
| Wi-Fi does not connect | `RiazM` visibility, password, signal, auth/reconnect reason | Modem fallback is broken |
| Modem fallback does not connect | SIM/antenna/registration/APN/signal/PDP state | Dashboard command was completed |
| Command shows queued | MQTT publication, device acceptance, execution result, timeout | Hardware operation succeeded |
| Dashboard says offline | Device last-seen age, MQTT device telemetry, power, broker | Cached fields are live |
| SMS duplicates | Message ID/index, receive event, fallback scan, dashboard dedupe | Modem sent twice |
| Reconnect flaps | Wi-Fi hold time, modem session, cooldown, repeated scans | Intermittent network is harmless |
| Status crashes or resets board | Boot log, task stack watermark, payload size, JSON buffer ownership | Add more polling |

Every failure report should include: timestamp, device ID, firmware/build
version, transport/path, command ID, expected result, observed result, logs,
and the exact blocker or next test.

## 10. Completion gates

A runtime feature is complete only when applicable gates pass:

- clean firmware build;
- stable boot across repeated restarts;
- MQTT connect, subscribe, publish, and reconnect;
- Wi-Fi primary path and modem fallback/recovery;
- command accepted, executed, and reported with a terminal result;
- timeout, retry, duplicate, queue-full, and offline behavior;
- SMS send/incoming behavior without duplicate history;
- stale status is shown as stale rather than guessed;
- dashboard restart preserves and resumes pending work;
- hardware evidence is recorded, or the exact hardware blocker is reported.

## 11. Change record template

Copy this block into a small Markdown note or issue when validating hardware:

```markdown
## Hardware validation: <feature>

- Date/time:
- Board/device ID:
- Firmware commit/build:
- Port/SIM/network:
- Dashboard/broker:
- Command or sequence:
- Expected result:
- Observed result:
- Logs/evidence:
- Result: PASS | FAIL | BLOCKED
- Next action:
```

## 12. Related references

- [ESP32 firmware README](../espidf/esp32-s3-a7670e/README.md)
- [ESP32 docs index](../espidf/esp32-s3-a7670e/docs/README.md)
- [ESP32 runtime rulebook](../espidf/esp32-s3-a7670e/docs/RULEBOOK.md)
- [ESP32 implementation plan](../espidf/esp32-s3-a7670e/docs/RUNTIME_IMPLEMENTATION_PLAN.md)
- [Android bridge contract](../android/docs/ANDROID_SMS_BRIDGE.md)
- [Cloudflare tunnel guide](../../server/CLOUDFLARE_TUNNEL.md)
