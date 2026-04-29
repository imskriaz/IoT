const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const session = require('express-session');
const expressLayouts = require('express-ejs-layouts');
const http = require('http');
const crypto = require('crypto');
const socketIo = require('socket.io');
const flash = require('connect-flash');
const moment = require('moment');
const ejs = require('ejs');
const fs = require('fs');
const logger = require('./utils/logger');
const { resolveDeviceId } = require('./utils/deviceResolver');
const { initializeDatabase } = require('./config/database');
const { DEFAULT_DEVICE_ID } = require('./config/device');
const { buildDashboardDeviceStatus } = require('./utils/dashboardStatus');
const { withEffectiveRole } = require('./middleware/auth');
const { captureRawBody, createErrorHandler } = require('./middleware/errorHandler');
const { getEffectiveSystemSettings, normalizeStatusWatchSettings } = require('./services/systemSettingsService');
const packageService = require('./services/packageService');
const paymentGatewayService = require('./services/paymentGatewayService');
const { backfillSmsConversations } = require('./services/smsConversations');
const authMiddleware = require('./middleware/auth');
const ASSET_VERSION = Date.now().toString(36);

// Import services
const mqttService = require('./services/mqttService');
const modemService = require('./services/modemService');

// Import routes
const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');
const indexRoutes = require('./routes/index');
const mqttRoutes = require('./routes/mqtt');
const usersRoute = require('./routes/users');
const onboardingRoute = require('./routes/onboarding');
const androidBridgeAdapterRoute = require('./routes/androidBridgeAdapter');
const deviceGroupsRoute = require('./routes/deviceGroups');
const apiKeysRoute = require('./routes/apiKeys');
const webhooksRoute = require('./routes/webhooks');
const automationRoute = require('./routes/automation');

// Swagger UI (available in all environments; auth-guarded below)
const swaggerUi   = require('swagger-ui-express');
let swaggerSpecCache = null;
const swaggerOptions = {
    customSiteTitle: 'ESP32 Dashboard API',
    swaggerOptions: { persistAuthorization: true }
};

function getSwaggerSpec() {
    if (!swaggerSpecCache) {
        swaggerSpecCache = require('./config/swagger');
    }
    return swaggerSpecCache;
}

const app = express();
const server = http.createServer(app);
const backgroundTimers = [];
const activeSockets = new Set();
let isShuttingDown = false;
const statusWatchReadyDevices = new Set();
const io = socketIo(server, {
    cors: {
        // In production set CORS_ORIGIN to the exact dashboard URL; leave unset for same-origin only
        origin: process.env.CORS_ORIGIN || false,
        methods: ["GET", "POST"],
        credentials: true
    },
    pingTimeout: 60000,
    pingInterval: 25000
});

function isBrokenPipeError(error) {
    if (!error) return false;
    return error.code === 'EPIPE' || /broken pipe/i.test(String(error.message || ''));
}

[process.stdout, process.stderr].forEach(stream => {
    if (!stream || typeof stream.on !== 'function') return;
    stream.on('error', (error) => {
        if (isBrokenPipeError(error)) {
            return;
        }
        throw error;
    });
});

// ==================== DATABASE INITIALIZATION ====================
let db;
let mqttHandlers = null;
let runtimeServicesInitialized = false;
(async () => {
    try {
        db = await initializeDatabase({ backfillSmsConversations: false });
        app.locals.db = db;
        try {
            const effectiveSystem = await getEffectiveSystemSettings(db);
            applyStatusWatchConfig(effectiveSystem.system);
        } catch (_) {
            applyStatusWatchConfig({});
        }
        
        // Create necessary directories
        const dirs = [
            path.join(__dirname, 'storage'),
            path.join(__dirname, 'backups'),
            path.join(__dirname, 'public/uploads'),
            path.join(__dirname, 'public/uploads/webcam'),
            path.join(__dirname, 'public/uploads/files'),
            path.join(__dirname, 'logs'),
            path.join(__dirname, 'data'),
            path.join(__dirname, 'temp')
        ];

        await Promise.all(dirs.map(dir => fs.promises.mkdir(dir, { recursive: true })));
        scheduleStartupSmsConversationBackfill(db);

    } catch (error) {
        logger.error('❌ Failed to initialize database:', error);
        process.exit(1);
    }
})();

