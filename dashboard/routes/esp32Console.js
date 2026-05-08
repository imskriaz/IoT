const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { DEFAULT_DEVICE_ID } = require('../config/device');
const { resolveDeviceId } = require('../utils/deviceResolver');
const {
    MAX_EVENT_LOG_LINES,
    appendConsoleEvent,
    clearConsoleEvents,
    readConsoleEvents,
    sanitizeEvent
} = require('../services/consoleEventLog');
const vendorCommandCatalog = require('../config/vendor-console-commands.json');

const router = express.Router();

const MAX_TIMEOUT_MS = 120000;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RAW_MODEM_LINE_LEN = 96;
const FIRMWARE_DOCS_DIR = path.join(__dirname, '..', '..', 'firmware', 'espidf', 'esp32-s3-a7670e', 'docs');
const DOCUMENT_CATALOG_CACHE_MS = 60000;
const VENDOR_MANUALS_DIR = path.join(FIRMWARE_DOCS_DIR, 'vendor', 'esp32-s3-a7670e', 'manuals');
let documentCatalogCache = {
    docs: null,
    expiresAt: 0
};
const vendorManualCache = new Map();
const vendorManualExampleCache = new Map();

const COMMAND_PRESETS = [
    {
        group: 'Status',
        category: 'system',
        deviceTypes: ['esp32', 'android'],
        command: 'get-status',
        label: 'Get Status',
        payload: {},
        waitForResponse: true,
        timeoutMs: 15000,
        note: 'Compact runtime status snapshot. Use before and after command tests.'
    },
    {
        group: 'Status',
        category: 'system',
        deviceTypes: ['esp32'],
        command: 'status-watch',
        label: 'Status Watch',
        payload: { active: true },
        waitForResponse: true,
        timeoutMs: 10000,
        note: 'Adjusts event-aware status watch behavior when supported by firmware.'
    },
    {
        group: 'Network',
        category: 'system',
        deviceTypes: ['esp32'],
        command: 'wifi-scan',
        label: 'Wi-Fi Scan',
        payload: {},
        waitForResponse: true,
        timeoutMs: 20000,
        note: 'Runs the firmware Wi-Fi scan lane over MQTT.'
    },
    {
        group: 'Network',
        category: 'system',
        deviceTypes: ['esp32'],
        command: 'wifi-reconnect',
        label: 'Wi-Fi Reconnect',
        payload: {},
        waitForResponse: true,
        timeoutMs: 45000,
        note: 'Requests Wi-Fi reconnect without using serial/debug transport.'
    },
    {
        group: 'Network',
        category: 'system',
        deviceTypes: ['esp32'],
        command: 'wifi-disconnect',
        label: 'Wi-Fi Disconnect',
        payload: {},
        waitForResponse: true,
        timeoutMs: 15000,
        note: 'Disconnects Wi-Fi when firmware allows it.'
    },
    {
        group: 'Network',
        category: 'system',
        deviceTypes: ['esp32'],
        command: 'mobile-toggle',
        label: 'Mobile Data On',
        payload: { enabled: true },
        waitForResponse: true,
        timeoutMs: 45000,
        note: 'Opens the modem data fallback lane.'
    },
    {
        group: 'Network',
        category: 'system',
        deviceTypes: ['esp32'],
        command: 'mobile-toggle',
        label: 'Mobile Data Off',
        payload: { enabled: false },
        waitForResponse: true,
        timeoutMs: 30000,
        note: 'Closes modem data when policy allows it.'
    },
    {
        group: 'Telephony',
        category: 'system',
        deviceTypes: ['esp32', 'android'],
        command: 'send-ussd',
        label: 'USSD',
        payload: { code: '*123#' },
        waitForResponse: true,
        timeoutMs: 60000,
        note: 'Vendor basis: AT+CUSD session; dashboard sends the runtime USSD action.'
    },
    {
        group: 'Telephony',
        category: 'system',
        deviceTypes: ['esp32', 'android'],
        command: 'cancel-ussd',
        label: 'Cancel USSD',
        payload: {},
        waitForResponse: true,
        timeoutMs: 15000,
        note: 'Vendor basis: AT+CUSD=2 cancellation.'
    },
    {
        group: 'Telephony',
        category: 'system',
        deviceTypes: ['esp32', 'android'],
        command: 'make-call',
        label: 'Dial Number',
        payload: { number: '' },
        waitForResponse: true,
        timeoutMs: 45000,
        note: 'Use only with a real target number. Active ESP32 support is dial/hangup.'
    },
    {
        group: 'Telephony',
        category: 'system',
        deviceTypes: ['esp32', 'android'],
        command: 'end-call',
        label: 'Hang Up',
        payload: {},
        waitForResponse: true,
        timeoutMs: 15000,
        note: 'Ends the active call lane when firmware reports support.'
    },
    {
        group: 'Storage',
        category: 'system',
        deviceTypes: ['esp32', 'android'],
        command: 'storage-info',
        label: 'Storage Info',
        payload: {},
        waitForResponse: true,
        timeoutMs: 10000,
        note: 'Reads card/mount health through the runtime storage lane.'
    },
    {
        group: 'GPIO',
        category: 'system',
        deviceTypes: ['esp32'],
        command: 'gpio-status',
        label: 'GPIO Status',
        payload: {},
        waitForResponse: true,
        timeoutMs: 10000,
        note: 'Reads the guarded GPIO2 diagnostic lane exposed by the active ESP32 firmware.'
    },
    {
        group: 'GPIO',
        category: 'system',
        deviceTypes: ['esp32'],
        command: 'gpio-write',
        label: 'GPIO Write',
        payload: { pin: 2, value: 1 },
        waitForResponse: true,
        timeoutMs: 10000,
        note: 'Writes only the guarded GPIO2 diagnostic lane; arbitrary board pins are not exposed.'
    },
    {
        group: 'System',
        category: 'system',
        deviceTypes: ['esp32'],
        command: 'restart-modem',
        label: 'Restart Modem',
        payload: {},
        waitForResponse: false,
        timeoutMs: 45000,
        note: 'Disruptive. Use only when the modem lane needs recovery.'
    },
    {
        group: 'Manual',
        category: 'manual',
        deviceTypes: ['esp32'],
        command: 'modem-at',
        label: 'Raw AT Probe',
        payload: { line: 'AT+CSQ' },
        waitForResponse: true,
        timeoutMs: 10000,
        note: 'Manual modem probe. Validate the same line in terminal/serial before turning it into firmware behavior.'
    }
];

