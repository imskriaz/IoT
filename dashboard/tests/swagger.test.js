'use strict';

const swaggerSpec = require('../config/swagger');
const { getApiCatalog } = require('../config/api-catalog');

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
});
