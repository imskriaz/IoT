'use strict';

const windowsHostedNetwork = require('./hostHotspot/windowsHostedNetwork');
const darwinInternetSharing = require('./hostHotspot/darwinInternetSharing');

const OVERRIDABLE_PLATFORMS = new Set(['win32', 'darwin', 'linux', 'freebsd', 'openbsd']);

/**
 * Active host-hotspot platform. Production resolves to process.platform;
 * HOST_HOTSPOT_PLATFORM is a test/deployment seam that lets the Windows
 * hosted-network adapter be exercised on any OS (and lets an operator
 * force-disable the feature with an unsupported value).
 */
function getActivePlatform() {
    const override = String(process.env.HOST_HOTSPOT_PLATFORM || '').trim().toLowerCase();
    if (override && OVERRIDABLE_PLATFORMS.has(override)) {
        return override;
    }
    return process.platform;
}

function createUnsupportedPlatformError(platform = getActivePlatform()) {
    const error = new Error(`host-hotspot-platform-not-supported:${platform}`);
    error.code = 'host_hotspot_platform_not_supported';
    error.platform = platform;
    return error;
}

function getAdapter(platform = getActivePlatform()) {
    if (platform === 'win32') {
        return windowsHostedNetwork;
    }
    if (platform === 'darwin') {
        return darwinInternetSharing;
    }
    return null;
}

function getPlatformSupport(platform = getActivePlatform()) {
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
    const platform = getActivePlatform();
    const adapter = getAdapter(platform);
    if (!adapter) {
        throw createUnsupportedPlatformError(platform);
    }
    return adapter.readState();
}

async function configure(options) {
    const platform = getActivePlatform();
    const adapter = getAdapter(platform);
    if (!adapter) {
        throw createUnsupportedPlatformError(platform);
    }
    return adapter.configure(options);
}

async function scanVisibleNetworks() {
    const platform = getActivePlatform();
    const adapter = getAdapter(platform);
    if (!adapter || typeof adapter.scanVisibleNetworks !== 'function') {
        throw createUnsupportedPlatformError(platform);
    }
    return adapter.scanVisibleNetworks();
}

module.exports = {
    getPlatformSupport,
    getActivePlatform,
    readState,
    configure,
    scanVisibleNetworks,
    createUnsupportedPlatformError
};
