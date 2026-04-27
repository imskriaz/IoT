# Runtime Implementation Plan

This plan turns the runtime rulebook into an execution roadmap for the single-lane dashboard + firmware system.

It is intentionally selective:

- dashboard does orchestration, durability, retries, aggregation, and operator UX
- firmware does hardware-local execution, transport control, compact status, and safety decisions
- MQTT is the normal runtime path
- serial/Bluetooth/other debug paths are for provisioning, controlled config, recovery, and diagnosis only

Use this document before adding or redesigning any runtime feature.

## Goals

- keep the firmware lean enough to stay stable under modem, Wi-Fi, MQTT, and SMS load
- prevent race conditions between modem control, status refresh, transport failover, and SMS/telephony work
- reduce repeated JSON and polling cost on the device
- make dashboard behavior the main source of derived state, queue durability, and operator workflow
- avoid rework by locking ownership and change order before implementation

## Architecture Summary

### Dashboard Responsibilities

- durable command queue
- retry and backoff policy
- stale/offline detection and freshness policy
- schedule execution
- SMS inbox/sent history, thread assembly, export, import, search, filters
- operator-facing validation and shaping
- system settings and environment override policy
- queue inspection and recovery after restart
- cross-page status normalization

### Firmware Responsibilities

- command intake from MQTT
- bounded in-memory execution queues
- modem AT control
- Wi-Fi scanning and connection control
- internet path selection
- SMS send/read/delete on modem
- compact status generation
- hardware-local persistence only where needed for continuity
- hardware event publication

## Ownership Matrix

| Domain | Dashboard Owns | Firmware Owns | Notes |
|---|---|---|---|
| Status | freshness policy, stale handling, normalization, UI rendering | compact status snapshot, event publication | dashboard should not infer live hardware state from stale cache |
| MQTT commands | durability, retries, idempotency, queue policy | command consume, execute, reply | dashboard is source of truth for pending work |
| Wi-Fi | config validation, operator workflow | scan, connect, disconnect, health check | firmware decides if Wi-Fi is truly usable |
| Modem data | operator workflow, visible state | PDP/data attach, modem MQTT fallback | no dashboard-side modem sequencing guesses |
| Internet switching | policy thresholds and config surface | actual state machine and switch execution | firmware must publish path-change events |
| SMS | templates, schedule, queueing, thread view, export, unread summaries | send, read, delete, compact events | device remains single executor for SMS/modem text mode |
| Calls/telephony | UX flow, history, derived state | dial/answer/hangup and modem call state | telephony lane must serialize with SMS as needed |
| Storage | browsing UX, bulk actions, retention policy | local read/write/delete primitives | storage operations should not bypass queue policy |
| Config | validation, source-of-truth rules, override precedence | apply config atomically, report effective values | runtime config must not be mixed into normal command path |

## Queue Model

### Queue Principles

- one durable queue owner: dashboard
- one execution queue owner per hardware lane: firmware
- no duplicate durability in firmware
- every command must have timeout, retry story, idempotency story, and terminal state

### Dashboard Queue Domains

- `telephony`
  - `send-sms`
  - call actions
  - USSD
- `network`
  - Wi-Fi connect/disconnect
  - modem restart
  - explicit connectivity tests
- `storage`
  - file writes, deletes, copy/move/format
- `status`
  - `get-status`
  - low-priority inspection commands
- `system`
  - restart, OTA, device-wide maintenance actions

### Firmware Execution Lanes

- `modem_control`
  - AT command owner
  - must not run concurrent modem-control work
- `sms_lane`
  - send/read/delete and unread recovery
  - serializes through modem control
- `telephony_lane`
  - call and USSD actions
  - arbitrates with `sms_lane`
- `wifi_lane`
  - scan/connect/disconnect health checks
- `transport_lane`
  - MQTT transport bring-up/teardown
  - owns path switching state machine
- `status_lane`
  - compact snapshot build
  - low priority, never starves command execution

### Conflict Rules

- `telephony_lane` and `sms_lane` cannot run overlapping modem text/voice actions
- `network` commands never preempt active telephony unless explicitly marked safe
- `get-status` never jumps ahead of critical telephony or recovery actions
- transport switching must not destroy an active healthy path until the next path is confirmed usable
- dashboard retries must honor firmware busy state and lane ownership

## Device Resource Rules

### CPU And Task Rules

- keep long-lived tasks narrow in responsibility
- keep telemetry/status work low priority
- avoid background loops that duplicate state already known by dashboard
- prefer event pushes over repeated full snapshots

### RAM And Buffer Rules

- avoid large stack allocations in `main`, `mqtt_mgr`, `telemetry_service`, `automation_bridge`, and modem workers
- use shared static buffers only where access ownership is clear
- use PSRAM for large or infrequent buffers when latency tolerance allows it
- keep command payload budgets realistic and aligned to actual contract size

### Suggested Budget Discipline

- tiny control tasks: parsing, routing, heartbeat only
- medium tasks: short modem and Wi-Fi orchestration
- large stacks only where unavoidable and documented
- JSON generation only in bounded buffers with explicit truncation/error paths

