'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');

// Resolve from this dashboard so both standalone and hoisted npm installs work.
// Expose only browser distribution directories, never the entire node_modules tree.
const distributions = {
    bootstrap: 'dist',
    'bootstrap-icons': 'font',
    dexie: 'dist',
    'intl-tel-input': 'build',
    jquery: 'dist',
    select2: 'dist',
    'select2-bootstrap-5-theme': 'dist',
    leaflet: 'dist',
    'leaflet.fullscreen': '',
    'chart.js': 'dist'
};

function packageDirectory(name) {
    try {
        return path.dirname(require.resolve(`${name}/package.json`));
    } catch (error) {
        if (!['ERR_PACKAGE_PATH_NOT_EXPORTED', 'MODULE_NOT_FOUND'].includes(error.code)) throw error;
    }
    // Some packages restrict package.json through exports; resolve their entry
    // and walk up to the matching manifest instead of assuming a disk layout.
    let directory = path.dirname(require.resolve(name));
    while (true) {
        const manifest = path.join(directory, 'package.json');
        if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, 'utf8')).name === name) {
            return directory;
        }
        const parent = path.dirname(directory);
        if (parent === directory) throw new Error(`Cannot locate browser assets for ${name}`);
        directory = parent;
    }
}

function mountVendorAssets(app) {
    for (const [name, distribution] of Object.entries(distributions)) {
        const directory = path.join(packageDirectory(name), distribution);
        app.use(`/vendor/${name}`, express.static(directory, { index: false, redirect: false }));
    }
    // Missing assets must be a real 404, not a login redirect or HTML page.
    app.use('/vendor', (_req, res) => res.status(404).type('text').send('Asset not found'));
}

module.exports = { mountVendorAssets };
