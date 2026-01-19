import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PlatformsService } from './platforms.service';
import { PlatformsController } from './platforms.controller';
import { FacebookAdapter } from './implementations/facebook/facebook-account.adapter';
import { FacebookApiService } from './implementations/facebook/facebook-api.service';
import { FacebookCampaignAdapter } from './implementations/facebook/facebook-campaign.adapter';
import { FacebookInsightAdapter } from './implementations/facebook/facebook-insight.adapter';
import { FacebookAdGroupAdapter } from './implementations/facebook/facebook-ad-group.adapter';
import { FacebookAdAdapter } from './implementations/facebook/facebook-ad.adapter';

import { SharedModule } from '../shared/shared.module';

@Module({
  imports: [HttpModule, SharedModule],
  providers: [
    PlatformsService,
    FacebookAdapter,
    FacebookApiService,
    FacebookCampaignAdapter,
    FacebookInsightAdapter,
    FacebookAdGroupAdapter,
    FacebookAdAdapter
  ],
  controllers: [PlatformsController],
  exports: [
    PlatformsService,
    FacebookApiService,
    FacebookCampaignAdapter,
    FacebookInsightAdapter,
    FacebookAdGroupAdapter,
    FacebookAdAdapter
  ],
})
export class PlatformsModule { }
