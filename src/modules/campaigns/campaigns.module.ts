import { forwardRef, Module } from '@nestjs/common';
import { PrismaModule } from '@n-database/prisma/prisma.module';
import { SharedModule } from '@n-modules/shared/shared.module';
import { CampaignsController } from './campaigns.controller';
import { CampaignsService } from './campaigns.service';
import { CampaignsSyncService } from './campaigns-sync.service';
import { PlatformsModule } from '../platforms/platforms.module';
import { AdsModule } from '../ads/ads.module';

@Module({
  imports: [PrismaModule, SharedModule, PlatformsModule, forwardRef(() => AdsModule)],
  controllers: [CampaignsController],
  providers: [CampaignsService, CampaignsSyncService],
  exports: [CampaignsService, CampaignsSyncService],
})
export class CampaignsModule { }