function initializeRuntimeServices() {
    if (runtimeServicesInitialized) return;
    runtimeServicesInitialized = true;

    try {
        // ==================== WEBHOOK SERVICE ====================
        const WebhookService = require('./services/webhookService');
        const webhookService = new WebhookService(app);
        app.locals.webhookService = webhookService;

        const pushNotificationService = require('./services/pushNotificationService');
        pushNotificationService.app = app;
        app.locals.pushNotificationService = pushNotificationService;
        global.pushNotificationService = pushNotificationService;

        // ==================== SCHEDULED SMS PROCESSOR ====================
        const { startScheduledSmsProcessor } = require('./routes/sms');
        backgroundTimers.push(startScheduledSmsProcessor(app));

        // ==================== MQTT HANDLERS INITIALIZATION ====================
        const MQTTHandlers = require('./services/mqttHandlers');
        mqttHandlers = new MQTTHandlers(mqttService, io, app);
        mqttHandlers.initialize();
        app.locals.mqttHandlers = mqttHandlers;
        global.mqttHandlers = mqttHandlers;

        // ==================== AUTOMATION ENGINE INITIALIZATION ====================
        // db may not be ready yet (async init above); pass a proxy accessor so the
        // engine picks up the db reference once it is available.
        const automationEngine = require('./services/automationEngine');
        const dbProxy = new Proxy({}, {
            get(_, prop) {
                const dbInst = app.locals.db;
                if (!dbInst) return undefined;
                const val = dbInst[prop];
                return typeof val === 'function' ? val.bind(dbInst) : val;
            }
        });
        automationEngine.init(dbProxy, mqttService, io);
        app.locals.automationEngine = automationEngine;
        global.automationEngine = automationEngine;

        // ==================== USB SERIAL BRIDGE ====================
        // Optional fallback channel when MQTT/4G is unavailable.
        // Enable by setting SERIAL_PORT and SERIAL_BRIDGE_ENABLED=true in .env
        if (process.env.SERIAL_PORT) {
            const serialBridge = require('./services/serialBridgeService');
            app.locals.serialBridge = serialBridge;
            if (process.env.SERIAL_BRIDGE_ENABLED === 'true') {
                serialBridge.start(app).catch(err => logger.warn('[SerialBridge] Start error:', err.message));
            }
        }
    } catch (error) {
        logger.error('❌ Failed to initialize runtime services:', error);
    }
}

function scheduleStartupSmsConversationBackfill(dbInst) {
    const timer = setTimeout(async () => {
        try {
            if (!dbInst) return;
            const pending = await dbInst.get(
                `SELECT id
                 FROM sms
                 WHERE COALESCE(device_id, '') != ''
                   AND (conversation_id IS NULL OR conversation_id = 0)
                 LIMIT 1`
            );
            if (!pending) return;
            logger.info('Starting background SMS conversation backfill');
            await backfillSmsConversations(dbInst);
            logger.info('Background SMS conversation backfill completed');
        } catch (error) {
            logger.warn('Background SMS conversation backfill skipped:', error.message);
        }
    }, 5000);
    timer.unref?.();
    backgroundTimers.push(timer);
}

// ==================== GLOBAL VARIABLES ====================
global.app = app;
global.io = io;
global.mqttService = mqttService;
global.modemService = modemService;
global.logger = logger;

// ==================== MIDDLEWARE ====================
// Security headers
const helmet = require('helmet');
app.use(helmet({
    contentSecurityPolicy: false,  // CSP requires nonce/hash plumbing; disabled for now
    crossOriginEmbedderPolicy: false  // breaks CDN-loaded Bootstrap/BI icons
}));

// Attach a unique request ID to every request for log tracing
app.use((req, _res, next) => {
    req.id = crypto.randomUUID();
    next();
});
app.use(require('compression')());
app.use(express.json({ limit: '5mb', verify: captureRawBody }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.get('/sw.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});
app.use(express.static(path.join(__dirname, 'public')));
app.get('/favicon.ico', (_req, res) => {
    res.status(204).end();
});
app.use('/vendor/intl-tel-input', express.static(path.join(__dirname, '..', 'node_modules', 'intl-tel-input', 'build')));
// Serve firmware binaries — auth guarded in routes but also limited here to .bin only
app.use('/firmware', authMiddleware, express.static(path.join(__dirname, 'data/firmware'), {
    dotfiles: 'deny',
    setHeaders: (res) => { res.setHeader('Content-Type', 'application/octet-stream'); }
}));

// Per-user rate limiting (keyed on session user ID, falls back to IPv6-safe IP)
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,    // 1-minute window
    max: 300,               // 300 requests/minute per user
    keyGenerator: (req) => (req.session?.user?.id ? `user_${req.session.user.id}` : ipKeyGenerator(req)),
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many requests — please slow down.' }
});
// Apply only to API routes (not static assets)
app.use('/api', apiLimiter);

// Strict limiter for login endpoint — 10 attempts per 15 minutes per IP
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,  // 15 minutes
    max: 10,
    keyGenerator: ipKeyGenerator,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many login attempts. Please try again in 15 minutes.',
    skipSuccessfulRequests: true   // only count failed attempts
});
app.use('/auth/login', loginLimiter);

