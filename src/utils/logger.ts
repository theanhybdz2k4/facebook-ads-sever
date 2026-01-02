import * as winston from 'winston';
import * as path from 'path';

export function logger(options?: { infoFile?: string; errorFile?: string }) {
  const logDir = path.join(process.cwd(), 'logs');

  // Custom format to properly serialize objects
  const consoleFormat = winston.format.printf(({ level, message, timestamp }) => {
    const msg = typeof message === 'object' ? JSON.stringify(message) : message;
    return `${level}: ${msg}`;
  });

  const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json(),
    ),
    transports: [
      new winston.transports.File({
        filename: path.join(logDir, options?.errorFile || 'error.log'),
        level: 'error',
      }),
      new winston.transports.File({
        filename: path.join(logDir, options?.infoFile || 'combined.log'),
      }),
    ],
  });

  if (process.env.NODE_ENV !== 'production') {
    logger.add(
      new winston.transports.Console({
        format: consoleFormat,
      }),
    );
  }

  return logger;
}