const KNOWN_CONSOLE_COMMANDS = new Set(COMMAND_PRESETS.map((preset) => preset.command));
function chainWithPrelude(title, steps) {
    return [`# ${title}`, 'AT', 'wait 500', ...steps];
}

function ftpsSessionChain(...steps) {
    return chainWithPrelude('FTPS session', [
        'AT+CFTPSSTART',
        'wait 1500',
        'AT+CFTPSLOGIN="server",21,"username","password",0',
        'wait 1500',
        ...steps
    ]);
}

function mqttSessionChain(...steps) {
    return chainWithPrelude('MQTT session', [
        'AT+CMQTTSTART',
        'wait 1500',
        'AT+CMQTTACCQ=0,"client-test",0',
        'wait 800',
        'AT+CMQTTCONNECT=0,"tcp://test.mosquitto.org:1883",60,1',
        'wait 1500',
        ...steps
    ]);
}

function httpSessionChain(...steps) {
    return chainWithPrelude('HTTP session', [
        'AT+HTTPINIT',
        'wait 1500',
        'AT+HTTPPARA="CID",1',
        'AT+HTTPPARA="URL","http://httpbin.org/get"',
        ...steps
    ]);
}

const VENDOR_WORKFLOW_HINTS = {
    'AT+CFTPSSTART': {
        workflowSummary: 'Start the FTP(S) service and activate PDP if needed.',
        workflowChain: chainWithPrelude('FTPS start', ['AT+CFTPSSTART'])
    },
    'AT+CFTPSLOGIN': {
        sessionRequired: true,
        workflowSummary: 'Start FTP(S) service, then log in to the FTP or FTPS server.',
        workflowChain: chainWithPrelude('FTPS login', [
            'AT+CFTPSSTART',
            'wait 1500',
            'AT+CFTPSLOGIN="server",21,"username","password",0'
        ])
    },
    'AT+CFTPSCWD': {
        sessionRequired: true,
        workflowSummary: 'Requires an active FTP(S) session. Use bare form to return to "/", or pass a directory name to change into it.',
        workflowChain: ftpsSessionChain(
            'AT+CFTPSPWD',
            'AT+CFTPSCWD="TEST1129"',
            '# Optional: use bare AT+CFTPSCWD to return to "/"'
        )
    },
    'AT+CFTPSLIST': {
        sessionRequired: true,
        workflowSummary: 'Requires an active FTP(S) session before listing server directories.',
        workflowChain: ftpsSessionChain('AT+CFTPSLIST="/"')
    },
    'AT+CFTPSPWD': {
        sessionRequired: true,
        workflowSummary: 'Requires an active FTP(S) session before reading the current server directory.',
        workflowChain: ftpsSessionChain('AT+CFTPSPWD')
    },
    'AT+CFTPSGET': {
        sessionRequired: true,
        workflowSummary: 'Requires an active FTP(S) session and a remote file path. Downloads the file to the serial stream.',
        workflowChain: ftpsSessionChain(
            'AT+CFTPSLIST="/"',
            'AT+CFTPSGET="test.txt"'
        )
    },
    'AT+CFTPSGETFILE': {
        sessionRequired: true,
        workflowSummary: 'Requires an active FTP(S) session and a remote file path. Downloads the file to module storage.',
        workflowChain: ftpsSessionChain('AT+CFTPSGETFILE="test.txt"')
    },
    'AT+CFTPSLOGI': {
        sessionRequired: true,
        workflowSummary: 'Vendor short-form login command. Start FTP(S) service, then log in to the FTP or FTPS server.',
        workflowChain: chainWithPrelude('FTPS login', [
            'AT+CFTPSSTART',
            'wait 1500',
            'AT+CFTPSLOGI="server",21,"username","password",0'
        ])
    },
    'AT+CFTPSDELE': {
        sessionRequired: true,
        workflowSummary: 'Requires an active FTP(S) session before deleting a remote file.',
        workflowChain: ftpsSessionChain('AT+CFTPSDELE="old.txt"')
    },
    'AT+CFTPSMKD': {
        sessionRequired: true,
        workflowSummary: 'Requires an active FTP(S) session before creating a remote directory.',
        workflowChain: ftpsSessionChain('AT+CFTPSMKD="TEST1129"')
    },
    'AT+CFTPSRMD': {
        sessionRequired: true,
        workflowSummary: 'Requires an active FTP(S) session before removing a remote directory.',
        workflowChain: ftpsSessionChain('AT+CFTPSRMD="TEST1129"')
    },
    'AT+CFTPSSIZE': {
        sessionRequired: true,
        workflowSummary: 'Requires an active FTP(S) session before querying the size of a remote file.',
        workflowChain: ftpsSessionChain('AT+CFTPSSIZE="test.txt"')
    },
    'AT+CFTPSPUT': {
        sessionRequired: true,
        workflowSummary: 'Requires an active FTP(S) session, a remote target name, and interactive upload data at the modem prompt.',
        workflowChain: ftpsSessionChain(
            'AT+CFTPSPUT="upload.txt",11',
            '# Then type hello world at the modem prompt'
        )
    },
    'AT+CFTPSPUTFILE': {
        sessionRequired: true,
        workflowSummary: 'Requires an active FTP(S) session and a local module file path before uploading to the FTP(S) server.',
        workflowChain: ftpsSessionChain('AT+CFTPSPUTFILE="/customer/upload.txt","upload.txt"')
    },
    'AT+CFTPSMODE': {
        sessionRequired: true,
        workflowSummary: 'Set FTP(S) transfer mode before file operations when the server requires active or passive changes.',
        workflowChain: ftpsSessionChain('AT+CFTPSMODE=1')
    },
    'AT+CFTPSTYPE': {
        sessionRequired: true,
        workflowSummary: 'Set the FTP(S) transfer type before upload or download operations when ASCII/Binary handling matters.',
        workflowChain: ftpsSessionChain('AT+CFTPSTYPE=0')
    },
    'AT+CFTPSSLCFG': {
        sessionRequired: true,
        workflowSummary: 'Bind the SSL context used by the FTP(S) session before login when the server requires TLS settings.',
        workflowChain: chainWithPrelude('FTPS SSL config', [
            'AT+CSSLCFG="sslversion",0,4',
            'AT+CFTPSSLCFG=0',
            'AT+CFTPSSTART',
            'wait 1500',
            'AT+CFTPSLOGIN="server",21,"username","password",0'
        ])
    },
    'AT+CFTPSSINGLEIP': {
        sessionRequired: true,
        workflowSummary: 'Configure single-IP handling before login when the server or NAT path requires it.',
        workflowChain: chainWithPrelude('FTPS single IP mode', [
            'AT+CFTPSSINGLEIP=1',
            'AT+CFTPSSTART',
            'wait 1500',
            'AT+CFTPSLOGIN="server",21,"username","password",0'
        ])
    },
    'AT+CFTPSLOGOUT': {
        sessionRequired: true,
        workflowSummary: 'Requires an active FTP(S) session before logging out cleanly.',
        workflowChain: ftpsSessionChain('AT+CFTPSLOGOUT')
    },
    'AT+CFTPSSTOP': {
        sessionRequired: true,
        workflowSummary: 'Stop the FTP(S) service after logout or when you want to tear down the session cleanly.',
        workflowChain: ftpsSessionChain(
            'AT+CFTPSLOGOUT',
            'wait 800',
            'AT+CFTPSSTOP'
        )
    },
    'AT+CFTPSTART': {
        workflowSummary: 'Vendor alias/start form for FTP service activation before FTP(S) session commands.',
        workflowChain: chainWithPrelude('FTP start', ['AT+CFTPSTART'])
    },
    'AT+CMQTTSTART': {
        workflowSummary: 'Start the MQTT(S) service and activate PDP if needed.',
        workflowChain: chainWithPrelude('MQTT service start', ['AT+CMQTTSTART'])
    },
    'AT+CMQTTACCQ': {
        sessionRequired: true,
        workflowSummary: 'Requires MQTT(S) service first, then acquires a client context for connect, publish, or subscribe operations.',
        workflowChain: chainWithPrelude('MQTT acquire client', [
            'AT+CMQTTSTART',
            'wait 1500',
            'AT+CMQTTACCQ=0,"client-test",0'
        ])
    },
    'AT+CMQTTCONNECT': {
        sessionRequired: true,
        workflowSummary: 'Requires MQTT(S) service and an acquired client before connecting to the broker.',
        workflowChain: chainWithPrelude('MQTT connect', [
            'AT+CMQTTSTART',
            'wait 1500',
            'AT+CMQTTACCQ=0,"client-test",0',
            'wait 800',
            'AT+CMQTTCONNECT=0,"tcp://test.mosquitto.org:1883",60,1'
        ])
    },
    'AT+CMQTTPUB': {
        sessionRequired: true,
        workflowSummary: 'Requires MQTT(S) service, client acquisition, broker connection, publish topic, and payload before publishing.',
        workflowChain: [
            '# MQTT publish',
            'AT',
            'wait 500',
            'AT+CMQTTSTART',
            'wait 1500',
            'AT+CMQTTACCQ=0,"client-test",0',
            'wait 800',
            'AT+CMQTTCONNECT=0,"tcp://test.mosquitto.org:1883",60,1',
            'wait 1500',
            'AT+CMQTTTOPIC=0,9',
            '# Then type topic/test at the modem prompt',
            'AT+CMQTTPAYLOAD=0,11',
            '# Then type hello world at the modem prompt',
            'AT+CMQTTPUB=0,1,60'
        ]
    },
    'AT+CMQTTTOPIC': {
        sessionRequired: true,
        workflowSummary: 'Requires MQTT(S) service, client acquisition, and broker connection before entering the publish topic at the modem prompt.',
        workflowChain: [
            '# MQTT publish topic',
            'AT',
            'wait 500',
            'AT+CMQTTSTART',
            'wait 1500',
            'AT+CMQTTACCQ=0,"client-test",0',
            'wait 800',
            'AT+CMQTTCONNECT=0,"tcp://test.mosquitto.org:1883",60,1',
            'wait 1500',
            'AT+CMQTTTOPIC=0,9',
            '# Then type topic/test at the modem prompt'
        ]
    },
    'AT+CMQTTPAYLOAD': {
        sessionRequired: true,
        workflowSummary: 'Requires MQTT(S) service, client acquisition, broker connection, and a prepared topic before entering the publish payload at the modem prompt.',
        workflowChain: [
            '# MQTT publish payload',
            'AT',
            'wait 500',
            'AT+CMQTTSTART',
            'wait 1500',
            'AT+CMQTTACCQ=0,"client-test",0',
            'wait 800',
            'AT+CMQTTCONNECT=0,"tcp://test.mosquitto.org:1883",60,1',
            'wait 1500',
            'AT+CMQTTTOPIC=0,9',
            '# Then type topic/test at the modem prompt',
            'AT+CMQTTPAYLOAD=0,11',
            '# Then type hello world at the modem prompt'
        ]
    },
    'AT+CMQTTSUB': {
        sessionRequired: true,
        workflowSummary: 'Requires MQTT(S) service, client acquisition, broker connection, and a prepared subscribe topic before subscribing.',
        workflowChain: [
            '# MQTT subscribe',
            'AT',
            'wait 500',
            'AT+CMQTTSTART',
            'wait 1500',
            'AT+CMQTTACCQ=0,"client-test",0',
            'wait 800',
            'AT+CMQTTCONNECT=0,"tcp://test.mosquitto.org:1883",60,1',
            'wait 1500',
            'AT+CMQTTSUBTOPIC=0,9,1',
            '# Then type topic/test at the modem prompt',
            'AT+CMQTTSUB=0,9,1'
        ]
    },
    'AT+CMQTTSUBTOPIC': {
        sessionRequired: true,
        workflowSummary: 'Requires MQTT(S) service, client acquisition, and broker connection before entering the subscribe topic at the modem prompt.',
        workflowChain: [
            '# MQTT subscribe topic',
            'AT',
            'wait 500',
            'AT+CMQTTSTART',
            'wait 1500',
            'AT+CMQTTACCQ=0,"client-test",0',
            'wait 800',
            'AT+CMQTTCONNECT=0,"tcp://test.mosquitto.org:1883",60,1',
            'wait 1500',
            'AT+CMQTTSUBTOPIC=0,9,1',
            '# Then type topic/test at the modem prompt'
        ]
    },
    'AT+CMQTTUNSUBTOPIC': {
        sessionRequired: true,
        workflowSummary: 'Requires MQTT(S) service, client acquisition, and broker connection before entering the unsubscribe topic at the modem prompt.',
        workflowChain: mqttSessionChain(
            'AT+CMQTTUNSUBTOPIC=0,9,1',
            '# Then type topic/test at the modem prompt'
        )
    },
    'AT+CMQTTUNSUB': {
        sessionRequired: true,
        workflowSummary: 'Requires MQTT(S) service, client acquisition, broker connection, and a prepared unsubscribe topic before unsubscribing.',
        workflowChain: mqttSessionChain(
            'AT+CMQTTUNSUBTOPIC=0,9,1',
            '# Then type topic/test at the modem prompt',
            'AT+CMQTTUNSUB=0,9,1'
        )
    },
    'AT+CMQTTCFG': {
        sessionRequired: true,
        workflowSummary: 'Configure MQTT context after client acquisition and before broker connect, especially for protocol or timeout tuning.',
        workflowChain: chainWithPrelude('MQTT config', [
            'AT+CMQTTSTART',
            'wait 1500',
            'AT+CMQTTACCQ=0,"client-test",0',
            'wait 800',
            'AT+CMQTTCFG="checkUTF8",0,0'
        ])
    },
    'AT+CMQTTSSLCFG': {
        sessionRequired: true,
        workflowSummary: 'Attach an SSL context to the MQTT client after acquisition and before broker connect for secure sessions.',
        workflowChain: chainWithPrelude('MQTT SSL config', [
            'AT+CSSLCFG="sslversion",0,4',
            'AT+CMQTTSTART',
            'wait 1500',
            'AT+CMQTTACCQ=0,"client-test",1',
            'wait 800',
            'AT+CMQTTSSLCFG=0,0'
        ])
    },
    'AT+CMQTTWILLTOPIC': {
        sessionRequired: true,
        workflowSummary: 'Set the MQTT will topic after client acquisition and before connect when the broker should publish a last-will message.',
        workflowChain: chainWithPrelude('MQTT will topic', [
            'AT+CMQTTSTART',
            'wait 1500',
            'AT+CMQTTACCQ=0,"client-test",0',
            'wait 800',
            'AT+CMQTTWILLTOPIC=0,10',
            '# Then type will/topic at the modem prompt'
        ])
    },
    'AT+CMQTTWILLMSG': {
        sessionRequired: true,
        workflowSummary: 'Set the MQTT will payload after the will topic and before connect when the broker should publish a last-will message.',
        workflowChain: chainWithPrelude('MQTT will message', [
            'AT+CMQTTSTART',
            'wait 1500',
            'AT+CMQTTACCQ=0,"client-test",0',
            'wait 800',
            'AT+CMQTTWILLTOPIC=0,10',
            '# Then type will/topic at the modem prompt',
            'AT+CMQTTWILLMSG=0,13,1',
            '# Then type offline-state at the modem prompt'
        ])
    },
    'AT+CMQTTDISC': {
        sessionRequired: true,
        workflowSummary: 'Requires an active MQTT broker connection before disconnecting the client cleanly.',
        workflowChain: mqttSessionChain('AT+CMQTTDISC=0,60')
    },
    'AT+CMQTTREL': {
        sessionRequired: true,
        workflowSummary: 'Release the acquired MQTT client after disconnecting it from the broker.',
        workflowChain: mqttSessionChain(
            'AT+CMQTTDISC=0,60',
            'wait 800',
            'AT+CMQTTREL=0'
        )
    },
    'AT+CMQTTSTOP': {
        sessionRequired: true,
        workflowSummary: 'Stop the MQTT(S) service after disconnecting and releasing the client.',
        workflowChain: mqttSessionChain(
            'AT+CMQTTDISC=0,60',
            'wait 800',
            'AT+CMQTTREL=0',
            'wait 800',
            'AT+CMQTTSTOP'
        )
    },
    'AT+HTTPINIT': {
        workflowSummary: 'Start the HTTP service and activate PDP if needed before setting request parameters.',
        workflowChain: chainWithPrelude('HTTP init', ['AT+HTTPINIT'])
    },
    'AT+HTTPACTION': {
        sessionRequired: true,
        workflowSummary: 'Requires HTTP service and request parameters such as CID and URL before sending the HTTP method action.',
        workflowChain: httpSessionChain('AT+HTTPACTION=0')
    },
    'AT+HTTPPARA': {
        sessionRequired: true,
        workflowSummary: 'Set HTTP request parameters such as CID, URL, headers, or content type after HTTP init and before HTTP action.',
        workflowChain: chainWithPrelude('HTTP parameter setup', [
            'AT+HTTPINIT',
            'wait 1500',
            'AT+HTTPPARA="CID",1',
            'AT+HTTPPARA="URL","http://httpbin.org/get"'
        ])
    },
    'AT+HTTPDATA': {
        sessionRequired: true,
        workflowSummary: 'Prepare POST body data after HTTP init and parameters, then type the payload at the modem prompt before HTTPACTION=1.',
        workflowChain: httpSessionChain(
            'AT+HTTPDATA=17,10000',
            '# Then type {"hello":"world"} at the modem prompt'
        )
    },
    'AT+HTTPPOSTFILE': {
        sessionRequired: true,
        workflowSummary: 'Post a local module file after HTTP init and parameters when the request body should come from storage.',
        workflowChain: httpSessionChain('AT+HTTPPOSTFILE="/customer/upload.txt",10000')
    },
    'AT+HTTPREAD': {
        sessionRequired: true,
        workflowSummary: 'Read the HTTP response body after a completed HTTP action.',
        workflowChain: httpSessionChain(
            'AT+HTTPACTION=0',
            'wait 3000',
            'AT+HTTPREAD'
        )
    },
    'AT+HTTPREADFILE': {
        sessionRequired: true,
        workflowSummary: 'Read the HTTP response body into a local file after a completed HTTP action.',
        workflowChain: httpSessionChain(
            'AT+HTTPACTION=0',
            'wait 3000',
            'AT+HTTPREADFILE="/customer/http.bin"'
        )
    },
    'AT+HTTPHEAD': {
        sessionRequired: true,
        workflowSummary: 'Read response headers after a completed HTTP action when header inspection is needed.',
        workflowChain: httpSessionChain(
            'AT+HTTPACTION=0',
            'wait 3000',
            'AT+HTTPHEAD'
        )
    },
    'AT+HTTPTERM': {
        sessionRequired: true,
        workflowSummary: 'Terminate the HTTP service after request handling is complete.',
        workflowChain: httpSessionChain(
            'AT+HTTPACTION=0',
            'wait 3000',
            'AT+HTTPTERM'
        )
    },
    'AT+CSSLCFG': {
        workflowSummary: 'Configure the shared SSL context before HTTPS, MQTTS, or FTPS commands that bind to a TLS profile.',
        workflowChain: chainWithPrelude('SSL context config', [
            'AT+CSSLCFG="sslversion",0,4',
            'AT+CSSLCFG="authmode",0,1'
        ])
    },
    'AT+NETOPEN': {
        workflowSummary: 'Activates the PDP context and starts the socket service before socket connect or send commands.',
        workflowChain: chainWithPrelude('TCPIP network open', ['AT+NETOPEN'])
    },
    'AT+CIPOPEN': {
        sessionRequired: true,
        workflowSummary: 'Requires PDP activation with AT+NETOPEN first, then opens the TCP or UDP socket.',
        workflowChain: chainWithPrelude('TCP socket open', [
            'AT+NETOPEN',
            'wait 1500',
            'AT+CIPOPEN=0,"TCP","117.131.85.139",5253'
        ])
    }
};

