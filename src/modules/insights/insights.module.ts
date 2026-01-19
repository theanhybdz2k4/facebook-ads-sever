import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '@n-database/prisma/prisma.module';
import { SharedModule } from '@n-modules/shared/shared.module';
import { BranchesModule } from '../branches/branches.module';
import { PlatformsModule } from '../platforms/platforms.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { AdsModule } from '../ads/ads.module';
import { InsightsController } from './insights.controller';
import { InsightsService } from './services/insights.service';
import { InsightsSyncService } from './services/insights-sync.service';
import { InsightsQueryService } from './services/insights-query.service';

@Module({
  imports: [
    PrismaModule, 
    SharedModule, 
    PlatformsModule, 
    CampaignsModule, 
    AdsModule, 
    forwardRef(() => BranchesModule)
  ],
  controllers: [InsightsController],
  providers: [InsightsService, InsightsSyncService, InsightsQueryService],
  exports: [InsightsService, InsightsSyncService, InsightsQueryService],
})
export class InsightsModule { }
