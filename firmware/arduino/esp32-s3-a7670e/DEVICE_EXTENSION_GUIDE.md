# Device Extension Guide

Last updated: 2026-03-27

Device: `Waveshare ESP32-S3-A7670E-4G V2`

This guide is device-specific.

It is written for beginners first:
- what is already used on the board
- what pins are safe for your own devices
- what devices can be added
- what combinations are safe
- what to avoid

Sources used for this guide:
- [config.h](e:/Projects/IoT/firmware/esp32-s3-a7670e/config.h)
- [storage.h](e:/Projects/IoT/firmware/common/storage.h)
- [camera_service.h](e:/Projects/IoT/firmware/common/camera_service.h)
- [touch.h](e:/Projects/IoT/firmware/common/touch.h)

## Quick Start

If you are new and just want the safest advice:

- Use `GPIO33`, `GPIO35`, `GPIO36`, and `GPIO37` for most extra devices.
- Use `I2C GPIO15/GPIO16` only for I2C modules.
- Do not use `GPIO17`, `GPIO18`, or `GPIO21`.
- Do not use `GPIO4`, `GPIO5`, or `GPIO6`.
- Do not use camera pins if camera is enabled.

Best beginner add-ons:
- relay module
- buzzer
- PIR sensor
- door sensor
- DS18B20 temperature sensor
- BME280 environmental sensor
- RTC DS3231
- SSD1306 OLED
- MCP23017 or PCF8574 IO expander

## What The Board Already Uses

These pins are already busy.

| Board function | Pins | Do not use? | Why |
|---|---:|---|---|
| 4G modem UART | `17`, `18` | Yes | modem communication |
| Modem enable | `21` | Yes | needed to keep modem level shifting active |
| SD card | `4`, `5`, `6` | Yes | proven working `SD_MMC` path |
| RGB LED | `38` | Yes | onboard status LED |
| Boot button | `0` | Avoid | boot / recovery behavior |
| USB debug serial | `43`, `44` | Avoid | serial/debug path |

## Safe Pins For Beginners

These are the best direct GPIO pins for your own extra devices.

| Pin | Good for | Beginner friendly? |
|---|---|---|
| `33` | relay, button, buzzer, one-wire, digital sensor | Yes |
| `35` | relay, button, buzzer, one-wire, digital sensor | Yes |
| `36` | relay, button, buzzer, one-wire, digital sensor | Yes |
| `37` | relay, button, buzzer, one-wire, digital sensor | Yes |

These are the four pins you should prefer first.

## I2C Bus For Smart Modules

The board already has an I2C bus:

| Bus | Pins | Notes |
|---|---:|---|
| I2C | `15` SDA, `16` SCL | shared with battery gauge, and camera control when camera is active |

Good I2C devices:
- BME280
- BH1750
- SHT31
- DS3231
- SSD1306 OLED
- ADS1115
- MCP23017
- PCF8574

Important:
- only connect I2C devices here
- make sure the device I2C address does not conflict with other devices
- if camera is enabled, this bus becomes more sensitive because camera control also uses it

## Camera Warning

If camera is enabled, these pins should be treated as reserved:

`7, 8, 9, 10, 11, 12, 13, 14, 39, 41, 42, 46`

So:
- do not attach extra devices to those pins if you want camera support
- if you do not use camera, some of those pins may later be repurposed carefully
- for a beginner setup, assume they are not available

## Best Expansion Strategy

There are two good ways to expand this device.

### Option 1: Direct GPIO

Use:
- `33`
- `35`
- `36`
- `37`

This is best for:
- relays
- buzzers
- buttons
- PIR sensors
- reed switches
- one-wire sensors

### Option 2: I2C Expansion

Use:
- `15`
- `16`

This is best for:
- sensors
- OLED displays
- RTC modules
- IO expanders

This is the smartest long-term option because one I2C expander can give you many more GPIO pins safely.

## Beginner Device List

### Easy devices

