(function () {
    'use strict';

    const fallbackTimeZone = (() => {
        try {
            return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        } catch (_) {
            return 'UTC';
        }
    })();

    let activeTimeZone = fallbackTimeZone;
    const nativeToLocaleString = Date.prototype.toLocaleString;
    const nativeToLocaleDateString = Date.prototype.toLocaleDateString;
    const nativeToLocaleTimeString = Date.prototype.toLocaleTimeString;

    function isValidTimeZone(value) {
        const zone = String(value || '').trim();
        if (!zone) return false;
        try {
            new Intl.DateTimeFormat(undefined, { timeZone: zone }).format(new Date());
            return true;
        } catch (_) {
            return false;
        }
    }

    function setTimeZone(value) {
        const zone = String(value || '').trim();
        activeTimeZone = isValidTimeZone(zone) ? zone : fallbackTimeZone;
        return activeTimeZone;
    }

    function dateFrom(value) {
        if (!value) return null;
        const date = value instanceof Date ? value : new Date(value);
        return Number.isNaN(date.getTime()) ? null : date;
    }

    function format(value, options = {}) {
        const date = dateFrom(value);
        if (!date) return value ? String(value) : '';
        const opts = { ...options };
        if (!opts.timeZone) opts.timeZone = activeTimeZone;
        try {
            return new Intl.DateTimeFormat(undefined, opts).format(date);
        } catch (_) {
            return date.toLocaleString();
        }
    }

    window.DashboardTime = {
        browserTimeZone: fallbackTimeZone,
        getTimeZone: () => activeTimeZone,
        isValidTimeZone,
        setTimeZone,
        formatDateTime: value => format(value, {
            year: 'numeric',
            month: 'short',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        }),
        formatDate: value => format(value, {
            year: 'numeric',
            month: 'short',
            day: '2-digit'
        }),
        formatTime: value => format(value, {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        })
    };

    window.formatDashboardDateTime = window.DashboardTime.formatDateTime;
    window.formatDashboardDate = window.DashboardTime.formatDate;
    window.formatDashboardTime = window.DashboardTime.formatTime;

    function withActiveTimeZone(options) {
        if (options && Object.prototype.hasOwnProperty.call(options, 'timeZone')) {
            return options;
        }
        return { ...(options || {}), timeZone: activeTimeZone };
    }

    Date.prototype.toLocaleString = function (locales, options) {
        return nativeToLocaleString.call(this, locales, withActiveTimeZone(options));
    };

    Date.prototype.toLocaleDateString = function (locales, options) {
        return nativeToLocaleDateString.call(this, locales, withActiveTimeZone(options));
    };

    Date.prototype.toLocaleTimeString = function (locales, options) {
        return nativeToLocaleTimeString.call(this, locales, withActiveTimeZone(options));
    };
})();
