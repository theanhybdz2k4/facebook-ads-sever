import { Controller, Get, Post, Put, Delete, Param, Body, Query, UseGuards, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { BranchesService, CreateBranchDto, UpdateBranchDto } from './services/branches.service';
import { BranchStatsService } from './services/branch-stats.service';
import { CurrentUser } from '../shared/decorators/current-user.decorator';
import { getVietnamDateString } from '@n-utils';

@ApiTags('Branches')
@Controller('branches')
export class BranchesController {
    constructor(
        private readonly branchesService: BranchesService,
        private readonly branchStatsService: BranchStatsService,
    ) { }

    @Get()
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'List all branches for user' })
    async getBranches(@CurrentUser() user: any) {
        return this.branchesService.getBranches(user.id);
    }

    @Post()
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Create a new branch' })
    async createBranch(
        @CurrentUser() user: any,
        @Body() dto: CreateBranchDto,
    ) {
        return this.branchesService.createBranch(user.id, dto);
    }

    @Get('stats/summary')
    @ApiOperation({ summary: 'Get summary stats for all branches (public)' })
    async getBranchesSummary(
        @Query('dateStart') dateStart?: string,
        @Query('dateEnd') dateEnd?: string,
        @Query('userId') userId?: string,
    ) {
        if (!userId) {
            throw new BadRequestException('userId query param is required');
        }
        const today = getVietnamDateString();
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const defaultStart = thirtyDaysAgo.toISOString().split('T')[0];

        return this.branchStatsService.getBranchesSummary(
            parseInt(userId, 10),
            dateStart || defaultStart,
            dateEnd || today,
        );
    }

    @Get(':id')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Get branch details' })
    async getBranch(
        @Param('id') id: string,
        @CurrentUser() user: any,
    ) {
        return this.branchesService.getBranch(parseInt(id, 10), user.id);
    }

    @Put(':id')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Update a branch' })
    async updateBranch(
        @Param('id') id: string,
        @CurrentUser() user: any,
        @Body() dto: UpdateBranchDto,
    ) {
        return this.branchesService.updateBranch(parseInt(id, 10), user.id, dto);
    }

    @Delete(':id')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Delete a branch' })
    async deleteBranch(
        @Param('id') id: string,
        @CurrentUser() user: any,
    ) {
        return this.branchesService.deleteBranch(parseInt(id, 10), user.id);
    }

    @Get(':id/stats')
    @ApiOperation({ summary: 'Get daily stats for a branch (public)' })
    async getBranchStats(
        @Param('id') id: string,
        @Query('dateStart') dateStart?: string,
        @Query('dateEnd') dateEnd?: string,
    ) {
        const today = getVietnamDateString();
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const defaultStart = thirtyDaysAgo.toISOString().split('T')[0];

        return this.branchStatsService.getBranchStats(
            parseInt(id, 10),
            dateStart || defaultStart,
            dateEnd || today,
        );
    }

    @Post(':id/stats/aggregate')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Manually trigger stats aggregation for a branch' })
    async aggregateBranchStats(
        @Param('id') id: string,
        @CurrentUser() user: any,
        @Body() dto: { date?: string },
    ) {
        // Verify branch ownership
        await this.branchesService.getBranch(parseInt(id, 10), user.id);

        const date = dto.date || getVietnamDateString();
        return this.branchStatsService.aggregateBranchStats(parseInt(id, 10), date);
    }

    @Post('stats/rebuild')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Rebuild branch stats for current user from all historical insights' })
    async rebuildBranchStats(@CurrentUser() user: any) {
        return this.branchStatsService.rebuildStatsForUser(user.id);
    }
}
