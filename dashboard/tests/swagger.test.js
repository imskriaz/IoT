'use strict';

const swaggerSpec = require('../config/swagger');
const { getApiCatalog, getCatalogRouteMounts, getApiRouteMounts } = require('../config/api-catalog');

describe('Swagger API auth', () => {
    test('documents only X-API-Key auth in the Authorize modal', () => {
        expect(swaggerSpec.components.securitySchemes).toEqual({
            apiKey: expect.objectContaining({
                type: 'apiKey',
                in: 'header',
                name: 'X-API-Key'
            })
        });

        expect(swaggerSpec.security).toEqual([{ apiKey: [] }]);
        expect(JSON.stringify(swaggerSpec)).not.toContain('sessionCookie');
        expect(JSON.stringify(swaggerSpec)).not.toContain('bearerApiKey');
    });

    test('covers every endpoint from the shared API catalog', () => {
        const catalog = getApiCatalog();
        const missing = catalog.endpoints.filter((endpoint) => {
            const pathItem = swaggerSpec.paths?.[endpoint.path];
            return !pathItem || !pathItem[endpoint.method];
        });

        expect(catalog.endpoints.length).toBeGreaterThan(150);
        expect(missing).toEqual([]);
        expect(swaggerSpec['x-api-catalog']).toEqual(expect.objectContaining({
            endpointCount: catalog.endpoints.length,
            source: 'dashboard/config/api-catalog.js'
        }));
    });

    test('catalog includes every mounted device route family', () => {
        const paths = getApiCatalog().endpoints.map((endpoint) => endpoint.path);
        expect(paths).toEqual(expect.arrayContaining([
            '/api/notifications',
            '/api/notifications/read',
            '/api/notifications/delete',
            '/api/devices/{deviceId}/hardware',
            '/api/devices/{deviceId}/hardware/validate',
            '/api/devices/{deviceId}/hardware/apply'
        ]));
    });

    test('catalog mount inventory matches the API router source', () => {
        const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'api.js'), 'utf8');
        for (const mount of getApiRouteMounts()) {
            expect(source).toContain(`router.use('${mount.basePath.slice('/api'.length)}', require('./${mount.file.replace(/\.js$/, '')}'))`);
        }
        const mounted = [...source.matchAll(/router\.use\('([^']+)', require\('\.\/([^']+)'\)\)/g)]
            .map(([, basePath, file]) => ({ basePath: `/api${basePath}`, file }));
        for (const mount of mounted) {
            expect(getCatalogRouteMounts().map((entry) => ({ ...entry, file: entry.file.replace(/\.js$/, '') }))).toEqual(expect.arrayContaining([
                expect.objectContaining({ basePath: mount.basePath, file: mount.file.replace(/\.js$/, '') })
            ]));
        }
    });
});