| Device | Where to connect | Difficulty | Notes |
|---|---|---:|---|
| Relay module | `33/35/36/37` | Low | use transistor/driver if needed |
| Buzzer | `33/35/36/37` | Low | active buzzer is easiest |
| Push button | `33/35/36/37` | Low | use pull-up/pull-down config |
| Door/reed sensor | `33/35/36/37` | Low | very common use case |
| PIR sensor | `33/35/36/37` | Low | easy automation input |
| Float switch | `33/35/36/37` | Low | tank / water level |
| DS18B20 | `33/35/36/37` | Low | strong beginner choice |
| BME280 | `15/16` | Low | temp/humidity/pressure |
| BH1750 | `15/16` | Low | light sensor |
| DS3231 RTC | `15/16` | Low | timekeeping |
| SSD1306 OLED | `15/16` | Low | local display |
| ADS1115 ADC | `15/16` | Low | more analog channels |
| MCP23017 IO expander | `15/16` | Low | best expansion part |
| PCF8574 IO expander | `15/16` | Low | simpler expander |

### Medium devices

| Device | Where to connect | Difficulty | Notes |
|---|---|---:|---|
| Ultrasonic sensor | `33/35/36/37` | Medium | timing and voltage care |
| Servo | `33/35/36/37` | Medium | use separate power |
| Stepper driver | `33/35/36/37` | Medium | needs more pins / timing |
| IMU sensor | `15/16` | Medium | extra driver logic |
| CO2 sensor | `15/16` or serial path | Medium | module-specific |
| Air quality sensor | `15/16` or serial path | Medium | polling logic needed |
| RFID reader | separate service | Medium | interface depends on module |
| Fingerprint sensor | separate service | Medium | usually UART-based |
| RS485 / Modbus module | separate service | Medium | good industrial path |
| LoRa module | separate service | Medium | bus ownership needed |

### Advanced devices

| Device | Difficulty | Why advanced |
|---|---:|---|
| Camera in main firmware | High | memory + pin + runtime conflicts |
| Face detection | High | camera + libraries + CPU/RAM work |
| Face recognition | High | same plus data/model flow |
| Audio intercom | High | audio transport + codec + streaming |
| Video recording to SD | High | storage throughput + memory |
| Zigbee/Thread coprocessor | High | bigger subsystem |
| UWB module | High | specialized driver and timing |

## Analog Support

For beginners, assume analog support is limited.

Best rule:
- if you need several analog inputs, use an external ADC like `ADS1115` over I2C

That is usually easier and safer than trying to depend on many onboard analog pins.

## Safe Combinations

| Combination | Safe? | Notes |
|---|---|---|
| Main firmware + relay on `33` | Yes | good |
| Main firmware + relay + PIR + buzzer on `33/35/36` | Yes | good |
| Main firmware + BME280 + RTC on `15/16` | Yes | good if I2C addresses do not conflict |
| Main firmware + IO expander on `15/16` | Yes | best scaling option |
| Main firmware + camera + relay on `33` | Yes | likely fine |
| Main firmware + camera + devices on `7-14/39/41/42/46` | No | camera conflict |
| Main firmware + custom SD wiring on `4/5/6` | No | SD conflict |
| Main firmware + devices on `17/18/21` | No | modem conflict |

## What To Avoid

Avoid these mistakes:

- connecting random devices to `17`, `18`, `21`
- using `4`, `5`, `6` for your own modules
- using camera pins while camera is active
- connecting non-I2C devices to `15/16`
- powering motors or servos directly from logic pins
- assuming every ESP32-S3 pin on paper is free on this board

## Recommended First Projects

If you want good beginner projects for this board, these are the best ones:

1. Door sensor + buzzer + status reporting
2. Relay-controlled light or lock
3. Environmental monitor with `BME280`
4. RTC + OLED local status screen
5. IO expander based sensor hub
6. Water tank or pump controller
7. RS485 / Modbus field node

## Service Model Recommendation

To keep the firmware clean, each extra device should be handled as its own service.

Recommended service structure:
- `init()`
- `tick(now)`
- `publishStatus()`
- `handleCommand()`
- `capabilities()`

Best future core pieces:
- `pin ownership registry`
- `extension manager`
- `I2C registry`
- `GPIO extension service`
- `IO expander service`

## Best Recommendation For Most Users

If you want the safest and most scalable setup:

- keep camera optional
- keep SD on its working path
- use `33/35/36/37` for simple direct devices
- use `15/16` for I2C modules
- if you need many more pins, add an `MCP23017` or `PCF8574`

That gives the best balance of:
- stability
- simple wiring
- low firmware conflict
- future expansion

