# Runtime Rulebook

This document is the operating rulebook for the single-lane dashboard + firmware system.

It exists to keep the ESP32-S3-A7670E firmware small, reliable, and selective, while pushing heavy orchestration to the dashboard where CPU, RAM, storage, retries, and audit history are cheaper.

For the file-by-file execution roadmap, use [Runtime Implementation Plan](/d:/Projects/IoT/firmware/esp32-s3-a7670e/docs/RUNTIME_IMPLEMENTATION_PLAN.md).

## Core Rules

- The target board profile is fixed and must be designed for explicitly:
  - ESP32-S3R8 dual-core Xtensa LX7
  - 512KB SRAM and 384KB ROM
  - 8MB PSRAM
  - 16MB flash
  - integrated 2.4GHz Wi-Fi and Bluetooth LE
  - A7670E-FASE modem with SMS, telephony, GNSS, and 4G/2G data
  - battery, charging, storage, camera, USB switching, and future expansion hardware
- The dashboard is the orchestration tier. The device is the execution tier.
- Heavy lifting belongs on the dashboard unless the hardware must do it locally.
- The device should only do work that requires physical access to the modem, Wi-Fi radio, GPIO, storage, sensors, or local safety decisions.
- Dashboard runtime operations must go through MQTT.
- USB/serial is for debug, provisioning, recovery, and controlled config only. It is not a normal runtime path.
- Wi-Fi is the preferred internet path. Modem is the fallback path.
- When dashboard behavior depends on firmware support or vendor constraints, verify the exact capability in firmware and `/docs` before exposing or assuming the runtime action.
- The firmware must stay selective. If a feature can be delegated safely to the dashboard, do not add that workload to the device.
- Device RAM and CPU are budgeted resources. Avoid large stack allocations, duplicate JSON work, and polling loops that can be replaced with dashboard logic or event-driven flow.
- All command execution must be serialized through queues so the modem, MQTT bridge, storage writes, and telephony actions do not race each other.
- The firmware must favor deterministic behavior over feature breadth.
- Design for future modules from the start: camera, NFC, display, GNSS, storage, audio, and Bluetooth must fit without requiring a later rewrite into a monolithic manager.

## Hardware-Aware Rules

- Use the dual-core MCU intentionally, but do not pin tasks blindly just because a second core exists.
- Keep clear execution lanes so Wi-Fi, modem, SMS, storage, telemetry, camera, display, and Bluetooth can grow without fighting for the same task or state.
- Prefer multiple narrow managers with explicit ownership over one large god-object manager.
- Avoid one shared "do everything" runtime loop.
- Keep ISR work tiny and defer real work to bounded tasks or queues.
- Treat internal SRAM as the scarce low-latency pool and PSRAM as the large-but-less-trusted pool.
- Use internal SRAM first for:
  - control-task stacks
  - flash/NVS-sensitive code paths
  - radio/control buffers that must remain predictable
  - queue metadata and synchronization primitives
- Use PSRAM for:
  - reusable large buffers
  - payload scratch space
  - status serialization buffers
  - optional caches
  - future camera/display frame or asset buffers
- Do not assume PSRAM is safe for every stack or every flash-disabled code path.
- Document any task that is allowed or forbidden to rely on PSRAM-backed memory.

## Delegation Rules

Move these responsibilities to the dashboard by default:

- retries
- durable queue storage
- long-lived pending state
- scheduling
- bulk import/export
- search/filter/sort/grouping
- history timelines
- dashboards, summaries, and aggregations
- stale-data cleanup and freshness policy
- cross-device coordination
- operator/admin workflows
- heavy validation that does not require hardware

Keep these responsibilities on the device:

- modem AT execution
- SMS send/read/delete on the modem
- Wi-Fi connect/scan state
- internet path switching decision
- storage read/write on local media
- GPIO, camera, audio, sensor, and telephony primitives
- short local health and safety decisions
- minimal command parsing and result publishing

## Queue Rules

- The dashboard owns the durable command queue.
- The device owns only small in-memory execution queues.
- There must be one clear queue owner per stage.
- A dashboard queue item may wait for a device result, but the device must not duplicate dashboard durability.
- Device queues should be bounded, domain-specific, and shallow.
- Queue overflow must fail clearly, not silently.
- Every command must have an idempotency story.
- Every command must have an explicit timeout, retry policy, and terminal state.
- Commands that touch the same hardware lane must serialize.

