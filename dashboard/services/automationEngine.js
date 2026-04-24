'use strict';

const nodemailer = require('nodemailer');
const logger = require('../utils/logger');
const { resolveSmsCommandForRecipient } = require('../utils/smsLimits');
const notificationService = require('./notificationService');
const { queueSmsForDelivery } = require('./smsQueue');

class AutomationEngine {
    constructor() {
        this.db = null;
        this.mqttService = null;
        this.io = null;
        this._flows = [];
        this._reloadTimer = null;
        this._scheduleTimer = null;
        this._deviceState = new Map();
        this._lastScheduleHits = new Map();
    }

    init(db, mqttService, io) {
        this.destroy();
        this.db = db;
        this.mqttService = mqttService;
        this.io = io;
        this._loadFlows();
        this._reloadTimer = setInterval(() => this._loadFlows(), 60_000);
        this._scheduleTimer = setInterval(() => this._runSchedules().catch((error) => {
            logger.error('AutomationEngine._runSchedules error:', error.message);
        }), 30_000);
        this._reloadTimer.unref?.();
        this._scheduleTimer.unref?.();
    }

    destroy() {
        if (this._reloadTimer) clearInterval(this._reloadTimer);
        if (this._scheduleTimer) clearInterval(this._scheduleTimer);
        this._reloadTimer = null;
        this._scheduleTimer = null;
    }

    invalidateCache() {
        this._loadFlows();
    }

    _loadFlows() {
        try {
            if (!this.db?._raw) return;
            const rows = this.db._raw.prepare(
                `SELECT id, name, nodes, edges, device_id FROM automation_flows WHERE enabled = 1`
            ).all();
            this._flows = rows.map((row) => ({
                id: row.id,
                name: row.name,
                deviceId: row.device_id,
                nodes: this._parse(row.nodes, []),
                edges: this._parse(row.edges, [])
            }));
        } catch (error) {
            logger.error('AutomationEngine._loadFlows error:', error.message);
        }
    }

    async onEvent(eventType, data = {}, deviceId = '') {
        const resolvedDeviceId = String(deviceId || data.deviceId || data.id || '').trim();
        const previousState = this._deviceState.get(resolvedDeviceId) || {};
        const currentState = this._mergeState(previousState, eventType, data, resolvedDeviceId);

        for (const flow of this._flows) {
            if (flow.deviceId && flow.deviceId !== '*' && resolvedDeviceId && flow.deviceId !== resolvedDeviceId) {
                continue;
            }

            try {
                await this._evaluateFlow(flow, eventType, data, resolvedDeviceId, previousState, currentState);
            } catch (error) {
                logger.error(`AutomationEngine flow ${flow.id} error:`, error.message);
            }
        }

        if (resolvedDeviceId) {
            this._deviceState.set(resolvedDeviceId, currentState);
        }
    }

    async testRun(flowId, triggerData = {}) {
        if (!this.db?._raw) throw new Error('DB not available');

        const row = this.db._raw.prepare('SELECT * FROM automation_flows WHERE id = ?').get(flowId);
        if (!row) throw new Error('Flow not found');

        const flow = {
            id: row.id,
            name: row.name,
            deviceId: row.device_id,
            nodes: this._parse(row.nodes, []),
            edges: this._parse(row.edges, [])
        };
        const trigger = this._nodes(flow).find((node) => node.type?.startsWith('trigger.'));
        if (!trigger) throw new Error('Flow has no trigger node');

        const deviceId = String(triggerData.deviceId || row.device_id || '');
        const previousState = this._deviceState.get(deviceId) || {};
        const currentState = this._mergeState(previousState, triggerData.eventType || 'test', triggerData, deviceId);
        const context = {
            deviceId,
            eventType: triggerData.eventType || 'test',
            trigger: { ...triggerData, deviceId },
            flow: {},
            state: currentState,
            previousState,
            _log: ['[TEST RUN]'],
            _test: true
        };

        await this._walkFrom(trigger.id, flow, context);
        await this._logExecution(flow.id, context._error ? 'error' : 'success', context);

        return {
            status: context._error ? 'error' : 'success',
            log: context._log,
            context
        };
    }

