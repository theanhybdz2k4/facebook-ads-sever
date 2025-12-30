import * as winston from 'winston';
import * as path from 'path';

export function logger(options?: { infoFile?: string; errorFile?: string }) {
  const logDir = path.join(process.cwd(), 'logs');

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
        format: winston.format.simple(),
      }),
    );
  }

  return logger;
}

