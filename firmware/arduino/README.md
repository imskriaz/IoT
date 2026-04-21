# Arduino Firmware

This folder contains the Arduino-based device firmware implementations.

Current device folders:

- `esp32-s3-a7670e`

Notes:

- Shared Arduino headers and services still live in `firmware/common/`.
- Diagnostic sketches still live in `firmware/diag/`.
- Use `firmware/build.sh` to build Arduino firmware variants.
- This lane remains the live production baseline while the ESP-IDF port is developed in parallel.