function readVendorManualLines(markdownFile) {
    if (!markdownFile) return [];
    if (vendorManualCache.has(markdownFile)) return vendorManualCache.get(markdownFile);
    const absolutePath = path.join(VENDOR_MANUALS_DIR, markdownFile);
    const lines = fs.existsSync(absolutePath)
        ? fs.readFileSync(absolutePath, 'utf8').split(/\r?\n/)
        : [];
    vendorManualCache.set(markdownFile, lines);
    return lines;
}

function readVendorManualExamples(markdownFile) {
    if (!markdownFile) return new Map();
    if (vendorManualExampleCache.has(markdownFile)) return vendorManualExampleCache.get(markdownFile);
    const commandMap = new Map();
    readVendorManualLines(markdownFile).forEach((line) => {
        const trimmed = String(line || '').replace(/\s+/g, ' ').trim();
        if (!trimmed || !/^(?:AT|A)\S*/i.test(trimmed)) return;
        const match = trimmed.match(/^((?:AT|A)(?:\+[A-Z0-9]+)+)/i);
        if (!match) return;
        const baseCommand = String(match[1] || '').toUpperCase();
        if (!baseCommand) return;
        const examples = commandMap.get(baseCommand) || [];
        if (!examples.includes(trimmed)) examples.push(trimmed);
        commandMap.set(baseCommand, examples);
    });
    vendorManualExampleCache.set(markdownFile, commandMap);
    return commandMap;
}

