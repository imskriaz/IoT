# Firmware - Waveshare ESP32-S3-A7670E-4G

Board reference for the custom dashboard firmware in this repo.

This file is intentionally split between:
- official Waveshare board facts from the vendor docs and design resources
- the current wiring and feature set used by this repo's firmware

If those two worlds differ, the difference is called out explicitly instead of being hidden.

---

## Official References

- Resources and Documents: https://docs.waveshare.com/ESP32-S3-A7670E-4G/Resources-And-Documents
- FAQ: https://docs.waveshare.com/ESP32-S3-A7670E-4G/FAQ
- Product wiki: https://www.waveshare.com/wiki/ESP32-S3-A7670E-4G

Use the Waveshare Resources page for the official schematic, V2 schematic, vendor demos, and A76XX AT/TCPIP/GNSS manuals.

---

## Scope

Official Waveshare board capabilities include:
- ESP32-S3R8 main MCU
- A7670E-FASE 4G modem with GNSS
- SIM slot
- GNSS antenna connector
- battery fuel gauge and charger ICs
- USB hub and USB mux
- camera connector and vendor camera demos
- TF/MicroSD support in the vendor hardware design
- onboard microphone and speaker for modem call audio

Current custom repo firmware supports:
- cellular data, MQTT, status heartbeat
- SMS, calls, USSD
- GNSS through A7670E AT commands
- GPIO read/write/PWM on a restricted safe pin set
- touch event publishing
- battery telemetry
- storage commands using the board-verified `SD_MMC` TF-card path
- OTA
- Wi-Fi onboarding, BLE setup, direct HTTP access
- optional SSD1306 display support behind `ENABLE_DISPLAY`

Not implemented in the current custom firmware:
- integrated camera capture or video streaming in the main firmware
- motion detection
- face detection or face recognition
- generic ESP32 audio capture/playback
- NFC
- RFID
- matrix keyboard

---

## Folder Map

```text
firmware/
|-- common/                      <- Shared library used by board sketches
|   |-- library.properties
|   |-- modem.h                  <- A7670E AT command driver
|   |-- mqtt_client.h            <- MQTT connect/pub/sub/reconnect
|   |-- led.h                    <- WS2812B status LED
|   |-- commands.h               <- MQTT command dispatcher
|   |-- battery.h                <- MAX17048G fuel gauge helpers
|   `-- gps.h                    <- GNSS helpers over AT commands
|
`-- esp32-s3-a7670e/             <- This board
    |-- esp32-s3-a7670e.ino      <- Main sketch
    |-- config.h                 <- Board-specific pin map and metadata
    |-- credentials.h            <- Device ID, APN, MQTT, Wi-Fi (gitignored)
    |-- credentials.h.example
    `-- README.md                <- This file
```

---

## Build And Flash

```bash
arduino-cli compile \
  --fqbn esp32:esp32:esp32s3:PSRAM=opi,PartitionScheme=huge_app \
  --library firmware/common \
  firmware/esp32-s3-a7670e
