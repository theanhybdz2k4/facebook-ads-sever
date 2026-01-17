import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '@n-database/prisma/prisma.module';
import { SharedModule } from '../shared/shared.module';
import { JobsModule } from '../jobs/jobs.module';
import { TokensModule } from '../tokens/tokens.module';
import { TelegramModule } from '../telegram/telegram.module';
import { BranchesModule } from '../branches/branches.module';
import { InsightsController } from './insights.controller';
import { InsightsService } from './services/insights.service';
import { InsightsSyncService } from './services/insights-sync.service';
import { InsightsQueryService } from './services/insights-query.service';

@Module({
  imports: [PrismaModule, SharedModule, JobsModule, TokensModule, TelegramModule, forwardRef(() => BranchesModule)],
  controllers: [InsightsController],
  providers: [InsightsService, InsightsSyncService, InsightsQueryService],
  exports: [InsightsService, InsightsSyncService, InsightsQueryService],
})
export class InsightsModule { }

