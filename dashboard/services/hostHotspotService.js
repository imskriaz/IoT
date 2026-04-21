'use strict';

const windowsHostedNetwork = require('./hostHotspot/windowsHostedNetwork');
const darwinInternetSharing = require('./hostHotspot/darwinInternetSharing');

function createUnsupportedPlatformError(platform = process.platform) {
    const error = new Error(`host-hotspot-platform-not-supported:${platform}`);
    error.code = 'host_hotspot_platform_not_supported';
    error.platform = platform;
    return error;
}

function getAdapter(platform = process.platform) {
    if (platform === 'win32') {
        return windowsHostedNetwork;
    }
    if (platform === 'darwin') {
        return darwinInternetSharing;
    }
    return null;
}

function getPlatformSupport(platform = process.platform) {
    const adapter = getAdapter(platform);
    if (adapter && typeof adapter.getSupport === 'function') {
        return adapter.getSupport();
    }

    return {
        platform,
        supported: false,
        label: platform,
        reason: 'not_implemented'
    };
}

async function readState() {
    const adapter = getAdapter(process.platform);
    if (!adapter) {
        throw createUnsupportedPlatformError(process.platform);
    }
    return adapter.readState();
}

async function configure(options) {
    const adapter = getAdapter(process.platform);
    if (!adapter) {
        throw createUnsupportedPlatformError(process.platform);
    }
    return adapter.configure(options);
}

async function scanVisibleNetworks() {
    const adapter = getAdapter(process.platform);
    if (!adapter || typeof adapter.scanVisibleNetworks !== 'function') {
        throw createUnsupportedPlatformError(process.platform);
    }
    return adapter.scanVisibleNetworks();
}

module.exports = {
    getPlatformSupport,
    readState,
    configure,
    scanVisibleNetworks,
    createUnsupportedPlatformError
};
