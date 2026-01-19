import { Controller, Get, Post, Put, Delete, Param, Body, Query, UseGuards, ParseIntPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@n-modules/auth/guards/jwt-auth.guard';
import { BranchesService, CreateBranchDto, UpdateBranchDto } from './services/branches.service';
import { BranchStatsService } from './services/branch-stats.service';
import { CurrentUser } from '@n-modules/shared/decorators/current-user.decorator';

@ApiTags('Branches (Unified)')
@Controller('branches')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class BranchesController {
    constructor(
        private readonly branchesService: BranchesService,
        private readonly branchStatsService: BranchStatsService,
    ) { }

    @Get()
    @ApiOperation({ summary: 'List all branches for user' })
    async getBranches(@CurrentUser('id') userId: number) {
        return this.branchesService.getBranches(userId);
    }

    @Post()
    @ApiOperation({ summary: 'Create a new branch' })
    async createBranch(
        @CurrentUser('id') userId: number,
        @Body() dto: CreateBranchDto,
    ) {
        return this.branchesService.createBranch(userId, dto);
    }

    @Get('stats/dashboard')
    @ApiOperation({ summary: 'Get consolidated dashboard stats' })
    async getDashboardStats(
        @CurrentUser('id') userId: number,
        @Query('dateStart') dateStart?: string,
        @Query('dateEnd') dateEnd?: string,
    ) {
        const today = new Date().toISOString().split('T')[0];
        const defaultStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

        return this.branchStatsService.getDashboardStats(
            userId,
            dateStart || defaultStart,
            dateEnd || today,
        );
    }

    @Post(':id/stats/aggregate')
    @ApiOperation({ summary: 'Manually trigger stats aggregation for a branch' })
    async aggregateBranchStats(
        @Param('id', ParseIntPipe) id: number,
        @CurrentUser('id') userId: number,
        @Body() dto: { date?: string },
    ) {
        // Verify branch ownership
        await this.branchesService.getBranch(id, userId);

        const date = dto.date || new Date().toISOString().split('T')[0];
        return this.branchStatsService.aggregateBranchStats(id, date);
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get branch details' })
    async getBranch(
        @Param('id', ParseIntPipe) id: number,
        @CurrentUser('id') userId: number,
    ) {
        return this.branchesService.getBranch(id, userId);
    }

    @Put(':id')
    @ApiOperation({ summary: 'Update a branch' })
    async updateBranch(
        @Param('id', ParseIntPipe) id: number,
        @CurrentUser('id') userId: number,
        @Body() dto: UpdateBranchDto,
    ) {
        return this.branchesService.updateBranch(id, userId, dto);
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Delete a branch' })
    async deleteBranch(
        @Param('id', ParseIntPipe) id: number,
        @CurrentUser('id') userId: number,
    ) {
        return this.branchesService.deleteBranch(id, userId);
    }
}
