import { Controller, Get, Post, Param, Query, Body, UseGuards, ParseIntPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@n-modules/auth/guards/jwt-auth.guard';
import { CurrentUser } from '@n-modules/shared/decorators/current-user.decorator';
import { InsightsQueryService } from './services/insights-query.service';
import { InsightsSyncService } from './services/insights-sync.service';

@ApiTags('Insights (Unified)')
@Controller('insights')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class InsightsController {
  constructor(
    private readonly insightsQuery: InsightsQueryService,
    private readonly insightsSync: InsightsSyncService,
  ) { }

  @Get()
  @ApiOperation({ summary: 'Query daily insights' })
  async getInsights(
    @CurrentUser() user: any,
    @Query('accountId') accountId?: string,
    @Query('dateStart') dateStart?: string,
    @Query('dateEnd') dateEnd?: string,
    @Query('branchId') branchId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.insightsQuery.getDailyInsights(user.id, {
      accountId: accountId ? Number(accountId) : undefined,
      dateStart,
      dateEnd,
      branchId: branchId ? Number(branchId) : undefined,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 50,
    });
  }

  @Post('sync/account/:id')
  @ApiOperation({ summary: 'Sync insights for a platform account' })
  async syncAccount(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { dateStart: string; dateEnd: string; granularity?: 'DAILY' | 'HOURLY' },
    @Query('force') force?: string,
  ) {
    const forceFullSync = force === 'true';
    if (dto.granularity === 'HOURLY') {
      return this.insightsSync.syncAccountHourlyInsights(id, dto.dateStart, dto.dateEnd, forceFullSync);
    }
    return this.insightsSync.syncAccountInsights(id, dto.dateStart, dto.dateEnd, forceFullSync);
  }

  @Post('sync/branch/:id')
  @ApiOperation({ summary: 'Sync all data for a branch (Campaigns, Ads, Insights)' })
  async syncBranch(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { dateStart: string; dateEnd: string; granularity?: 'DAILY' | 'HOURLY' },
    @Query('force') force?: string,
  ) {
    const forceFullSync = force === 'true';
    return this.insightsSync.syncBranch(id, dto.dateStart, dto.dateEnd, dto.granularity || 'DAILY', forceFullSync);
  }
  @Get('ads/:adId/analytics')
  @ApiOperation({ summary: 'Get aggregated analytics for an ad' })
  async getAdAnalytics(
    @CurrentUser('id') userId: number,
    @Param('adId') adId: string,
    @Query('dateStart') dateStart?: string,
    @Query('dateEnd') dateEnd?: string,
  ) {
    return this.insightsQuery.getAdAnalytics(userId, adId, dateStart, dateEnd);
  }

  @Get('ads/:adId/hourly')
  @ApiOperation({ summary: 'Get hourly insights for an ad' })
  async getAdHourly(
    @CurrentUser('id') userId: number,
    @Param('adId') adId: string,
    @Query('date') date?: string,
  ) {
    return this.insightsQuery.getAdHourly(userId, adId, date);
  }

  @Post('sync')
  @ApiOperation({ summary: 'Sync insights for a specific ad' })
  async syncAd(
    @Body() dto: { adId: string; dateStart: string; dateEnd: string; breakdown?: string },
  ) {
    return this.insightsSync.syncAdInsights(dto.adId, dto.dateStart, dto.dateEnd, dto.breakdown);
  }
}
