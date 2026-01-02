import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PgBossService } from '../../../pgboss/pgboss.service';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { TelegramService } from '../services/telegram.service';
import { EntitySyncJobData } from '../processors/entity.processor';
import { InsightsSyncJobData } from '../processors/insights.processor';
import {
    INSIGHTS_SYNC_BUFFER_MINUTE,
    ENTITY_SYNC_PAUSE_HOUR,
    ACCOUNT_DELAY_MS,
} from '../constants/facebook-api.constants';
import { getVietnamHour, getVietnamMinute, getVietnamDateString } from '@n-utils';

@Injectable()
export class CrawlSchedulerService {
    private readonly logger = new Logger(CrawlSchedulerService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly telegramService: TelegramService,
        private readonly pgBoss: PgBossService,
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
            await this.pgBoss.addJob<EntitySyncJobData>(
                'fb-entity-sync',
                { accountId: accounts[i].id, entityType: 'campaigns' },
                { startAfter: Math.floor(i * ACCOUNT_DELAY_MS / 1000) },
            );
        }
    }

    // 2:10 AM - Sync adsets
    // @Cron('10 2 * * *') // DISABLED: Backend 512MB limit
    async syncAdsets() {
        this.logger.log('[CRON] Starting adsets sync');
        const accounts = await this.getActiveAccounts();

        for (let i = 0; i < accounts.length; i++) {
            await this.pgBoss.addJob<EntitySyncJobData>(
                'fb-entity-sync',
                { accountId: accounts[i].id, entityType: 'adsets' },
                { startAfter: Math.floor(i * ACCOUNT_DELAY_MS / 1000) },
            );
        }
    }

    // 2:15 AM - Sync ads
    // @Cron('15 2 * * *') // DISABLED: Backend 512MB limit
    async syncAds() {
        this.logger.log('[CRON] Starting ads sync');
        const accounts = await this.getActiveAccounts();

        for (let i = 0; i < accounts.length; i++) {
            await this.pgBoss.addJob<EntitySyncJobData>(
                'fb-entity-sync',
                { accountId: accounts[i].id, entityType: 'ads' },
                { startAfter: Math.floor(i * ACCOUNT_DELAY_MS / 1000) },
            );
        }
    }

    // 2:20 AM - Sync creatives
    // @Cron('20 2 * * *') // DISABLED: Backend 512MB limit
    async syncCreatives() {
        this.logger.log('[CRON] Starting creatives sync');
        const accounts = await this.getActiveAccounts();

        for (let i = 0; i < accounts.length; i++) {
            await this.pgBoss.addJob<EntitySyncJobData>(
                'fb-entity-sync',
                { accountId: accounts[i].id, entityType: 'creatives' },
                { startAfter: Math.floor(i * ACCOUNT_DELAY_MS / 1000) },
            );
        }
    }

    // ==================== INSIGHTS SYNC (Hourly, except 2:00 AM) ====================

    // Every hour at :00 (except 2:00 AM)
    // @Cron('0 0-1,3-23 * * *') // DISABLED: Backend 512MB limit
    async syncHourlyInsights() {
        const minute = getVietnamMinute();
        const hour = getVietnamHour();

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

        const today = getVietnamDateString();
        const accounts = await this.getActiveAccounts();

        for (let i = 0; i < accounts.length; i++) {
            await this.pgBoss.addJob<InsightsSyncJobData>(
                'fb-insights-sync',
                {
                    accountId: accounts[i].id,
                    dateStart: today,
                    dateEnd: today,
                    breakdown: 'all',
                },
                { startAfter: Math.floor(i * ACCOUNT_DELAY_MS / 1000) },
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
        // Use local timezone instead of UTC
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    // ==================== MANUAL TRIGGERS ====================

    async triggerEntitySync(accountId: string, entityType: string) {
        return this.pgBoss.addJob<EntitySyncJobData>('fb-entity-sync', {
            accountId,
            entityType: entityType as any,
        });
    }

    async triggerAdsetsSyncByCampaign(campaignId: string) {
        return this.pgBoss.addJob<EntitySyncJobData>('fb-entity-sync', {
            campaignId,
            entityType: 'adsets-by-campaign',
        });
    }

    async triggerAdsSyncByAdset(adsetId: string) {
        return this.pgBoss.addJob<EntitySyncJobData>('fb-entity-sync', {
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
        return this.pgBoss.addJob<InsightsSyncJobData>('fb-insights-sync', {
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
        return this.pgBoss.addJob<InsightsSyncJobData>('fb-insights-sync', {
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
