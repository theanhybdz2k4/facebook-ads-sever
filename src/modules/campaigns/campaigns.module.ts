import { Module } from '@nestjs/common';
import { PrismaModule } from '@n-database/prisma/prisma.module';
import { SharedModule } from '../shared/shared.module';
import { JobsModule } from '../jobs/jobs.module';
import { TokensModule } from '../tokens/tokens.module';
import { CampaignsController } from './campaigns.controller';
import { CampaignsService } from './services/campaigns.service';
import { CampaignsSyncService } from './services/campaigns-sync.service';

@Module({
  imports: [PrismaModule, SharedModule, JobsModule, TokensModule],
  controllers: [CampaignsController],
  providers: [CampaignsService, CampaignsSyncService],
  exports: [CampaignsService, CampaignsSyncService],
})
export class CampaignsModule {}