```

```bash
arduino-cli upload -p COM3 --fqbn esp32:esp32:esp32s3 firmware/esp32-s3-a7670e
```

Notes:
- This custom firmware uses `PSRAM=opi` and `PartitionScheme=huge_app`.
- That build choice is for this repo's firmware, not for the vendor camera demos.
- If you are flashing the official Waveshare camera examples, follow the vendor docs instead of this README.

---

## Board Reality Vs Current Firmware Wiring

The table below distinguishes official board facts from what this repo currently drives.

| Area | Official board reality | Current repo firmware |
|---|---|---|
| Modem UART | V2 design routes the A7670E UART through TXB0104PWR | Uses `GPIO17` RX and `GPIO18` TX |
| Level shifter enable | TXB0104PWR `OE` is on `GPIO21` | Uses `GPIO21` |
| Fuel gauge I2C | Board has MAX17048G; older vendor examples used different pins on older revisions | Uses `GPIO15` SDA and `GPIO16` SCL |
| RGB LED | Board has a single WS2812B | Uses `GPIO38` |
| UART0 debug | Board exposes UART0 through CH343P | Uses `GPIO43` TX and `GPIO44` RX |
| Battery ADC | Board exposes battery sense on `GPIO39` | Analog read supported only on `GPIO39` |
| MicroSD | Vendor board family exposes TF/MicroSD in the hardware design | Live-tested path is `SD_MMC` on `CLK=5`, `CMD=4`, `D0=6`, `CD=46` |
| Camera | Official Waveshare docs include camera demos and V2 camera notes | Standalone diagnostics work; main-firmware integration is still pending |
| Onboard mic/speaker | Official FAQ says they are wired to the A7670E for call audio, not to the ESP32 for generic voice apps | Call control is supported; generic ESP32 audio is not |

Important:
- Do not describe every pin in this repo as "hardware verified". That is not true anymore.
- The SD-card path is no longer speculative on this tested unit: `SD_MMC` is the proven working bus and SPI SD is the rejected path for this board profile.
- The official FAQ says units after early 2026 use the OV5640 camera with V2 marking, while older units use OV2640. Those camera programs are not interchangeable.

---

## Current Firmware Pin Map

This is the active pin map from [`config.h`](/e:/Projects/IoT/firmware/esp32-s3-a7670e/config.h), not a claim about every possible vendor example.

| Function | GPIO | Notes |
|---|---|---|
| Modem RX | 17 | ESP32 receives from A7670E through TXB0104PWR |
| Modem TX | 18 | ESP32 transmits to A7670E through TXB0104PWR |
| Modem level shifter OE | 21 | HIGH enables TXB0104PWR |
| I2C SDA | 15 | MAX17048G fuel gauge |
| I2C SCL | 16 | MAX17048G fuel gauge |
| RGB LED | 38 | WS2812B data line |
| UART0 TX | 43 | CH343P debug UART |
| UART0 RX | 44 | CH343P debug UART |
| SDMMC CLK | 5 | Proven TF-card clock on this board |
| SDMMC CMD | 4 | Proven TF-card command pin |
| SDMMC D0 | 6 | Proven TF-card data pin |
| SD card detect | 46 | Low when card is present in the tested unit |
| BAT_ADC | 39 | Battery sense divider |

---

## GPIO And Expansion Rules

The board has more ESP32 pins than the firmware safely exposes.

Current safe GPIO set in the firmware:
- Output and PWM: `33`, `35`, `36`, `37`, `41`, `42`
- Digital read: `33`, `35`, `36`, `37`, `39`, `41`, `42`
- Analog read: `39` only

Pins that should be treated as reserved by this firmware:
- `17`, `18` for modem UART
- `21` for level shifter enable
- `15`, `16` for I2C fuel gauge bus
- `19`, `20` for native USB
- `38` for the RGB LED
- `43`, `44` for UART0 debug

Expansion notes:
- Extra I2C devices can share `GPIO15/16`, but they must coexist with MAX17048G at address `0x36`.
- Touch publishing exists in firmware, but the default touch init uses `GPIO1/2/3`. Those are touch-capable ESP32-S3 pins, not the documented "safe expansion header" set for this board. Treat touch as experimental unless you validate the exact wiring on your unit.
- Camera-related pins in vendor examples are not available for arbitrary expansion if you want official camera support later.

---

## Boot Flow

```text
Power on
  |
  +-- Read NVS config
  |     - if empty: enter onboarding mode
  |     - if valid: continue normal boot
  |
  +-- Bring up local services
  |     - setup AP server when unconfigured
  |     - BLE setup service
  |     - battery gauge init
  |     - storageInit() for the board `SD_MMC` path
  |     - optional display init
  |
  +-- Bring up modem on Serial1
  |     - AT / SIM / registration / data session
  |
  +-- Connect MQTT
  |     - subscribe to device/{id}/command/#
  |     - publish capabilities
  |     - publish first status heartbeat
  |
  `-- Main loop
        - AT URC parser
        - MQTT command dispatcher
        - status heartbeats
        - GNSS polling
        - battery trend sampling
        - touch event publishing
        - optional display updates
        - setup/direct HTTP handling
```

---

## Setup And Direct Access

Setup mode:
- Wi-Fi AP: `IoT-Setup-<MAC4>`
- HTTP: `http://192.168.4.1`
- Endpoints:
  - `GET /status`
  - `POST /configure`
- BLE name: `IoT-Setup-<MAC4>`
- Wi-Fi password: derived at runtime from the board MAC
- BLE passkey: derived at runtime from the board MAC

Direct HTTP mode:
- If station Wi-Fi is unavailable, the device falls back to `Device-Direct-<MAC4>`
- Password: derived at runtime from the board MAC suffix
- Endpoints:
  - `GET /status`
  - `GET /config`
  - `POST /reboot`

---

## NVS Layout

