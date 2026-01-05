import { Module } from '@nestjs/common';
import { PrismaModule } from '@n-database/prisma/prisma.module';
import { SharedModule } from '../shared/shared.module';
import { JobsModule } from '../jobs/jobs.module';
import { TokensModule } from '../tokens/tokens.module';
import { AdsController } from './ads.controller';
import { AdsService } from './services/ads.service';
import { AdsSyncService } from './services/ads-sync.service';

@Module({
  imports: [PrismaModule, SharedModule, JobsModule, TokensModule],
  controllers: [AdsController],
  providers: [AdsService, AdsSyncService],
  exports: [AdsService, AdsSyncService],
})
export class AdsModule {}

