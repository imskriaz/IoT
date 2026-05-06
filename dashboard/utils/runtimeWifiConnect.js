function normalizeWifiConnectText(value) {
    return String(value || '').trim();
}

function buildCommandOptions(commandOptionsFactory, command, options = {}) {
    if (typeof commandOptionsFactory === 'function') {
        return commandOptionsFactory(command, options);
    }
    return options;
}

function buildWifiConnectCommandError(error) {
    const detail = normalizeWifiConnectText(error?.message || error) || 'Wi-Fi connect command failed';
    const enriched = new Error(
        'Device did not accept the Wi-Fi switch command. The dashboard now uses only the wifi-connect runtime command; validate it over serial first, then flash firmware with wifi-connect support and try again.'
    );
    enriched.code = 'WIFI_CONNECT_COMMAND_FAILED';
    enriched.statusCode = 502;
    enriched.stage = 'wifi-connect';
    enriched.detail = detail;
    enriched.cause = error;
    return enriched;
}

async function publishWifiConnectSequence({
    mqttService,
    deviceId,
    ssid,
    password = '',
    security = '',
    timeoutMs = 15000,
    commandOptionsFactory = null
}) {
    const normalizedSsid = normalizeWifiConnectText(ssid);
    const normalizedPassword = password === undefined || password === null ? '' : String(password);
    const normalizedSecurity = normalizeWifiConnectText(security);

    if (!mqttService || typeof mqttService.publishCommand !== 'function') {
        throw new Error('MQTT service unavailable');
    }
    if (!normalizedSsid) {
        throw new Error('SSID is required');
    }

    const wifiConnectPayload = {
        ssid: normalizedSsid,
        password: normalizedPassword,
        security: normalizedSecurity
    };

    try {
        const response = await mqttService.publishCommand(
            deviceId,
            'wifi-connect',
            wifiConnectPayload,
            true,
            timeoutMs,
            buildCommandOptions(commandOptionsFactory, 'wifi-connect', {
                skipPersistentQueue: true,
                domain: 'network'
            })
        );

        if (response?.success === false) {
            throw buildWifiConnectCommandError(
                response.detail || response.message || response.error || 'wifi-connect returned unsuccessful response'
            );
        }
        return response;
    } catch (error) {
        if (error?.code === 'WIFI_CONNECT_COMMAND_FAILED') {
            throw error;
        }
        throw buildWifiConnectCommandError(error);
    }
}

module.exports = {
    publishWifiConnectSequence
};