// Guard session secret — hard-fail in production, warn in development
const INSECURE_DEFAULT_SECRET = 'secret-key-change-in-production';
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === INSECURE_DEFAULT_SECRET) {
    if (process.env.NODE_ENV === 'production') {
        logger.error('FATAL: SESSION_SECRET is not set (or uses the insecure default). Refusing to start in production.');
        process.exit(1);
    } else {
        logger.warn('⚠️  SESSION_SECRET not set — using insecure default. Set it in .env before going live.');
    }
}

// Session configuration — stored in SQLite so sessions survive restarts
try {
    const SQLiteStore = require('connect-sqlite3')(session);

    const sessionMiddleware = session({
        store: new SQLiteStore({
            db: 'database.sqlite',
            dir: path.join(__dirname, 'data'),
            table: 'sessions'
        }),
        secret: process.env.SESSION_SECRET || 'secret-key-change-in-production',
        resave: false,
        saveUninitialized: false,
        cookie: {
            secure: process.env.NODE_ENV === 'production',
            httpOnly: true,
            maxAge: 24 * 60 * 60 * 1000, // 24 hours
            sameSite: 'lax'
        },
        name: 'esp32.sid',
        rolling: true
    });

    // Make session middleware available to Socket.IO auth.
    global.sessionMiddleware = sessionMiddleware;

    app.use(sessionMiddleware);
} catch (error) {
    logger.error('❌ Session configuration error:', error);
}

// Flash messages
app.use(flash());

// Make variables available to all views
app.use((req, res, next) => {
    try {
        res.locals.user = withEffectiveRole(req.user || req.session.user || null);
        res.locals.success_msg = req.flash('success');
        res.locals.error_msg = req.flash('error');
        res.locals.moment = moment;
        res.locals.currentYear = new Date().getFullYear();
        res.locals.nodeEnv = process.env.NODE_ENV || 'development';
        res.locals.assetVersion = ASSET_VERSION;
        res.locals.deviceId = resolveDeviceId(req, DEFAULT_DEVICE_ID);
        res.locals.phoneCountryCode = process.env.PHONE_COUNTRY_CODE || '';
        res.locals.showSidebar = true;

        // CSRF: generate once per session, expose to views
        if (!req.session.csrfToken) {
            req.session.csrfToken = crypto.randomBytes(32).toString('hex');
        }
        res.locals.csrfToken = req.session.csrfToken;
    } catch (error) {
        logger.error('Error in locals middleware:', error);
    }
    next();
});

// CSRF validation disabled — rely on session auth + rate limiting for protection
// (Re-enable for production by restoring the token-check middleware here)

// Make io available to routes
app.use((req, res, next) => {
    req.io = io;
    next();
});

// Request logging
if (process.env.NODE_ENV !== 'production') {
    // Development: brief debug log via Winston
    app.use((req, res, next) => {
        logger.debug(`${req.method} ${req.url}`);
        next();
    });
} else {
    // Production: morgan combined-format to a rotating access log file
    const morgan = require('morgan');
    const accessLogStream = fs.createWriteStream(
        path.join(__dirname, 'logs/access.log'),
        { flags: 'a' }
    );
    app.use(morgan('combined', { stream: accessLogStream }));
}

// ==================== EJS SETUP ====================
try {
    app.use(expressLayouts);
    app.set('view engine', 'html');
    app.engine('html', ejs.renderFile);
    app.set('views', path.join(__dirname, 'views'));
    app.set('layout', 'layouts/main');
    app.locals.settings = {
        'view options': {
            client: false,
            filename: path.join(__dirname, 'views')
        }
    };
} catch (error) {
    logger.error('❌ EJS setup error:', error);
}

