/**
 * FAANG-grade structured logging with correlation IDs and distributed tracing.
 * All logs include correlation ID, timestamp, pod ID, and trace context.
 */

const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const { trace } = require('@opentelemetry/api');
const config = require('../config');

// Generate unique correlation ID
function generateCorrelationId() {
  return `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Get current trace context from OpenTelemetry
function getTraceContext() {
  const span = trace.getActiveSpan();
  if (!span) return null;
  
  const spanContext = span.spanContext();
  return {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
  };
}

// Custom format for structured logs
const logFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json(),
  winston.format.printf(({ timestamp, level, message, correlationId, podId, traceContext, ...meta }) => {
    return JSON.stringify({
      timestamp,
      level,
      message,
      correlationId,
      podId,
      traceContext,
      ...meta,
    });
  })
);

// Create logger instance
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  defaultMeta: {
    podId: process.env.POD_ID || `pod-${process.pid}-${Date.now()}`,
    service: 'webrtc-signaling',
    env: config.env,
  },
  transports: [
    // Console transport for development
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, correlationId, ...meta }) => {
          const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
          return `${timestamp} [${level}]${correlationId ? ` [${correlationId}]` : ''}: ${message} ${metaStr}`;
        })
      ),
    }),
    
    // File transport with daily rotation
    new DailyRotateFile({
      filename: 'logs/application-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '100m',
      maxFiles: '30d',
      format: logFormat,
    }),
    
    // Error log file
    new DailyRotateFile({
      filename: 'logs/error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxSize: '50m',
      maxFiles: '30d',
      format: logFormat,
    }),
  ],
});

// Create a context-aware logger that includes correlation ID
class ContextLogger {
  constructor(correlationId = null) {
    this.correlationId = correlationId || generateCorrelationId();
  }

  child(meta) {
    const childCorrelationId = meta.correlationId || this.correlationId;
    return new ContextLogger(childCorrelationId);
  }

  _log(level, message, meta = {}) {
    const traceContext = getTraceContext();
    logger.log(level, message, {
      correlationId: this.correlationId,
      traceContext,
      ...meta,
    });
  }

  info(message, meta) {
    this._log('info', message, meta);
  }

  warn(message, meta) {
    this._log('warn', message, meta);
  }

  error(message, meta) {
    this._log('error', message, meta);
  }

  debug(message, meta) {
    this._log('debug', message, meta);
  }
}

// Create default logger instance
const defaultLogger = new ContextLogger();

module.exports = {
  logger,
  ContextLogger,
  generateCorrelationId,
  getTraceContext,
  default: defaultLogger,
};