## Race-Control Rules

- Never let Wi-Fi management, modem data management, MQTT transport switching, and telephony commands fight for the same modem/control path at the same time.
- Never run multiple modem-control operations concurrently.
- Never let status refresh flood the same path used for real commands.
- Never mix transport failover logic with user command execution without state gating.
- Use state machines and explicit ownership, not incidental timing.
- Add hysteresis and cooldown windows for internet-path switching so the device does not flap between Wi-Fi and modem.
- Separate high-frequency health sampling from heavyweight status serialization.

## Device Resource Rules

- Keep stack use conservative, especially in `main`, telemetry, MQTT, and modem tasks.
- Prefer static/shared buffers for repeated JSON/status work where safe.
- Avoid building large JSON payloads on small control-task stacks.
- Prefer event-driven updates over periodic full snapshots.
- Stable runtime loops should back off when their hot path is already event-driven. Keep fast polling only where the hardware/API requires it, such as modem-side MQTT receive or bounded retry windows.
- Do not keep a dedicated task alive for bookkeeping-only heartbeat updates. If a module has no background hardware work, publish its health from real activity or from an existing owning lane.
- Keep per-task responsibilities narrow.
- Keep telemetry light and bounded.
- Keep logs useful but not chatty enough to destabilize runtime.
- Every long-lived task must justify its stack size, core placement, queue depth, and buffer ownership.
- Reusable large buffers should live in one owned place, not be duplicated across modules.
- Avoid duplicate copies of large payload history, JSON scratch buffers, and modem/MQTT payload buffers.
- Prefer lazy allocation or shared owned buffers for debug/status paths that are not always active.
- Runtime paths must not depend on debug buffers staying resident in scarce internal RAM.

## Resource-Manager Rules

- A `resources_manager` is allowed only if it stays simple, measurable, and low-risk.
- Do not build a generic abstraction layer that hides ownership, timing, or hardware constraints.
- The purpose of resource management is budgeting and coordination, not centralizing all logic.
- If a `resources_manager` is added, it should own only:
  - memory-budget reporting
  - task/buffer budget notes
  - shared resource reservations
  - pressure signals and diagnostic snapshots
- It must not become:
  - a second scheduler
  - a second queue system
  - a second state machine for every module
  - a dumping ground for unrelated helpers
- Prefer explicit per-lane ownership plus a thin budget/visibility layer over a complex runtime resource framework.
- Reliability is more important than theoretical flexibility.
- Performance optimizations that increase hidden coupling or debugging difficulty should be rejected.

## Scalability Rules

- New modules must plug into existing execution lanes or add a new narrow lane with explicit ownership.
- Camera, display, NFC, GNSS, and future features must not force SMS, modem, or Wi-Fi paths to share large hot loops.
- Keep command contracts compact so adding features does not inflate the baseline runtime cost for unrelated modules.
- Make optional modules cold by default: if unused, they should consume minimal CPU, memory, and chatter.
- Protect baseline communication paths first: Wi-Fi, modem, MQTT, SMS, config, and storage must remain reliable even after adding new peripherals.

## Network Rules

- Wi-Fi first, modem fallback.
- Internet switching must be automatic but conservative.
- The active path should change only when the preferred path is truly healthy and stable.
- Do not tear down a healthy modem MQTT session unless Wi-Fi is confirmed usable.
- Do not let repeated Wi-Fi scans starve modem work.
- Dashboard status should prefer on-demand refresh plus a slow heartbeat, not aggressive polling.
- Treat hotspot `RiazM` as a user-managed dependency for Wi-Fi validation. If `RiazM` is offline, not visible, or otherwise unavailable, pause Wi-Fi-dependent coding, provisioning, and testing, ask the user to enable it, and wait before continuing that Wi-Fi-dependent work.
- If Android auto-turns hotspot or Wi-Fi off during testing, do not code around that condition or assume a firmware bug. Ask the user to turn it back on and wait before continuing Wi-Fi-dependent work.
- Distinguish hotspot availability problems from device auth/reconnect problems. If the target SSID is visible but the device is failing authentication or reconnect, continue debugging the Wi-Fi path instead of treating it as a missing-hotspot case.

## Status Rules

