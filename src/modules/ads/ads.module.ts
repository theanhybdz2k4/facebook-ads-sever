import { forwardRef, Module } from '@nestjs/common';
import { PrismaModule } from '@n-database/prisma/prisma.module';
import { SharedModule } from '@n-modules/shared/shared.module';
import { PlatformsModule } from '../platforms/platforms.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { AdGroupsModule } from '../ad-groups/ad-groups.module';
import { AdsController } from './ads.controller';
import { AdCreativesController } from './ad-creatives.controller';
import { AdsService } from './services/ads.service';
import { AdsSyncService } from './services/ads-sync.service';
import { CreativeSyncService } from './services/creative-sync.service';

@Module({
  imports: [PrismaModule, SharedModule, PlatformsModule, forwardRef(() => CampaignsModule), AdGroupsModule],
  controllers: [AdsController, AdCreativesController],
  providers: [AdsService, AdsSyncService, CreativeSyncService],
  exports: [AdsService, AdsSyncService, CreativeSyncService],
})
export class AdsModule { }