| Namespace | Key | Type | Notes |
|---|---|---|---|
| `esp32cfg` | `device_id` | string | MQTT device identifier |
| `esp32cfg` | `mqtt_host` | string | broker host or IP |
| `esp32cfg` | `mqtt_port` | int | default `1883` |
| `esp32cfg` | `mqtt_user` | string | optional |
| `esp32cfg` | `mqtt_pass` | string | optional |
| `esp32cfg` | `apn` | string | carrier APN |

Runtime settings are now intended to come from NVS/dashboard provisioning. Static sample credentials are not the runtime source of truth.

Factory reset:
- hold BOOT (`GPIO0`) for about 5 seconds
- NVS is cleared
- device re-enters onboarding

---

## Capabilities Published By The Firmware

Representative capability payload:

```json
{
  "firmware": "2.0.0",
  "board": "waveshare-esp32-s3-a7670e-4g-v2",
  "caps": {
    "gps": true,
    "battery": true,
    "storage": false,
    "sd": false,
    "display": false,
    "audio": false,
    "camera": false,
    "nfc": false,
    "rfid": false,
    "touch": true,
    "keyboard": false,
    "cellular": true,
    "sms": true,
    "calls": true,
    "ussd": true,
    "ota": true,
    "gpio": true,
    "wifi": true,
    "charging_detection": true
  }
}
```

Interpretation:
- `storage` and `sd` are runtime values and flip with live card mount state.
- `display` becomes `true` only when the firmware is built with `ENABLE_DISPLAY` and the OLED is actually available.
- `audio` is `false` because there is no generic ESP32 audio subsystem in this repo, even though modem call audio exists at the board level.
- `charging_detection` means the firmware publishes a charging heuristic, not that it has a dedicated charger-status GPIO.

---

## Feature Matrix

| Feature | Current state | Notes |
|---|---|---|
| Cellular data | Supported | Through A7670E |
| MQTT | Supported | Main device control path |
| SMS | Supported | Incoming plus outgoing flow |
| Calls | Supported | Modem call control and status publishing |
| USSD | Supported | Asynchronous `+CUSD` handling |
| GNSS | Supported | Requires GNSS antenna and open sky |
| Battery telemetry | Supported | MAX17048G plus BAT_ADC reporting |
| Charging state | Partial | Voltage-trend heuristic only |
| GPIO | Supported | Restricted safe pin set only |
| PWM | Supported | Same safe output pin set |
| Touch events | Supported with caveats | Firmware publishes events; physical use depends on real wiring |
| Storage | Supported | Tested working on `SD_MMC` |
| OLED display | Optional | Requires `ENABLE_DISPLAY` |
| Camera | Partial | Dedicated diagnostics and HTTP camera service work; main-firmware merge still pending |
| Motion detection | Not supported | Would require camera support first |
| Face detection / recognition | Not supported | Not present in this firmware |
| NFC / RFID / keyboard | Not supported | Dashboard scaffolding may exist, firmware does not |

---

## Key ICs

| Ref | IC | Role |
|---|---|---|
| U3 | ESP32-S3R8 | Main MCU |
| U7A | A7670E-FASE | 4G LTE modem with GNSS |
| U14 | TXB0104PWR | 3.3 V to 1.8 V level shifter |
| U10 | MAX17048G | Battery fuel gauge |
| U9 | ETA6098 | Li-ion charger |
| U1 | CN3791 | Solar MPPT charger |
| U11 | EA3036C | 3.3 V regulator |
| U4 | CH343P | USB-to-UART bridge |
| U5 | CH334F | USB 2.0 hub |
| U12 | FSUSB42UMX | USB mux |

---

## DIP Switches

The official Waveshare FAQ describes the rear DIP switches as:

| Position | Label | Function |
|---|---|---|
| 1 | CAM | Enable or disable the camera path |
| 2 | HUB | USB hub power |
| 3 | 4G | A7670E module power |
| 4 | USB | A7670E USB channel selection |

Practical notes:
- Keep `4G` ON for the modem to stay powered.
- The `USB` switch affects the modem USB path, not the repo's normal `Serial1` control path over `GPIO17/18`.
- The official FAQ says the modem can also be power-controlled by hardware methods such as the `PWK` button or a dedicated board control path, but this repo does not document that as a firmware feature because it is not implemented here.

---

## LEDs

Board-level LEDs from the official hardware:

