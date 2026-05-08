'use strict';

const fs = require('fs');
const path = require('path');

const ROUTES_DIR = path.join(__dirname, '..', 'routes');

const API_ROUTE_MOUNTS = [
    { file: 'sms.js', basePath: '/api/sms', tag: 'SMS' },
    { file: 'calls.js', basePath: '/api/calls', tag: 'Calls' },
    { file: 'contacts.js', basePath: '/api/contacts', tag: 'Contacts' },
    { file: 'status.js', basePath: '/api/status', tag: 'Status' },
    { file: 'modem.js', basePath: '/api/modem', tag: 'Modem' },
    { file: 'ussd.js', basePath: '/api/ussd', tag: 'USSD' },
    { file: 'intercom.js', basePath: '/api/intercom', tag: 'Intercom' },
    { file: 'settings.js', basePath: '/api/settings', tag: 'Settings' },
    { file: 'storage.js', basePath: '/api/storage', tag: 'Storage' },
    { file: 'location.js', basePath: '/api/location', tag: 'Location' },
    { file: 'test.js', basePath: '/api/test', tag: 'Device Test' },
    { file: 'esp32Console.js', basePath: '/api/esp32-console', tag: 'ESP32 Console' },
    { file: 'logs.js', basePath: '/api/logs', tag: 'Logs' },
    { file: 'ota.js', basePath: '/api/ota', tag: 'OTA' },
    { file: 'devices.js', basePath: '/api/devices', tag: 'Devices' },
    { file: 'gpio.js', basePath: '/api/gpio', tag: 'GPIO' },
    { file: 'queue.js', basePath: '/api/queue', tag: 'Queue' }
];

const SERVER_ROUTE_MOUNTS = [
    { file: 'mqtt.js', basePath: '/api/mqtt', tag: 'MQTT' },
    { file: 'deviceGroups.js', basePath: '/api/device-groups', tag: 'Device Groups' },
    { file: 'apiKeys.js', basePath: '/api/keys', tag: 'API Keys' },
    { file: 'webhooks.js', basePath: '/api/webhooks', tag: 'Webhooks' },
    { file: 'automation.js', basePath: '/api/automation', tag: 'Automation' },
    { file: 'androidBridgeAdapter.js', basePath: '/v1/android/bridge', tag: 'Android Bridge' },
    { file: 'httpSmsAdapter.js', basePath: '/v1', tag: 'httpSMS Adapter' },
    { file: 'auth.js', basePath: '/auth', tag: 'Auth' },
    { file: 'users.js', basePath: '/admin', tag: 'Admin' },
    { file: 'onboarding.js', basePath: '', tag: 'Onboarding' },
    { file: 'index.js', basePath: '', tag: 'Dashboard Pages' }
];

const VIRTUAL_ENDPOINTS = [
    {
        method: 'get',
        path: '/health',
        expressPath: '/health',
        routeFile: 'server.js',
        line: null,
        tag: 'System',
        generated: true
    },
    ...['/api-docs', '/api-docs.json', '/api-docs/catalog'].map((routePath) => ({
        method: 'get',
        path: routePath,
        expressPath: routePath,
        routeFile: 'server.js',
        line: null,
        tag: 'API Docs',
        generated: true
    })),
    ...['display', 'nfc', 'rfid', 'touch', 'keyboard'].map((page) => ({
        method: 'get',
        path: `/${page}`,
        expressPath: `/${page}`,
        routeFile: 'routes/index.js',
        line: 1168,
        tag: 'Dashboard Pages',
        generated: true
    }))
];

