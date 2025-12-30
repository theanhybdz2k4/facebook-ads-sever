import { logger } from './logger';

export const LoggerFactory = {
  create: (context?: string) => {
    return logger({
      infoFile: context ? `${context}-info.log` : 'app-info.log',
      errorFile: context ? `${context}-error.log` : 'app-error.log',
    });
  },
};