    _parse(value, fallback) {
        let parsed = value;
        if (typeof value === 'string') {
            try { parsed = JSON.parse(value); } catch { return fallback; }
        }

        if (Array.isArray(fallback)) {
            return Array.isArray(parsed) ? parsed : fallback;
        }

        return parsed ?? fallback;
    }

    _nodes(flow) {
        return Array.isArray(flow?.nodes) ? flow.nodes : [];
    }

    _edges(flow) {
        return Array.isArray(flow?.edges) ? flow.edges : [];
    }

    _mergeState(previousState, eventType, data, deviceId) {
        const next = {
            ...previousState,
            deviceId: deviceId || previousState.deviceId || null,
            lastEventType: eventType,
            lastEventAt: new Date().toISOString()
        };

        if (eventType === 'telemetry') {
            Object.assign(next, {
                signal: data.signal ?? next.signal ?? null,
                signalDbm: data.signalDbm ?? next.signalDbm ?? null,
                battery: data.battery ?? next.battery ?? null,
                charging: data.charging ?? next.charging ?? null,
                temperature: data.temperature ?? next.temperature ?? null,
                voltageMv: data.voltageMv ?? next.voltageMv ?? null,
                network: data.network ?? next.network ?? null,
                operator: data.operator ?? next.operator ?? null,
                ip: data.ip ?? next.ip ?? null,
                wifi: data.wifi ?? next.wifi ?? null,
                mobile: data.mobile ?? next.mobile ?? null,
                system: data.system ?? next.system ?? null,
                lastTelemetry: data,
                lastLocation: this._extractLocation(data, previousState.lastLocation)
            });
        }

        if (eventType.startsWith('call.')) {
            next.lastCall = data;
            next.callStatus = data.status ?? next.callStatus ?? null;
            next.callNumber = data.number ?? next.callNumber ?? null;
        }

        if (eventType === 'sms.incoming') {
            next.lastSms = data;
            next.lastSmsFrom = data.from ?? next.lastSmsFrom ?? null;
        }

        if (eventType === 'gps.geofence' || eventType === 'gps.location') {
            next.lastLocation = this._extractLocation(data, previousState.lastLocation);
        }

        if (eventType === 'device.online') next.online = true;
        if (eventType === 'device.offline') next.online = false;

        return next;
    }

    _extractLocation(data, fallback = null) {
        const latitude = data?.latitude ?? data?.lat ?? fallback?.latitude ?? null;
        const longitude = data?.longitude ?? data?.lng ?? data?.lon ?? fallback?.longitude ?? null;
        if (latitude == null || longitude == null) return fallback;
        return { latitude: Number(latitude), longitude: Number(longitude) };
    }

    async _evaluateFlow(flow, eventType, data, deviceId, previousState, currentState) {
        const triggerNodes = this._nodes(flow).filter((node) => node.type?.startsWith('trigger.'));
        if (!triggerNodes.length) return;

        for (const trigger of triggerNodes) {
            if (!this._matchTrigger(trigger, eventType, data, deviceId, previousState, currentState)) continue;

            const context = {
                deviceId,
                eventType,
                trigger: { ...data, deviceId },
                flow: {},
                state: currentState,
                previousState,
                _log: [`[TRIGGER] ${trigger.type} matched on device ${deviceId || 'unknown'}`]
            };

            await this._walkFrom(trigger.id, flow, context);
            await this._logExecution(flow.id, context._error ? 'error' : 'success', context);
            break;
        }
    }

