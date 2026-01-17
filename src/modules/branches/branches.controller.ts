import { Controller, Get, Post, Put, Delete, Param, Body, Query, UseGuards, BadRequestException, Inject, forwardRef } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { BranchesService, CreateBranchDto, UpdateBranchDto } from './services/branches.service';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { BranchStatsService } from './services/branch-stats.service';
import { InsightsSyncService } from '../insights/services/insights-sync.service';
import { CurrentUser } from '../shared/decorators/current-user.decorator';
import { getVietnamDateString } from '@n-utils';

@ApiTags('Branches')
@Controller('branches')
export class BranchesController {
    constructor(
        private readonly prisma: PrismaService,
        private readonly branchesService: BranchesService,
        private readonly branchStatsService: BranchStatsService,
        @Inject(forwardRef(() => InsightsSyncService))
        private readonly insightsSyncService: InsightsSyncService,
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

    @Get('stats/dashboard')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Get consolidated dashboard stats (branches + breakdowns) for current user' })
    async getDashboardStats(
        @CurrentUser() user: any,
        @Query('dateStart') dateStart?: string,
        @Query('dateEnd') dateEnd?: string,
    ) {
        const today = getVietnamDateString();
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const defaultStart = thirtyDaysAgo.toISOString().split('T')[0];

        return this.branchStatsService.getDashboardStats(
            user.id,
            dateStart || defaultStart,
            dateEnd || today,
        );
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

    @Get(':code/stats')
    @ApiOperation({ summary: 'Get daily stats for a branch by code (public)' })
    async getBranchStats(
        @Param('code') code: string,
        @Query('userId') userId?: string,
        @Query('dateStart') dateStart?: string,
        @Query('dateEnd') dateEnd?: string,
    ) {
        if (!userId) {
            throw new BadRequestException('userId query param is required');
        }

        const branch = await this.branchesService.getBranchByCode(code, parseInt(userId, 10));

        const today = getVietnamDateString();
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const defaultStart = thirtyDaysAgo.toISOString().split('T')[0];

        const stats = await this.branchStatsService.getBranchStats(
            branch.id,
            dateStart || defaultStart,
            dateEnd || today,
        );

        const daily = stats.map((stat) => {
            const totalSpend = Number(stat.totalSpend);
            const totalImpressions = Number(stat.totalImpressions);
            const totalClicks = Number(stat.totalClicks);
            const totalReach = Number(stat.totalReach);
            const totalResults = Number(stat.totalResults);
            const totalMessaging = Number(stat.totalMessaging);

            const ctr = totalImpressions > 0 ? totalClicks / totalImpressions : 0;
            const cpc = totalClicks > 0 ? totalSpend / totalClicks : 0;
            const cpm = totalImpressions > 0 ? (totalSpend / totalImpressions) * 1000 : 0;
            const cpr = totalResults > 0 ? totalSpend / totalResults : 0;
            const costPerMessage = totalMessaging > 0 ? totalSpend / totalMessaging : 0;

            return {
                date: stat.date.toISOString().split('T')[0],
                totalSpend,
                totalImpressions,
                totalClicks,
                totalReach,
                totalResults,
                totalMessaging,
                ctr,
                cpc,
                cpm,
                cpr,
                costPerMessage,
            };
        });

        const totals = daily.reduce(
            (acc, d) => {
                acc.totalSpend += d.totalSpend;
                acc.totalImpressions += d.totalImpressions;
                acc.totalClicks += d.totalClicks;
                acc.totalReach += d.totalReach;
                acc.totalResults += d.totalResults;
                acc.totalMessaging += d.totalMessaging;
                return acc;
            },
            {
                totalSpend: 0,
                totalImpressions: 0,
                totalClicks: 0,
                totalReach: 0,
                totalResults: 0,
                totalMessaging: 0,
            },
        );

        const ctr =
            totals.totalImpressions > 0 ? totals.totalClicks / totals.totalImpressions : 0;
        const cpc = totals.totalClicks > 0 ? totals.totalSpend / totals.totalClicks : 0;
        const cpm =
            totals.totalImpressions > 0
                ? (totals.totalSpend / totals.totalImpressions) * 1000
                : 0;
        const cpr = totals.totalResults > 0 ? totals.totalSpend / totals.totalResults : 0;
        const costPerMessage =
            totals.totalMessaging > 0 ? totals.totalSpend / totals.totalMessaging : 0;

        return {
            id: branch.id,
            name: branch.name,
            code: branch.code,
            daysWithData: daily.length,
            ...totals,
            ctr,
            cpc,
            cpm,
            cpr,
            costPerMessage,
            daily,
        };
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

    @Get(':id/stats/device')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Get device breakdown stats for a branch' })
    async getBranchDeviceStats(
        @Param('id') id: string,
        @CurrentUser() user: any,
        @Query('dateStart') dateStart: string,
        @Query('dateEnd') dateEnd: string,
    ) {
        await this.branchesService.getBranch(parseInt(id, 10), user.id);
        return this.branchStatsService.getBranchDeviceStats(parseInt(id, 10), dateStart, dateEnd);
    }

    @Get(':id/stats/age-gender')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Get age/gender breakdown stats for a branch' })
    async getBranchAgeGenderStats(
        @Param('id') id: string,
        @CurrentUser() user: any,
        @Query('dateStart') dateStart: string,
        @Query('dateEnd') dateEnd: string,
    ) {
        await this.branchesService.getBranch(parseInt(id, 10), user.id);
        return this.branchStatsService.getBranchAgeGenderStats(parseInt(id, 10), dateStart, dateEnd);
    }

    @Get(':id/stats/region')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Get region breakdown stats for a branch' })
    async getBranchRegionStats(
        @Param('id') id: string,
        @CurrentUser() user: any,
        @Query('dateStart') dateStart: string,
        @Query('dateEnd') dateEnd: string,
    ) {
        await this.branchesService.getBranch(parseInt(id, 10), user.id);
        return this.branchStatsService.getBranchRegionStats(parseInt(id, 10), dateStart, dateEnd);
    }

    @Post('stats/rebuild')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Rebuild branch stats for current user from all historical insights' })
    async rebuildBranchStats(@CurrentUser() user: any) {
        return this.branchStatsService.rebuildStatsForUser(user.id);
    }

    @Post(':id/sync')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Trigger sync (crawl + aggregate) for a branch' })
    async syncBranch(
        @Param('id') id: string,
        @CurrentUser() user: any,
        @Body() dto: { dateStart: string; dateEnd: string },
    ) {
        // Verify branch ownership
        const branchIds = await this.branchesService.getBranches(user.id);
        const hasAccess = branchIds.some(b => b.id === parseInt(id, 10));
        if (!hasAccess) {
             // If getBranches doesn't return ID directly we might need a better check, but existing service methods like getBranch() throw exception if not found/owned
             await this.branchesService.getBranch(parseInt(id, 10), user.id);
        }

        await this.insightsSyncService.syncBranch(
            parseInt(id, 10),
            user.id,
            dto.dateStart,
            dto.dateEnd
        );

        return { success: true, message: 'Branch sync started' };
    }
}