function extractVendorCommandExamples(commandEntry) {
    const baseCommand = String(commandEntry?.line || commandEntry?.command || '').trim().toUpperCase();
    if (!baseCommand) return [];
    const examples = new Set();
    const sources = Array.isArray(commandEntry?.sources) ? commandEntry.sources : [];

    sources.forEach((source) => {
        const commandMap = readVendorManualExamples(source?.markdown);
        const entries = commandMap.get(baseCommand) || [];
        entries.forEach((entry) => {
            if (String(entry).toUpperCase() === baseCommand) return;
            examples.add(entry);
        });
    });

    const rankExample = (example) => {
        const text = String(example || '').trim();
        if (!text) return 99;
        if (/^.+="[^"]+"/.test(text) || /^.+=\d/.test(text)) return 0;
        if (/^.+=(?!\?$).+/.test(text) && !/<[^>]+>/.test(text)) return 1;
        if (/^.+=<[^>]+>/.test(text)) return 2;
        if (/^.+=\?$/.test(text)) return 3;
        if (/^.+\?$/.test(text)) return 4;
        return 5;
    };

    return Array.from(examples)
        .sort((left, right) => rankExample(left) - rankExample(right) || left.localeCompare(right))
        .slice(0, 3);
}

function vendorCommandAllowsBare(commandEntry) {
    const baseCommand = String(commandEntry?.line || commandEntry?.command || '').trim().toUpperCase();
    if (!baseCommand) return false;
    const sources = Array.isArray(commandEntry?.sources) ? commandEntry.sources : [];
    return sources.some((source) => {
        const lines = readVendorManualLines(source?.markdown);
        return lines.some((line, index) => {
            if (String(line || '').trim().toUpperCase() !== baseCommand) return false;
            const lookahead = lines.slice(index + 1, index + 5)
                .map((item) => String(item || '').trim().toUpperCase())
                .filter(Boolean);
            return lookahead.some((item) => item === 'OK' || item.startsWith(`+${baseCommand.slice(3)}:`));
        });
    });
}