    _matchTrigger(node, eventType, data, deviceId, previousState, currentState) {
        const cfg = node.config || {};
        const fieldValue = cfg.field ? this._resolveField(cfg.field, {
            trigger: data,
            state: currentState,
            previousState
        }) : undefined;

        switch (node.type) {
            case 'trigger.device_online':
                return eventType === 'device.online' && (!cfg.deviceId || cfg.deviceId === deviceId);
            case 'trigger.device_offline':
                return eventType === 'device.offline' && (!cfg.deviceId || cfg.deviceId === deviceId);
            case 'trigger.telemetry':
                return eventType === 'telemetry' && (!cfg.field || fieldValue !== undefined);
            case 'trigger.sensor_threshold':
                return eventType === 'telemetry'
                    && fieldValue !== undefined
                    && this._compare(fieldValue, cfg.op || 'gt', cfg.threshold ?? 0);
            case 'trigger.battery_low':
                return eventType === 'telemetry'
                    && typeof currentState.battery === 'number'
                    && currentState.battery < Number(cfg.threshold || 20);
            case 'trigger.sms_incoming':
                return eventType === 'sms.incoming'
                    && (!cfg.keyword || String(data.message || '').toLowerCase().includes(String(cfg.keyword).toLowerCase()));
            case 'trigger.call_incoming':
                return eventType === 'call.incoming'
                    && (!cfg.from || String(data.number || '') === String(cfg.from));
            case 'trigger.call_ended':
                return eventType === 'call.ended';
            case 'trigger.mqtt_message':
                return eventType === 'mqtt.message'
                    && (!cfg.topic || String(data.topic || '') === String(cfg.topic));
            case 'trigger.webhook':
                return eventType === 'webhook'
                    && (!cfg.webhookId || String(data.webhookId || '') === String(cfg.webhookId));
            case 'trigger.schedule':
                return eventType === 'schedule' && String(data.flowId || '') === String(node.id);
            case 'trigger.geofence_enter':
                return eventType === 'gps.geofence' && data.type === 'enter';
            case 'trigger.geofence_exit':
                return eventType === 'gps.geofence' && data.type === 'exit';
            case 'trigger.firmware_update':
                return eventType === 'ota.available';
            case 'trigger.connection_degraded':
                return eventType === 'telemetry'
                    && typeof currentState.signal === 'number'
                    && currentState.signal < Number(cfg.threshold || 20);
            case 'trigger.property_changed': {
                const property = cfg.property || cfg.field;
                if (!property) return false;
                const previous = this._resolvePath(property, previousState);
                const current = this._resolvePath(property, currentState);
                return previous !== current;
            }
            case 'trigger.command_ack':
                return eventType === 'command.ack';
            case 'trigger.alert':
                return eventType === 'alert'
                    && (!cfg.alertType || String(data.type || '') === String(cfg.alertType));
            default:
                return false;
        }
    }

    async _walkFrom(nodeId, flow, context) {
        const node = this._nodes(flow).find((entry) => entry.id === nodeId);
        if (!node) return;

        if (node.type?.startsWith('trigger.')) {
            for (const next of this._nextNodes(nodeId, flow)) {
                await this._walkFrom(next.id, flow, context);
            }
            return;
        }

        if (node.type?.startsWith('condition.')) {
            const result = await this._evalCondition(node, context);
            context._log.push(`[CONDITION] ${node.label || node.type} -> ${result ? 'PASS' : 'FAIL'}`);
            for (const next of this._nextNodes(nodeId, flow, result ? 'yes' : 'no')) {
                await this._walkFrom(next.id, flow, context);
            }
            return;
        }

        if (node.type === 'logic.delay') {
            const seconds = Math.max(0, Math.min(60, Number(node.config?.seconds || 0)));
            if (seconds > 0) await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
            for (const next of this._nextNodes(nodeId, flow)) {
                await this._walkFrom(next.id, flow, context);
            }
            return;
        }

        if (node.type === 'logic.branch') {
            for (const next of this._nextNodes(nodeId, flow, 'yes')) {
                await this._walkFrom(next.id, flow, context);
            }
            for (const next of this._nextNodes(nodeId, flow, 'no')) {
                await this._walkFrom(next.id, flow, context);
            }
            return;
        }

        if (node.type === 'logic.log') {
            context._log.push(`[DEBUG] ${this._interpolate(node.config?.message || '', context)}`);
            for (const next of this._nextNodes(nodeId, flow)) {
                await this._walkFrom(next.id, flow, context);
            }
            return;
        }

        if (node.type?.startsWith('action.') || node.type?.startsWith('integration.') || node.type?.startsWith('ai.')) {
            await this._execAction(node, context, flow);
            for (const next of this._nextNodes(nodeId, flow)) {
                await this._walkFrom(next.id, flow, context);
            }
        }
    }

