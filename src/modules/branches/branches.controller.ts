import { Controller, Get, Post, Put, Delete, Param, Body, Query, UseGuards, ParseIntPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiSecurity } from '@nestjs/swagger';
import { JwtAuthGuard } from '@n-modules/auth/guards/jwt-auth.guard';
import { InternalApiKeyGuard } from '@n-modules/auth/guards/internal-api-key.guard';
import { BranchesService, CreateBranchDto, UpdateBranchDto } from './services/branches.service';
import { BranchStatsService } from './services/branch-stats.service';
import { CurrentUser } from '@n-modules/shared/decorators/current-user.decorator';

@ApiTags('Branches (Unified)')
@Controller('branches')
@ApiBearerAuth()
export class BranchesController {
    constructor(
        private readonly branchesService: BranchesService,
        private readonly branchStatsService: BranchStatsService,
    ) { }

    @Get()
    @UseGuards(JwtAuthGuard)
    @ApiOperation({ summary: 'List all branches for user' })
    async getBranches(@CurrentUser('id') userId: number) {
        return this.branchesService.getBranches(userId);
    }

    @Post()
    @UseGuards(JwtAuthGuard)
    @ApiOperation({ summary: 'Create a new branch' })
    async createBranch(
        @CurrentUser('id') userId: number,
        @Body() dto: CreateBranchDto,
    ) {
        return this.branchesService.createBranch(userId, dto);
    }



    @Get(':id/stats/device')
    @UseGuards(JwtAuthGuard)
    @ApiOperation({ summary: 'Get device breakdown stats' })
    async getDeviceStats(
        @Param('id', ParseIntPipe) id: number,
        @Query('dateStart') dateStart: string,
        @Query('dateEnd') dateEnd: string,
        @Query('platformCode') platformCode?: string,
    ) {
        // device breakdown usually maps to 'impression_device'
        return this.branchStatsService.getBranchBreakdowns(id, dateStart, dateEnd, 'device', platformCode);
    }

    @Get(':id/stats/age-gender')
    @UseGuards(JwtAuthGuard)
    @ApiOperation({ summary: 'Get age/gender breakdown stats' })
    async getAgeGenderStats(
        @Param('id', ParseIntPipe) id: number,
        @Query('dateStart') dateStart: string,
        @Query('dateEnd') dateEnd: string,
        @Query('platformCode') platformCode?: string,
    ) {
        return this.branchStatsService.getBranchBreakdowns(id, dateStart, dateEnd, 'age-gender', platformCode);
    }

    @Get(':id/stats/region')
    @UseGuards(JwtAuthGuard)
    @ApiOperation({ summary: 'Get region breakdown stats' })
    async getRegionStats(
        @Param('id', ParseIntPipe) id: number,
        @Query('dateStart') dateStart: string,
        @Query('dateEnd') dateEnd: string,
        @Query('platformCode') platformCode?: string,
    ) {
        return this.branchStatsService.getBranchBreakdowns(id, dateStart, dateEnd, 'region', platformCode);
    }

    @Get(':id/stats')
    @UseGuards(InternalApiKeyGuard)
    @ApiOperation({ summary: 'Get consolidated stats for a specific branch (by ID or code)' })
    async getBranchStatsByCode(
        @Param('id') id: string,
        @Query('userId') queryUserId: string, // Mandatory for this public/internal route
        @Query('dateStart') dateStart?: string,
        @Query('dateEnd') dateEnd?: string,
        @Query('platformCode') platformCode?: string,
    ) {
        const today = new Date().toISOString().split('T')[0];
        const defaultStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

        return this.branchStatsService.getBranchStatsByCode(
            Number(queryUserId),
            id,
            dateStart || defaultStart,
            dateEnd || today,
            platformCode
        );
    }

    @Post('stats/rebuild')
    @UseGuards(JwtAuthGuard)
    @ApiOperation({ summary: 'Rebuild branch statistics from insights history' })
    async rebuildStats(@CurrentUser('id') userId: number) {
        return this.branchStatsService.rebuildStats(userId);
    }

    @Get('stats/dashboard')
    @UseGuards(InternalApiKeyGuard)
    @ApiOperation({ summary: 'Get consolidated dashboard stats' })
    async getDashboardStats(
        @Query('userId') queryUserId: string,
        @Query('dateStart') dateStart?: string,
        @Query('dateEnd') dateEnd?: string,
        @Query('platformCode') platformCode?: string,
    ) {
        const today = new Date().toISOString().split('T')[0];
        const defaultStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

        return this.branchStatsService.getDashboardStats(
            Number(queryUserId),
            dateStart || defaultStart,
            dateEnd || today,
            platformCode
        );
    }

    @Post(':id/stats/aggregate')
    @UseGuards(JwtAuthGuard)
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
    @UseGuards(JwtAuthGuard)
    @ApiOperation({ summary: 'Get branch details' })
    async getBranch(
        @Param('id', ParseIntPipe) id: number,
        @CurrentUser('id') userId: number,
    ) {
        return this.branchesService.getBranch(id, userId);
    }

    @Put(':id')
    @UseGuards(JwtAuthGuard)
    @ApiOperation({ summary: 'Update a branch' })
    async updateBranch(
        @Param('id', ParseIntPipe) id: number,
        @CurrentUser('id') userId: number,
        @Body() dto: UpdateBranchDto,
    ) {
        return this.branchesService.updateBranch(id, userId, dto);
    }

    @Delete(':id')
    @UseGuards(JwtAuthGuard)
    @ApiOperation({ summary: 'Delete a branch' })
    async deleteBranch(
        @Param('id', ParseIntPipe) id: number,
        @CurrentUser('id') userId: number,
    ) {
        return this.branchesService.deleteBranch(id, userId);
    }
}