function enrichVendorCommand(commandEntry) {
    const workflowHint = VENDOR_WORKFLOW_HINTS[String(commandEntry?.line || commandEntry?.command || '').trim().toUpperCase()] || null;
    const syntaxExamples = extractVendorCommandExamples(commandEntry);
    const allowsBare = vendorCommandAllowsBare(commandEntry);
    const requiresInput = syntaxExamples.some((example) => {
        const suffix = String(example).slice(String(commandEntry.line || commandEntry.command || '').trim().length).trim();
        return suffix.startsWith('=') || suffix.startsWith('"');
    }) && !allowsBare;
    const requiresVariant = !allowsBare && syntaxExamples.length > 0;
    return {
        ...commandEntry,
        syntaxExamples,
        requiresInput,
        allowsBare,
        requiresVariant,
        sessionRequired: Boolean(workflowHint?.sessionRequired),
        workflowSummary: workflowHint?.workflowSummary || '',
        workflowChain: Array.isArray(workflowHint?.workflowChain) ? workflowHint.workflowChain : []
    };
}

const VENDOR_COMMANDS = Array.isArray(vendorCommandCatalog?.commands)
    ? vendorCommandCatalog.commands
        .filter((command) => command && command.line && Array.isArray(command.transports))
        .map(enrichVendorCommand)
    : [];

