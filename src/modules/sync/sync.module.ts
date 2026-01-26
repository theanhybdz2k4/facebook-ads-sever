import { Module } from '@nestjs/common';
import { PrismaModule } from '@n-database/prisma/prisma.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { AdsModule } from '../ads/ads.module';
import { InsightsModule } from '../insights/insights.module';
import { TelegramModule } from '../telegram/telegram.module';
import { BranchesModule } from '../branches/branches.module';
import { DispatchService } from './dispatch.service';
import { InternalSyncController } from './internal-sync.controller';


@Module({
  imports: [
    PrismaModule,
    CampaignsModule,
    AdsModule,
    InsightsModule,
    TelegramModule,
    BranchesModule,
  ],
  controllers: [InternalSyncController],
  providers: [DispatchService],
  exports: [DispatchService],
})
export class SyncModule { }
