# IoT platform

Dashboard/API: `dashboard`. ESP32-S3/A7670E: `firmware/espidf/esp32-s3-a7670e`. Android bridge: `firmware/android`.

Start with the [active goal](ACTIVE_GOAL.md), [agent operations guide](firmware/espidf/esp32-s3-a7670e-idf6.1/docs/AGENT_OPERATIONS_GUIDE.md), and [fresh ESP32 documentation](firmware/espidf/esp32-s3-a7670e/docs/README.md). The canonical plan owns module/resource strategy; its validation ledger records open and failed gates.

Dashboard owns durable orchestration. ESP32 owns bounded physical execution. Wi-Fi is primary, cellular is fallback, MQTT carries device commands/events, HTTP/WebSocket supports dashboard/browser and implemented transfers, and USB/serial supports provisioning/debug/recovery.

Public dashboard: https://device.madebydevs.com/. Availability alone does not prove hardware operation.

## Run locally

From the repository root, start the dashboard/API and Cloudflare tunnel together:

```powershell
npm start
```

The dashboard must already have its dependencies installed in `dashboard/node_modules`.
The launcher waits for `http://127.0.0.1:3001/health` before opening the tunnel and
stops both processes when either one exits. The dashboard's `.env` currently selects
the remote MQTT broker, so this command does not start a local MQTT service.

See [firmware build instructions](firmware/espidf/esp32-s3-a7670e/README.md). Repository-local toolchain wrappers are absent in this checkout.

Earlier ESP32 docs are recoverable in `.archive/docs/2026-09-13-esp32-refresh/`. Vendor manuals, raw artifacts, and unrelated dashboard/Android documentation are preserved. Root historical audits contain cross-platform backlog requiring revalidation; they are not the ESP32 completion ledger.
