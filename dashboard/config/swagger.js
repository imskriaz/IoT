'use strict';
const swaggerJsdoc = require('swagger-jsdoc');

const options = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'Device Bridge API',
            version: '2.1.0',
            description: 'REST API for remotely controlling and monitoring IoT boards over MQTT.'
        },
        servers: [{ url: '/api', description: 'API base path' }],
        components: {
            securitySchemes: {
                sessionCookie: {
                    type: 'apiKey',
                    in: 'cookie',
                    name: 'connect.sid'
                }
            },
            schemas: {
                Error: {
                    type: 'object',
                    properties: {
                        success: { type: 'boolean', example: false },
                        message: { type: 'string' }
                    }
                },
                Pagination: {
                    type: 'object',
                    properties: {
                        page:  { type: 'integer' },
                        limit: { type: 'integer' },
                        total: { type: 'integer' },
                        pages: { type: 'integer' }
                    }
                },
                SMS: {
                    type: 'object',
                    properties: {
                        id:           { type: 'integer' },
                        device_id:    { type: 'string' },
                        from_number:  { type: 'string' },
                        to_number:    { type: 'string', nullable: true },
                        message:      { type: 'string' },
                        timestamp:    { type: 'string', format: 'date-time' },
                        read:         { type: 'boolean' },
                        type:         { type: 'string', enum: ['incoming', 'outgoing'] },
                        status:       { type: 'string' }
                    }
                },
                Call: {
                    type: 'object',
                    properties: {
                        id:           { type: 'integer' },
                        device_id:    { type: 'string' },
                        phone_number: { type: 'string' },
                        contact_name: { type: 'string', nullable: true },
                        type:         { type: 'string', enum: ['incoming', 'outgoing', 'missed'] },
                        status:       { type: 'string' },
                        start_time:   { type: 'string', format: 'date-time' },
                        end_time:     { type: 'string', format: 'date-time', nullable: true },
                        duration:     { type: 'integer', description: 'Seconds' }
                    }
                },
                Contact: {
                    type: 'object',
                    properties: {
                        id:           { type: 'integer' },
                        name:         { type: 'string' },
                        phone_number: { type: 'string' },
                        email:        { type: 'string', nullable: true },
                        company:      { type: 'string', nullable: true },
                        favorite:     { type: 'boolean' },
                        notes:        { type: 'string', nullable: true }
                    }
                },
                GpsLocation: {
                    type: 'object',
                    properties: {
                        id:         { type: 'integer' },
                        device_id:  { type: 'string' },
                        latitude:   { type: 'number' },
                        longitude:  { type: 'number' },
                        altitude:   { type: 'number', nullable: true },
                        satellites: { type: 'integer', nullable: true },
                        timestamp:  { type: 'string', format: 'date-time' }
                    }
                },
                Device: {
                    type: 'object',
                    properties: {
                        id:       { type: 'string' },
                        name:     { type: 'string', nullable: true },
                        online:   { type: 'boolean' },
                        signal:   { type: 'number', nullable: true },
                        battery:  { type: 'number', nullable: true },
                        network:  { type: 'string', nullable: true },
                        operator: { type: 'string', nullable: true },
                        lastSeen: { type: 'string', format: 'date-time', nullable: true }
                    }
                },
                ApiKey: {
                    type: 'object',
                    properties: {
                        id:            { type: 'integer' },
                        name:          { type: 'string' },
                        key_prefix:    { type: 'string', description: 'First 8 chars of key (for identification)' },
                        scopes:        { type: 'string', example: 'read,write' },
                        device_ids:    { type: 'string', nullable: true },
                        last_used:     { type: 'string', format: 'date-time', nullable: true },
                        expires_at:    { type: 'string', format: 'date-time', nullable: true },
                        is_active:     { type: 'boolean' },
                        rate_limit_rpm:{ type: 'integer', nullable: true },
                        created_at:    { type: 'string', format: 'date-time' }
                    }
                },
                Webhook: {
                    type: 'object',
                    properties: {
                        id:           { type: 'integer' },
                        name:         { type: 'string' },
                        url:          { type: 'string', format: 'uri' },
                        events:       { type: 'string', example: 'sms.incoming,call.incoming' },
                        device_ids:   { type: 'string', nullable: true },
                        is_active:    { type: 'boolean' },
                        last_fired_at:{ type: 'string', format: 'date-time', nullable: true },
                        last_status:  { type: 'integer', nullable: true },
                        created_at:   { type: 'string', format: 'date-time' }
                    }
                },
                DeviceGroup: {
                    type: 'object',
                    properties: {
                        id:           { type: 'integer' },
                        name:         { type: 'string' },
                        description:  { type: 'string', nullable: true },
                        color:        { type: 'string', example: '#0d6efd' },
                        owner_id:     { type: 'integer' },
                        owner_name:   { type: 'string', nullable: true },
                        member_count: { type: 'integer' },
                        created_at:   { type: 'string', format: 'date-time' }
                    }
                },
                FlowTemplate: {
                    type: 'object',
                    properties: {
                        id:          { type: 'string' },
                        name:        { type: 'string' },
                        description: { type: 'string' },
                        condition:   { type: 'string' },
                        action:      { type: 'string', description: 'JSON-encoded action object' },
                        tags:        { type: 'array', items: { type: 'string' } }
                    }
                },
                FlowExecutionLog: {
                    type: 'object',
                    properties: {
                        id:               { type: 'integer' },
                        rule_id:          { type: 'string' },
                        device_id:        { type: 'string' },
                        rule_name:        { type: 'string' },
                        condition_values: { type: 'string', description: 'JSON snapshot of context values at trigger time' },
                        triggered_at:     { type: 'string', format: 'date-time' }
                    }
                }
            }
        },
        security: [{ sessionCookie: [] }]
    },
    apis: ['./routes/*.js']
};

module.exports = swaggerJsdoc(options);
