const BOARD_CATALOG = {
    'waveshare-esp32-s3-a7670e-4g-v2': {
        aliases: [
            'waveshare esp32-s3-a7670e-4g',
            'waveshare-esp32-s3-a7670e',
            'esp32-s3-a7670e',
            'esp32-s3-a7670e-4g',
            'waveshare esp32 s3 a7670e'
        ],
        board: {
            slug: 'waveshare-esp32-s3-a7670e-4g-v2',
            name: 'Waveshare ESP32-S3-A7670E-4G',
            vendor: 'Waveshare',
            revision: 'V2.0',
            family: 'ESP32-S3 + A7670E',
            chip: 'ESP32-S3',
            cpu: 'Xtensa LX7 dual-core up to 240 MHz',
            flash: '16 MB',
            psram: '8 MB',
            notes: 'Primary dashboard reference board'
        },
        interfaces: [
            '4G LTE Cat-1 via A7670E-FASE',
            'GNSS via A7670E',
            'Wi-Fi',
            'Bluetooth LE',
            'MicroSD over SPI',
            'SSD1306 OLED over I2C',
            'WS2812B RGB LED'
        ],
        pins: [
            { label: 'Modem RX', pin: 17, notes: 'ESP32 <- A7670E TXD via TXB0104PWR' },
            { label: 'Modem TX', pin: 18, notes: 'ESP32 -> A7670E RXD via TXB0104PWR' },
            { label: 'Modem level shifter OE', pin: 21, notes: 'TXB0104PWR enable' },
            { label: 'Battery I2C SDA', pin: 15, notes: 'MAX17048G SDA' },
            { label: 'Battery I2C SCL', pin: 16, notes: 'MAX17048G SCL' },
            { label: 'RGB LED', pin: 38, notes: 'WS2812B data line' },
            { label: 'SD CS', pin: 10, notes: 'MicroSD SPI chip-select' },
            { label: 'SD MOSI', pin: 11, notes: 'MicroSD SPI MOSI' },
            { label: 'SD CLK', pin: 12, notes: 'MicroSD SPI clock' },
            { label: 'SD MISO', pin: 13, notes: 'MicroSD SPI MISO' }
        ],
        ics: [
            { ref: 'U3', model: 'ESP32-S3R8', role: 'Main MCU' },
            { ref: 'U7A', model: 'A7670E-FASE', role: '4G LTE modem with GNSS' },
            { ref: 'U14', model: 'TXB0104PWR', role: '3.3V <-> 1.8V level shifter' },
            { ref: 'U10', model: 'MAX17048G', role: 'Battery fuel gauge' },
            { ref: 'U9', model: 'ETA6098', role: 'Li-ion charger' },
            { ref: 'U1', model: 'CN3791', role: 'Solar MPPT charger' },
            { ref: 'U11', model: 'EA3036C', role: '3.3V buck regulator' },
            { ref: 'U4', model: 'CH343P', role: 'USB-to-UART bridge' },
            { ref: 'U5', model: 'CH334F', role: 'USB 2.0 hub' },
            { ref: 'U12', model: 'FSUSB42UMX', role: 'USB mux' }
        ]
    },
    'esp32-a7670e': {
        aliases: ['esp32-a7670e', 'esp32 a7670e', 'classic esp32 a7670e'],
        board: {
            slug: 'esp32-a7670e',
            name: 'ESP32 + A7670E',
            vendor: 'Custom / Generic',
            family: 'ESP32 + A7670E',
            chip: 'ESP32',
            cpu: 'Xtensa dual-core up to 240 MHz',
            flash: 'Board-specific',
            psram: 'Usually none'
        },
        interfaces: [
            '4G LTE Cat-1 via A7670E',
            'GNSS via A7670E',
            'Wi-Fi',
            'Bluetooth Classic / BLE'
        ],
        pins: [
            { label: 'Modem RX', pin: 16, notes: 'ESP32 <- A7670E TX' },
            { label: 'Modem TX', pin: 17, notes: 'ESP32 -> A7670E RX' },
            { label: 'Modem enable', pin: 4, notes: 'Board-defined enable / OE' },
            { label: 'Battery ADC', pin: 34, notes: 'VBAT divider input' },
            { label: 'I2C SDA', pin: 21, notes: 'Battery / peripherals' },
            { label: 'I2C SCL', pin: 22, notes: 'Battery / peripherals' },
            { label: 'RGB LED', pin: 2, notes: 'Board-defined RGB / status LED' }
        ],
        ics: [
            { ref: 'SOC', model: 'ESP32', role: 'Main MCU' },
            { ref: 'MODEM', model: 'A7670E', role: '4G LTE modem with GNSS' }
        ]
    },
    'esp32-c3-a7670e': {
        aliases: ['esp32-c3-a7670e', 'esp32 c3 a7670e'],
        board: {
            slug: 'esp32-c3-a7670e',
            name: 'ESP32-C3 + A7670E',
            vendor: 'Custom / Generic',
            family: 'ESP32-C3 + A7670E',
            chip: 'ESP32-C3',
            cpu: 'RISC-V single-core up to 160 MHz',
            flash: 'Board-specific',
            psram: 'None'
        },
        interfaces: [
            '4G LTE Cat-1 via A7670E',
            'GNSS via A7670E',
            'Wi-Fi',
            'Bluetooth LE'
        ],
        pins: [
            { label: 'Modem RX', pin: 4, notes: 'ESP32-C3 <- A7670E TX' },
            { label: 'Modem TX', pin: 5, notes: 'ESP32-C3 -> A7670E RX' },
            { label: 'Modem enable', pin: 3, notes: 'Board-defined enable / OE' },
            { label: 'Battery ADC', pin: 1, notes: 'Battery sense input' },
            { label: 'I2C SDA', pin: 6, notes: 'Battery / peripherals' },
            { label: 'I2C SCL', pin: 7, notes: 'Battery / peripherals' },
            { label: 'RGB LED', pin: 8, notes: 'Board-defined RGB / status LED' }
        ],
        ics: [
            { ref: 'SOC', model: 'ESP32-C3', role: 'Main MCU' },
            { ref: 'MODEM', model: 'A7670E', role: '4G LTE modem with GNSS' }
        ]
    },
    'esp32-c6-a7670e': {
        aliases: ['esp32-c6-a7670e', 'esp32 c6 a7670e'],
        board: {
            slug: 'esp32-c6-a7670e',
            name: 'ESP32-C6 + A7670E',
            vendor: 'Custom / Generic',
            family: 'ESP32-C6 + A7670E',
            chip: 'ESP32-C6',
            cpu: 'RISC-V single-core up to 160 MHz',
            flash: 'Board-specific',
            psram: 'None'
        },
        interfaces: [
            '4G LTE Cat-1 via A7670E',
            'GNSS via A7670E',
            'Wi-Fi 6',
            'Bluetooth 5',
            'Zigbee / Thread capable SoC'
        ],
        pins: [
            { label: 'Modem RX', pin: 4, notes: 'ESP32-C6 <- A7670E TX' },
            { label: 'Modem TX', pin: 5, notes: 'ESP32-C6 -> A7670E RX' },
            { label: 'Modem enable', pin: 3, notes: 'Board-defined enable / OE' },
            { label: 'Battery ADC', pin: 2, notes: 'Battery sense input' },
            { label: 'I2C SDA', pin: 6, notes: 'Battery / peripherals' },
            { label: 'I2C SCL', pin: 7, notes: 'Battery / peripherals' },
            { label: 'RGB LED', pin: 8, notes: 'Board-defined RGB / status LED' }
        ],
        ics: [
            { ref: 'SOC', model: 'ESP32-C6', role: 'Main MCU' },
            { ref: 'MODEM', model: 'A7670E', role: '4G LTE modem with GNSS' }
        ]
    }
};

