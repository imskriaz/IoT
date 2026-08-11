---
title: IoT project documentation
status: active
last_reviewed: 2026-08-11
format: Markdown with optional YAML front matter
---

# IoT project documentation

This is the documentation entry point for the repository. Start with the
[project knowledge base](./PROJECT_KNOWLEDGE.md), then open the detailed
reference that matches the work.

## Start here

- [Current online dashboard](https://device.madebydevs.com/) — the public URL
  for the active setup.
- [Project knowledge base](./PROJECT_KNOWLEDGE.md) — current architecture,
  supported behavior, build/flash workflow, recovery, and validation gates.
- [Device types](./DEVICE_TYPES.md) — the two supported device families and
  their transport boundaries.
- [ESP32 runtime rulebook](../espidf/esp32-s3-a7670e/docs/RULEBOOK.md) —
  ownership, queue, race-control, memory, and network rules.
- [ESP32 implementation plan](../espidf/esp32-s3-a7670e/docs/RUNTIME_IMPLEMENTATION_PLAN.md)
  — file-level redesign and acceptance plan.
- [Android bridge contract](../android/docs/ANDROID_SMS_BRIDGE.md) — Android
  provisioning, permissions, identity, and transport behavior.
- [Server/tunnel guide](../../server/CLOUDFLARE_TUNNEL.md) — public access for
  a dashboard that runs locally.

## Source-of-truth order

When documents disagree, use this order:

1. Actual code and automated tests.
2. The vendor references under
   `firmware/espidf/esp32-s3-a7670e/docs/vendor/` for board and modem limits.
3. This knowledge base for the current operational workflow.
4. The runtime rulebook and implementation plan for architecture and planned
   changes.
5. Older READMEs, examples, and vendor demo code only as historical reference.

Never treat a dashboard-queued command, a serial-only test, or a vendor demo
as proof of a complete device runtime path.

## Documentation format

Keep new project knowledge as small Markdown pages with:

```yaml
---
title: Short descriptive title
status: active | draft | historical | blocked
last_reviewed: YYYY-MM-DD
source_of_truth: code | vendor | operational-test | design
---
```

Use stable headings, repository-relative links, copyable commands, and explicit
failure/blocker notes. Record hardware evidence with the date, board, port,
firmware version, command, expected result, observed result, and next action.
