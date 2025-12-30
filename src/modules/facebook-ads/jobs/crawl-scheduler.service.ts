import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { TelegramService } from '../services/telegram.service';
import { EntitySyncJobData } from '../processors/entity.processor';
import { InsightsSyncJobData } from '../processors/insights.processor';
import {
    INSIGHTS_SYNC_BUFFER_MINUTE,
    ENTITY_SYNC_PAUSE_HOUR,
    ACCOUNT_DELAY_MS,
} from '../constants/facebook-api.constants';

@Injectable()
export class CrawlSchedulerService {
    private readonly logger = new Logger(CrawlSchedulerService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly telegramService: TelegramService,
        @InjectQueue('fb-entity-sync') private readonly entityQueue: Queue<EntitySyncJobData>,
        @InjectQueue('fb-insights-sync') private readonly insightsQueue: Queue<InsightsSyncJobData>,
    ) { }

    // ==================== ENTITY SYNC (Daily staggered) ====================
    // Note: Ad accounts sync is triggered via FbAccountService.syncAdAccounts()
    // These crons only sync campaigns, adsets, ads, creatives

    // 2:05 AM - Sync campaigns
    // @Cron('5 2 * * *') // DISABLED: Backend 512MB limit
    async syncCampaigns() {
        this.logger.log('[CRON] Starting campaigns sync');
        const accounts = await this.getActiveAccounts();

        for (let i = 0; i < accounts.length; i++) {
            await this.entityQueue.add(
                'sync-campaigns',
                { accountId: accounts[i].id, entityType: 'campaigns' },
                { delay: i * ACCOUNT_DELAY_MS },
            );
        }
    }

    // 2:10 AM - Sync adsets
    // @Cron('10 2 * * *') // DISABLED: Backend 512MB limit
    async syncAdsets() {
        this.logger.log('[CRON] Starting adsets sync');
        const accounts = await this.getActiveAccounts();

        for (let i = 0; i < accounts.length; i++) {
            await this.entityQueue.add(
                'sync-adsets',
                { accountId: accounts[i].id, entityType: 'adsets' },
                { delay: i * ACCOUNT_DELAY_MS },
            );
        }
    }

    // 2:15 AM - Sync ads
    // @Cron('15 2 * * *') // DISABLED: Backend 512MB limit
    async syncAds() {
        this.logger.log('[CRON] Starting ads sync');
        const accounts = await this.getActiveAccounts();

        for (let i = 0; i < accounts.length; i++) {
            await this.entityQueue.add(
                'sync-ads',
                { accountId: accounts[i].id, entityType: 'ads' },
                { delay: i * ACCOUNT_DELAY_MS },
            );
        }
    }

    // 2:20 AM - Sync creatives
    // @Cron('20 2 * * *') // DISABLED: Backend 512MB limit
    async syncCreatives() {
        this.logger.log('[CRON] Starting creatives sync');
        const accounts = await this.getActiveAccounts();

        for (let i = 0; i < accounts.length; i++) {
            await this.entityQueue.add(
                'sync-creatives',
                { accountId: accounts[i].id, entityType: 'creatives' },
                { delay: i * ACCOUNT_DELAY_MS },
            );
        }
    }

    // ==================== INSIGHTS SYNC (Hourly, except 2:00 AM) ====================

    // Every hour at :00 (except 2:00 AM)
    // @Cron('0 0-1,3-23 * * *') // DISABLED: Backend 512MB limit
    async syncHourlyInsights() {
        const now = new Date();
        const minute = now.getMinutes();
        const hour = now.getHours();

        // Buffer check - don't start sync after :50
        if (minute >= INSIGHTS_SYNC_BUFFER_MINUTE) {
            this.logger.log('[CRON] Skipping insights sync - in buffer period');
            return;
        }

        // Pause during entity sync hour
        if (hour === ENTITY_SYNC_PAUSE_HOUR) {
            this.logger.log('[CRON] Skipping insights sync - entity sync hour');
            return;
        }

        this.logger.log('[CRON] Starting hourly insights sync');

        const today = this.formatDate(now);
        const accounts = await this.getActiveAccounts();

        for (let i = 0; i < accounts.length; i++) {
            await this.insightsQueue.add(
                'sync-insights-hourly',
                {
                    accountId: accounts[i].id,
                    dateStart: today,
                    dateEnd: today,
                    breakdown: 'all',
                },
                { delay: i * ACCOUNT_DELAY_MS },
            );
        }
    }

    // ==================== HELPERS ====================

    private async getActiveAccounts() {
        return this.prisma.adAccount.findMany({
            where: { accountStatus: 1 }, // ACTIVE
            select: { id: true, name: true },
        });
    }

    private formatDate(date: Date): string {
        return date.toISOString().split('T')[0];
    }

    // ==================== MANUAL TRIGGERS ====================

    async triggerEntitySync(accountId: string, entityType: string) {
        return this.entityQueue.add('manual-entity-sync', {
            accountId,
            entityType: entityType as any,
        });
    }

    async triggerAdsetsSyncByCampaign(campaignId: string) {
        return this.entityQueue.add('sync-adsets-by-campaign', {
            campaignId,
            entityType: 'adsets-by-campaign',
        });
    }

    async triggerAdsSyncByAdset(adsetId: string) {
        return this.entityQueue.add('sync-ads-by-adset', {
            adsetId,
            entityType: 'ads-by-adset',
        });
    }

    async triggerInsightsSync(
        accountId: string,
        dateStart: string,
        dateEnd: string,
        breakdown?: string,
    ) {
        return this.insightsQueue.add('manual-insights-sync', {
            accountId,
            dateStart,
            dateEnd,
            breakdown: breakdown as any,
        });
    }

    async triggerInsightsSyncByAd(
        adId: string,
        dateStart: string,
        dateEnd: string,
        breakdown?: string,
    ) {
        return this.insightsQueue.add('sync-insights-by-ad', {
            adId,
            dateStart,
            dateEnd,
            breakdown: breakdown as any,
        });
    }

    // ==================== TELEGRAM NOTIFICATIONS ====================

    async sendDailySummaryToTelegram() {
        const today = this.formatDate(new Date());

        // Get today's insights summary
        const insights = await this.prisma.adInsightsDaily.findMany({
            where: { date: new Date(today) },
            include: { account: true },
        });

        if (insights.length === 0) {
            return;
        }

        const totalSpend = insights.reduce((sum, i) => sum + Number(i.spend || 0), 0);
        const totalImpressions = insights.reduce((sum, i) => sum + Number(i.impressions || 0), 0);
        const totalClicks = insights.reduce((sum, i) => sum + Number(i.clicks || 0), 0);
        const totalReach = insights.reduce((sum, i) => sum + Number(i.reach || 0), 0);

        // Get top ads by spend
        const topAds = await this.prisma.adInsightsDaily.findMany({
            where: { date: new Date(today) },
            include: { ad: true },
            orderBy: { spend: 'desc' },
            take: 5,
        });

        await this.telegramService.sendDailySummary({
            date: today,
            accountsSynced: new Set(insights.map(i => i.accountId)).size,
            totalSpend,
            totalImpressions,
            totalClicks,
            topAds: topAds.map(a => ({
                name: a.ad?.name || a.adId,
                spend: Number(a.spend || 0),
                clicks: Number(a.clicks || 0),
            })),
            currency: 'VND',
        });
    }
}

