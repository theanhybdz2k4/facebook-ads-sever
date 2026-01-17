import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { SharedModule } from '../shared/shared.module';
import { JobsModule } from '../jobs/jobs.module';
import { CronModule } from '../cron/cron.module';
import { InsightsModule } from '../insights/insights.module';
import { TokensModule } from '../tokens/tokens.module';
import { BranchesModule } from '../branches/branches.module';
import { TelegramModule } from '../telegram/telegram.module';
import { FacebookAdsController } from './facebook-ads.controller';
import { InternalN8nController } from './internal-n8n.controller';
import { EntitySyncService } from './services/entity-sync.service';
import { InsightsSyncService } from '../insights/services/insights-sync.service';
import { EntityProcessor } from './processors/entity.processor';
import { InsightsProcessor } from './processors/insights.processor';
import { PrismaModule } from '@n-database/prisma/prisma.module';
import { InternalApiKeyGuard } from '../auth/guards';

// Queue names
export const ENTITY_QUEUE = 'fb-entity-sync';
export const INSIGHTS_QUEUE = 'fb-insights-sync';

@Module({
  imports: [
    SharedModule,
    JobsModule,
    CronModule,
    InsightsModule,
    TokensModule,
    TelegramModule,
    BranchesModule,
    PrismaModule,
    ConfigModule,
    HttpModule.register({
      timeout: 60000,
      maxRedirects: 5,
    }),
  ],
  controllers: [FacebookAdsController, InternalN8nController],
  providers: [
    EntitySyncService,
    EntityProcessor,
    InsightsProcessor,
    InternalApiKeyGuard,
  ],
  exports: [
    EntitySyncService,
  ],
})
export class FacebookAdsModule { }

