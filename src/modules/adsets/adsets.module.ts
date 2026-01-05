import { Module } from '@nestjs/common';
import { PrismaModule } from '@n-database/prisma/prisma.module';
import { SharedModule } from '../shared/shared.module';
import { JobsModule } from '../jobs/jobs.module';
import { TokensModule } from '../tokens/tokens.module';
import { AdSetsController } from './adsets.controller';
import { AdSetsService } from './services/adsets.service';
import { AdSetsSyncService } from './services/adsets-sync.service';

@Module({
  imports: [PrismaModule, SharedModule, JobsModule, TokensModule],
  controllers: [AdSetsController],
  providers: [AdSetsService, AdSetsSyncService],
  exports: [AdSetsService, AdSetsSyncService],
})
export class AdSetsModule {}