function pushDoc(docs, title, absolutePath, group = 'Documents') {
    if (!absolutePath || !fs.existsSync(absolutePath)) return;
    docs.push({
        title,
        group,
        path: path.relative(path.join(__dirname, '..', '..'), absolutePath).replace(/\\/g, '/'),
        kind: path.extname(absolutePath).replace('.', '').toLowerCase() || 'file',
        bytes: fs.statSync(absolutePath).size
    });
}

function buildDocumentCatalog() {
    const docs = [];
    pushDoc(docs, 'Runtime Rulebook', path.join(FIRMWARE_DOCS_DIR, 'RULEBOOK.md'), 'Runtime');
    pushDoc(docs, 'Runtime Implementation Plan', path.join(FIRMWARE_DOCS_DIR, 'RUNTIME_IMPLEMENTATION_PLAN.md'), 'Runtime');
    pushDoc(docs, 'ESP32 Docs Index', path.join(FIRMWARE_DOCS_DIR, 'README.md'), 'Runtime');

    const vendorRoot = path.join(FIRMWARE_DOCS_DIR, 'vendor', 'esp32-s3-a7670e');
    const walk = (dir) => {
        if (!fs.existsSync(dir)) return;
        fs.readdirSync(dir, { withFileTypes: true })
            .sort((left, right) => left.name.localeCompare(right.name))
            .forEach((entry) => {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(fullPath);
                    return;
                }
                if (!/\.(md|pdf)$/i.test(entry.name)) return;
                const relative = path.relative(vendorRoot, fullPath).replace(/\\/g, '/');
                const group = relative.startsWith('hardware/')
                    ? 'Hardware'
                    : (relative.startsWith('demo/') ? 'Demo' : 'Vendor');
                const title = entry.name.replace(/\.(md|pdf)$/i, '').replace(/_/g, ' ');
                pushDoc(docs, title, fullPath, group);
            });
    };
    walk(vendorRoot);
    return docs;
}