## Internet Path Strategy

### Preferred Runtime Model

- Wi-Fi is primary when confirmed healthy
- modem MQTT is fallback when Wi-Fi is unavailable or unhealthy
- USB/serial is never a normal runtime data path

### Proposed State Machine

- `offline`
- `wifi_candidate`
- `wifi_primary`
- `modem_candidate`
- `modem_primary`
- `recovery_cooldown`

### State Rules

- only enter `wifi_primary` after Wi-Fi passes stability checks
- only tear down modem fallback after Wi-Fi remains healthy for a hold period
- enter `modem_candidate` only after Wi-Fi failure threshold is crossed
- do not rescan aggressively while `modem_primary` is healthy
- after repeated Wi-Fi failures, stay in `recovery_cooldown` before trying again
- publish explicit path-change and path-health events

### Health Inputs

- Wi-Fi association state
- IP acquisition
- broker reachability
- recent MQTT publish/subscribe success
- modem data attach/PDP state
- modem MQTT connect state
- recent path switch failures

## Status And Telemetry Strategy

### Target Model

- one-minute heartbeat remains as a safety net
- on-demand `get-status` on:
  - dashboard load
  - dashboard device switch
  - manual refresh
  - selected page open
  - selected operator actions
- event-driven updates for:
  - internet path changes
  - MQTT up/down
  - queue transitions
  - SMS received
  - SMS send result
  - telephony state changes
  - storage health changes

### Firmware Status Contract

- include only fields required for:
  - header
  - dashboard home
  - modem/network view
  - queue visibility
  - SMS health
  - module health
- exclude bulky debug-only fields from normal status payload
- keep status generation bounded and cheap

### Dashboard Freshness Rules

- stale heartbeat must blank live-only fields instead of guessing
- page-specific views must consume the shared normalizer
- no page should reintroduce raw cached connectivity data after the normalizer marks it stale

## SMS Design

### Dashboard-Side

- schedule and retry policy
- thread assembly
- unread summaries
- import/export
- templates
- operator search and filtering
- durable send queue

### Firmware-Side

- single SMS executor through modem control
- compact incoming event publication
- compact send-result publication
- unread fallback scan only as recovery, not primary flow
- explicit counters and last-error detail in status

### SMS Acceptance Rules

- one send path
- one receive path
- one delete path
- no duplicate inbox creation from fallback scans
- no dashboard feature may imply multipart support unless firmware contract truly supports it
- when the dashboard already has the full SMS body, Unicode/Bangla analysis and multipart selection should be decided there instead of adding extra preprocessing load to firmware
- keep firmware SMS logic limited to modem execution details, serialization, and vendor-required constraints

## Config And Provisioning Strategy

### Config Sources

- system settings in dashboard
- device settings in dashboard
- serial/Bluetooth/recovery paths for provisioning or emergency correction

### Precedence

- dashboard system settings define global policy
- device settings override only device-specific fields
- firmware persists only effective applied values it needs locally

### Runtime Boundary

- config writes are explicit and rare
- config is not part of ordinary status polling
- runtime operations must continue over MQTT after config completes

## File-Level Implementation Roadmap

### Phase A: Lock Shared Contracts

Files:

- [RULEBOOK.md](/d:/Projects/IoT/firmware/esp32-s3-a7670e/docs/RULEBOOK.md)
- [RUNTIME_IMPLEMENTATION_PLAN.md](/d:/Projects/IoT/firmware/esp32-s3-a7670e/docs/RUNTIME_IMPLEMENTATION_PLAN.md)
- [dashboard/services/mqttService.js](/d:/Projects/IoT/dashboard/services/mqttService.js)
- [firmware/esp32-s3-a7670e/espidf/components/shared_models/include/action_models.h](/d:/Projects/IoT/firmware/esp32-s3-a7670e/espidf/components/shared_models/include/action_models.h)
- [firmware/esp32-s3-a7670e/espidf/components/api_bridge/include/api_bridge.h](/d:/Projects/IoT/firmware/esp32-s3-a7670e/espidf/components/api_bridge/include/api_bridge.h)

Deliverables:

- command ownership table reflected in code comments or docs
- command categories normalized in dashboard queue service
- payload budgets documented against actual firmware limits

### Phase B: Harden Dashboard Queue Ownership

Files:

- [dashboard/services/mqttService.js](/d:/Projects/IoT/dashboard/services/mqttService.js)
- [dashboard/routes/status.js](/d:/Projects/IoT/dashboard/routes/status.js)
- [dashboard/utils/dashboardStatus.js](/d:/Projects/IoT/dashboard/utils/dashboardStatus.js)

Deliverables:

- queue domains made explicit
- busy/device lane suppression made visible to callers
- `get-status` treated as low-priority, non-intrusive command
- no page bypasses the shared queue policy

### Phase C: Slim Firmware Command Intake

Files:

