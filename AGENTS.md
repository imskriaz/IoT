# Agent Instructions

Use this file as the default Codex reference for this repo before changing dashboard,
firmware, or device contracts.

## Active Repo Paths

- ESP32 active firmware: `firmware/espidf/esp32-s3-a7670e`
- Dashboard server: `dashboard`
- Android bridge app: `firmware/android`
- Flutter UI: `firmware/android/flutter_ui`
- Repo docs index: `firmware/docs/README.md`
- ESP32 runtime rulebook: `firmware/espidf/esp32-s3-a7670e/docs/RULEBOOK.md`
- ESP32 runtime plan: `firmware/espidf/esp32-s3-a7670e/docs/RUNTIME_IMPLEMENTATION_PLAN.md`
- ESP32 vendor docs: `firmware/espidf/esp32-s3-a7670e/docs/vendor/`

## Source Of Truth

- For ESP32 firmware behavior, board wiring, modem AT behavior, and hardware limits,
  check the vendor docs under `firmware/espidf/esp32-s3-a7670e/docs/vendor/`
  before assuming support.
- For runtime ownership and architecture decisions, follow
  `firmware/espidf/esp32-s3-a7670e/docs/RULEBOOK.md`.
- For file-by-file implementation direction, follow
  `firmware/espidf/esp32-s3-a7670e/docs/RUNTIME_IMPLEMENTATION_PLAN.md`.
- When dashboard behavior depends on firmware support or vendor constraints, verify the
  capability in firmware and docs before exposing or assuming the action.

## Completion Standard

- Treat every task as end-to-end unless the user explicitly limits scope. Do all
  known follow-up work in the same session: dashboard, backend, firmware,
  device contract, persistence, reporting, tests, and live validation where
  hardware access allows it.
- Before calling a task complete, sweep the likely edge cases: offline and stale
  devices, reconnects, retries, duplicate events, partial payloads, missing
  fields, failed hardware commands, storage-full or queue-full states, reboot
  recovery, and dashboard refresh/restart behavior.
- A command is not successful just because the dashboard queued or published it.
  Success must mean the execution tier accepted and completed it, or the report
  must clearly say what remains blocked and why.
- If live hardware validation is blocked, report the exact blocker, keep the code
  and automated tests complete, and leave the next hardware command ready to run.

## ESP32 Firmware Command Workflow

- When working on ESP32 firmware commands, first validate the command from the
  terminal or serial console.
- For any ESP32 command sequence, first run the sequence directly in the serial
  monitor or terminal and confirm the expected response, timing, and failure
  behavior there before testing it through firmware, MQTT, or dashboard flows.
- Add the command to firmware only after it works correctly outside the firmware
  and the expected response, timing, and failure behavior are understood.
- Prefer this terminal-first check before build, flash, and boot trial cycles to
  avoid unnecessary firmware trial and error.
- Do not treat a debug-only or serial-only success as proof that the runtime MQTT
  command path is complete.
- After the direct serial or terminal sequence is confirmed, run the higher-level
  runtime test separately to verify the real firmware and MQTT path.

## ESP32 Runtime Rules

- The ESP32-S3 MQTT lane is the active runtime path today.
- Keep the current firmware layout as-is: `firmware/espidf/esp32-s3-a7670e`.
- Use Wi-Fi as the primary internet path and the A7670 modem as fallback.
- Use MQTT for normal device operations. Use HTTP only where payload, file,
  media, or OTA transfer materially benefits from it.
- USB/serial is for debug, provisioning, recovery, and controlled config; it is
  not a normal runtime transport.
- Credentials must not be hardcoded into firmware.
- The dashboard is the orchestration tier. The device is the execution tier.
- Heavy lifting belongs on the dashboard unless the hardware must do it locally.
- Firmware should do only work that requires local modem, Wi-Fi, GPIO, storage,
  sensor, telephony, or safety access.
- Keep firmware selective, deterministic, queue-driven, and race-aware.
- All commands that touch the same hardware lane must serialize.
- Never run multiple modem-control operations concurrently.
- Status refresh must not flood or compete with real commands.
- Prefer event-driven updates and compact status over repeated full snapshots.
- Treat internal SRAM as scarce. Avoid large stack allocations, duplicate JSON
  work, and long-lived tasks without clear ownership.
- Use PSRAM for large reusable buffers or optional caches only where safe; do not
  assume it is safe for every task stack or flash-disabled path.

## Dashboard And Firmware Ownership

- Dashboard owns durable queues, retries, scheduling, pending state, stale/offline
  reconciliation, bulk workflows, user-facing validation, history, reporting, and
  operator tooling.
- Firmware owns bounded local execution, hardware safety, compact event/status
  publication, path selection, and minimal local persistence required for hardware
  continuity.
- SMS send, read, and delete belong to firmware.
- SMS scheduling, retries, templates, export, bulk import, thread assembly,
  unread summaries, Unicode/Bangla analysis, and multipart selection belong to
  the dashboard when the dashboard already has the full message text.
- Call support on the active ESP32 lane is limited to implemented and verified
  actions such as dial and hangup. Do not assume hold, resume, mute, answer, or
  reject support without firmware implementation and vendor-doc validation.

## Build And Validation

- Build ESP32 firmware with `.\.toolchain\build-firmware.ps1`.
- Flash ESP32 firmware with `.\.toolchain\flash-firmware.ps1 -Port COM5`.
- Dashboard status validation uses
  `firmware/espidf/esp32-s3-a7670e/verify-status-payload.js`.
- Major runtime changes should validate boot stability, MQTT reconnect, Wi-Fi to
  modem failover, modem to Wi-Fi recovery, queued SMS send, incoming SMS receive,
  stale-status handling, and dashboard restart with queue recovery.
- No feature is done if it only works after manual refresh or only through debug
  transport.

## Wi-Fi Test Dependency

- Treat hotspot `RiazM` as a user-managed dependency for Wi-Fi validation.
- If `RiazM` is offline, hidden, or unavailable, pause Wi-Fi-dependent testing and
  ask the user to enable it instead of coding around that condition.
- If the target SSID is visible but auth or reconnect fails, continue debugging
  the Wi-Fi path as a device or credential issue.