| LED | Color | Meaning |
|---|---|---|
| PWR | Blue | Board power present |
| BATT_REV | Yellow | Reverse battery indication |
| SOLAR | Green | Solar charger activity |
| NET | Red | A7670E network light |

Firmware-controlled RGB LED on `GPIO38`:

| State | Pattern | Meaning |
|---|---|---|
| `SETUP_MODE` | yellow slow pulse | onboarding mode |
| `CONNECTING` | amber solid | booting or waiting for data |
| `NETWORK_READY` | teal solid | data ready, waiting for MQTT |
| `CONNECTED` | green solid | MQTT connected |
| `BUSY` | blue solid | active task or call |
| `CALL_RINGING` | blue fast blink | incoming call |
| `LOW_BATTERY` | amber slow blink | critically low battery |
| `SMS_RECEIVED` | purple flash | SMS received |
| `SMS_SENT` | cool white flash | outgoing SMS accepted |
| `SMS_DELIVERED` | mint flash | delivery report received |
| `GPS_FIX` | cyan flash | GPS location published |
| `OTA` | cyan slow pulse | OTA in progress |
| `OTA_SUCCESS` | green flash | OTA success |
| `OTA_FAILED` | orange-red flash | OTA failure |
| `STORAGE_ERROR` | orange flash | storage error |
| `NO_SIGNAL` | red solid | registration or signal issue |
| `FACTORY_RESET` | red/yellow alternate | factory reset |
| `ERROR` | red fast blink | fatal error |

---

## Power

| Source | Voltage |
|---|---|
| USB-C | 5 V |
| 18650 battery | about 3.7 V to 4.2 V |
| Solar input | about 5 V to 6 V |
| Logic rail | 3.3 V |
| A7670E supply | VBAT with high burst current |

---

## GPS, Storage, And Charging Notes

GPS:
- The official FAQ says to connect the GNSS antenna and test in an open outdoor environment.
- Indoors, a balcony or open window is better than a room test.
- Give GNSS about 1 minute after power-on before judging fix quality.

Storage:
- On the tested board, the working storage path is `SD_MMC`, not SPI SD.
- A card that worked in a phone may still fail here if it is exFAT, encrypted, or adopted as internal Android storage.
- For device-side testing, back up the card first and reformat it as FAT32 with MBR if needed.

Charging:
- The firmware reports charger IC identities (`ETA6098`, `CN3791`) from board knowledge.
- The published `system.charging` value is inferred from battery voltage trend using MAX17048 samples.
- That is useful telemetry, but it is not the same as a dedicated charger-status signal.

Carrier note:
- On the currently used Bangladesh Robi SIM, the balance USSD is `*222#`.

---

## Test Checklist

| # | Module | Test | Expected |
|---|---|---|---|
| 1 | Modem | `AT` | `OK` |
| 2 | SIM | `AT+CPIN?` | `+CPIN: READY` |
| 3 | Network registration | `AT+CEREG?` or status telemetry | registered |
| 4 | Mobile data | `AT+NETOPEN` then `AT+IPADDR` | valid IP |
| 5 | MQTT | broker connect and first status publish | online in dashboard |
| 6 | SMS | receive and send a real SMS | DB row and modem acknowledgement |
| 7 | Calls | ringing, connected, ended | duration recorded |
| 8 | USSD | send balance code such as `*222#` on Robi | response published |
| 9 | GNSS | antenna attached, outdoor sky view, wait for fix | lat/lon returned |
| 10 | Battery gauge | read MAX17048G | sane percent and voltage |
| 11 | Battery ADC | `analogRead(39)` | non-zero battery sense |
| 12 | RGB LED | flash RGB states | visible transitions |
| 13 | Storage | `storage-info` and list root | mounted card or clear mount error |
| 14 | GPIO outputs | toggle `33/35/36/37/41/42` | output changes |
| 15 | GPIO analog | read `39` | analog sample returned |
| 16 | Touch | verify published touch events only on validated wiring | topic updates |
| 17 | Display | build with `ENABLE_DISPLAY` and issue display commands | OLED updates |
| 18 | Modem call audio | place a real call | speaker/mic work through A7670E |

---

## What This README Does Not Claim

This README does not claim:
- that every vendor hardware feature is already implemented in this repo
- that camera support is present
- that generic ESP32 audio is present
- that MicroSD wiring is universally settled across every board revision
- that touch pins are universally exposed on the free header

Treat the official Waveshare design resources as authoritative for raw board hardware, and treat this README as authoritative for what the current custom firmware actually uses.
