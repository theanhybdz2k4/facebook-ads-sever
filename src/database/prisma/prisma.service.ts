import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { blue } from 'colorette';
import { convertToVietnamTimezone, logger } from '@n-utils';
import { PrismaClientExtended } from './prisma.extended';

@Injectable()
export class PrismaService
  extends PrismaClientExtended
  implements OnModuleInit, OnModuleDestroy {
  private readonly loggerTerminal = new Logger(PrismaService.name);

  private readonly logger = logger({
    infoFile: 'prisma-info.log',
    errorFile: 'prisma-error.log',
  });

  constructor() {
    super({
      log: [
        {
          emit: 'event',
          level: 'query',
        },
        {
          emit: 'event',
          level: 'error',
        },
        {
          emit: 'event',
          level: 'info',
        },
        {
          emit: 'event',
          level: 'warn',
        },
      ],
    });

    // Set timezone to Vietnam
    process.env.TZ = 'Asia/Ho_Chi_Minh';
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  async onModuleInit() {
    await this.$connect();
    this.$use(this.findMiddleware);
    this.$use(this.softDeleteMiddleware);
    this.$use(this.dateMiddleware);

    // Prisma 5.x event listeners - using type assertion for compatibility
    (this as any).$on('error' as any, ({ message }: { message: string }) => {
      this.loggerTerminal.error(message);
      this.logger.error(message);
    });
    (this as any).$on('warn' as any, ({ message }: { message: string }) => {
      this.loggerTerminal.warn(message);
    });
    (this as any).$on('info' as any, ({ message }: { message: string }) => {
      this.loggerTerminal.debug(message);
      this.logger.info(message);
    });
    (this as any).$on('query' as any, ({ query, params }: { query: string; params: any }) => {
      const transformedQuery = this.simplifyQuery(query, params);
      this.loggerTerminal.log(blue(transformedQuery));
    });
  }

  private simplifyQuery(inputQuery: string, params: string): string {
    try {
      const paramsObject = JSON.parse(params);

      let simplifiedQuery = inputQuery;

      paramsObject.forEach((param, index) => {
        // Serialize objects/arrays properly for logging instead of [object Object]
        const paramStr = typeof param === 'object' && param !== null
          ? JSON.stringify(param)
          : String(param);
        simplifiedQuery = simplifiedQuery.replace(
          `$${index + 1}`,
          `'${paramStr}'`,
        );
      });

      return simplifiedQuery;
    } catch (error) {
      return inputQuery;
    }
  }

  softDeleteMiddleware: Prisma.Middleware = async (params, next) => {
    // Only apply soft delete to models that have deletedAt field
    const modelHasDeletedAt = this.modelsWithDeletedAt.has(params.model || '');

    if (!modelHasDeletedAt) {
      // For models without deletedAt, do real delete
      return next(params);
    }

    if (params.action === 'delete') {
      return next({
        ...params,
        action: 'update',
        args: {
          ...params.args,
          data: {
            deletedAt: new Date(),
          },
        },
      });
    }

    if (params.action === 'deleteMany') {
      return next({
        ...params,
        action: 'updateMany',
        args: {
          ...params.args,
          data: {
            deletedAt: new Date(),
          },
        },
      });
    }

    return next(params);
  };

  // Models that have deletedAt field - used by findMiddleware
  private readonly modelsWithDeletedAt = new Set([
    'User', 'FbAccount', 'FbApiToken', 'RefreshToken', 'AdAccount',
    'Campaign', 'Adset', 'Ad', 'Creative', 'AdImage', 'AdVideo', 'CrawlJob',
  ]);

  findMiddleware: Prisma.Middleware = async (params, next) => {
    if (['findUnique', 'findFirst', 'findMany', 'count'].includes(params.action)) {
      // Only add deletedAt filter if the model has this field
      const modelHasDeletedAt = this.modelsWithDeletedAt.has(params.model || '');

      if (modelHasDeletedAt) {
        const hasDeleted = params.args?.where && this.hasDeletedCondition(params.args.where);
        if (!hasDeleted) {
          params = {
            ...params,
            args: {
              ...params.args,
              where: {
                ...params.args?.where,
                deletedAt: null,
              },
            },
          };
        }
      }

      // NOTE: Do NOT enable include filtering - Prisma doesn't support
      // 'where' on _count or single-relation (non-array) includes.
      // The deletedAt filter only applies to top-level queries.

      if (params.action === 'findUnique' || params.action === 'findFirst') {
        params.action = 'findFirst';
      }
    }

    return next(params);
  };

  private applyDeletedFilterToInclude(include: any): any {
    const newInclude = { ...include };
    for (const key in newInclude) {
      if (typeof newInclude[key] === 'object') {
        newInclude[key] = {
          ...newInclude[key],
          where: {
            ...newInclude[key]?.where,
            deletedAt: null,
          },
        };
        if (newInclude[key].include) {
          newInclude[key].include = this.applyDeletedFilterToInclude(newInclude[key].include);
        }
      }
    }
    return newInclude;
  }

  private hasDeletedCondition(where) {
    if (where.deletedAt !== undefined) {
      return true;
    }

    return ['AND', 'OR', 'NOT'].some((condition) => {
      if (where[condition]) {
        const conditions = Array.isArray(where[condition]) ? where[condition] : [where[condition]];
        return conditions.some((subWhere: any) => this.hasDeletedCondition(subWhere));
      }
      return false;
    });
  }

  async cleanDatabase() {
    if (process.env.NODE_ENV === 'production') return;

    const models = Prisma.dmmf.datamodel.models;
    return Promise.all(
      models.map(model => this[model.name.toLowerCase()].deleteMany())
    );
  }

  dateMiddleware: Prisma.Middleware = async (params, next) => {
    const result = await next(params);

    if (result && typeof result === 'object') {
      // Convert createdAt and updatedAt to Vietnam timezone
      if (result.createdAt) {
        result.createdAt = convertToVietnamTimezone(result.createdAt);
      }
      if (result.updatedAt) {
        result.updatedAt = convertToVietnamTimezone(result.updatedAt);
      }
    }

    return result;
  };
}

