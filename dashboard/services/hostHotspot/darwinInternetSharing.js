'use strict';

function createNotImplementedError() {
    const error = new Error('host-hotspot-platform-not-supported:darwin');
    error.code = 'host_hotspot_platform_not_supported';
    error.platform = 'darwin';
    return error;
}

function getSupport() {
    return {
        platform: 'darwin',
        supported: false,
        label: 'macOS Internet Sharing',
        reason: 'not_implemented'
    };
}

async function readState() {
    throw createNotImplementedError();
}

async function configure() {
    throw createNotImplementedError();
}

async function scanVisibleNetworks() {
    throw createNotImplementedError();
}

module.exports = {
    getSupport,
    readState,
    configure,
    scanVisibleNetworks
};
