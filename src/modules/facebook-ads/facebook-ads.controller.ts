import {
    Controller,
    Get,
    Post,
    Body,
    Query,
    UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RateLimiterService } from '../shared/services/rate-limiter.service';
import { CrawlSchedulerService } from '../cron/services/cron-scheduler.service';
import { InsightsSyncService } from '../insights/services/insights-sync.service';
import { SyncEntitiesDto, SyncInsightsDto } from './dtos';
import { getVietnamDateString } from '@n-utils';
import { PrismaService } from '@n-database/prisma/prisma.service';
@ApiTags('Facebook Ads (Legacy)')
@Controller('fb-ads')
export class FacebookAdsController {
    constructor(
        private readonly rateLimiterService: RateLimiterService,
        private readonly schedulerService: CrawlSchedulerService,
        private readonly insightsSyncService: InsightsSyncService,
        private readonly prisma: PrismaService,
    ) { }

    // ==================== RATE LIMIT ====================

    @Get('rate-limit')
    @ApiOperation({ summary: 'Get current rate limit status' })
    async getRateLimitStatus() {
        return this.rateLimiterService.getAllStates();
    }

    // ==================== ENTITY SYNC (Job Triggers) ====================

    @Post('sync/entities')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Trigger entity sync job (campaigns, adsets, ads, creatives)' })
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

    // ==================== INSIGHTS SYNC (Job Triggers) ====================

    @Post('sync/insights')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Trigger insights sync job for date range' })
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

    // ==================== QUICK HOURLY SYNC (OPTIMIZED) ====================

    @Post('sync/hourly')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Quick sync today\'s hourly insights (optimized, no Telegram)' })
    async syncHourlyQuick(@Body('accountId') accountId?: string) {
        // If accountId provided, sync just that account
        if (accountId) {
            const result = await this.insightsSyncService.syncHourlyInsightsQuick(accountId);
            return {
                success: true,
                message: `Synced ${result.count} hourly insights in ${result.duration}ms`,
                ...result,
            };
        }

        // Otherwise sync all active accounts
        const accounts = await this.prisma.adAccount.findMany({
            where: { accountStatus: 1 },
            select: { id: true, name: true },
        });

        if (accounts.length === 0) {
            return { success: false, message: 'No active ad accounts found' };
        }

        const results = [];
        for (const account of accounts) {
            try {
                const result = await this.insightsSyncService.syncHourlyInsightsQuick(account.id);
                results.push({ accountId: account.id, name: account.name, ...result });
            } catch (error) {
                results.push({ accountId: account.id, name: account.name, error: error.message });
            }
        }

        const totalCount = results.reduce((sum, r) => sum + (r.count || 0), 0);
        const totalDuration = results.reduce((sum, r) => sum + (r.duration || 0), 0);

        return {
            success: true,
            message: `Synced ${totalCount} hourly insights from ${accounts.length} accounts in ${totalDuration}ms`,
            totalCount,
            totalDuration,
            accounts: results,
        };
    }

    @Post('telegram/send-hour-report')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Send Telegram report for current hour (reads from DB, no FB API)' })
    async sendHourTelegramReport() {
        return this.insightsSyncService.sendLatestHourTelegramReport();
    }

    @Post('cleanup-hourly')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Cleanup old hourly insights (older than yesterday)' })
    async cleanupHourlyInsights() {
        const deletedCount = await this.insightsSyncService.cleanupAllOldHourlyInsights();
        return {
            success: true,
            message: `Cleaned up ${deletedCount} old hourly insights`,
            deletedCount,
        };
    }

    // ==================== LEGACY CRON ENDPOINTS (for n8n) ====================
    // NOTE: These are kept for backward compatibility with n8n workflows
    // New code should use /internal/n8n/* endpoints instead

    @Post('cron/sync-campaigns')
    @ApiOperation({ summary: '[n8n Legacy] Sync campaigns from all ACTIVE ad accounts' })
    async cronSyncCampaigns() {
        const accounts = await this.prisma.adAccount.findMany({
            where: { accountStatus: 1 },
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
    @ApiOperation({ summary: '[n8n Legacy] Sync adsets from all ACTIVE campaigns' })
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
    @ApiOperation({ summary: '[n8n Legacy] Sync ads from all ACTIVE adsets' })
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
    @ApiOperation({ summary: '[n8n Legacy] Sync insights from all ACTIVE ads (today)' })
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

    @Post('cron/full-sync')
    @ApiOperation({ summary: '[n8n Legacy] Full sync: entities + 7 days insights for all accounts' })
    async cronFullSync(@Query('days') daysParam?: string) {
        const days = parseInt(daysParam || '7', 10);

        const dateEnd = getVietnamDateString();
        const [year, month, day] = dateEnd.split('-').map(Number);
        const startDate = new Date(year, month - 1, day);
        startDate.setDate(startDate.getDate() - days + 1);
        const dateStart = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')}`;

        const accounts = await this.prisma.adAccount.findMany({
            where: { accountStatus: 1 },
            select: { id: true, name: true },
        });

        if (accounts.length === 0) {
            return {
                success: false,
                message: 'No active ad accounts found. Please add FB account and sync ad accounts first.',
            };
        }

        for (const account of accounts) {
            await this.schedulerService.triggerEntitySync(account.id, 'all');
            await this.schedulerService.triggerInsightsSync(
                account.id,
                dateStart,
                dateEnd,
                'all',
            );
        }

        return {
            success: true,
            message: `Full sync initiated for ${accounts.length} accounts`,
            summary: {
                accounts: accounts.length,
                dateRange: `${dateStart} to ${dateEnd}`,
                days,
            },
            note: 'Using account-level insights sync for better performance.',
        };
    }
}
