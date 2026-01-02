import {
    Controller,
    Get,
    Post,
    Delete,
    Body,
    Param,
    Query,
    ParseIntPipe,
    UseGuards,
    Request,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { FbAccountService } from './services/fb-account.service';
import { TokenService } from './services/token.service';
import { CrawlJobService } from './services/crawl-job.service';
import { RateLimiterService } from './services/rate-limiter.service';
import { CrawlSchedulerService } from './jobs/crawl-scheduler.service';
import { TelegramService } from './services/telegram.service';
import { SyncEntitiesDto, SyncInsightsDto } from './dtos';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { getVietnamDateString } from '@n-utils';
import { IsString, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// DTOs for FB Account management
export class AddFbAccountDto {
    @ApiProperty({ description: 'Facebook access token' })
    @IsString()
    accessToken: string;

    @ApiPropertyOptional({ description: 'Name for this FB account' })
    @IsOptional()
    @IsString()
    name?: string;
}

export class AddTokenDto {
    @ApiProperty({ description: 'Facebook access token' })
    @IsString()
    accessToken: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    name?: string;

    @ApiPropertyOptional()
    @IsOptional()
    isDefault?: boolean;
}

@ApiTags('Facebook Ads')
@Controller('fb-ads')
export class FacebookAdsController {
    constructor(
        private readonly fbAccountService: FbAccountService,
        private readonly tokenService: TokenService,
        private readonly crawlJobService: CrawlJobService,
        private readonly rateLimiterService: RateLimiterService,
        private readonly schedulerService: CrawlSchedulerService,
        private readonly telegramService: TelegramService,
        private readonly prisma: PrismaService,
    ) { }

    // ==================== FB ACCOUNTS ====================

    @Post('fb-accounts')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Add new FB account (enter token)' })
    async addFbAccount(@Request() req: any, @Body() dto: AddFbAccountDto) {
        return this.fbAccountService.addFbAccount(req.user.id, dto.accessToken, dto.name);
    }

    @Get('fb-accounts')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'List user FB accounts' })
    async getFbAccounts(@Request() req: any) {
        return this.fbAccountService.getFbAccountsByUser(req.user.id);
    }

    @Get('fb-accounts/:id')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Get FB account details' })
    async getFbAccount(@Param('id', ParseIntPipe) id: number) {
        return this.fbAccountService.getFbAccountWithDetails(id);
    }

    @Delete('fb-accounts/:id')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Delete FB account' })
    async deleteFbAccount(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
        return this.fbAccountService.deleteFbAccount(req.user.id, id);
    }

    @Post('fb-accounts/:id/sync')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Sync ad accounts from FB' })
    async syncAdAccounts(@Param('id', ParseIntPipe) id: number) {
        return this.fbAccountService.syncAdAccounts(id);
    }

    @Post('fb-accounts/:id/tokens')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Add token to FB account' })
    async addToken(@Param('id', ParseIntPipe) id: number, @Body() dto: AddTokenDto) {
        return this.fbAccountService.addToken(id, dto.accessToken, dto.name, dto.isDefault);
    }

    // ==================== ENTITY SYNC ====================

    @Post('sync/entities')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Sync entities (campaigns, adsets, ads, creatives)' })
    async syncEntities(@Body() dto: SyncEntitiesDto) {
        // If adsetId is provided, sync ads for that specific adset
        if (dto.adsetId) {
            await this.schedulerService.triggerAdsSyncByAdset(dto.adsetId);
            return { message: 'Ads sync job queued for adset', adsetId: dto.adsetId };
        }

        // If campaignId is provided, sync adsets for that specific campaign
        if (dto.campaignId) {
            await this.schedulerService.triggerAdsetsSyncByCampaign(dto.campaignId);
            return { message: 'Adsets sync job queued for campaign', campaignId: dto.campaignId };
        }

        // Otherwise sync by accountId as before
        if (!dto.accountId) {
            throw new Error('Either accountId, campaignId, or adsetId is required');
        }
        await this.schedulerService.triggerEntitySync(dto.accountId, dto.entityType || 'all');
        return { message: 'Entity sync job queued', accountId: dto.accountId };
    }

    // ==================== INSIGHTS SYNC ====================

    @Post('sync/insights')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Sync insights for date range' })
    async syncInsights(@Body() dto: SyncInsightsDto) {
        // If adId is provided, sync insights for that specific ad
        if (dto.adId) {
            await this.schedulerService.triggerInsightsSyncByAd(
                dto.adId,
                dto.dateStart,
                dto.dateEnd,
                dto.breakdown || 'all',
            );
            return {
                message: 'Insights sync job queued for ad',
                adId: dto.adId,
                dateRange: `${dto.dateStart} to ${dto.dateEnd}`,
            };
        }

        // Otherwise sync by accountId
        if (!dto.accountId) {
            throw new Error('Either accountId or adId is required');
        }
        await this.schedulerService.triggerInsightsSync(
            dto.accountId,
            dto.dateStart,
            dto.dateEnd,
            dto.breakdown || 'all',
        );
        return {
            message: 'Insights sync job queued',
            accountId: dto.accountId,
            dateRange: `${dto.dateStart} to ${dto.dateEnd}`,
        };
    }

    // ==================== JOBS ====================

    @Get('jobs')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'List recent crawl jobs' })
    async getJobs(@Query('limit') limit?: string) {
        return this.crawlJobService.getRecentJobs(limit ? parseInt(limit) : 50);
    }

    @Get('jobs/:id')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Get crawl job details' })
    async getJob(@Param('id', ParseIntPipe) id: number) {
        return this.crawlJobService.getJob(id);
    }

    // ==================== RATE LIMIT ====================

    @Get('rate-limit')
    @ApiOperation({ summary: 'Get current rate limit status' })
    async getRateLimitStatus() {
        return this.rateLimiterService.getAllStates();
    }

    // ==================== DATA QUERIES ====================

    @Get('accounts')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'List active ad accounts' })
    async getAdAccounts(@Request() req: any) {
        return this.prisma.adAccount.findMany({
            where: {
                fbAccount: { userId: req.user.id },
                accountStatus: 1, // Only ACTIVE accounts
            },
            orderBy: { syncedAt: 'desc' },
        });
    }

    @Get('campaigns')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'List campaigns' })
    async getCampaigns(
        @Request() req: any,
        @Query('accountId') accountId?: string,
        @Query('effectiveStatus') effectiveStatus?: string,
        @Query('search') search?: string,
    ) {
        return this.prisma.campaign.findMany({
            where: {
                ...(accountId && { accountId }),
                ...(effectiveStatus && { effectiveStatus }),
                ...(search && {
                    OR: [
                        { name: { contains: search, mode: 'insensitive' } },
                        { id: { contains: search } },
                    ],
                }),
                account: { fbAccount: { userId: req.user.id } },
            },
            orderBy: { syncedAt: 'desc' },
            take: 100,
        });
    }

    @Get('adsets')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'List adsets' })
    async getAdsets(
        @Request() req: any,
        @Query('accountId') accountId?: string,
        @Query('campaignId') campaignId?: string,
        @Query('effectiveStatus') effectiveStatus?: string,
        @Query('search') search?: string,
    ) {
        return this.prisma.adset.findMany({
            where: {
                ...(accountId && { accountId }),
                ...(campaignId && { campaignId }),
                ...(effectiveStatus && { effectiveStatus }),
                ...(search && {
                    OR: [
                        { name: { contains: search, mode: 'insensitive' } },
                        { id: { contains: search } },
                    ],
                }),
                account: { fbAccount: { userId: req.user.id } },
            },
            orderBy: { syncedAt: 'desc' },
            take: 100,
        });
    }

    @Get('ads')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'List ads' })
    async getAds(
        @Request() req: any,
        @Query('accountId') accountId?: string,
        @Query('adsetId') adsetId?: string,
        @Query('effectiveStatus') effectiveStatus?: string,
        @Query('search') search?: string,
    ) {
        const ads = await this.prisma.ad.findMany({
            where: {
                ...(accountId && { accountId }),
                ...(adsetId && { adsetId }),
                ...(effectiveStatus && { effectiveStatus }),
                ...(search && {
                    OR: [
                        { name: { contains: search, mode: 'insensitive' } },
                        { id: { contains: search } },
                    ],
                }),
                account: { fbAccount: { userId: req.user.id } },
            },
            orderBy: { syncedAt: 'desc' },
            take: 100,
        });

        // Extract creative IDs from ads
        const creativeIds = ads
            .map((ad) => {
                const creative = ad.creative as Record<string, any> | null;
                return creative?.id;
            })
            .filter((id): id is string => !!id);

        // Fetch creatives with thumbnails
        const creatives = await this.prisma.creative.findMany({
            where: { id: { in: creativeIds } },
            select: {
                id: true,
                imageUrl: true,
                thumbnailUrl: true,
            },
        });

        // Create lookup map
        const creativeMap = new Map(creatives.map((c) => [c.id, c]));

        // Map ads to include thumbnailUrl from creative data
        return ads.map((ad) => {
            let thumbnailUrl: string | null = null;
            const creativeJson = ad.creative as Record<string, any> | null;

            // Priority 1: From Creative table (lookup by creative.id)
            if (creativeJson?.id) {
                const creative = creativeMap.get(creativeJson.id);
                if (creative) {
                    thumbnailUrl = creative.thumbnailUrl || creative.imageUrl || null;
                }
            }

            // Priority 2: From embedded creative JSON (fallback)
            if (!thumbnailUrl && creativeJson) {
                thumbnailUrl =
                    creativeJson.thumbnail_url ||
                    creativeJson.image_url ||
                    null;
            }

            return {
                ...ad,
                thumbnailUrl,
            };
        });
    }

    @Get('ads/:id')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Get single ad details' })
    async getAd(@Request() req: any, @Param('id') adId: string) {
        const ad = await this.prisma.ad.findUnique({
            where: { id: adId },
            include: {
                account: { select: { name: true, currency: true } },
                adset: { select: { name: true } },
                campaign: { select: { name: true } },
            },
        });

        if (!ad) {
            return null;
        }

        // Get thumbnail from creative
        let thumbnailUrl: string | null = null;
        const creativeJson = ad.creative as Record<string, any> | null;
        if (creativeJson?.id) {
            const creative = await this.prisma.creative.findUnique({
                where: { id: creativeJson.id },
                select: { thumbnailUrl: true, imageUrl: true },
            });
            if (creative) {
                thumbnailUrl = creative.thumbnailUrl || creative.imageUrl || null;
            }
        }

        return { ...ad, thumbnailUrl };
    }

    @Get('ads/:id/analytics')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Get ad analytics with insights and breakdowns' })
    async getAdAnalytics(
        @Request() req: any,
        @Param('id') adId: string,
        @Query('dateStart') dateStart?: string,
        @Query('dateEnd') dateEnd?: string,
    ) {
        // Default to last 30 days
        const endDate = dateEnd ? new Date(dateEnd) : new Date();
        const startDate = dateStart
            ? new Date(dateStart)
            : new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);

        // Daily insights
        const dailyInsights = await this.prisma.adInsightsDaily.findMany({
            where: {
                adId,
                date: { gte: startDate, lte: endDate },
            },
            orderBy: { date: 'asc' },
        });

        // Summary (aggregate all daily data)
        const summary = {
            totalSpend: 0,
            totalImpressions: 0,
            totalReach: 0,
            totalClicks: 0,
            totalResults: 0,
            totalMessages: 0,
            avgCtr: 0,
            avgCpc: 0,
            avgCpm: 0,
            avgCpr: 0,
            avgCostPerMessage: 0,
        };

        dailyInsights.forEach((day) => {
            summary.totalSpend += Number(day.spend) || 0;
            summary.totalImpressions += Number(day.impressions) || 0;
            summary.totalReach += Number(day.reach) || 0;
            summary.totalClicks += Number(day.clicks) || 0;
            summary.totalResults += Number(day.results) || 0;
            summary.totalMessages += Number(day.messagingStarted) || 0;
        });

        if (summary.totalImpressions > 0) {
            summary.avgCtr = (summary.totalClicks / summary.totalImpressions) * 100;
            summary.avgCpm = (summary.totalSpend / summary.totalImpressions) * 1000;
        }
        if (summary.totalClicks > 0) {
            summary.avgCpc = summary.totalSpend / summary.totalClicks;
        }
        if (summary.totalResults > 0) {
            summary.avgCpr = summary.totalSpend / summary.totalResults;
        }
        if (summary.totalMessages > 0) {
            summary.avgCostPerMessage = summary.totalSpend / summary.totalMessages;
        }

        // Calculate day-over-day growth rates
        // Compare the last 2 days of data (today vs yesterday)
        const growth: Record<string, number | null> = {
            spend: null,
            impressions: null,
            reach: null,
            clicks: null,
            ctr: null,
            cpc: null,
            cpm: null,
            results: null,
            cpr: null,
            messages: null,
            costPerMessage: null,
        };

        if (dailyInsights.length >= 2) {
            // dailyInsights is sorted by date ASC, so last 2 items are yesterday and today
            const today = dailyInsights[dailyInsights.length - 1];
            const yesterday = dailyInsights[dailyInsights.length - 2];

            const calcGrowth = (todayVal: number, yesterdayVal: number): number | null => {
                if (yesterdayVal === 0) return todayVal > 0 ? 100 : null;
                return ((todayVal - yesterdayVal) / yesterdayVal) * 100;
            };

            growth.spend = calcGrowth(Number(today.spend) || 0, Number(yesterday.spend) || 0);
            growth.impressions = calcGrowth(Number(today.impressions) || 0, Number(yesterday.impressions) || 0);
            growth.reach = calcGrowth(Number(today.reach) || 0, Number(yesterday.reach) || 0);
            growth.clicks = calcGrowth(Number(today.clicks) || 0, Number(yesterday.clicks) || 0);
            growth.ctr = calcGrowth(Number(today.ctr) || 0, Number(yesterday.ctr) || 0);
            growth.cpc = calcGrowth(Number(today.cpc) || 0, Number(yesterday.cpc) || 0);
            growth.cpm = calcGrowth(Number(today.cpm) || 0, Number(yesterday.cpm) || 0);
            growth.results = calcGrowth(Number(today.results) || 0, Number(yesterday.results) || 0);
            growth.cpr = calcGrowth(Number(today.costPerResult) || 0, Number(yesterday.costPerResult) || 0);
            growth.messages = calcGrowth(Number(today.messagingStarted) || 0, Number(yesterday.messagingStarted) || 0);
            growth.costPerMessage = calcGrowth(Number(today.costPerMessaging) || 0, Number(yesterday.costPerMessaging) || 0);
        }

        // Device breakdown (aggregate)
        const deviceBreakdown = await this.prisma.adInsightsDeviceDaily.groupBy({
            by: ['devicePlatform'],
            where: { adId, date: { gte: startDate, lte: endDate } },
            _sum: {
                spend: true,
                impressions: true,
                clicks: true,
            },
        });

        // Placement breakdown (aggregate)
        const placementBreakdown = await this.prisma.adInsightsPlacementDaily.groupBy({
            by: ['publisherPlatform', 'platformPosition'],
            where: { adId, date: { gte: startDate, lte: endDate } },
            _sum: {
                spend: true,
                impressions: true,
                clicks: true,
            },
        });

        // Age/Gender breakdown (aggregate)
        const ageGenderBreakdown = await this.prisma.adInsightsAgeGenderDaily.groupBy({
            by: ['age', 'gender'],
            where: { adId, date: { gte: startDate, lte: endDate } },
            _sum: {
                spend: true,
                impressions: true,
                clicks: true,
            },
        });

        return {
            summary: { ...summary, growth },
            dailyInsights: dailyInsights.map((d) => ({
                date: d.date,
                spend: Number(d.spend) || 0,
                impressions: Number(d.impressions) || 0,
                reach: Number(d.reach) || 0,
                clicks: Number(d.clicks) || 0,
                ctr: Number(d.ctr) || 0,
                cpc: Number(d.cpc) || 0,
                cpm: Number(d.cpm) || 0,
                results: Number(d.results) || 0,
                costPerResult: Number(d.costPerResult) || 0,
                qualityRanking: d.qualityRanking,
                engagementRateRanking: d.engagementRateRanking,
            })),
            deviceBreakdown: deviceBreakdown.map((d) => ({
                device: d.devicePlatform,
                spend: Number(d._sum.spend) || 0,
                impressions: Number(d._sum.impressions) || 0,
                clicks: Number(d._sum.clicks) || 0,
            })),
            placementBreakdown: placementBreakdown.map((p) => ({
                platform: p.publisherPlatform,
                position: p.platformPosition,
                spend: Number(p._sum.spend) || 0,
                impressions: Number(p._sum.impressions) || 0,
                clicks: Number(p._sum.clicks) || 0,
            })),
            ageGenderBreakdown: ageGenderBreakdown.map((a) => ({
                age: a.age,
                gender: a.gender,
                spend: Number(a._sum.spend) || 0,
                impressions: Number(a._sum.impressions) || 0,
                clicks: Number(a._sum.clicks) || 0,
            })),
        };
    }

    @Get('ads/:id/hourly')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Get hourly insights for an ad' })
    async getAdHourlyInsights(
        @Request() req: any,
        @Param('id') adId: string,
        @Query('date') date?: string, // YYYY-MM-DD format
    ) {
        // Create Date at UTC midnight for the requested date
        // This ensures PostgreSQL DATE comparison works correctly
        let targetDate: Date;
        
        if (date) {
            // Parse YYYY-MM-DD and create UTC midnight
            targetDate = new Date(`${date}T00:00:00.000Z`);
        } else {
            // Today in Vietnam timezone, at UTC midnight for DB query
            const todayVN = getVietnamDateString();
            targetDate = new Date(`${todayVN}T00:00:00.000Z`);
        }

        // Log for debugging
        console.log(`[Hourly Query] date param: ${date}, targetDate: ${targetDate.toISOString()}`);

        const hourlyInsights = await this.prisma.adInsightsHourly.findMany({
            where: {
                adId,
                date: targetDate, // Exact match at UTC midnight
            },
            orderBy: { hourlyStatsAggregatedByAdvertiserTimeZone: 'asc' },
        });

        console.log(`[Hourly Query] Found ${hourlyInsights.length} records`);

        return hourlyInsights.map((h) => {
            // Extract hour from string like "00:00:00 - 00:59:59"
            const hourString = h.hourlyStatsAggregatedByAdvertiserTimeZone;
            const hour = parseInt(hourString.split(':')[0], 10);

            return {
                hour,
                hourLabel: hourString,
                date: h.date,
                spend: Number(h.spend) || 0,
                impressions: Number(h.impressions) || 0,
                reach: Number(h.reach) || 0,
                clicks: Number(h.clicks) || 0,
                ctr: Number(h.ctr) || 0,
                cpc: Number(h.cpc) || 0,
                cpm: Number(h.cpm) || 0,
                results: Number(h.results) || 0,
                costPerResult: Number(h.costPerResult) || 0,
            };
        });
    }

    @Get('insights')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Query daily insights' })
    async getInsights(
        @Request() req: any,
        @Query('accountId') accountId?: string,
        @Query('dateStart') dateStart?: string,
        @Query('dateEnd') dateEnd?: string,
    ) {
        return this.prisma.adInsightsDaily.findMany({
            where: {
                ...(accountId && { accountId }),
                ...(dateStart && dateEnd && {
                    date: { gte: new Date(dateStart), lte: new Date(dateEnd) },
                }),
                account: { fbAccount: { userId: req.user.id } },
            },
            orderBy: { date: 'desc' },
            take: 100,
        });
    }

    // ==================== TELEGRAM ====================

    @Post('telegram/refresh')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Refresh Telegram chat IDs from getUpdates' })
    async refreshTelegramChatIds() {
        await this.telegramService.refreshChatIds();
        return { success: true, chatIds: this.telegramService.getChatIds() };
    }

    @Post('telegram/add-chat')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Manually add a Telegram chat ID' })
    async addTelegramChatId(@Body('chatId') chatId: string) {
        this.telegramService.addChatId(chatId);
        return { success: true, chatId };
    }

    @Get('telegram/chat-ids')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Get all registered Telegram chat IDs' })
    getTelegramChatIds() {
        return { chatIds: this.telegramService.getChatIds() };
    }

    @Post('telegram/test')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Send test message to all Telegram subscribers' })
    async sendTestTelegram() {
        await this.telegramService.sendInsightsSyncReport({
            accountName: 'Test Account',
            date: getVietnamDateString(),
            adsCount: 10,
            totalSpend: 500000,
            totalImpressions: 50000,
            totalClicks: 1500,
            totalReach: 40000,
            currency: 'VND',
        });
        return { success: true, subscriberCount: this.telegramService.getChatIds().length };
    }

    // ==================== PUBLIC CRON ENDPOINTS (for n8n) ====================
    // No authentication required - designed for external cron services

    @Get('health')
    @ApiOperation({ summary: 'Health check endpoint' })
    async healthCheck() {
        return {
            status: 'ok',
            timestamp: new Date().toISOString(),
            timezone: process.env.TZ || 'Asia/Ho_Chi_Minh',
        };
    }

    @Post('cron/sync-campaigns')
    @ApiOperation({ summary: '[n8n] Sync campaigns from all ACTIVE ad accounts' })
    async cronSyncCampaigns() {
        const accounts = await this.prisma.adAccount.findMany({
            where: { accountStatus: 1 }, // ACTIVE accounts only
            select: { id: true, name: true },
        });

        for (const account of accounts) {
            await this.schedulerService.triggerEntitySync(account.id, 'campaigns');
        }

        return {
            success: true,
            message: `Campaigns sync jobs queued for ${accounts.length} active accounts`,
            accounts: accounts.map(a => ({ id: a.id, name: a.name })),
        };
    }

    @Post('cron/sync-adsets')
    @ApiOperation({ summary: '[n8n] Sync adsets from all ACTIVE campaigns' })
    async cronSyncAdsets() {
        const campaigns = await this.prisma.campaign.findMany({
            where: { effectiveStatus: 'ACTIVE' },
            select: { id: true, name: true, accountId: true },
        });

        for (const campaign of campaigns) {
            await this.schedulerService.triggerAdsetsSyncByCampaign(campaign.id);
        }

        return {
            success: true,
            message: `Adsets sync jobs queued for ${campaigns.length} active campaigns`,
            campaigns: campaigns.map(c => ({ id: c.id, name: c.name })),
        };
    }

    @Post('cron/sync-ads')
    @ApiOperation({ summary: '[n8n] Sync ads from all ACTIVE adsets' })
    async cronSyncAds() {
        const adsets = await this.prisma.adset.findMany({
            where: { effectiveStatus: 'ACTIVE' },
            select: { id: true, name: true, campaignId: true },
        });

        for (const adset of adsets) {
            await this.schedulerService.triggerAdsSyncByAdset(adset.id);
        }

        return {
            success: true,
            message: `Ads sync jobs queued for ${adsets.length} active adsets`,
            adsets: adsets.map(a => ({ id: a.id, name: a.name })),
        };
    }

    @Post('cron/sync-insights')
    @ApiOperation({ summary: '[n8n] Sync insights from all ACTIVE ads (today)' })
    async cronSyncInsights(
        @Query('dateStart') dateStartParam?: string,
        @Query('dateEnd') dateEndParam?: string,
        @Query('breakdown') breakdown?: string,
    ) {
        const today = getVietnamDateString();
        const dateStart = dateStartParam || today;
        const dateEnd = dateEndParam || today;

        const ads = await this.prisma.ad.findMany({
            where: { effectiveStatus: 'ACTIVE' },
            select: { id: true, name: true, accountId: true },
        });

        for (const ad of ads) {
            await this.schedulerService.triggerInsightsSyncByAd(
                ad.id,
                dateStart,
                dateEnd,
                breakdown || 'all',
            );
        }

        return {
            success: true,
            message: `Insights sync jobs queued for ${ads.length} active ads`,
            dateRange: `${dateStart} to ${dateEnd}`,
            breakdown: breakdown || 'all',
            adsCount: ads.length,
        };
    }
}