app.get('/', async (req, res, next) => {
    try {
        if (req.session?.user) {
            return res.redirect('/dashboard');
        }

        const offers = await packageService.loadPackageOffers(app.locals.db);
        const payment = await paymentGatewayService.loadPaymentInstructions(app.locals.db);
        return res.render('pages/landing', {
            title: 'Device Bridge',
            layout: false,
            offers: offers.map(packageService.serializeOffer),
            payment
        });
    } catch (error) {
        return next(error);
    }
});

// ==================== SOCKET.IO ====================
io.use((socket, next) => {
    try {
        const sessionMiddleware = global.sessionMiddleware;
        if (!sessionMiddleware) {
            return next(new Error('Authentication error'));
        }

        sessionMiddleware(socket.request, {}, (err) => {
            if (err) {
                logger.error('Socket auth session middleware error:', err);
                return next(new Error('Authentication error'));
            }

            const sessionData = socket.request?.session;
            if (!sessionData?.user) {
                return next(new Error('Authentication error'));
            }

            socket.sessionId = socket.request.sessionID || socket.request.session?.id || null;
            socket.user = sessionData.user;
            return next();
        });
    } catch (error) {
        logger.error('Socket auth error:', error);
        next(new Error('Authentication error'));
    }
});

// Track connected clients
const connectedClients = new Map();
const dashboardDeviceWatchers = new Map();
let statusWatchRefreshTimer = null;
let lastStatusWatchRefreshAt = 0;

function getStatusWatchConfig() {
    return normalizeStatusWatchSettings(app.locals?.statusWatchConfig || {});
}

function scheduleStatusWatchRefreshTimer() {
    const previousTimer = statusWatchRefreshTimer;
    if (statusWatchRefreshTimer) {
        clearInterval(statusWatchRefreshTimer);
    }

    const config = getStatusWatchConfig();
    const tickMs = Math.max(10000, Math.min(30000, Math.floor(config.statusWatchRefreshMs / 2)));
    statusWatchRefreshTimer = setInterval(() => {
        const activeConfig = getStatusWatchConfig();
        if ((Date.now() - lastStatusWatchRefreshAt) < activeConfig.statusWatchRefreshMs) {
            return;
        }
        refreshStatusWatchers();
    }, tickMs);
    statusWatchRefreshTimer.unref?.();
    if (previousTimer) {
        const previousIndex = backgroundTimers.indexOf(previousTimer);
        if (previousIndex >= 0) {
            backgroundTimers[previousIndex] = statusWatchRefreshTimer;
            return;
        }
    }
    backgroundTimers.push(statusWatchRefreshTimer);
}

function applyStatusWatchConfig(input = {}) {
    app.locals.statusWatchConfig = normalizeStatusWatchSettings(input);
    scheduleStatusWatchRefreshTimer();
    lastStatusWatchRefreshAt = 0;
    if (dashboardDeviceWatchers.size > 0 && mqttService?.connected) {
        setTimeout(refreshStatusWatchers, 50).unref?.();
    }
    return app.locals.statusWatchConfig;
}

app.locals.applyStatusWatchConfig = applyStatusWatchConfig;

function publishStatusWatch(deviceId, active) {
    const normalizedDeviceId = String(deviceId || '').trim();
    const config = getStatusWatchConfig();
    const deviceBusy = normalizedDeviceId
        && (
            mqttService?.isDeviceBusy?.(normalizedDeviceId) === true
            || mqttService?.hasDeviceQueueActivity?.(normalizedDeviceId) === true
        );
    const deviceCommandAccepting = normalizedDeviceId && statusWatchReadyDevices.has(normalizedDeviceId);
    const shouldEnable = Boolean(active);

    if (!normalizedDeviceId || !mqttService?.connected) {
        return;
    }

    if (shouldEnable && deviceBusy) {
        /* Avoid injecting status-watch control traffic while telephony or other
         * runtime commands are in flight on the same modem MQTT lane. Re-enable
         * the watch after the device leaves the busy window instead of pushing
         * an explicit disable command during the critical section. */
        return;
    }

    if (shouldEnable && !deviceCommandAccepting) {
        /* Do not push status-watch control traffic at a device that has not yet
         * reported a live command-accepting MQTT lane. Early status-watch
         * messages can collide with the modem CMQTT subscribe handshake and
         * delay recovery after boot or telephony reconnects. */
        return;
    }

    mqttService.publishRuntimeCommand(
        normalizedDeviceId,
        'status-watch',
        {
            enabled: shouldEnable,
            ttl_ms: config.statusWatchTtlMs,
            interval_ms: config.statusWatchIntervalMs
        },
        false,
        5000,
        {
            domain: 'status',
            skipQueue: true,
            skipPersistentQueue: true,
            source: 'dashboard-presence'
        }
    ).catch((error) => {
        logger.debug(`Status watch update skipped for ${normalizedDeviceId}: ${error.message}`);
    });
}