- Status is a product contract, not a debug dump.
- Publish only the fields the dashboard needs for runtime decisions and operator visibility.
- Prefer on-demand `get-status` plus a periodic heartbeat.
- Use event pushes for meaningful state changes.
- When the device observes status on a shorter loop than the operator heartbeat window, prefer change-aware publishing with a slower forced heartbeat over unconditional full-status publishes every cycle.
- Do not keep background event publication loops alive if nothing consumes those events.
- Do not rely on frequent full snapshots for correctness.
- Stale status must be detected and shown as stale, not guessed.

## SMS Rules

- SMS send, read, and delete belong to the device.
- SMS scheduling, retries, templates, export, bulk import, thread assembly, and unread summaries belong to the dashboard.
- SMS encoding analysis, Unicode/Bangla part counting, and single-vs-multipart command selection belong to the dashboard whenever the dashboard already has the full message text.
- Do not add firmware-side preprocessing for SMS logic that the dashboard can determine safely before dispatch. Keep firmware focused on modem-safe execution and vendor-specific constraints.
- The device should publish compact incoming/outgoing result events.
- The dashboard should persist SMS history and derive UI state from that data.
- The SMS path must remain single-executor on the device so modem text-mode operations do not collide.

## Config Rules

- Runtime operations use MQTT.
- Config/provision/debug may use serial, Bluetooth, controlled Wi-Fi, or other explicit recovery paths.
- Config writes should be rare, compact, and explicit.
- The dashboard should validate config before asking the device to apply it.
- The device should apply config atomically and report exactly what changed.

## Audit Summary

Current codebase findings that shape this rulebook:

- The dashboard already has a durable queue and per-device serialization in [mqttService.js](/d:/Projects/IoT/dashboard/services/mqttService.js).
- The firmware already has a slim command bridge and in-memory command queue in [automation_bridge.c](/d:/Projects/IoT/firmware/esp32-s3-a7670e/espidf/components/automation_bridge/src/automation_bridge.c).
- Transport switching is already handled in firmware MQTT runtime code in [mqtt_mgr.c](/d:/Projects/IoT/firmware/esp32-s3-a7670e/espidf/components/mqtt_mgr/src/mqtt_mgr.c), but it should be treated as a formal state machine with stronger anti-flap rules.
- Full status JSON work is still expensive enough to matter on-device, as shown by the recent stack-overflow regression around [device_status.c](/d:/Projects/IoT/firmware/esp32-s3-a7670e/espidf/components/device_status/src/device_status.c) and [app_main.c](/d:/Projects/IoT/firmware/esp32-s3-a7670e/espidf/main/app_main.c).
- Telemetry is still periodic in [telemetry_service.c](/d:/Projects/IoT/firmware/esp32-s3-a7670e/espidf/components/telemetry_service/src/telemetry_service.c); this should become more selective and event-aware over time.

## Target Operating Model

### Dashboard Owns

- device command durability
- retries and exponential backoff
- pending state and recovery after restart
- schedule execution
- stale/offline reconciliation
- bulk workflows
- inbox/sent/thread assembly
- user-facing validation and shaping
- data retention and reporting
- queue inspection and operator tooling

### Firmware Owns

- local hardware execution
- bounded command intake
- local hardware safety
- path-selection state
- event publication
- compact status publication
- minimal local persistence required for hardware continuity

## Detailed Redesign Plan

### Phase 1: Lock the Contract

- Freeze the runtime rule that dashboard does orchestration and firmware does execution.
- Document the command ownership matrix for SMS, calls, storage, GPIO, status, Wi-Fi, modem, and config.
- Keep the firmware MQTT contract compact and versioned.
- Remove any remaining dashboard logic that assumes serial runtime fallback.

### Phase 2: Make Queue Ownership Explicit

- Dashboard durable queue stays the single source of truth for pending runtime commands.
- Split queue policy by domain:
  - telephony lane
  - network lane
  - storage lane
  - low-risk status lane
- Add queue conflict rules:
  - telephony commands serialize with each other
  - network reconfiguration blocks until telephony-safe
  - status refresh never jumps ahead of critical commands
- Make device queue depth visible in dashboard health.

### High-Value Command Order

- Keep telephony control first:
  - `end-call`
  - `reject-call`
  - `answer-call`
  - `make-call` / `call-dial`
- Keep message actions next:
  - `send-sms`
  - `send-ussd`
- Keep connectivity reconfiguration behind active telephony:
  - `config-set` for runtime Wi-Fi/modem keys
  - `wifi-reconnect`
