---
title: Supported device types
status: active
last_reviewed: 2026-08-11
source_of_truth: code and operational contract
---

# Supported device types

The repository has two supported device families. Transport is a property of
the device configuration, not a new device family.

| Device family | Identity | Preferred runtime | Optional/recovery path | Main hardware boundary |
|---|---|---|---|---|
| ESP32-S3 modem board | ESP32-S3 + A7670E | MQTT | Serial/USB for provisioning, debug, recovery | Wi-Fi, modem, SMS, telephony, GNSS, storage, GPIO |
| Android bridge | `android-sms-bridge` | MQTT | HTTP API for bridge mode; Android UI/ADB for recovery | Phone SMS, permissions, cellular/Wi-Fi, battery/storage |

## Contract rules

- The dashboard is the orchestration tier for both families.
- The device is the execution tier for hardware-local actions.
- MQTT is the normal command and event lane.
- Android `HTTP API` is a transport mode, not a separate `httpSMS` device type.
- Browser Socket.IO is for dashboard live updates and signaling; it is not a
  direct device transport.
- Do not advertise a capability until the device implementation and a real
  end-to-end result are verified.

For the full operational workflow, read
[PROJECT_KNOWLEDGE.md](./PROJECT_KNOWLEDGE.md).

