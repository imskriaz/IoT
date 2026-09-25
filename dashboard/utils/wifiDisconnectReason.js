'use strict';

const WIFI_DISCONNECT_REASON_TEXT = {
    0: '',
    1: 'unspecified',
    2: 'auth_expire',
    3: 'auth_leave',
    4: 'assoc_expire',
    5: 'assoc_too_many',
    6: 'not_authed',
    7: 'not_assoced',
    8: 'assoc_leave',
    9: 'assoc_not_authed',
    15: '4way_handshake_timeout',
    16: 'group_key_update_timeout',
    23: '8021x_auth_failed',
    200: 'beacon_timeout',
    201: 'no_ap_found',
    202: 'auth_fail',
    203: 'assoc_fail',
    204: 'handshake_timeout',
    205: 'connection_fail',
    206: 'ap_tsf_reset',
    207: 'roaming',
    208: 'assoc_comeback_too_long',
    209: 'sa_query_timeout',
    210: 'no_ap_with_compatible_security',
    211: 'no_ap_in_authmode_threshold',
    212: 'no_ap_in_rssi_threshold'
};

function getWifiDisconnectReasonText(reasonCode, providedText = '') {
    const normalizedText = String(providedText || '').trim();
    if (normalizedText) {
        return normalizedText;
    }

    const code = Number(reasonCode || 0);
    return WIFI_DISCONNECT_REASON_TEXT[code] || (code > 0 ? 'unknown' : '');
}

function formatWifiDisconnectReason(reasonCode, providedText = '') {
    const code = Number(reasonCode || 0);
    const text = getWifiDisconnectReasonText(code, providedText);

    if (!text) {
        return String(code);
    }

    return `${code} (${text})`;
}

module.exports = {
    WIFI_DISCONNECT_REASON_TEXT,
    getWifiDisconnectReasonText,
    formatWifiDisconnectReason
};
