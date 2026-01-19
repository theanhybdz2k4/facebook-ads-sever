import { forwardRef, Module } from '@nestjs/common';
import { PrismaModule } from '@n-database/prisma/prisma.module';
import { SharedModule } from '@n-modules/shared/shared.module';
import { PlatformsModule } from '../platforms/platforms.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { AdGroupsModule } from '../ad-groups/ad-groups.module';
import { AdsController } from './ads.controller';
import { AdsService } from './services/ads.service';
import { AdsSyncService } from './services/ads-sync.service';

@Module({
  imports: [PrismaModule, SharedModule, PlatformsModule, forwardRef(() => CampaignsModule), AdGroupsModule],
  controllers: [AdsController],
  providers: [AdsService, AdsSyncService],
  exports: [AdsService, AdsSyncService],
})
export class AdsModule { }