    _nextNodes(fromId, flow, handle = null) {
        const nodes = this._nodes(flow);
        return this._edges(flow)
            .filter((edge) => edge.sourceId === fromId && (!handle || !edge.sourceHandle || edge.sourceHandle === handle))
            .map((edge) => nodes.find((node) => node.id === edge.targetId))
            .filter(Boolean);
    }

    async _evalCondition(node, context) {
        const cfg = node.config || {};

        switch (node.type) {
            case 'condition.compare':
            case 'condition.boolean':
            case 'condition.text':
            case 'condition.api_response': {
                const value = this._resolveField(cfg.field || '', context);
                return this._compare(value, cfg.op || 'eq', cfg.value);
            }
            case 'condition.time_window':
                return this._isNowInWindow(cfg.from, cfg.to, cfg.tz);
            case 'condition.day_of_week':
                return this._isAllowedWeekday(cfg.days, cfg.tz);
            case 'condition.device_type': {
                const deviceType = context.state?.deviceType || context.state?.board || context.trigger?.deviceType || '';
                return this._compare(deviceType, 'eq', cfg.value || '');
            }
            case 'condition.has_field':
                return this._resolveField(cfg.field || '', context) !== undefined;
            case 'condition.last_state': {
                const property = cfg.property || cfg.field || '';
                const previous = this._resolvePath(property, context.previousState);
                return this._compare(previous, cfg.op || 'eq', cfg.value);
            }
            case 'condition.location': {
                const current = context.state?.lastLocation || this._extractLocation(context.trigger);
                if (!current) return false;
                const distanceKm = this._distanceKm(
                    Number(current.latitude),
                    Number(current.longitude),
                    Number(cfg.lat),
                    Number(cfg.lon)
                );
                return distanceKm <= Number(cfg.radius || 1);
            }
            case 'condition.value_changed': {
                const field = cfg.field || '';
                const previous = this._resolvePath(field, context.previousState);
                const current = this._resolvePath(field, context.state);
                const fromOk = cfg.from === undefined || cfg.from === '' || String(previous) === String(cfg.from);
                const toOk = cfg.to === undefined || cfg.to === '' || String(current) === String(cfg.to);
                return previous !== current && fromOk && toOk;
            }
            default:
                return false;
        }
    }

