const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');

// Ensure logs directory exists
const logsDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir);
}

const logLevel = process.env.LOG_LEVEL || 'info';

const jsonFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
);

const rotateOptions = {
    datePattern: 'YYYY-MM-DD',
    maxFiles: '14d'
};

const logger = winston.createLogger({
    level: logLevel,
    format: jsonFormat,
    defaultMeta: { service: 'esp32-dashboard' },
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
                winston.format.printf(({ timestamp, level, message, ...meta }) => {
                    const extra = Object.keys(meta).filter(k => k !== 'service').length
                        ? ' ' + JSON.stringify(Object.fromEntries(Object.entries(meta).filter(([k]) => k !== 'service')))
                        : '';
                    return `${timestamp} [${level}]: ${message}${extra}`;
                })
            )
        }),
        new DailyRotateFile({
            ...rotateOptions,
            filename: path.join(logsDir, 'app-%DATE%.log'),
            level: logLevel
        }),
        new DailyRotateFile({
            ...rotateOptions,
            filename: path.join(logsDir, 'error-%DATE%.log'),
            level: 'error'
        })
    ]
});

// Dedicated MQTT logger — writes to its own rotating file
const mqttLogger = winston.createLogger({
    level: 'debug',
    format: jsonFormat,
    defaultMeta: { service: 'mqtt' },
    transports: [
        new DailyRotateFile({
            ...rotateOptions,
            filename: path.join(logsDir, 'mqtt-%DATE%.log')
        })
    ]
});

logger.mqtt = mqttLogger;

module.exports = logger;