- [firmware/esp32-s3-a7670e/espidf/components/automation_bridge/src/automation_bridge.c](/d:/Projects/IoT/firmware/esp32-s3-a7670e/espidf/components/automation_bridge/src/automation_bridge.c)
- [firmware/esp32-s3-a7670e/espidf/components/api_bridge/src/api_bridge.c](/d:/Projects/IoT/firmware/esp32-s3-a7670e/espidf/components/api_bridge/src/api_bridge.c)

Deliverables:

- command parsing remains thin
- dispatch by lane/domain, not by incidental function sequence
- explicit rejection for commands that arrive while a conflicting lane is busy

### Phase D: Formalize Transport State Machine

Files:

- [firmware/esp32-s3-a7670e/espidf/components/mqtt_mgr/src/mqtt_mgr.c](/d:/Projects/IoT/firmware/esp32-s3-a7670e/espidf/components/mqtt_mgr/src/mqtt_mgr.c)
- [firmware/esp32-s3-a7670e/espidf/components/wifi_mgr/src/wifi_mgr.c](/d:/Projects/IoT/firmware/esp32-s3-a7670e/espidf/components/wifi_mgr/src/wifi_mgr.c)
- [firmware/esp32-s3-a7670e/espidf/components/modem_a7670/src/modem_a7670.c](/d:/Projects/IoT/firmware/esp32-s3-a7670e/espidf/components/modem_a7670/src/modem_a7670.c)

Deliverables:

- formal path states
- anti-flap timers and hold periods
- reduced repeated scan/connect churn
- clear reason codes in status for active path choice

### Phase E: Reduce Telemetry Cost

Files:

- [firmware/esp32-s3-a7670e/espidf/components/telemetry_service/src/telemetry_service.c](/d:/Projects/IoT/firmware/esp32-s3-a7670e/espidf/components/telemetry_service/src/telemetry_service.c)
- [firmware/esp32-s3-a7670e/espidf/components/device_status/src/device_status.c](/d:/Projects/IoT/firmware/esp32-s3-a7670e/espidf/components/device_status/src/device_status.c)

Deliverables:

- event-aware publish flow
- compact heartbeat payload
- full snapshot generation only when needed
- bounded shared buffers and no fragile-stack JSON work

### Phase F: SMS Lane Hardening

Files:

- [firmware/esp32-s3-a7670e/espidf/components/sms_service/src/sms_service.c](/d:/Projects/IoT/firmware/esp32-s3-a7670e/espidf/components/sms_service/src/sms_service.c)
- [dashboard/routes/sms.js](/d:/Projects/IoT/dashboard/routes/sms.js)
- [dashboard/public/js/sms.js](/d:/Projects/IoT/dashboard/public/js/sms.js)

Deliverables:

- single firmware SMS executor
- queue-aware dashboard send flow
- compact deterministic incoming events
- no stale cross-device page updates

### Phase G: Stability Consolidation

Files:

- [dashboard/public/js/main.js](/d:/Projects/IoT/dashboard/public/js/main.js)
- [dashboard/services/modemService.js](/d:/Projects/IoT/dashboard/services/modemService.js)
- [dashboard/routes/modem.js](/d:/Projects/IoT/dashboard/routes/modem.js)
- [dashboard/views/pages/index.html](/d:/Projects/IoT/dashboard/views/pages/index.html)

Deliverables:

- one shared freshness policy
- one shared connectivity presentation model
- no stale Wi-Fi/modem/operator/SIM fields after heartbeat expiry

## Acceptance Gates

### Firmware Gates

- boot is stable after repeated restart
- no task stack overflow during status, MQTT, SMS, or modem fallback load
- Wi-Fi and modem do not flap under transient failure
- SMS send does not race with status refresh
- incoming SMS does not duplicate under fallback recovery

### Dashboard Gates

- queue survives dashboard restart
- device switch never paints stale SMS or stale connectivity state
- home page, header, modem page, and device-about page agree on operator/SIM/path state
- page refresh triggers on-demand status without flooding

### End-To-End Gates

- Wi-Fi primary when healthy
- modem fallback when Wi-Fi unavailable
- recovery back to Wi-Fi after hold period
- live `get-status` over active path
- queued SMS send over active path
- incoming SMS appears in dashboard inbox and unread count
- stale device becomes visibly stale, not falsely online

## Change Order

1. lock contracts and queue ownership
2. harden dashboard queue and freshness path
3. formalize firmware transport state machine
4. slim telemetry and status generation
5. harden SMS lane
6. consolidate UI freshness and connectivity views
7. run live end-to-end validation

## Stop Conditions

Pause and realign before continuing if any of these happen:

- a new feature needs firmware durability instead of dashboard durability
- a page bypasses the shared MQTT queue path
- a device task needs a larger stack without a clear budget reason
- a new runtime path depends on serial/USB for normal operation
- status payload size grows because UI wants derived/debug data instead of true live state

## Working Rule

If the dashboard can do it reliably, cheaply, and durably, keep it on the dashboard.

If the device must do it because it touches hardware or local safety, keep it on the device, keep it small, and serialize it carefully.
