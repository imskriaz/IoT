(function () {
    'use strict';

    const instances = new WeakMap();
    let initPromise = null;

    function getInput(ref) {
        if (!ref) return null;
        if (ref instanceof HTMLElement) return ref;
        return document.getElementById(ref);
    }

    function getCountryData() {
        return window.intlTelInputGlobals?.getCountryData?.() || [];
    }

    function getBrowserCountry() {
        const locale = Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
        const match = locale.match(/-([A-Z]{2})$/i);
        return match ? match[1].toLowerCase() : 'us';
    }

    function inferCountryFromDialCode(dialCode) {
        const digits = String(dialCode || '').replace(/\D/g, '');
        if (!digits) return null;

        for (const country of getCountryData()) {
            if (!country?.iso2 || !country?.dialCode) continue;
            if (String(country.dialCode) === digits) {
                return country.iso2;
            }
        }

        return null;
    }

    function getConfiguredCountry() {
        const preferredIso = String(window.PREFERRED_PHONE_COUNTRY_ISO2 || '').trim().toLowerCase();
        if (/^[a-z]{2}$/.test(preferredIso)) {
            return preferredIso;
        }

        return inferCountryFromDialCode(window.PREFERRED_PHONE_COUNTRY_CODE);
    }

    function inferCountryFromNumber(number) {
        const digits = String(number || '').replace(/\D/g, '');
        if (!digits) return null;

        let bestMatch = null;
        for (const country of getCountryData()) {
            if (!country?.iso2 || !country?.dialCode) continue;
            if (!digits.startsWith(country.dialCode)) continue;
            if (!bestMatch || country.dialCode.length > bestMatch.dialCode.length) {
                bestMatch = country;
            }
        }

        return bestMatch?.iso2 || null;
    }

    async function fetchDefaultCountry() {
        const configuredCountry = getConfiguredCountry();
        if (configuredCountry) {
            return configuredCountry;
        }

        try {
            const response = await fetch('/api/status', {
                cache: 'no-store',
                credentials: 'same-origin',
                headers: {
                    Accept: 'application/json',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache'
                }
            });
            const payload = await response.json();
            if (!payload?.success) return getBrowserCountry();

            const sim = payload?.data?.sim || null;
            const fromNumber = inferCountryFromNumber(sim?.number);
            if (fromNumber) return fromNumber;
        } catch (_) {}

        return getBrowserCountry();
    }

    function looksLikeShortCode(raw) {
        const compact = String(raw || '').replace(/\s+/g, '');
        return /^[*#\d]{2,8}$/.test(compact);
    }

    function getFallbackValue(input, allowShortCode) {
        const raw = String(input?.value || '').trim();
        if (!raw) return '';
        if (allowShortCode && looksLikeShortCode(raw) && !raw.startsWith('+')) {
            return raw.replace(/\s+/g, '');
        }
        const digits = raw.replace(/\D/g, '');
        if (!digits) return '';
        if (raw.startsWith('+')) return '+' + digits;
        if (raw.startsWith('00')) return '+' + digits.slice(2);
        return '+' + digits;
    }

    function initInput(input, initialCountry) {
        if (!input || instances.has(input) || typeof window.intlTelInput !== 'function') {
            return instances.get(input) || null;
        }

        const instance = window.intlTelInput(input, {
            initialCountry: input.dataset.phoneInitialCountry || initialCountry || 'us',
            autoPlaceholder: input.dataset.phonePlaceholder || 'aggressive',
            formatAsYouType: true,
            nationalMode: true,
            separateDialCode: input.dataset.phoneSeparateDialCode !== 'false',
            strictMode: false
        });

        instances.set(input, instance);

        input.addEventListener('countrychange', () => {
            const iso2 = instance.getSelectedCountryData?.()?.iso2 || '';
            input.dataset.phoneCountry = iso2;
        });

        return instance;
    }

    async function initAll(root = document) {
        const country = await fetchDefaultCountry();
        root.querySelectorAll('[data-intl-tel-input]').forEach((input) => {
            const instance = initInput(input, country);
            if (instance && input.dataset.phoneValue) {
                instance.setNumber(input.dataset.phoneValue);
            }
        });

        document.dispatchEvent(new CustomEvent('phone-inputs:ready', {
            detail: { country }
        }));

        return country;
    }

    function ensureInit() {
        if (!initPromise) {
            initPromise = initAll();
        }
        return initPromise;
    }

    function setValue(ref, value) {
        const input = getInput(ref);
        if (!input) return;

        const instance = instances.get(input) || initInput(input, getBrowserCountry());
        if (instance) {
            instance.setNumber(String(value || ''));
        } else {
            input.value = String(value || '');
        }

        input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function sync(ref) {
        const input = getInput(ref);
        if (!input) return;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function getValue(ref, options = {}) {
        const input = getInput(ref);
        if (!input) return '';

        const allowShortCode = options.allowShortCode === true;
        const raw = String(input.value || '').trim();
        if (!raw) return '';

        if (allowShortCode && looksLikeShortCode(raw) && !raw.startsWith('+')) {
            return raw.replace(/\s+/g, '');
        }

        const instance = instances.get(input);
        if (instance) {
            const candidate = instance.getNumber?.() || '';
            if (/^\+[1-9]\d{5,14}$/.test(candidate)) {
                return candidate;
            }
        }

        return getFallbackValue(input, allowShortCode);
    }

    function validate(ref, options = {}) {
        const input = getInput(ref);
        const required = options.required !== false;
        const allowShortCode = options.allowShortCode === true;
        const raw = String(input?.value || '').trim();

        if (!raw) {
            return required
                ? { ok: false, value: '', message: 'Phone number is required' }
                : { ok: true, value: '', message: '' };
        }

        if (allowShortCode && looksLikeShortCode(raw) && !raw.startsWith('+')) {
            return { ok: true, value: raw.replace(/\s+/g, ''), serviceCode: true, message: '' };
        }

        const value = getValue(input, { allowShortCode });
        if (!/^\+[1-9]\d{5,14}$/.test(value)) {
            return { ok: false, value, message: 'Enter a valid international phone number' };
        }

        const instance = instances.get(input);
        if (instance?.isValidNumber && !instance.isValidNumber()) {
            return { ok: false, value, message: 'Enter a valid phone number for the selected country' };
        }

        return { ok: true, value, message: '' };
    }

    window.PhoneInputs = {
        ensureInit,
        initAll,
        inferCountryFromNumber,
        looksLikeShortCode,
        setValue,
        sync,
        getValue,
        validate
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', ensureInit, { once: true });
    } else {
        ensureInit();
    }
})();
