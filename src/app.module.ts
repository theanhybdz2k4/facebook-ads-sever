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

// Unified Modules
import { AuthModule } from './modules/auth/auth.module';
import { SharedModule } from './modules/shared/shared.module';
import { PlatformsModule } from './modules/platforms/platforms.module';
import { AccountsModule } from './modules/accounts/accounts.module';
import { CampaignsModule } from './modules/campaigns/campaigns.module';
import { AdGroupsModule } from './modules/ad-groups/ad-groups.module';
import { AdsModule } from './modules/ads/ads.module';
import { InsightsModule } from './modules/insights/insights.module';
import { BranchesModule } from './modules/branches/branches.module';
import { CronSettingsModule } from './modules/cron-settings/cron-settings.module';
import { TelegramModule } from './modules/telegram/telegram.module';
import { SyncModule } from './modules/sync/sync.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      load: [appConfig, databaseConfig],
      validate,
    }),
    SharedModule,
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
    PlatformsModule,
    AccountsModule,
    CampaignsModule,
    AdGroupsModule,
    AdsModule,
    InsightsModule,
    BranchesModule,
    CronSettingsModule,
    TelegramModule,
    SyncModule,
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
