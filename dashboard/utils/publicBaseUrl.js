'use strict';

function clean(value) {
    return String(value || '').trim();
}

function normalizeUrl(value) {
    return clean(value).replace(/\/+$/, '');
}

function firstHeaderValue(value) {
    return clean(String(value || '').split(',')[0]);
}

function isLoopbackHost(hostname) {
    const normalized = clean(hostname).toLowerCase()
        .replace(/^\[/, '')
        .replace(/\]$/, '');
    return ['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(normalized);
}

function parseHostname(value) {
    try {
        return new URL(value).hostname;
    } catch (_) {
        return '';
    }
}

function isLocalUrl(value) {
    const hostname = parseHostname(value);
    return !hostname || isLoopbackHost(hostname);
}

function requestOrigin(req) {
    const forwardedHost = firstHeaderValue(req.get?.('x-forwarded-host'));
    const host = forwardedHost || req.get?.('host') || '';
    if (!host) return '';

    const forwardedProto = firstHeaderValue(req.get?.('x-forwarded-proto'));
    const forwardedSsl = clean(req.get?.('x-forwarded-ssl')).toLowerCase();
    const protocol = forwardedProto
        || (forwardedSsl === 'on' ? 'https' : '')
        || (req.secure ? 'https' : '')
        || clean(req.protocol)
        || 'http';

    return normalizeUrl(`${protocol}://${host}`);
}

function configuredPublicBaseUrl() {
    return normalizeUrl(
        process.env.ANDROID_BRIDGE_PUBLIC_URL ||
        process.env.PUBLIC_BRIDGE_BASE_URL ||
        ''
    );
}

function resolvePublicBaseUrl(req, options = {}) {
    const configured = configuredPublicBaseUrl();
    const origin = requestOrigin(req);
    const preferRequestOrigin = options.preferRequestOrigin === true;

    if (preferRequestOrigin && origin && !isLocalUrl(origin)) {
        return origin;
    }

    if (configured && !isLocalUrl(configured)) {
        return configured;
    }

    if (origin) {
        return origin;
    }

    return configured;
}

function resolveDeviceReachableBaseUrl(req, options = {}) {
    const configured = normalizeUrl(options.configured || configuredPublicBaseUrl());
    const origin = requestOrigin(req);

    if (configured && !isLocalUrl(configured)) {
        return configured;
    }
    if (origin && !isLocalUrl(origin)) {
        return origin;
    }
    return null;
}

module.exports = {
    configuredPublicBaseUrl,
    isLocalUrl,
    isLoopbackHost,
    requestOrigin,
    resolveDeviceReachableBaseUrl,
    resolvePublicBaseUrl
};