function setSocketDeviceWatch(socket, deviceId) {
    const nextDeviceId = String(deviceId || '').trim();
    const previousDeviceId = socket.data?.statusWatchDeviceId || '';

    if (!nextDeviceId || nextDeviceId === previousDeviceId) {
        return;
    }

    if (previousDeviceId) {
        const previousCount = Math.max(0, Number(dashboardDeviceWatchers.get(previousDeviceId) || 0) - 1);
        if (previousCount > 0) {
            dashboardDeviceWatchers.set(previousDeviceId, previousCount);
        } else {
            dashboardDeviceWatchers.delete(previousDeviceId);
            publishStatusWatch(previousDeviceId, false);
        }
    }

    const nextCount = Number(dashboardDeviceWatchers.get(nextDeviceId) || 0) + 1;
    dashboardDeviceWatchers.set(nextDeviceId, nextCount);
    socket.data.statusWatchDeviceId = nextDeviceId;

    if (nextCount === 1) {
        publishStatusWatch(nextDeviceId, true);
    }
}

function clearSocketDeviceWatch(socket) {
    const previousDeviceId = socket.data?.statusWatchDeviceId || '';

    if (!previousDeviceId) {
        return;
    }

    const previousCount = Math.max(0, Number(dashboardDeviceWatchers.get(previousDeviceId) || 0) - 1);
    if (previousCount > 0) {
        dashboardDeviceWatchers.set(previousDeviceId, previousCount);
    } else {
        dashboardDeviceWatchers.delete(previousDeviceId);
        publishStatusWatch(previousDeviceId, false);
    }
    socket.data.statusWatchDeviceId = '';
}

function syncSocketDeviceWatch(socket) {
    const isVisible = socket.data?.statusWatchVisible !== false;
    const isActive = socket.data?.statusWatchActive === true;
    const subscribedDeviceId = String(socket.data?.subscribedDeviceId || '').trim();

    if (!isVisible || !isActive || !subscribedDeviceId) {
        clearSocketDeviceWatch(socket);
        return;
    }

    setSocketDeviceWatch(socket, subscribedDeviceId);
}

function refreshStatusWatchers() {
    lastStatusWatchRefreshAt = Date.now();
    for (const [deviceId, count] of dashboardDeviceWatchers.entries()) {
        if (count > 0) {
            publishStatusWatch(deviceId, true);
        }
    }
}

applyStatusWatchConfig({});
mqttService.on('connect', () => {
    setTimeout(refreshStatusWatchers, 250).unref?.();
});
mqttService.on('device:busy-change', (deviceId, busy) => {
    const normalizedDeviceId = String(deviceId || '').trim();
    const watcherCount = Number(dashboardDeviceWatchers.get(normalizedDeviceId) || 0);

    if (!normalizedDeviceId || watcherCount <= 0) {
        return;
    }

    if (busy === true) {
        return;
    }

    publishStatusWatch(normalizedDeviceId, true);
});
mqttService.on('status', (deviceId, data) => {
    const normalizedDeviceId = String(deviceId || '').trim();
    const watcherCount = Number(dashboardDeviceWatchers.get(normalizedDeviceId) || 0);
    const liveCommandAccepting = Boolean(
        data
        && data.online === true
        && (
            data.transport?.mqttCommandAccepting === true
            || data.mqtt?.connected === true
        )
    );

    if (!normalizedDeviceId) {
        return;
    }

    if (liveCommandAccepting) {
        statusWatchReadyDevices.add(normalizedDeviceId);
    } else {
        statusWatchReadyDevices.delete(normalizedDeviceId);
    }

    if (watcherCount <= 0 || !liveCommandAccepting) {
        return;
    }

    publishStatusWatch(normalizedDeviceId, true);
});

