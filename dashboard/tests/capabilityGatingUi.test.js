'use strict';

const fs = require('fs');
const path = require('path');

function read(relativePath) {
    return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

describe('device capability UI gating', () => {
    test('call history sync and incoming remote controls default hidden', () => {
        const callsPage = read('views/pages/calls.html');
        const layout = read('views/layouts/main.html');
        const callsJs = read('public/js/calls.js');
        const mainJs = read('public/js/main.js');

        expect(callsPage).toContain('data-call-capability="android" id="syncCallsBtn"');
        expect(callsPage).toContain('id="syncCallsBtn"');
        expect(callsPage).toContain('disabled');
        expect(layout).toContain('id="incomingCallRemoteActions" data-call-capability="android"');
        expect(layout).toContain('Answer or reject on the connected device.');
        expect(callsJs).toContain('function supportsAndroidCallControls()');
        expect(callsJs).toContain("return identity.includes('android');");
        expect(mainJs).toContain('function supportsAndroidIncomingCallControls()');
        expect(mainJs).toContain("showToast('Answer this call on the connected device', 'warning');");
        expect(mainJs).toContain("showToast('Reject this call on the connected device', 'warning');");
    });

    test('unsupported hold and mute handlers do not reach fetch', () => {
        const callsJs = read('public/js/calls.js');
        const muteStart = callsJs.indexOf('window.muteCall = function ()');
        const holdStart = callsJs.indexOf('window.holdCall = function ()');
        const muteGuard = callsJs.slice(muteStart, callsJs.indexOf("fetch(buildCallsApiUrl('/api/calls/mute')", muteStart));
        const holdGuard = callsJs.slice(holdStart, callsJs.indexOf("fetch(buildCallsApiUrl('/api/calls/hold')", holdStart));
        expect(muteGuard).toContain('return;');
        expect(holdGuard).toContain('return;');
    });

    test('storage mutations are hidden and guarded from keyboard or stale modal entry points', () => {
        const storagePage = read('views/pages/storage.html');
        const storageJs = read('public/js/storage.js');

        for (const action of ['write', 'create', 'delete', 'rename', 'move', 'copy', 'compress', 'format']) {
            expect(storagePage).toContain(`data-storage-mutation="${action}"`);
        }
        expect(storagePage).toContain('id="storageReadOnlyNotice"');
        expect(storageJs).toContain('function requireStorageMutation(action)');
        expect(storageJs).toContain("if (!requireStorageMutation('delete')) return;");
        expect(storageJs).toContain("if (!requireStorageMutation('format')) return;");
        expect(storageJs).toContain("if (!requireStorageMutation('write')) return;");
        expect(storageJs).toContain("if (!requireStorageMutation('move')) return;");
    });
});
