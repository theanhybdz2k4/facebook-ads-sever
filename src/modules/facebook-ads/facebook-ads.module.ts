import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { BullModule } from '@nestjs/bullmq';
import { FacebookAdsController } from './facebook-ads.controller';
import { FacebookApiService } from './api/facebook-api.service';
import { RateLimiterService } from './api/rate-limiter.service';
import { TokenService } from './accounts/token.service';
import { FbAccountService } from './accounts/fb-account.service';
import { EntitySyncService } from './sync/entity-sync.service';
import { InsightsSyncService } from './sync/insights-sync.service';
import { CrawlJobService } from './sync/crawl-job.service';
import { TelegramService } from './notifications/telegram.service';
import { EntityProcessor } from './processors/entity.processor';
import { InsightsProcessor } from './processors/insights.processor';
import { CrawlSchedulerService } from './jobs/crawl-scheduler.service';
import { PrismaModule } from '@n-database/prisma/prisma.module';

// Queue names
export const ENTITY_QUEUE = 'fb-entity-sync';
export const INSIGHTS_QUEUE = 'fb-insights-sync';

@Module({
  imports: [
    PrismaModule,
    HttpModule.register({
      timeout: 60000,
      maxRedirects: 5,
    }),
    BullModule.registerQueue(
      { name: 'fb-entity-sync' },
      { name: 'fb-insights-sync' },
    ),
  ],
    controllers: [FacebookAdsController],
    providers: [
        FacebookApiService,
        RateLimiterService,
        TokenService,
        FbAccountService,
        EntitySyncService,
        InsightsSyncService,
        CrawlJobService,
        TelegramService,
        EntityProcessor,
        InsightsProcessor,
        CrawlSchedulerService,
    ],
    exports: [
        FacebookApiService,
        TokenService,
        FbAccountService,
        EntitySyncService,
        InsightsSyncService,
        TelegramService,
    ],
})
export class FacebookAdsModule { }
