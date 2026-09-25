'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/sms.js'), 'utf8');
const handler = source.slice(source.indexOf('    function handleChatSendSms(e)'),
    source.indexOf('    // Handle send SMS', source.indexOf('    function handleChatSendSms(e)')));

test.each(['', 'Photo caption'])('attachment compose explains the unsupported transport before text validation: %j', message => {
    const context = {
        document: { getElementById: id => id === 'smsChatMessage' ? { value: message } : null },
        window: { getActiveDeviceId: () => 'esp32-test' },
        isSystemSmsThread: () => false,
        validatePhoneField: () => ({ ok: true, values: ['+8801000000000'] }),
        analyzeSmsComposeText: () => ({ valid: true }),
        getChatSendMode: () => 'instant',
        smsAttachment: { type: 'image/png', name: 'test.png' },
        showToast: jest.fn(), fetch: jest.fn()
    };
    vm.createContext(context);
    vm.runInContext(handler, context);
    const event = { preventDefault: jest.fn() };
    context.handleChatSendSms(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(context.showToast).toHaveBeenCalledTimes(1);
    expect(context.showToast).toHaveBeenCalledWith(expect.stringContaining('MMS attachment transport is not enabled'), 'warning');
    expect(context.fetch).not.toHaveBeenCalled();
});

test('empty text without an attachment retains the ordinary compose warning', () => {
    const context = {
        document: { getElementById: () => null },
        window: { getActiveDeviceId: () => 'esp32-test' },
        isSystemSmsThread: () => false,
        validatePhoneField: () => ({ ok: true, values: ['+8801000000000'] }),
        analyzeSmsComposeText: () => ({ valid: true }),
        getChatSendMode: () => 'instant',
        smsAttachment: null, showToast: jest.fn(), fetch: jest.fn()
    };
    vm.createContext(context);
    vm.runInContext(handler, context);
    context.handleChatSendSms({ preventDefault: jest.fn() });
    expect(context.showToast).toHaveBeenCalledWith('Please type a message first.', 'warning');
    expect(context.fetch).not.toHaveBeenCalled();
});
