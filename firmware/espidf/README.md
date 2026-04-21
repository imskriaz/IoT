# ESP-IDF Firmware

Single main firmware lane for the Waveshare ESP32-S3-A7670E-4G board.

## Active Path

- main lane: `esp32-s3-a7670e`

## Rules

- prefer native ESP-IDF and FreeRTOS primitives
- keep the runtime small, dynamic, and profile-driven
- validate on real hardware before keeping module code
- keep the main lane clean and product-focused
- keep heavy orchestration on the dashboard when hardware-local execution is not required
- keep device runtime selective, serialized, and resource-aware
- use dashboard durability and queue logic before adding firmware complexity
- keep firmware focused on hardware execution, transport arbitration, and compact status/events

## Shared Docs

- [Main Lane README](/d:/Projects/IoT/firmware/espidf/esp32-s3-a7670e/README.md)
- [Docs Index](/d:/Projects/IoT/firmware/docs/README.md)
- [Runtime Rulebook](/d:/Projects/IoT/firmware/docs/RULEBOOK.md)
- [Runtime Implementation Plan](/d:/Projects/IoT/firmware/docs/RUNTIME_IMPLEMENTATION_PLAN.md)
- [Vendor Bundle README](/d:/Projects/IoT/firmware/docs/vendor/esp32-s3-a7670e/README.md)
