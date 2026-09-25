'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

const source = fs.readFileSync(path.join(__dirname, '../public/js/sms.js'), 'utf8');
const recoverySource = source.slice(source.indexOf('    function attachSmsLiveRecovery()'),
    source.indexOf('    function attachScheduledSmsUpdates()'));
const timestampSource = source.slice(source.indexOf('    function parseSmsTimestamp(ts)'),
    source.indexOf('    function formatTs(ts)'));

function eventTarget() {
    const target = new EventEmitter();
    target.addEventListener = target.on.bind(target);
    target.removeEventListener = target.off.bind(target);
    return target;
}

function setup({ connected = false, socketPresent = true } = {}) {
    const socket = Object.assign(new EventEmitter(), { connected });
    const window = eventTarget();
    if (socketPresent) window.socket = socket;
    const document = Object.assign(eventTarget(), { hidden: false });
    const context = {
        window, document, navigator: { onLine: true }, Promise, setTimeout, clearTimeout,
        threadState: { number: '+8801000000000', conversationId: 4, title: 'Test thread' },
        getSmsActiveDeviceId: jest.fn(() => 'esp32-test'),
        isSmsDeviceSnapshotCurrent: jest.fn(() => true),
        isThreadModalOpen: jest.fn(() => true),
        refreshSmsPageData: jest.fn().mockResolvedValue(undefined),
        loadSmsThread: jest.fn().mockResolvedValue(undefined)
    };
    vm.createContext(context);
    vm.runInContext(recoverySource, context);
    context.attachSmsLiveRecovery();
    return { ...context, socket };
}

async function settle() {
    for (let i = 0; i < 12; i++) await Promise.resolve();
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
});

test.each([true, false])('disconnected fallback waits 15 seconds and remains bounded (socket present: %s)', async socketPresent => {
    const app = setup({ socketPresent });
    for (let i = 0; i < 20; i++) app.socket.emit('connect_error');
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(14999);
    expect(app.refreshSmsPageData).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(app.refreshSmsPageData).toHaveBeenCalledTimes(1);
    expect(app.loadSmsThread).toHaveBeenCalledWith('+8801000000000', expect.objectContaining({
        conversationId: 4, showModal: false, silent: true, historyMode: 'ignore'
    }));
    await jest.advanceTimersByTimeAsync(15000);
    expect(app.refreshSmsPageData).toHaveBeenCalledTimes(2);
});

test('connected socket has no periodic polling; reconnect catches up and cancels fallback', async () => {
    const app = setup({ connected: true });
    await jest.advanceTimersByTimeAsync(60000);
    expect(app.refreshSmsPageData).not.toHaveBeenCalled();
    app.socket.connected = false;
    app.socket.emit('disconnect');
    expect(jest.getTimerCount()).toBe(1);
    app.socket.connected = true;
    app.socket.emit('connect');
    await settle();
    expect(app.refreshSmsPageData).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
});

test('reconnect during an active refresh coalesces one follow-up without overlapping requests', async () => {
    const app = setup();
    let resolveFirst;
    app.refreshSmsPageData.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }));
    await jest.advanceTimersByTimeAsync(15000);
    app.socket.connected = true;
    app.socket.emit('connect');
    app.window.emit('online');
    await settle();
    expect(app.refreshSmsPageData).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    resolveFirst();
    await settle();
    expect(app.refreshSmsPageData).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
});

test('failed refresh retries only after the fallback interval', async () => {
    const app = setup();
    app.refreshSmsPageData.mockRejectedValueOnce(new Error('network unavailable'));
    await jest.advanceTimersByTimeAsync(15000);
    expect(app.loadSmsThread).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(14999);
    expect(app.refreshSmsPageData).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(app.refreshSmsPageData).toHaveBeenCalledTimes(2);
});

test('hidden and offline pages pause requests and catch up when visible or online', async () => {
    const app = setup();
    app.document.hidden = true;
    app.document.emit('visibilitychange');
    await jest.advanceTimersByTimeAsync(60000);
    expect(jest.getTimerCount()).toBe(0);
    expect(app.refreshSmsPageData).not.toHaveBeenCalled();
    app.navigator.onLine = false;
    app.document.hidden = false;
    app.document.emit('visibilitychange');
    await settle();
    expect(app.refreshSmsPageData).not.toHaveBeenCalled();
    app.navigator.onLine = true;
    app.window.emit('online');
    await settle();
    expect(app.refreshSmsPageData).toHaveBeenCalledTimes(1);
    app.navigator.onLine = false;
    await jest.advanceTimersByTimeAsync(60000);
    expect(app.refreshSmsPageData).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
});

test.each(['device', 'thread', 'closed'])('does not restore a stale thread after %s changes during refresh', async change => {
    const app = setup();
    let resolveFirst;
    app.refreshSmsPageData.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }));
    await jest.advanceTimersByTimeAsync(15000);
    if (change === 'device') app.isSmsDeviceSnapshotCurrent.mockReturnValue(false);
    if (change === 'thread') app.threadState.number = '+8801000000001';
    if (change === 'closed') app.isThreadModalOpen.mockReturnValue(false);
    resolveFirst();
    await settle();
    expect(app.loadSmsThread).not.toHaveBeenCalled();
});

test('unload removes recovery listeners and prevents an in-flight request from rearming', async () => {
    const app = setup();
    let resolveFirst;
    app.refreshSmsPageData.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }));
    await jest.advanceTimersByTimeAsync(15000);
    app.socket.emit('connect');
    app.window.emit('beforeunload');
    resolveFirst();
    await settle();
    expect(app.loadSmsThread).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
    expect(app.socket.eventNames()).toEqual([]);
    expect(app.document.eventNames()).toEqual([]);
    expect(app.window.eventNames()).toEqual([]);
    await jest.advanceTimersByTimeAsync(60000);
    expect(app.refreshSmsPageData).toHaveBeenCalledTimes(1);
});

test.each([
    ['2026-09-13 03:22:58', '2026-09-13T03:22:58.000Z'],
    ['2026-09-13T03:22:58', '2026-09-13T03:22:58.000Z'],
    [' 2026-09-13 03:22:58.123 ', '2026-09-13T03:22:58.123Z'],
    ['2026-09-13T09:22:58+06:00', '2026-09-13T03:22:58.000Z'],
    ['2026-09-12T22:22:58-05:00', '2026-09-13T03:22:58.000Z'],
    ['2026-09-13T03:22:58Z', '2026-09-13T03:22:58.000Z'],
    [0, '1970-01-01T00:00:00.000Z']
])('parses persisted UTC timestamps without shifting explicit offsets: %s', (value, expected) => {
    const context = vm.createContext({});
    vm.runInContext(timestampSource, context);
    expect(context.parseSmsTimestamp(value).toISOString()).toBe(expected);
});

test('invalid timestamps remain invalid rather than displaying an invented date', () => {
    const context = vm.createContext({});
    vm.runInContext(timestampSource, context);
    expect(Number.isNaN(context.parseSmsTimestamp('not a timestamp').getTime())).toBe(true);
});
