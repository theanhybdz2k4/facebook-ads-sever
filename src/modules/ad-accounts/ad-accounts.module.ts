import { Module } from '@nestjs/common';
import { PrismaModule } from '@n-database/prisma/prisma.module';
import { SharedModule } from '../shared/shared.module';
import { JobsModule } from '../jobs/jobs.module';
import { TokensModule } from '../tokens/tokens.module';
import { AdAccountsController } from './ad-accounts.controller';
import { AdAccountsService } from './services/ad-accounts.service';
import { AdAccountsSyncService } from './services/ad-accounts-sync.service';

@Module({
  imports: [PrismaModule, SharedModule, JobsModule, TokensModule],
  controllers: [AdAccountsController],
  providers: [AdAccountsService, AdAccountsSyncService],
  exports: [AdAccountsService, AdAccountsSyncService],
})
export class AdAccountsModule {}

