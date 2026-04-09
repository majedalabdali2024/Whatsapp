import winston from 'winston';
import 'winston-daily-rotate-file';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import __dirname from './dirname.js';

const logsDir = join(__dirname, 'logs');
if (!existsSync(logsDir)) {
    mkdirSync(logsDir, { recursive: true });
}

// Define log format
const logFormat = winston.format.combine(
    winston.format.timestamp({
        format: 'YYYY-MM-DD HH:mm:ss'
    }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
        let metaString = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
        return `${timestamp} [${level.toUpperCase()}]: ${message} ${metaString}`;
    })
);

// Create daily rotate file transport for general logs
const dailyRotateFileTransport = new winston.transports.DailyRotateFile({
    filename: join(logsDir, 'whatsapp-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    maxSize: '20m',
    maxFiles: '14d',
    format: logFormat
});

// Create daily rotate file transport for error logs
const errorRotateFileTransport = new winston.transports.DailyRotateFile({
    filename: join(logsDir, 'error-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    maxSize: '20m',
    maxFiles: '14d',
    level: 'error',
    format: logFormat
});

// exitOnError: false — Baileys يرمي أحياناً أخطاء غير متوقعة لا يجب أن تُوقف الخدمة
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    exitOnError: false,
    format: logFormat,
    transports: [
        dailyRotateFileTransport,
        errorRotateFileTransport,
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple(),
                winston.format.printf(({ timestamp, level, message, ...meta }) => {
                    let metaString = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
                    return `${timestamp} [${level}]: ${message} ${metaString}`;
                })
            )
        })
    ]
});

// Export logger functions
export default {
    info: (message, meta = {}) => logger.info(message, meta),
    error: (message, meta = {}) => logger.error(message, meta),
    warn: (message, meta = {}) => logger.warn(message, meta),
    debug: (message, meta = {}) => logger.debug(message, meta),
    verbose: (message, meta = {}) => logger.verbose(message, meta),

    // Log API requests
    logRequest: (req, res, next) => {
        const start = Date.now();
        logger.info(`Incoming ${req.method} request to ${req.path}`, {
            method: req.method,
            path: req.path,
            query: req.query,
            ip: req.ip
        });
        next();
    }
};