function getDocumentCatalog() {
    const now = Date.now();
    if (documentCatalogCache.docs && documentCatalogCache.expiresAt > now) {
        return documentCatalogCache.docs;
    }
    const docs = buildDocumentCatalog();
    documentCatalogCache = {
        docs,
        expiresAt: now + DOCUMENT_CATALOG_CACHE_MS
    };
    return docs;
}

function normalizeBoolean(value, fallback = false) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
        if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    }
    return fallback;
}

function normalizeTimeout(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
    return Math.max(1000, Math.min(MAX_TIMEOUT_MS, Math.round(parsed)));
}

function normalizeCommand(value) {
    const command = String(value || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(command)) {
        return '';
    }
    return command;
}

function normalizeRawModemLine(value) {
    const line = String(value || '').trim();
    if (!line) {
        return '';
    }
    if (line.length > MAX_RAW_MODEM_LINE_LEN) {
        throw new Error(`Raw modem line must be ${MAX_RAW_MODEM_LINE_LEN} characters or less`);
    }
    if (/[\r\n\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(line)) {
        throw new Error('Raw modem line must be a single printable line');
    }
    return line;
}

function looksLikeRawModemLine(value) {
    const line = String(value || '').trim();
    if (!line) {
        return false;
    }
    const normalizedCommand = normalizeCommand(line);
    if (normalizedCommand && KNOWN_CONSOLE_COMMANDS.has(normalizedCommand)) {
        return false;
    }
    if (normalizedCommand === 'modem-at') {
        return false;
    }
    if (/^a(?:t)?(?:$|[+?=,])/i.test(line)) {
        return true;
    }
    return !normalizedCommand && /[+?=,"\s]/.test(line);
}

function normalizePayload(value) {
    if (value === undefined || value === null || value === '') {
        return {};
    }
    if (typeof value === 'string') {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Payload must be a JSON object');
        }
        return parsed;
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Payload must be a JSON object');
    }
    return value;
}

router.get('/commands', (req, res) => {
    res.json({
        success: true,
        data: {
            presets: COMMAND_PRESETS,
            vendorCommands: VENDOR_COMMANDS,
            vendorCatalog: {
                version: vendorCommandCatalog.version || 1,
                generatedFrom: vendorCommandCatalog.generatedFrom || []
            },
            documents: getDocumentCatalog(),
            defaults: {
                waitForResponse: true,
                timeoutMs: DEFAULT_TIMEOUT_MS,
                liveOnly: true
            }
        }
    });
});

router.get('/events', (req, res) => {
    const limit = Math.max(1, Math.min(MAX_EVENT_LOG_LINES, Number(req.query?.limit) || 100));
    const deviceId = String(resolveDeviceId(req, '') || '').trim();
    res.json({
        success: true,
        data: readConsoleEvents(limit, deviceId)
    });
});

router.get('/documents', (req, res) => {
    try {
        const repoRoot = path.join(__dirname, '..', '..');
        const requested = String(req.query?.path || '').trim();
        const absolutePath = path.resolve(repoRoot, requested);
        const docsRoot = path.resolve(FIRMWARE_DOCS_DIR);

        if (!requested || !absolutePath.startsWith(docsRoot + path.sep) || !fs.existsSync(absolutePath)) {
            return res.status(404).json({
                success: false,
                message: 'Document not found'
            });
        }

        return res.sendFile(absolutePath);
    } catch (error) {
        logger.warn('Console document read failed:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Failed to read document'
        });
    }
});

