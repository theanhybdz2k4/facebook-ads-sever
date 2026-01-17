import { Module, forwardRef } from '@nestjs/common';
import { BranchesController } from './branches.controller';
import { BranchesService } from './services/branches.service';
import { BranchStatsService } from './services/branch-stats.service';
import { PrismaModule } from '@n-database/prisma/prisma.module';
import { InsightsModule } from '../insights/insights.module';

@Module({
    imports: [PrismaModule, forwardRef(() => InsightsModule)],
    controllers: [BranchesController],
    providers: [BranchesService, BranchStatsService],
    exports: [BranchesService, BranchStatsService],
})
export class BranchesModule { }
