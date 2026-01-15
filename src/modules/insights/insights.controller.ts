import { Controller, Get, Post, Param, Query, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { InsightsService } from './services/insights.service';
import { CurrentUser } from '../shared/decorators/current-user.decorator';

@ApiTags('Insights')
@Controller('insights')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class InsightsController {
    constructor(private readonly insightsService: InsightsService) { }

    @Get()
    @ApiOperation({ summary: 'Query daily insights' })
    async getInsights(
        @CurrentUser() user: any,
        @Query('accountId') accountId?: string,
        @Query('dateStart') dateStart?: string,
        @Query('dateEnd') dateEnd?: string,
        @Query('branchId') branchId?: string,
    ) {
        return this.insightsService.getDailyInsights(user.id, {
            accountId,
            dateStart,
            dateEnd,
            branchId,
        });
    }

    @Get('ads/:id/analytics')
    @ApiOperation({ summary: 'Get ad analytics with insights and breakdowns' })
    async getAdAnalytics(
        @Param('id') adId: string,
        @CurrentUser() user: any,
        @Query('dateStart') dateStart?: string,
        @Query('dateEnd') dateEnd?: string,
    ) {
        return this.insightsService.getAdAnalytics(adId, user.id, dateStart, dateEnd);
    }

    @Get('ads/:id/hourly')
    @ApiOperation({ summary: 'Get hourly insights for an ad' })
    async getAdHourlyInsights(
        @Param('id') adId: string,
        @CurrentUser() user: any,
        @Query('date') date?: string,
    ) {
        return this.insightsService.getHourlyInsights(adId, user.id, date);
    }

    @Post('sync')
    @ApiOperation({ summary: 'Sync insights for date range' })
    async syncInsights(
        @CurrentUser() user: any,
        @Body() dto: { accountId?: string; adId?: string; dateStart: string; dateEnd: string; breakdown?: string },
    ) {
        if (dto.adId) {
            return this.insightsService.syncInsightsForAd(
                dto.adId,
                user.id,
                dto.dateStart,
                dto.dateEnd,
                dto.breakdown || 'all',
            );
        }

        if (!dto.accountId) {
            throw new Error('Either accountId or adId is required');
        }

        return this.insightsService.syncDailyInsights(
            dto.accountId,
            user.id,
            dto.dateStart,
            dto.dateEnd,
        );
    }
}

