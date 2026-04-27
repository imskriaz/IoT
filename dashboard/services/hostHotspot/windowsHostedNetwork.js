'use strict';

const { execFile } = require('child_process');

function execFileAsync(file, args) {
    return new Promise((resolve, reject) => {
        execFile(file, args, { windowsHide: true }, (error, stdout, stderr) => {
            if (error) {
                error.stdout = String(stdout || '');
                error.stderr = String(stderr || '');
                reject(error);
                return;
            }
            resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
        });
    });
}

function parseHostedNetworkOutput(text) {
    const output = String(text || '');
    const ssidMatch = output.match(/SSID name\s*:\s*"([^\"]*)"/i);
    const statusMatch = output.match(/Status\s*:\s*([^\r\n]+)/i);

    return {
        ssid: ssidMatch ? ssidMatch[1].trim() : '',
        status: statusMatch ? statusMatch[1].trim() : ''
    };
}

function parseHostedSecurityOutput(text) {
    const output = String(text || '');
    const userKeyMatch = output.match(/User security key\s*:\s*([^\r\n]+)/i);

    return {
        userSecurityKey: userKeyMatch ? userKeyMatch[1].trim() : ''
    };
}

function parseDriverSupportOutput(text) {
    const output = String(text || '');
    const hostedNetworkMatch = output.match(/Hosted network supported\s*:\s*(Yes|No)/i);

    return {
        hostedNetworkSupported: hostedNetworkMatch ? hostedNetworkMatch[1].toLowerCase() === 'yes' : null
    };
}

function parseInterfaceOutput(text) {
    const output = String(text || '');
    const nameMatch = output.match(/Name\s*:\s*([^\r\n]+)/i);
    const descriptionMatch = output.match(/Description\s*:\s*([^\r\n]+)/i);
    const stateMatch = output.match(/State\s*:\s*([^\r\n]+)/i);
    const radioMatch = output.match(/Radio status\s*:\s*([^\r\n]+)\r?\n\s*([^\r\n]+)/i);

    return {
        name: nameMatch ? nameMatch[1].trim() : '',
        description: descriptionMatch ? descriptionMatch[1].trim() : '',
        state: stateMatch ? stateMatch[1].trim() : '',
        radioHardwareOn: radioMatch ? /on/i.test(radioMatch[1]) : null,
        radioSoftwareOn: radioMatch ? /on/i.test(radioMatch[2]) : null
    };
}

function parseVisibleNetworksOutput(text) {
    const lines = String(text || '').split(/\r?\n/);
    const networks = [];
    let current = null;

    const pushCurrent = () => {
        if (!current) {
            return;
        }

        const signal = current.signals.length
            ? Math.max(...current.signals)
            : null;

        networks.push({
            ssid: current.ssid,
            authentication: current.authentication,
            encryption: current.encryption,
            signal,
            band: current.bands[0] || '',
            channel: current.channels[0] || null,
            bssids: current.bssids
        });
    };

    for (const rawLine of lines) {
        const line = String(rawLine || '').trim();
        if (!line) {
            continue;
        }

        const ssidMatch = line.match(/^SSID\s+\d+\s*:\s*(.*)$/i);
        if (ssidMatch) {
            pushCurrent();
            current = {
                ssid: ssidMatch[1].trim(),
                authentication: '',
                encryption: '',
                signals: [],
                bands: [],
                channels: [],
                bssids: []
            };
            continue;
        }

        if (!current) {
            continue;
        }

        const authMatch = line.match(/^Authentication\s*:\s*(.*)$/i);
        if (authMatch) {
            current.authentication = authMatch[1].trim();
            continue;
        }

        const encryptionMatch = line.match(/^Encryption\s*:\s*(.*)$/i);
        if (encryptionMatch) {
            current.encryption = encryptionMatch[1].trim();
            continue;
        }

        const bssidMatch = line.match(/^BSSID\s+\d+\s*:\s*([0-9a-f:]+)/i);
        if (bssidMatch) {
            current.bssids.push(bssidMatch[1].toUpperCase());
            continue;
        }

        const signalMatch = line.match(/^Signal\s*:\s*(\d+)%/i);
        if (signalMatch) {
            current.signals.push(Number(signalMatch[1]));
            continue;
        }

        const bandMatch = line.match(/^Band\s*:\s*(.*)$/i);
        if (bandMatch) {
            const band = bandMatch[1].trim();
            if (band && !current.bands.includes(band)) {
                current.bands.push(band);
            }
            continue;
        }

        const channelMatch = line.match(/^Channel\s*:\s*(\d+)/i);
        if (channelMatch) {
            const channel = Number(channelMatch[1]);
            if (Number.isFinite(channel) && !current.channels.includes(channel)) {
                current.channels.push(channel);
            }
        }
    }

    pushCurrent();
    return networks.sort((left, right) => (right.signal || 0) - (left.signal || 0));
}