server.on('connection', (socket) => {
    activeSockets.add(socket);

    socket.on('close', () => {
        activeSockets.delete(socket);
    });
});

io.on('connection', (socket) => {
    const clientInfo = {
        id: socket.id,
        ip: socket.handshake.address,
        userAgent: socket.handshake.headers['user-agent'],
        connectedAt: new Date().toISOString()
    };
    
    connectedClients.set(socket.id, clientInfo);
    logger.info(`🔌 Socket connected: ${socket.id} (${connectedClients.size} total)`);

    // Per-socket rate limiter: max 30 events per second
    let socketMsgCount = 0;
    const socketRateLimitInterval = setInterval(() => { socketMsgCount = 0; }, 1000);
    const socketRateLimit = (eventName, handler) => (...args) => {
        socketMsgCount++;
        if (socketMsgCount > 30) {
            socket.emit('rate_limited', { message: 'Too many messages', retryAfter: 1 });
            return;
        }
        handler(...args);
    };

    const initialDeviceId = resolveDeviceId({ session: socket.request?.session }, DEFAULT_DEVICE_ID);
    socket.data.statusWatchVisible = true;
    socket.data.statusWatchActive = false;
    socket.data.subscribedDeviceId = initialDeviceId || '';
    if (initialDeviceId) {
        socket.join('device:' + initialDeviceId);
        syncSocketDeviceWatch(socket);
    }

    // Send initial connection status
    socket.emit('connected', {
        id: socket.id,
        timestamp: new Date().toISOString(),
        mqtt: mqttService.connected,
        clients: connectedClients.size
    });

    // Push MQTT status immediately so client sidebar updates without a round-trip
    socket.emit('mqtt:status', mqttService.getStatus());

    // Send initial device status (modemService.getDeviceStatus returns flat object)
    const deviceStatus = modemService.getDeviceStatus(initialDeviceId);
    socket.emit('device:status', {
        deviceId: initialDeviceId,
        ...buildDashboardDeviceStatus(deviceStatus, deviceStatus?.online)
    });

    // Allow client to subscribe to a specific device's room
    socket.on('subscribe:device', socketRateLimit('subscribe:device', ({ deviceId } = {}) => {
        if (!deviceId || typeof deviceId !== 'string') return;
        const normalizedDeviceId = String(deviceId).trim();
        if (!normalizedDeviceId) return;
        const room = 'device:' + normalizedDeviceId;
        for (const joinedRoom of socket.rooms) {
            if (joinedRoom.startsWith('device:') && joinedRoom !== room) {
                socket.leave(joinedRoom);
            }
        }
        if (!socket.rooms.has(room)) {
            socket.join(room);
            logger.debug(`Socket ${socket.id} joined room ${room}`);
        }
        socket.data.subscribedDeviceId = normalizedDeviceId;
        syncSocketDeviceWatch(socket);
        if (socket.request?.session) {
            socket.request.session.deviceId = normalizedDeviceId;
            socket.request.session.save?.(() => {});
        }
    }));

    socket.on('status-watch:visibility', socketRateLimit('status-watch:visibility', ({ visible, active } = {}) => {
        if (typeof visible === 'boolean') {
            socket.data.statusWatchVisible = visible;
        }
        if (typeof active === 'boolean') {
            socket.data.statusWatchActive = active;
        }
        syncSocketDeviceWatch(socket);
    }));

    socket.on('disconnect', () => {
        clearInterval(socketRateLimitInterval);
        clearSocketDeviceWatch(socket);
        connectedClients.delete(socket.id);
        logger.info(`🔌 Socket disconnected: ${socket.id} (${connectedClients.size} remaining)`);
    });

    socket.on('error', (error) => {
        logger.error(`Socket error for ${socket.id}:`, error);
    });

    // Handle client requests
    socket.on('get:status', socketRateLimit('get:status', () => {
        socket.emit('status', {
            server: 'online',
            mqtt: mqttService.connected,
            clients: connectedClients.size,
            timestamp: new Date().toISOString()
        });
    }));

    socket.on('get:mqtt-status', socketRateLimit('get:mqtt-status', () => {
        socket.emit('mqtt:status', mqttService.getStatus());
    }));

    socket.on('get:device-status', socketRateLimit('get:device-status', ({ deviceId } = {}) => {
        const requestedDeviceId = resolveDeviceId({
            body: { deviceId },
            session: socket.request?.session
        }, DEFAULT_DEVICE_ID);
        if (!requestedDeviceId) return;
        const status = modemService.getDeviceStatus(requestedDeviceId);
        socket.emit('device:status', {
            deviceId: requestedDeviceId,
            ...buildDashboardDeviceStatus(status, status?.online)
        });
    }));

    socket.on('get:devices', socketRateLimit('get:devices', () => {
        const devices = modemService.getAllDevices();
        socket.emit('devices:list', devices);
    }));
});

