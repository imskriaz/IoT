'use strict';

const swaggerSpec = require('../config/swagger');

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
});