function normalizeBoardToken(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function deepClone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function mergeArrays(base, override) {
    return Array.isArray(override) && override.length ? override : (Array.isArray(base) ? base : []);
}

function mergeObjects(base = {}, override = {}) {
    const merged = { ...base };
    for (const [key, value] of Object.entries(override || {})) {
        if (Array.isArray(value)) {
            merged[key] = mergeArrays(base[key], value);
        } else if (value && typeof value === 'object') {
            merged[key] = mergeObjects(base[key] || {}, value);
        } else if (value !== undefined && value !== null && value !== '') {
            merged[key] = value;
        }
    }
    return merged;
}

function resolveCatalogKey(boardValue = '', caps = {}) {
    const token = normalizeBoardToken(boardValue);
    for (const [key, profile] of Object.entries(BOARD_CATALOG)) {
        if (token === key) return key;
        if ((profile.aliases || []).some(alias => normalizeBoardToken(alias) === token)) {
            return key;
        }
    }

    if (token.includes('s3') && token.includes('a7670')) return 'waveshare-esp32-s3-a7670e-4g-v2';
    if (token.includes('c3') && token.includes('a7670')) return 'esp32-c3-a7670e';
    if (token.includes('c6') && token.includes('a7670')) return 'esp32-c6-a7670e';
    if (token.includes('esp32') && token.includes('a7670')) return 'esp32-a7670e';

    if (caps.display && caps.audio && caps.gps && caps.sd) {
        return 'waveshare-esp32-s3-a7670e-4g-v2';
    }
    if (caps.touch && caps.dac) return 'esp32-a7670e';
    return null;
}

function toCapabilityList(caps = {}) {
    return Object.entries(caps)
        .filter(([key, value]) => key !== 'specs' && key !== 'raw' && value === true)
        .map(([key]) => key)
        .sort();
}

function buildDeviceSpecs({ device = {}, profile = {}, live = {}, caps = {} }) {
    const reportedSpecs = caps.specs && typeof caps.specs === 'object' ? deepClone(caps.specs) : {};
    const profileKey = resolveCatalogKey(profile.board || caps.board || reportedSpecs.board?.name || device.type, caps);
    const catalogProfile = profileKey ? BOARD_CATALOG[profileKey] : null;

    const merged = {
        board: mergeObjects(catalogProfile?.board || {}, reportedSpecs.board || {}),
        interfaces: mergeArrays(catalogProfile?.interfaces, reportedSpecs.interfaces),
        pins: mergeArrays(catalogProfile?.pins, reportedSpecs.pins),
        ics: mergeArrays(catalogProfile?.ics, reportedSpecs.ics)
    };

    return {
        detectedProfile: profileKey,
        detectionSource: reportedSpecs.board ? 'device-reported' : (catalogProfile ? (profile.board ? 'catalog-board' : 'catalog-inferred') : 'unknown'),
        board: merged.board,
        build: reportedSpecs.build || {},
        interfaces: merged.interfaces,
        pins: merged.pins,
        ics: merged.ics,
        capabilities: toCapabilityList(caps),
        device: {
            id: device.id,
            name: device.name || device.id,
            type: device.type || 'esp32',
            status: live.online ? 'online' : (device.status || 'offline'),
            description: device.description || null,
            location: profile.location || null,
            firmware: profile.firmware_version || null,
            board: profile.board || merged.board.name || null,
            localIp: profile.local_ip || null,
            apn: profile.apn || null,
            mqttHost: profile.mqtt_host || null,
            mqttUser: profile.mqtt_user || null,
            online: !!live.online,
            lastSeen: live.lastSeen || device.last_seen || null,
            createdAt: device.created_at || null
        },
        runtime: {
            signal: live.signal ?? null,
            signalDbm: live.signalDbm ?? null,
            battery: live.battery ?? null,
            voltageMv: live.voltageMv ?? null,
            charging: live.charging ?? null,
            network: live.network || null,
            operator: live.operator || null,
            ip: live.ip || null,
            temperature: live.temperature ?? null,
            uptime: live.uptime || null,
            imei: live.imei || null
        }
    };
}

module.exports = {
    BOARD_CATALOG,
    buildDeviceSpecs,
    resolveCatalogKey
};