// ==================== DAILY AUTO-BACKUP ====================
// Runs once per day. Only executes if auto_backup setting is enabled in DB.
(function scheduleAutoBackup() {
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
    const autoBackupTimer = setInterval(async () => {
        try {
            const dbInst = app.locals.db;
            if (!dbInst) return;

            const row = await dbInst.get("SELECT value FROM settings WHERE key = 'auto_backup'");
            const enabled = row ? (row.value === 'true' || row.value === '"true"') : false;
            if (!enabled) return;

            const backupDir = path.join(__dirname, 'backups');
            await fs.promises.mkdir(backupDir, { recursive: true });

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const dst = path.join(backupDir, `backup-${timestamp}.db`);

            // Use better-sqlite3's online backup API (safe on a live DB)
            await dbInst._raw.backup(dst);
            logger.info(`Auto-backup created: ${dst}`);

            // Retention: delete backups older than 30 days
            const maxAge = 30 * 24 * 60 * 60 * 1000;
            fs.readdirSync(backupDir)
                .filter(f => f.startsWith('backup-') && f.endsWith('.db'))
                .forEach(f => {
                    const fp = path.join(backupDir, f);
                    if (Date.now() - fs.statSync(fp).mtimeMs > maxAge) {
                        fs.unlinkSync(fp);
                        logger.info(`Auto-backup retention: deleted ${f}`);
                    }
                });
        } catch (err) {
            logger.error('Auto-backup error:', err);
        }
    }, TWENTY_FOUR_HOURS);
    autoBackupTimer.unref();
    backgroundTimers.push(autoBackupTimer);
})();

// ==================== WAL CHECKPOINT ====================
// Run PRAGMA wal_checkpoint(TRUNCATE) every 6 hours to prevent WAL file growth.
const walCheckpointTimer = setInterval(() => {
    try {
        const dbInst = app.locals.db;
        if (dbInst?._raw) dbInst._raw.pragma('wal_checkpoint(TRUNCATE)');
    } catch (err) {
        logger.error('WAL checkpoint error:', err.message);
    }
}, 6 * 60 * 60 * 1000);
walCheckpointTimer.unref();
backgroundTimers.push(walCheckpointTimer);

// ==================== HEALTH CHECK ENDPOINT ====================
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        mqtt: {
            connected: mqttService.connected,
            connecting: mqttService.connecting
        },
        database: !!app.locals.db,
        clients: connectedClients.size,
        memory: process.memoryUsage(),
        version: process.version
    });
});

// ==================== ROUTES ====================
try {
    app.use('/auth', authRoutes);
    app.use('/api', authMiddleware, apiRoutes);
    app.use('/api/mqtt', authMiddleware, mqttRoutes);
    app.use('/admin', authMiddleware, usersRoute);
    app.get('/api-docs.json', authMiddleware, (_req, res) => res.json(getSwaggerSpec()));
    app.use('/api-docs', authMiddleware, swaggerUi.serve, (req, res, next) => {
        swaggerUi.setup(getSwaggerSpec(), swaggerOptions)(req, res, next);
    });
    app.use('/api/device-groups', authMiddleware, deviceGroupsRoute);
    app.use('/api/keys', authMiddleware, apiKeysRoute);
    app.use('/api/webhooks', authMiddleware, webhooksRoute);
    app.use('/api/automation', authMiddleware, automationRoute);
    app.use('/v1/android/bridge', authMiddleware, androidBridgeAdapterRoute);
    app.use('/', authMiddleware, onboardingRoute);
    app.use('/', authMiddleware, indexRoutes);
} catch (error) {
    logger.error('❌ Error loading routes:', error);
}

// ==================== 404 HANDLER ====================
app.use((req, res) => {
    try {
        res.status(404).render('pages/404', {
            title: 'Page Not Found',
            layout: 'layouts/main'
        });
    } catch (error) {
        logger.error('404 handler error:', error);
        res.status(404).send('Page not found');
    }
});