    async _execAction(node, context, flow) {
        const cfg = node.config || {};
        context._log.push(`[ACTION] ${node.label || node.type}`);

        try {
            switch (node.type) {
                case 'action.gpio_write':
                    await this._publishCommand(context.deviceId, 'gpio-write', {
                        pin: Number(cfg.pin),
                        value: Number(cfg.value || 0)
                    });
                    break;
                case 'action.gpio_pwm':
                    await this._publishCommand(context.deviceId, 'gpio-pwm', {
                        pin: Number(cfg.pin),
                        duty: Number(cfg.duty || 128),
                        freq: Number(cfg.freq || 5000)
                    });
                    break;
                case 'action.set_led':
                    await this._publishCommand(context.deviceId, 'led', {
                        r: Number(cfg.r || 0),
                        g: Number(cfg.g || 0),
                        b: Number(cfg.b || 0)
                    });
                    break;
                case 'action.send_sms':
                    {
                        const to = this._interpolate(cfg.to || '', context);
                        const message = this._interpolate(cfg.message || '', context);
                        if (this.db && this.mqttService?.publishCommand) {
                            await queueSmsForDelivery({
                                db: this.db,
                                mqttService: this.mqttService,
                                deviceId: context.deviceId,
                                to,
                                message,
                                source: 'automation'
                            });
                        } else {
                            const resolved = resolveSmsCommandForRecipient(to, message);
                            await this._publishCommand(context.deviceId, resolved.command, {
                                to,
                                message,
                                timeout: resolved.timeoutMs,
                                ...(resolved.metadata || {})
                            }, false, resolved.timeoutMs);
                        }
                    }
                    break;
                case 'action.send_notification': {
                    const title = this._interpolate(cfg.title || 'Automation Alert', context);
                    const message = this._interpolate(cfg.message || '', context);
                    this.io?.emit('automation:notification', {
                        flowId: flow.id,
                        title,
                        message
                    });
                    await notificationService.notify(title, message);
                    break;
                }
                case 'action.reboot_device':
                    await this._publishCommand(context.deviceId, 'restart', {});
                    break;
                case 'action.gps_toggle':
                    await this._publishCommand(context.deviceId, 'gps-set-enabled', {
                        enabled: String(cfg.enabled) !== 'false'
                    });
                    break;
                case 'action.ota_update':
                    await this._publishCommand(context.deviceId, 'ota-update', {
                        url: this._interpolate(cfg.url || '', context)
                    });
                    break;
                case 'action.set_mode':
                    await this._publishCommand(context.deviceId, 'set-mode', {
                        mode: this._interpolate(cfg.mode || '', context)
                    });
                    break;
                case 'action.trigger_siren':
                    await this._publishCommand(context.deviceId, 'alarm', {
                        duration: Number(cfg.duration || 3000),
                        pattern: this._interpolate(cfg.pattern || 'continuous', context)
                    });
                    break;
                case 'action.log_event': {
                    const message = this._interpolate(cfg.message || '', context);
                    context._log.push(`[LOG] ${message}`);
                    await this._appendSystemLog('info', message, context);
                    break;
                }
                case 'action.store_data':
                    await this._storeAutomationRecord(flow.id, context.deviceId, cfg.tags || '', context.trigger);
                    break;
                case 'action.create_alert': {
                    const severity = this._interpolate(cfg.severity || 'warning', context);
                    const message = this._interpolate(cfg.message || 'Automation alert', context);
                    await this._createAlert(severity, message, context.deviceId);
                    this.io?.emit('automation:alert', { severity, message, deviceId: context.deviceId });
                    break;
                }
                case 'action.update_twin':
                    await this._updateTwin(
                        context.deviceId,
                        this._interpolate(cfg.property || '', context),
                        this._interpolate(cfg.value || '', context)
                    );
                    context.state[this._interpolate(cfg.property || '', context)] = this._interpolate(cfg.value || '', context);
                    break;
                case 'integration.call_api':
                    context.flow.lastApi = await this._httpRequest({
                        url: this._interpolate(cfg.url || '', context),
                        method: cfg.method || 'POST',
                        headers: this._parseJson(cfg.headers, {}),
                        body: this._templatePayload(cfg.body, context)
                    });
                    break;
                case 'integration.call_device_api':
                    context.flow.lastApi = await this._callDeviceApi(context.deviceId, cfg, context);
                    break;
                case 'integration.mqtt_publish':
                case 'action.mqtt_publish':
                    await this._publish(
                        this._interpolate(cfg.topic || '', context),
                        this._templatePayload(cfg.payload, context)
                    );
                    break;
                case 'integration.call_webhook':
                case 'action.call_webhook':
                    context.flow.lastWebhook = await this._httpRequest({
                        url: this._interpolate(cfg.url || '', context),
                        method: cfg.method || 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: this._templatePayload(cfg.body, context)
                    });
                    break;
                case 'integration.send_email':
                    await this._sendEmail(
                        this._interpolate(cfg.to || '', context),
                        this._interpolate(cfg.subject || 'Automation Email', context),
                        this._interpolate(cfg.body || '', context)
                    );
                    break;
                case 'ai.analyze_telemetry':
                case 'ai.summarize_alert':
                case 'ai.recommend_action':
                case 'ai.custom':
                    context.flow.lastAi = await this._runAiNode(node.type, cfg, context);
                    break;
                default:
                    context._log.push(`[SKIP] unhandled node type: ${node.type}`);
            }
        } catch (error) {
            context._error = error.message;
            context._log.push(`[ERROR] ${node.type}: ${error.message}`);
            logger.error(`AutomationEngine action ${node.type} error:`, error.message);
        }
    }

    async _publishCommand(deviceId, command, payload, waitForResponse = false, timeout = 30000, options = {}) {
        if (!this.mqttService?.connected) throw new Error('MQTT not connected');
        await this.mqttService.publishCommand(deviceId, command, payload, waitForResponse, timeout, options);
    }

    async _publish(topic, payload) {
        if (!this.mqttService?.connected) throw new Error('MQTT not connected');
        const message = typeof payload === 'string' ? payload : JSON.stringify(payload || {});
        await this.mqttService.publish(topic, message);
    }

