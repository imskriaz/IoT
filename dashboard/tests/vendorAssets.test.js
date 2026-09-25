'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { mountVendorAssets } = require('../config/vendorAssets');

function templates(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const file = path.join(directory, entry.name);
        return entry.isDirectory() ? templates(file) : entry.name.endsWith('.html') ? [file] : [];
    });
}

const sources = templates(path.join(__dirname, '../views')).map(file => fs.readFileSync(file, 'utf8'));
const assets = [...new Set(sources.flatMap(source =>
    [...source.matchAll(/(?:src|href)=["'](\/vendor\/[^"'?]+)["']/g)].map(match => match[1])
))];
// Assets referenced indirectly by library CSS must work as well.
assets.push('/vendor/bootstrap-icons/fonts/bootstrap-icons.woff2',
    '/vendor/intl-tel-input/img/flags.webp', '/vendor/leaflet/images/marker-icon.png',
    '/vendor/leaflet.fullscreen/icon-fullscreen.svg');

const app = express();
mountVendorAssets(app);

test.each(assets)('serves browser asset %s without authentication or an HTML fallback', async url => {
    const response = await request(app).get(url);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).not.toMatch(/text\/html/);
    expect(Number(response.headers['content-length'])).toBeGreaterThan(0);
    if (url.endsWith('.css')) expect(response.headers['content-type']).toMatch(/text\/css/);
    if (url.endsWith('.js')) expect(response.headers['content-type']).toMatch(/javascript/);
});

test('missing vendor assets return 404 instead of falling through to authenticated pages', async () => {
    app.use((_req, res) => res.redirect('/auth/login'));
    const response = await request(app).get('/vendor/bootstrap/missing.js');
    expect(response.status).toBe(404);
    expect(response.headers.location).toBeUndefined();
});

test('scripts and styles do not require CDN exceptions in the CSP', () => {
    for (const source of sources) {
        expect(source).not.toMatch(/<(?:script|link)\b[^>]*(?:src|href)=["']https?:\/\//i);
    }
});
