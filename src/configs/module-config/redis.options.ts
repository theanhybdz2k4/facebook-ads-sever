import { ConfigModule, ConfigService } from '@nestjs/config';
import { CacheModuleAsyncOptions } from '@nestjs/cache-manager';
import { redisStore } from 'cache-manager-redis-store';

export const RedisOptions: CacheModuleAsyncOptions = {
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: async (configService: ConfigService) => {
    const store = await redisStore({
      socket: {
        host: configService.get('redis.host'),
        port: configService.get('redis.port'),
      },
      password: configService.get('redis.password'),
    });

    return {
      store: () => store,
      ttl: configService.get('redis.ttl'),
    };
  },
};

