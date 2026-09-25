'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/sms.js'), 'utf8');
const start = source.indexOf('function handleLiveSmsEvent(');
const end = source.indexOf('smsSyncStartedHandler =', start);

test.each(['matched', 'unmatched', undefined])('partial delivery refreshes only correlated messages: %s', correlation => {
    const context = { matchesSmsScope: () => true, scheduleSmsRefresh: jest.fn(), scheduleThreadRefresh: jest.fn() };
    vm.createContext(context);
    vm.runInContext(source.slice(start, end), context);
    context.handleLiveSmsEvent('sms:delivery', { correlation, status: 'sent' });
    expect(context.scheduleSmsRefresh).toHaveBeenCalledTimes(correlation === 'matched' ? 1 : 0);
    expect(context.scheduleThreadRefresh).toHaveBeenCalledTimes(correlation === 'matched' ? 1 : 0);
});

test('subscribes to neutral delivery events', () => {
    expect(source).toContain("'sms:delivery': function (data) { handleLiveSmsEvent('sms:delivery', data); }");
});
