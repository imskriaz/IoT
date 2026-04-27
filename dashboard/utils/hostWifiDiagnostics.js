'use strict';

function normalizeSsid(value) {
    return String(value || '').trim();
}

function buildHostScanSummary(scanResult, targetSsid = '') {
    const desiredSsid = normalizeSsid(targetSsid);
    const networks = Array.isArray(scanResult?.networks) ? scanResult.networks : [];
    const desiredNetwork = desiredSsid
        ? (networks.find(network => normalizeSsid(network?.ssid) === desiredSsid) || null)
        : null;

    return {
        available: true,
        interfaceState: scanResult?.interfaceState || null,
        visibleNetworkCount: networks.length,
        desiredVisible: desiredSsid ? !!desiredNetwork : null,
        desiredNetwork,
        networks,
        sampleNetworks: networks.slice(0, 8)
    };
}

async function readHostScanSummary(hostHotspotService, targetSsid = '') {
    if (!hostHotspotService || typeof hostHotspotService.scanVisibleNetworks !== 'function') {
        return {
            available: false,
            interfaceState: null,
            visibleNetworkCount: null,
            desiredVisible: null,
            desiredNetwork: null,
            networks: [],
            sampleNetworks: [],
            error: 'scan_not_supported'
        };
    }

    try {
        return buildHostScanSummary(
            await hostHotspotService.scanVisibleNetworks(),
            targetSsid
        );
    } catch (error) {
        return {
            available: false,
            interfaceState: null,
            visibleNetworkCount: null,
            desiredVisible: null,
            desiredNetwork: null,
            networks: [],
            sampleNetworks: [],
            error: error?.code || 'scan_failed',
            message: error?.message || 'Host Wi-Fi scan failed'
        };
    }
}

module.exports = {
    normalizeSsid,
    buildHostScanSummary,
    readHostScanSummary
};