const ROUTE_CALL_PATTERN = /router\.(get|post|put|patch|delete)\s*\(\s*(['"`])([^'"`]+)\2/g;

function joinPaths(basePath, routePath) {
    const base = String(basePath || '').trim();
    const route = String(routePath || '').trim();
    if (!base && (!route || route === '/')) return '/';
    if (!route || route === '/') return normalizeSlashes(base || '/');
    return normalizeSlashes(`${base}/${route}`);
}

function normalizeSlashes(value) {
    const normalized = String(value || '/').replace(/\/{2,}/g, '/');
    return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function toOpenApiPath(expressPath) {
    return normalizeSlashes(expressPath)
        .replace(/:([A-Za-z0-9_]+)(\([^/]+\))?/g, '{$1}')
        .replace(/\?/g, '');
}

function lineNumberAt(source, index) {
    return source.slice(0, index).split(/\r?\n/).length;
}

function extractRoutesFromFile(mount) {
    const absolutePath = path.join(ROUTES_DIR, mount.file);
    const source = fs.readFileSync(absolutePath, 'utf8');
    const endpoints = [];
    ROUTE_CALL_PATTERN.lastIndex = 0;

    let match;
    while ((match = ROUTE_CALL_PATTERN.exec(source)) !== null) {
        const [, method, , routePath] = match;
        const nextSignificant = source.slice(ROUTE_CALL_PATTERN.lastIndex).match(/\S/)?.[0];
        if (nextSignificant && nextSignificant !== ',' && nextSignificant !== ')') continue;
        const expressPath = joinPaths(mount.basePath, routePath);
        endpoints.push({
            method,
            path: toOpenApiPath(expressPath),
            expressPath,
            routeFile: path.join('routes', mount.file).replace(/\\/g, '/'),
            line: lineNumberAt(source, match.index),
            tag: mount.tag
        });
    }

    return endpoints;
}

function getApiCatalog() {
    const mountedEndpoints = [...API_ROUTE_MOUNTS, ...SERVER_ROUTE_MOUNTS]
        .flatMap(extractRoutesFromFile);
    const endpoints = [...mountedEndpoints, ...VIRTUAL_ENDPOINTS]
        .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

    return {
        generatedAt: new Date().toISOString(),
        source: 'dashboard/config/api-catalog.js',
        endpoints
    };
}

function getCatalogTags(endpoints) {
    return [...new Set(endpoints.map((endpoint) => endpoint.tag).filter(Boolean))]
        .sort()
        .map((name) => ({ name }));
}

function getPathParameters(openApiPath) {
    const params = [];
    const seen = new Set();
    const pattern = /\{([^}]+)\}/g;
    let match;
    while ((match = pattern.exec(openApiPath)) !== null) {
        const name = match[1];
        if (seen.has(name)) continue;
        seen.add(name);
        params.push({
            name,
            in: 'path',
            required: true,
            schema: { type: 'string' }
        });
    }
    return params;
}

function generatedOperation(endpoint) {
    const operation = {
        tags: [endpoint.tag],
        summary: `${endpoint.method.toUpperCase()} ${endpoint.path}`,
        description: `Generated from ${endpoint.routeFile}${endpoint.line ? `:${endpoint.line}` : ''} via the shared API catalog.`,
        operationId: `${endpoint.method}_${endpoint.path.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`,
        security: [{ apiKey: [] }],
        responses: {
            200: { description: 'Successful response' },
            400: { description: 'Invalid request' },
            401: { description: 'Authentication required' },
            500: { description: 'Server error' }
        },
        'x-route-source': {
            file: endpoint.routeFile,
            line: endpoint.line
        },
        'x-generated-from-catalog': true
    };

    const parameters = getPathParameters(endpoint.path);
    if (parameters.length) operation.parameters = parameters;

    if (['post', 'put', 'patch'].includes(endpoint.method)) {
        operation.requestBody = {
            required: false,
            content: {
                'application/json': {
                    schema: {
                        type: 'object',
                        additionalProperties: true
                    }
                }
            }
        };
    }

    return operation;
}

function normalizeExistingPaths(paths = {}) {
    const normalized = {};
    for (const [rawPath, methods] of Object.entries(paths)) {
        const fullPath = rawPath.startsWith('/api/')
            || rawPath.startsWith('/v1/')
            || rawPath.startsWith('/auth/')
            || rawPath.startsWith('/admin/')
            || rawPath === '/health'
            ? rawPath
            : joinPaths('/api', rawPath);
        normalized[fullPath] = {
            ...(normalized[fullPath] || {}),
            ...methods
        };
    }
    return normalized;
}

function applyApiCatalogToSpec(spec) {
    const catalog = getApiCatalog();
    const paths = normalizeExistingPaths(spec.paths || {});

    for (const endpoint of catalog.endpoints) {
        if (!paths[endpoint.path]) paths[endpoint.path] = {};
        if (!paths[endpoint.path][endpoint.method]) {
            paths[endpoint.path][endpoint.method] = generatedOperation(endpoint);
        }
    }

    spec.paths = Object.fromEntries(
        Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))
    );
    spec.tags = getCatalogTags(catalog.endpoints);
    spec.servers = [{ url: '/', description: 'Dashboard origin' }];
    spec['x-api-catalog'] = {
        endpointCount: catalog.endpoints.length,
        source: catalog.source
    };

    return spec;
}

module.exports = {
    getApiCatalog,
    applyApiCatalogToSpec,
    toOpenApiPath
};