function getSupport() {
    return {
        platform: 'win32',
        supported: true,
        label: 'Windows hosted network',
        reason: null
    };
}

async function readState() {
    const hosted = parseHostedNetworkOutput((await execFileAsync('netsh', ['wlan', 'show', 'hostednetwork'])).stdout);
    const security = parseHostedSecurityOutput((await execFileAsync('netsh', ['wlan', 'show', 'hostednetwork', 'setting=security'])).stdout);
    const driverSupport = parseDriverSupportOutput(
        (await execFileAsync('netsh', ['wlan', 'show', 'drivers']).catch(() => ({ stdout: '' }))).stdout
    );

    return {
        hosted,
        security,
        support: {
            ...getSupport(),
            ...driverSupport,
            supported: driverSupport.hostedNetworkSupported === false ? false : getSupport().supported,
            reason: driverSupport.hostedNetworkSupported === false ? 'hosted_network_not_supported' : getSupport().reason
        }
    };
}

async function scanVisibleNetworks() {
    const interfaceState = parseInterfaceOutput(
        (await execFileAsync('netsh', ['wlan', 'show', 'interfaces']).catch(() => ({ stdout: '' }))).stdout
    );
    const networks = parseVisibleNetworksOutput(
        (await execFileAsync('netsh', ['wlan', 'show', 'networks', 'mode=bssid'])).stdout
    );

    return {
        interfaceState,
        networks
    };
}

async function configure({ ssid, password, start }) {
    const desiredSsid = String(ssid || '').trim();
    const desiredPassword = String(password || '');

    if (!desiredSsid) {
        const error = new Error('missing-ssid');
        error.code = 'missing_ssid';
        throw error;
    }
    if (!desiredPassword) {
        const error = new Error('missing-password');
        error.code = 'missing_password';
        throw error;
    }

    const driverSupport = parseDriverSupportOutput(
        (await execFileAsync('netsh', ['wlan', 'show', 'drivers']).catch(() => ({ stdout: '' }))).stdout
    );
    if (driverSupport.hostedNetworkSupported === false) {
        const error = new Error('windows-hosted-network-not-supported');
        error.code = 'hosted_network_not_supported';
        error.detail = 'This Windows Wi-Fi adapter reports Hosted network supported: No.';
        throw error;
    }

    const setResult = await execFileAsync('netsh', [
        'wlan',
        'set',
        'hostednetwork',
        'mode=allow',
        `ssid=${desiredSsid}`,
        `key=${desiredPassword}`
    ]);

    let startResult = null;
    if (start) {
        startResult = await execFileAsync('netsh', ['wlan', 'start', 'hostednetwork']);
    }

    return {
        setOutput: String(setResult.stdout || '').trim(),
        startOutput: startResult ? String(startResult.stdout || '').trim() : '',
        started: !!start && /started/i.test(String(startResult?.stdout || '')),
        support: getSupport()
    };
}

module.exports = {
    getSupport,
    readState,
    configure,
    scanVisibleNetworks
};