// ==================== ERROR HANDLER ====================
app.use(createErrorHandler(logger));

// Legacy fallback handler retained below.
app.use((err, req, res, next) => {
    if (res.headersSent) {
        return next(err);
    }

    try {
        logger.error(`💥 Unhandled error: ${err.message}`, { 
            stack: err.stack,
            url: req.url,
            method: req.method,
            ip: req.ip,
            body: req.body
        });

        const isApiRequest = req.originalUrl?.startsWith('/api');
        const statusCode = err.status || err.statusCode || (err.type === 'entity.parse.failed' ? 400 : 500);

        // Don't send error details in production
        const message = process.env.NODE_ENV === 'production' 
            ? 'Something went wrong!' 
            : (err.type === 'entity.parse.failed' ? 'Invalid JSON body' : err.message);

        if (isApiRequest) {
            return res.status(statusCode).json({
                success: false,
                message
            });
        }

        res.status(statusCode).render('pages/404', {
            title: 'Server Error',
            message: message,
            layout: 'layouts/main'
        });
    } catch (error) {
        logger.error('Error handler failed:', error);
        if (res.headersSent) {
            return next(error);
        }
        res.status(500).send('Server Error');
    }
});

// ==================== SERVER START ====================
const PORT = process.env.PORT || 3001;

try {
    server.listen(PORT, '0.0.0.0', () => {
        logger.debug(`Server listening on http://localhost:${PORT}`);
        const runtimeInitTimer = setTimeout(initializeRuntimeServices, 500);
        runtimeInitTimer.unref?.();
        backgroundTimers.push(runtimeInitTimer);
    });

    server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
            logger.error(`❌ Port ${PORT} is already in use — another process is still running`);
        } else {
            logger.error(`❌ Server error: ${error.message}`);
        }
        process.exit(1);
    });

} catch (error) {
    logger.error('❌ Failed to start server:', error);
    process.exit(1);
}

// ==================== GRACEFUL SHUTDOWN ====================
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

async function gracefulShutdown() {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info('🛑 Received shutdown signal, closing connections...');

    // Hard forced exit after 5 s — ensures port is always released even if cleanup hangs
    const forceExit = setTimeout(() => {
        logger.warn('⚠️  Forced exit after 5 s (some handles did not close in time)');
        process.exit(0);
    }, 5000);
    // Do NOT unref — this must fire even if other handles are blocking
    if (forceExit.unref) forceExit.unref = null; // prevent accidental .unref() calls later

    // Clear all tracked background timers
    for (const timer of backgroundTimers) {
        if (timer) {
            clearInterval(timer);
            clearTimeout(timer);
        }
    }

    // Destroy all tracked HTTP keep-alive sockets immediately
    try {
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
    } catch (_) {}

    for (const socket of activeSockets) {
        try { socket.destroy(); } catch (_) {}
    }
    activeSockets.clear();

    // Close Socket.IO (gracefully disconnects all clients)
    try {
        await new Promise(resolve => io.close(resolve));
        logger.info('✅ Socket.IO closed');
    } catch (_) {}

    // Disconnect MQTT
    try {
        if (mqttHandlers) {
            mqttHandlers.disconnect();
            logger.info('✅ MQTT disconnected');
        }
    } catch (_) {}

    // Stop accepting new HTTP connections (existing ones already destroyed above)
    try {
        await Promise.race([
            new Promise(resolve => server.close(resolve)),
            new Promise(resolve => setTimeout(resolve, 2000))
        ]);
        logger.info('✅ HTTP server closed');
    } catch (_) {}

    // Close SQLite
    try {
        if (db) {
            await Promise.race([
                db.close(),
                new Promise(resolve => setTimeout(resolve, 2000))
            ]);
            logger.info('✅ Database closed');
        }
    } catch (_) {}

    logger.info('👋 Goodbye!');
    clearTimeout(forceExit);
    process.exit(0);
}

// ==================== UNCAUGHT EXCEPTIONS ====================
process.on('uncaughtException', (error) => {
    if (isBrokenPipeError(error)) {
        return;
    }
    logger.error(`💥 Uncaught Exception: ${error.message}`);
    logger.error(error.stack);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('💥 Unhandled Rejection at:', promise);
    logger.error('💥 Reason:', reason);
});

module.exports = { app, server };
