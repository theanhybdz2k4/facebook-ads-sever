import { Module } from '@nestjs/common';
import { BranchesController } from './branches.controller';
import { BranchesService } from './services/branches.service';
import { BranchStatsService } from './services/branch-stats.service';
import { PrismaModule } from '@n-database/prisma/prisma.module';

@Module({
    imports: [PrismaModule],
    controllers: [BranchesController],
    providers: [BranchesService, BranchStatsService],
    exports: [BranchesService, BranchStatsService],
})
export class BranchesModule { }