    async _httpRequest({ url, method = 'POST', headers = {}, body = undefined }) {
        const fetchFn = globalThis.fetch?.bind(globalThis);
        if (!fetchFn) throw new Error('Fetch is not available in this runtime');
        if (!url) throw new Error('Request URL is required');

        const options = {
            method,
            headers: { ...headers }
        };

        if (!['GET', 'HEAD'].includes(String(method).toUpperCase()) && body !== undefined) {
            options.body = typeof body === 'string' ? body : JSON.stringify(body);
            if (!options.headers['Content-Type']) {
                options.headers['Content-Type'] = 'application/json';
            }
        }

        const response = await fetchFn(url, options);
        const text = await response.text();
        let parsed = text;
        try { parsed = JSON.parse(text); } catch {}

        return {
            ok: response.ok,
            status: response.status,
            body: parsed
        };
    }

    async _callDeviceApi(deviceId, cfg, context) {
        const profile = await this.db?.get?.(
            `SELECT local_ip FROM device_profiles WHERE device_id = ?`,
            [deviceId]
        );
        if (!profile?.local_ip) {
            throw new Error('Device local IP is not configured');
        }

        const rawPath = this._interpolate(cfg.path || '', context).replace(/^\/+/, '');
        const url = `http://${profile.local_ip}/${rawPath}`;
        return this._httpRequest({
            url,
            method: cfg.method || 'GET',
            headers: { 'Content-Type': 'application/json' },
            body: this._templatePayload(cfg.body, context)
        });
    }

    async _sendEmail(to, subject, body) {
        if (!process.env.EMAIL_HOST || !to) {
            throw new Error('Email is not configured');
        }

        const transporter = nodemailer.createTransport({
            host: process.env.EMAIL_HOST,
            port: Number(process.env.EMAIL_PORT || 587),
            secure: String(process.env.EMAIL_PORT || '587') === '465',
            auth: process.env.EMAIL_USER
                ? {
                    user: process.env.EMAIL_USER,
                    pass: process.env.EMAIL_PASS || ''
                }
                : undefined
        });

        await transporter.sendMail({
            from: process.env.EMAIL_FROM || process.env.EMAIL_USER || 'iot-dashboard@noreply',
            to,
            subject,
            text: body
        });
    }