router.post('/events', (req, res) => {
    try {
        const event = sanitizeEvent({
            ...(req.body || {}),
            deviceId: String(req.body?.deviceId || resolveDeviceId(req, DEFAULT_DEVICE_ID) || '').trim()
        });
        appendConsoleEvent(event);
        res.json({
            success: true,
            data: event
        });
    } catch (error) {
        logger.warn('Console event log append failed:', error.message);
        res.status(500).json({
            success: false,
            message: 'Failed to append console event'
        });
    }
});

router.delete('/events', (req, res) => {
    try {
        clearConsoleEvents();
        res.json({ success: true });
    } catch (error) {
        logger.warn('Console event log clear failed:', error.message);
        res.status(500).json({
            success: false,
            message: 'Failed to clear console event log'
        });
    }
});

router.post('/command', async (req, res) => {
    const startedAt = Date.now();

    try {
        const deviceId = String(resolveDeviceId(req, DEFAULT_DEVICE_ID) || '').trim();
        const commandInput = String(req.body?.command || '').trim();
        let command = normalizeCommand(commandInput);
        let payload = normalizePayload(req.body?.payload);
        let rawLine = '';
        const waitForResponse = normalizeBoolean(req.body?.waitForResponse, true);
        const timeoutMs = normalizeTimeout(req.body?.timeoutMs);
        const messageId = String(req.body?.messageId || '').trim()
            || `console_${crypto.randomBytes(6).toString('hex')}`;
        const explicitRaw = normalizeBoolean(req.body?.raw, false);

        if (explicitRaw || looksLikeRawModemLine(commandInput)) {
            rawLine = normalizeRawModemLine(commandInput);
            command = 'modem-at';
            payload = {
                ...payload,
                line: rawLine,
                raw_line: rawLine
            };
        } else if (command === 'modem-at') {
            rawLine = normalizeRawModemLine(payload.line || payload.raw_line || payload.rawLine);
            if (rawLine) {
                payload = {
                    ...payload,
                    line: rawLine,
                    raw_line: rawLine
                };
            }
        }

        if (!deviceId) {
            return res.status(400).json({ success: false, message: 'No active device selected' });
        }

        if (!command) {
            return res.status(400).json({
                success: false,
                message: 'Command must use only letters, numbers, hyphen, and underscore, or enter a single raw modem line'
            });
        }

        if (command === 'modem-at' && !rawLine) {
            return res.status(400).json({
                success: false,
                message: 'Raw modem command requires a line, for example AT or AT+CSQ'
            });
        }

        if (!global.mqttService || typeof global.mqttService.publishCommand !== 'function') {
            return res.status(503).json({ success: false, message: 'MQTT command service unavailable' });
        }

        const result = await global.mqttService.publishCommand(
            deviceId,
            command,
            payload,
            waitForResponse,
            timeoutMs,
            {
                source: 'dashboard-esp32-console',
                messageId,
                skipPersistentQueue: true,
                domain: command === 'get-status' ? 'status' : undefined,
                bypassCompatibility: true
            }
        );

        res.json({
            success: true,
            deviceId,
            command,
            rawLine: rawLine || undefined,
            payload,
            waitForResponse,
            timeoutMs,
            messageId,
            durationMs: Date.now() - startedAt,
            result
        });
    } catch (error) {
        logger.warn('ESP32 console command failed:', error.message);
        const message = String(error.message || '');
        const statusCode = /timeout/i.test(message)
            ? 504
            : (/payload must|command must|no active device/i.test(message)
                ? 400
                : (/mqtt not connected|mqtt command service unavailable/i.test(message) ? 503 : 500));
        res.status(statusCode).json({
            success: false,
            message: message || 'Command failed',
            durationMs: Date.now() - startedAt
        });
    }
});

module.exports = router;
