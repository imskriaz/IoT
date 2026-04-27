'use strict';

const express = require('express');
const request = require('supertest');
const { buildRawBodyPreview, captureRawBody, createErrorHandler } = require('../middleware/errorHandler');

describe('error handler middleware', () => {
    test('buildRawBodyPreview normalizes whitespace and truncates long payloads', () => {
        expect(buildRawBodyPreview("  { 'a': 1 }\n\n")).toBe("{ 'a': 1 }");
        expect(buildRawBodyPreview('x'.repeat(200))).toHaveLength(163);
    });

    test('returns 400 for malformed JSON requests and logs a warning preview', async () => {
        const logger = {
            warn: jest.fn(),
            error: jest.fn()
        };
        const app = express();

        app.use(express.json({ verify: captureRawBody }));
        app.post('/api/settings/system', (_req, res) => res.json({ success: true }));
        app.use(createErrorHandler(logger));

        const response = await request(app)
            .post('/api/settings/system')
            .set('Content-Type', 'application/json')
            .send("{'timezone':'Asia/Dhaka'}");

        expect(response.status).toBe(400);
        expect(response.body).toEqual({
            success: false,
            message: 'Invalid JSON body'
        });
        expect(logger.warn).toHaveBeenCalledWith('Invalid JSON body', expect.objectContaining({
            url: '/api/settings/system',
            method: 'POST',
            bodyPreview: "{'timezone':'Asia/Dhaka'}"
        }));
        expect(logger.error).not.toHaveBeenCalled();
    });

    test('logs non-parse failures as unhandled errors', async () => {
        const logger = {
            warn: jest.fn(),
            error: jest.fn()
        };
        const app = express();

        app.get('/api/fail', () => {
            throw new Error('boom');
        });
        app.use(createErrorHandler(logger));

        const response = await request(app).get('/api/fail');

        expect(response.status).toBe(500);
        expect(response.body).toEqual({
            success: false,
            message: 'boom'
        });
        expect(logger.warn).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith('Unhandled error: boom', expect.objectContaining({
            url: '/api/fail',
            method: 'GET'
        }));
    });

    test('delegates when headers were already sent', () => {
        const logger = {
            warn: jest.fn(),
            error: jest.fn()
        };
        const handler = createErrorHandler(logger);
        const error = new Error('late failure');
        const next = jest.fn();

        handler(error, { originalUrl: '/api/fail' }, { headersSent: true }, next);

        expect(next).toHaveBeenCalledWith(error);
        expect(logger.warn).not.toHaveBeenCalled();
        expect(logger.error).not.toHaveBeenCalled();
    });
});
