# Android Device Bridge

This document describes the supported Android bridge in this repo. It replaces the earlier experimental notes that borrowed ideas from external SMS apps.

## Purpose

The Android app in [firmware/android](/d:/Projects/IoT/firmware/android) is a first-party `Device Bridge` client that turns an Android phone into a dashboard-managed SMS and status bridge.

Supported transport modes:

- `MQTT`
- `HTTP API`

Both transports use the same device identity, dashboard ownership model, queue rules, and permission model.

## What The App Does

- sends SMS through the phone
- receives inbound SMS and forwards it to the dashboard
- reports delivery and failure events
- publishes health and device status
- exposes battery, storage, network, IMEI, device identity, and dual-SIM telemetry
- accepts dashboard provisioning by encoded setup token or QR

## Provisioning Contract

The dashboard generates an opaque encoded setup code for Android devices.

The token contains:

- device identity
- selected transport mode
- server URL for HTTP mode
- device-scoped API key for HTTP mode
- MQTT broker details for MQTT mode

The app should onboard directly from QR scan or setup token import. Raw secrets are not shown in the dashboard UI when Android recovery QR is generated.

## Device Identity

Android devices should be registered as:

- type/model: `android-sms-bridge`
- lane: `android`

The dashboard no longer supports a separate `httpSMS` device type. If Android uses HTTP, that is still an Android device, not a different product lane.

## Permission Model

The app permission flow is user-triggered and recovery-aware.

Primary permissions:

- `SEND_SMS`
- `RECEIVE_SMS`
- `READ_SMS`
- `POST_NOTIFICATIONS`
- `READ_PHONE_STATE`
- `READ_PHONE_NUMBERS`

Operational expectations:

- ask for permissions during onboarding and from Support Center later
- explain why each permission is needed
- keep the bridge visible through app UI and foreground-service behavior
- guide the operator to app settings only after the runtime prompt path is exhausted

## Dashboard Expectations

The dashboard expects Android to provide:

- SMS queue pickup and delivery reporting
- device heartbeat and last-seen state
- battery and charging state
- storage totals and queue depth
- Wi-Fi and cellular identity
- IMEI and device model identity
- dual-SIM slot data and active slot selection

## Dual-SIM Rules

When the phone reports two SIMs, the dashboard can expose SIM-aware views and send preferences.

Recommended Android behavior:

- publish all detected SIM slots in status
- include slot index, subscription id, carrier/operator, number when available
- mark preferred/default SMS, data, and voice subscriptions
- honor requested `sim_slot` or `subscription_id` when sending SMS
  Legacy aliases like `simSlot` can still be accepted for backward compatibility, but the MQTT contract should emit only `sim_slot`.

## Boundary

This repo supports two device families only:

- ESP32 firmware devices
- Android Device Bridge devices

`HTTP API` is an Android transport option, not a separate device family.