    async _runAiNode(nodeType, cfg, context) {
        const provider = String(cfg.provider || 'openrouter').toLowerCase();
        const model = this._interpolate(cfg.model || '', context);
        const apiKey = this._interpolate(cfg.apiKey || '', context);
        const fetchFn = globalThis.fetch?.bind(globalThis);
        if (!fetchFn) throw new Error('Fetch is not available in this runtime');
        if (!apiKey) throw new Error('AI API key is required');
        if (!model) throw new Error('AI model is required');

        const defaultPrompts = {
            'ai.analyze_telemetry': {
                system: 'You analyze IoT telemetry and identify actionable anomalies.',
                user: this._interpolate(cfg.prompt || JSON.stringify(context.trigger), context)
            },
            'ai.summarize_alert': {
                system: 'You summarize IoT alerts in concise plain language.',
                user: this._interpolate(cfg.prompt || JSON.stringify(context.trigger), context)
            },
            'ai.recommend_action': {
                system: 'You recommend the next operational action for an IoT device.',
                user: this._interpolate(cfg.context || JSON.stringify(context.trigger), context)
            },
            'ai.custom': {
                system: this._interpolate(cfg.prompt || 'You are an IoT automation assistant.', context),
                user: this._interpolate(cfg.userMsg || JSON.stringify(context.trigger), context)
            }
        };

        const prompt = defaultPrompts[nodeType] || defaultPrompts['ai.custom'];

        if (provider === 'anthropic') {
            const response = await fetchFn('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model,
                    max_tokens: 400,
                    system: prompt.system,
                    messages: [{ role: 'user', content: prompt.user }]
                })
            });

            const payload = await response.json();
            const output = payload?.content?.map((item) => item.text).filter(Boolean).join('\n') || '';
            return { provider, model, output, raw: payload };
        }

        const url = provider === 'openai'
            ? 'https://api.openai.com/v1/chat/completions'
            : 'https://openrouter.ai/api/v1/chat/completions';

        const response = await fetchFn(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model,
                temperature: 0.2,
                messages: [
                    { role: 'system', content: prompt.system },
                    { role: 'user', content: prompt.user }
                ]
            })
        });

        const payload = await response.json();
        const output = payload?.choices?.[0]?.message?.content || '';
        return { provider, model, output, raw: payload };
    }

    async _appendSystemLog(level, message, context) {
        await this.db?.run?.(
            `INSERT INTO system_logs (level, message, module, data)
             VALUES (?, ?, 'automation', ?)`,
            [level, message, JSON.stringify({ deviceId: context.deviceId, trigger: context.trigger })]
        );
    }

    async _storeAutomationRecord(flowId, deviceId, tags, payload) {
        await this.db?.run?.(
            `INSERT INTO automation_data_records (flow_id, device_id, tags, payload)
             VALUES (?, ?, ?, ?)`,
            [flowId, deviceId, String(tags || ''), JSON.stringify(payload || {})]
        );
    }

    async _createAlert(severity, message, deviceId) {
        await this.db?.run?.(
            `INSERT INTO notifications (type, title, message, action_url)
             VALUES (?, 'Automation Alert', ?, ?)`,
            [severity || 'warning', message, deviceId ? `/devices/${deviceId}` : null]
        );
    }

    async _updateTwin(deviceId, property, value) {
        if (!property) throw new Error('Twin property is required');
        return { deviceId, property, value };
    }

    async _logExecution(flowId, status, context) {
        try {
            await this.db?.run?.(
                `INSERT INTO automation_logs (flow_id, status, trigger, context, log)
                 VALUES (?, ?, ?, ?, ?)`,
                [
                    flowId,
                    status,
                    JSON.stringify(context.trigger || {}),
                    JSON.stringify({
                        deviceId: context.deviceId,
                        flow: context.flow || {},
                        state: context.state || {}
                    }),
                    context._log.join('\n')
                ]
            );
            await this.db?.run?.(
                `UPDATE automation_flows
                 SET last_triggered = CURRENT_TIMESTAMP,
                     trigger_count = trigger_count + 1,
                     last_result = ?
                 WHERE id = ?`,
                [status, flowId]
            );
        } catch (error) {
            logger.error('AutomationEngine._logExecution error:', error.message);
        }
    }

    async _runSchedules() {
        const now = new Date();
        for (const flow of this._flows) {
            const triggers = this._nodes(flow).filter((node) => node.type === 'trigger.schedule');
            for (const trigger of triggers) {
                if (!this._cronMatches(trigger.config?.cron || '* * * * *', now, trigger.config?.tz)) continue;
                const dedupeKey = `${trigger.id}:${this._minuteKey(now, trigger.config?.tz)}`;
                if (this._lastScheduleHits.get(dedupeKey)) continue;
                this._lastScheduleHits.set(dedupeKey, true);
                await this.onEvent('schedule', {
                    flowId: trigger.id,
                    cron: trigger.config?.cron || '* * * * *',
                    timestamp: now.toISOString()
                }, flow.deviceId || '');
            }
        }
    }

    _minuteKey(date, timeZone) {
        const parts = this._dateParts(date, timeZone);
        return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
    }

    _cronMatches(expr, date, timeZone) {
        const parts = String(expr || '').trim().split(/\s+/);
        if (parts.length !== 5) return false;
        const values = this._dateParts(date, timeZone);
        const weekday = values.weekday === 0 ? 7 : values.weekday;

        return this._cronFieldMatches(parts[0], values.minute)
            && this._cronFieldMatches(parts[1], values.hour)
            && this._cronFieldMatches(parts[2], values.day)
            && this._cronFieldMatches(parts[3], values.month)
            && this._cronFieldMatches(parts[4], weekday);
    }

    _cronFieldMatches(field, value) {
        return String(field).split(',').some((part) => {
            const trimmed = part.trim();
            if (trimmed === '*') return true;
            if (trimmed.startsWith('*/')) {
                const step = Number(trimmed.slice(2));
                return step > 0 && value % step === 0;
            }
            if (trimmed.includes('-')) {
                const [start, end] = trimmed.split('-').map(Number);
                return value >= start && value <= end;
            }
            return Number(trimmed) === value;
        });
    }

    _dateParts(date, timeZone) {
        if (!timeZone) {
            return {
                minute: date.getMinutes(),
                hour: date.getHours(),
                day: date.getDate(),
                month: date.getMonth() + 1,
                year: date.getFullYear(),
                weekday: date.getDay()
            };
        }

        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone,
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            weekday: 'short',
            hour12: false
        });
        const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
        const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
        return {
            minute: Number(parts.minute),
            hour: Number(parts.hour),
            day: Number(parts.day),
            month: Number(parts.month),
            year: Number(parts.year),
            weekday: weekdays[parts.weekday] ?? 0
        };
    }

    _isNowInWindow(from, to, timeZone) {
        if (!from || !to) return false;
        const parts = this._dateParts(new Date(), timeZone);
        const current = (parts.hour * 60) + parts.minute;
        const start = this._timeToMinutes(from);
        const end = this._timeToMinutes(to);
        if (start == null || end == null) return false;
        if (start <= end) return current >= start && current <= end;
        return current >= start || current <= end;
    }

    _isAllowedWeekday(days, timeZone) {
        if (!days) return false;
        const allowed = String(days).split(',').map((day) => day.trim().slice(0, 3).toLowerCase()).filter(Boolean);
        const weekdayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
        const weekday = weekdayNames[this._dateParts(new Date(), timeZone).weekday];
        return allowed.includes(weekday);
    }

    _timeToMinutes(value) {
        const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
        if (!match) return null;
        return (Number(match[1]) * 60) + Number(match[2]);
    }

    _distanceKm(lat1, lon1, lat2, lon2) {
        if ([lat1, lon1, lat2, lon2].some((value) => Number.isNaN(value))) return Number.POSITIVE_INFINITY;
        const toRad = (deg) => (deg * Math.PI) / 180;
        const earthRadiusKm = 6371;
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const a = Math.sin(dLat / 2) ** 2
            + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
        return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    _resolveField(field, context) {
        if (!field) return undefined;
        if (field.includes('.')) return this._resolvePath(field, context);

        if (context.trigger && Object.prototype.hasOwnProperty.call(context.trigger, field)) return context.trigger[field];
        if (context.state && Object.prototype.hasOwnProperty.call(context.state, field)) return context.state[field];
        if (context.previousState && Object.prototype.hasOwnProperty.call(context.previousState, field)) return context.previousState[field];
        if (context.flow && Object.prototype.hasOwnProperty.call(context.flow, field)) return context.flow[field];
        return undefined;
    }

    _resolvePath(path, source) {
        return String(path || '').split('.').reduce((value, key) => {
            if (value == null) return undefined;
            return value[key];
        }, source);
    }

    _compare(a, op, b) {
        const leftNum = Number(a);
        const rightNum = Number(b);
        const left = Number.isNaN(leftNum) ? a : leftNum;
        const right = Number.isNaN(rightNum) ? b : rightNum;

        switch (op) {
            case 'eq': return String(left) === String(right);
            case 'ne': return String(left) !== String(right);
            case 'gt': return Number(left) > Number(right);
            case 'gte': return Number(left) >= Number(right);
            case 'lt': return Number(left) < Number(right);
            case 'lte': return Number(left) <= Number(right);
            case 'contains': return String(left || '').includes(String(right || ''));
            case 'starts_with': return String(left || '').startsWith(String(right || ''));
            case 'regex':
                try { return new RegExp(String(right || '')).test(String(left || '')); }
                catch { return false; }
            case 'truthy': return !!left;
            case 'falsy': return !left;
            default: return false;
        }
    }

    _templatePayload(template, context) {
        if (template == null || template === '') return undefined;
        const interpolated = this._interpolate(template, context);
        return this._parseJson(interpolated, interpolated);
    }

    _parseJson(value, fallback) {
        try { return JSON.parse(value); } catch { return fallback; }
    }

    _interpolate(template, context) {
        if (typeof template !== 'string') return template;
        return template.replace(/\{\{([^}]+)\}\}/g, (_match, expression) => {
            const value = this._resolvePath(expression.trim(), context);
            return value !== undefined ? String(value) : `{{${expression}}}`;
        });
    }
}

const engine = new AutomationEngine();
module.exports = engine;
