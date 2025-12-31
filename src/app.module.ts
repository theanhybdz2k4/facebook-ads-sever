import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { AppController } from './app.controller';
import databaseConfig from '@n-configs/env/database.config';
import { AppService } from './app.service';
import appConfig from '@n-configs/env/app.config';
import { LoggerOptions } from '@n-configs/module-config/logger.options';
import { ScheduleModule } from '@nestjs/schedule';
import { ClsModule } from 'nestjs-cls';
import { ClsPluginTransactional } from '@nestjs-cls/transactional';
import { TransactionalAdapterPrisma } from '@nestjs-cls/transactional-adapter-prisma';
import { PrismaModule } from '@n-database/prisma/prisma.module';
import { PrismaService } from '@n-database/prisma/prisma.service';
import validate from '@n-configs/env/env.validation';
import { APP_INTERCEPTOR, APP_FILTER } from '@nestjs/core';
import { ResponseInterceptor } from '@n-interceptors/response.interceptor';
import { AllExceptionFilter } from './filter-exceptions/exception.filter';
import { AuthModule } from './modules/auth/auth.module';
import { FacebookAdsModule } from './modules/facebook-ads/facebook-ads.module';
import { PgBossModule } from './pgboss/pgboss.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      load: [appConfig, databaseConfig],
      validate,
    }),
    PgBossModule,
    LoggerModule.forRoot(LoggerOptions),
    ClsModule.forRoot({
      plugins: [
        new ClsPluginTransactional({
          imports: [PrismaModule],
          adapter: new TransactionalAdapterPrisma({
            prismaInjectionToken: PrismaService,
          }),
        }),
      ],
      global: true,
      middleware: { mount: true },
    }),
    ScheduleModule.forRoot(),
    AuthModule,
    FacebookAdsModule,
  ],
  controllers: [AppController],
  providers: [
    PrismaService,
    AppService,
    {
      provide: APP_INTERCEPTOR,
      useClass: ResponseInterceptor,
    },
    {
      provide: APP_FILTER,
      useClass: AllExceptionFilter,
    },
  ],
})
export class AppModule { }