- Keep recovery and routing inspection behind the above:
  - `internet-status`
  - `hotspot-clients`
  - `wifi-scan`
- Keep low-risk observability last:
  - `get-status`
  - `gps-status`
  - `storage-info`

- Dashboard priority should stay aligned with the current durable queue defaults in [mqttService.js](/d:/Projects/IoT/dashboard/services/mqttService.js):
  - `telephony` domain: `50`
  - `network` domain: `80`
  - `control` domain: `100`
  - `storage` domain: `110`
  - `status` domain: `250`
- The intent is simple:
  - call teardown/answer must not be delayed by Wi-Fi retries or status refreshes
  - SMS and USSD must stay serialized with telephony-safe modem ownership
  - network recovery must not starve transport, but it also must not break an active call lane
  - status and inspection work must always yield to real operator actions

### Phase 3: Formalize Firmware Execution Lanes

- Keep separate firmware lanes for:
  - modem control
  - MQTT transport
  - SMS service
  - Wi-Fi manager
  - telemetry/status
- Prevent cross-lane command execution without explicit handoff.
- Reduce shared mutable state and tighten ownership boundaries.

### Phase 4: Smarter Internet Failover

- Build a formal internet-path state machine:
  - wifi_primary
  - wifi_candidate
  - modem_primary
  - recovery
  - offline
- Require stability windows before switching back to Wi-Fi.
- Add cooldown after failed Wi-Fi attempts.
- Do not rescan or reconnect aggressively while modem fallback is healthy.
- Publish path-change events so the dashboard updates without polling.

### Phase 5: Smarter Status Model

- Keep the 1-minute timer as a safety heartbeat.
- Prefer on-demand `get-status` on page load, manual refresh, and selected high-value UI actions.
- Push event updates for:
  - path changes
  - queue transitions
  - SMS received
  - SMS sent result
  - call state
  - storage health changes
- Reduce repeated full status serialization on the device.

### Phase 6: SMS Hardening

- Keep modem SMS read/send/delete in firmware only.
- Keep scheduling, resend policy, template logic, inbox grouping, and export in dashboard only.
- Ensure the device serializes all SMS-related modem operations.
- Make incoming SMS publication compact and deterministic.
- Keep fallback unread scanning as a recovery tool, not the primary path.

### Phase 7: Resource Budgeting

- Audit every long-lived task for:
  - stack size
  - heap pressure
  - PSRAM suitability
  - flash/NVS safety
- Move reusable buffers out of fragile stacks where needed.
- Avoid full JSON creation in latency-sensitive or tiny-stack contexts.
- Add task-level notes for which tasks may and may not use PSRAM-backed stacks.
- Add a living budget for:
  - internal SRAM
  - PSRAM
  - task stacks
  - shared buffers
  - optional module headroom for camera/display/NFC growth
- Track where duplication exists before adding new features.
- Prefer reducing duplication before increasing baseline memory budgets.

### Phase 8: Dashboard Redesign For Stability

- Keep dashboard as the place for derived state and operator UX.
- Centralize command submission policy in one service path.
- Centralize status freshness policy in one normalizer.
- Centralize queue conflict policy in one queue manager path.
- Avoid page-specific command shortcuts that bypass the common command/queue flow.

### Phase 9: Validation Gates

- Every major runtime change must pass:
  - device boot stability
  - MQTT reconnect
  - Wi-Fi to modem failover
  - modem to Wi-Fi recovery
  - queued SMS send
  - incoming SMS receive
  - stale-status handling
  - dashboard restart with queue recovery
- No feature is considered done if it only works after a manual refresh or only through debug transport.

## No-Rework Checklist

- Define ownership before coding.
- Define queue behavior before wiring UI actions.
- Define timeout/retry/idempotency before adding a command.
- Define status freshness rules before exposing a new field to the dashboard.
- Define resource budget before adding a long-lived firmware task.
- Define ownership, memory budget, and queue impact before adding any new hardware module.
- Validate live on hardware before keeping new runtime complexity.

## Immediate Implementation Priorities

- keep dashboard queue as the only durable runtime queue
- keep firmware command execution thin and serialized
- reduce full-status work where event updates are enough
- formalize internet failover hysteresis
- prevent low-value status traffic from competing with real device work
- keep SMS reliable with device-side single-lane execution and dashboard-side orchestration
