import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { TelegramService } from '../notifications/telegram.service';
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

    @Cron('5 2 * * *')
    async syncCampaigns() {
        this.logger.log('[CRON] Starting campaigns sync');
        const accounts = await this.getActiveAccounts();
        for (let i = 0; i < accounts.length; i++) {
            await this.entityQueue.add('sync-campaigns', { accountId: accounts[i].id, entityType: 'campaigns' }, { delay: i * ACCOUNT_DELAY_MS });
        }
    }

    @Cron('10 2 * * *')
    async syncAdsets() {
        this.logger.log('[CRON] Starting adsets sync');
        const accounts = await this.getActiveAccounts();
        for (let i = 0; i < accounts.length; i++) {
            await this.entityQueue.add('sync-adsets', { accountId: accounts[i].id, entityType: 'adsets' }, { delay: i * ACCOUNT_DELAY_MS });
        }
    }

    @Cron('15 2 * * *')
    async syncAds() {
        this.logger.log('[CRON] Starting ads sync');
        const accounts = await this.getActiveAccounts();
        for (let i = 0; i < accounts.length; i++) {
            await this.entityQueue.add('sync-ads', { accountId: accounts[i].id, entityType: 'ads' }, { delay: i * ACCOUNT_DELAY_MS });
        }
    }

    @Cron('20 2 * * *')
    async syncCreatives() {
        this.logger.log('[CRON] Starting creatives sync');
        const accounts = await this.getActiveAccounts();
        for (let i = 0; i < accounts.length; i++) {
            await this.entityQueue.add('sync-creatives', { accountId: accounts[i].id, entityType: 'creatives' }, { delay: i * ACCOUNT_DELAY_MS });
        }
    }

    @Cron('0 0-1,3-23 * * *')
    async syncHourlyInsights() {
        const now = new Date();
        if (now.getMinutes() >= INSIGHTS_SYNC_BUFFER_MINUTE || now.getHours() === ENTITY_SYNC_PAUSE_HOUR) return;

        const today = this.formatDate(now);
        const accounts = await this.getActiveAccounts();

        for (let i = 0; i < accounts.length; i++) {
            await this.insightsQueue.add('sync-insights-hourly', {
                accountId: accounts[i].id,
                dateStart: today,
                dateEnd: today,
                breakdown: 'hourly',
            }, { delay: i * ACCOUNT_DELAY_MS });
        }
    }

    private async getActiveAccounts() {
        return this.prisma.platformAccount.findMany({
            where: { accountStatus: '1' },
            select: { id: true, name: true }
        });
    }

    private formatDate(date: Date): string {
        return date.toISOString().split('T')[0];
    }

    async triggerEntitySync(accountId: number, entityType: string) {
        return this.entityQueue.add('manual-entity-sync', { accountId, entityType: entityType as any });
    }

    async triggerInsightsSync(accountId: number, dateStart: string, dateEnd: string, breakdown?: string) {
        return this.insightsQueue.add('manual-insights-sync', {
            accountId,
            dateStart,
            dateEnd,
            breakdown: (breakdown || 'all') as any,
        });
    }

    async sendDailySummaryToTelegram() {
        const todayStr = this.formatDate(new Date());
        const today = new Date(todayStr);

        const insights = await this.prisma.unifiedInsight.findMany({
            where: { date: today },
            include: { account: true, ad: true },
        });

        if (insights.length === 0) return;

        const totalSpend = insights.reduce((sum, i) => sum + Number(i.spend || 0), 0);
        const totalImpressions = Number(insights.reduce((sum, i) => sum + (i.impressions || 0n), 0n));
        const totalClicks = Number(insights.reduce((sum, i) => sum + (i.clicks || 0n), 0n));

        const topAds = [...insights].sort((a, b) => Number((b.spend || 0)) - Number((a.spend || 0))).slice(0, 5);

        await this.telegramService.sendDailySummary({
            date: todayStr,
            accountsSynced: new Set(insights.map(i => i.platformAccountId)).size,
            totalSpend,
            totalImpressions,
            totalClicks,
            topAds: topAds.map(a => ({
                name: a.ad?.name || a.unifiedAdId || 'Unknown Ad',
                spend: Number(a.spend || 0),
                clicks: Number(a.clicks || 0),
            })),
            currency: 'VND',
        });
    }
}
