import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { FacebookApiService } from '../../shared/services/facebook-api.service';
import { CrawlJobService } from '../../jobs/services/crawl-job.service';
import { TelegramService } from '../../telegram/services/telegram.service';
import { CrawlJobType } from '@prisma/client';
import { getVietnamDateString, getVietnamHour, getVietnamMinute } from '@n-utils';
import { TokensService } from '../../tokens/services/tokens.service';

@Injectable()
export class InsightsSyncService {
    private readonly logger = new Logger(InsightsSyncService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly facebookApi: FacebookApiService,
        private readonly tokensService: TokensService,
        private readonly crawlJobService: CrawlJobService,
        private readonly telegramService: TelegramService,
    ) { }

    private parseLocalDate(dateStr: string): Date {
        // Parse as UTC midnight for consistent storage across all environments
        return new Date(`${dateStr}T00:00:00.000Z`);
    }

    /**
     * Hourly insights retention is strictly 2 days (today + yesterday).
     * Clamp any incoming range to avoid accidentally syncing a large historical window.
     */
    private clampHourlyDateRange(dateStart: string, dateEnd: string): { dateStart: string; dateEnd: string; clamped: boolean } {
        const todayStr = getVietnamDateString(); // YYYY-MM-DD
        const today = this.parseLocalDate(todayStr);
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().split('T')[0];

        // Normalize order
        let start = dateStart;
        let end = dateEnd;
        if (end < start) {
            [start, end] = [end, start];
        }

        // Clamp into [yesterday, today]
        const clampedStart = start < yesterdayStr ? yesterdayStr : (start > todayStr ? todayStr : start);
        const clampedEnd = end < yesterdayStr ? yesterdayStr : (end > todayStr ? todayStr : end);

        const clamped = clampedStart !== dateStart || clampedEnd !== dateEnd || (end < start);
        return { dateStart: clampedStart, dateEnd: clampedEnd, clamped };
    }

    // ==================== SYNC BY AD ID ====================

    async syncInsightsForAd(
        adId: string,
        dateStart: string,
        dateEnd: string,
        breakdown: string = 'all',
    ): Promise<number> {
        // Get the ad to find its accountId
        const ad = await this.prisma.ad.findUnique({
            where: { id: adId },
            select: { id: true, accountId: true, adsetId: true, campaignId: true },
        });

        if (!ad) {
            throw new Error(`Ad ${adId} not found`);
        }

        const accountId = ad.accountId;
        // Internal use - called from processors/cron without userId context
        const accessToken = await this.tokensService.getTokenForAdAccountInternal(accountId);
        if (!accessToken) {
            throw new Error(`No valid token for account ${accountId}`);
        }

        const job = await this.crawlJobService.createJob({
            accountId,
            jobType: CrawlJobType.INSIGHTS_DAILY,
            dateStart: new Date(dateStart),
            dateEnd: new Date(dateEnd),
            level: 'ad',
        });

        try {
            await this.crawlJobService.startJob(job.id);
            const now = new Date();

            const insights = await this.facebookApi.getAdInsights(
                adId,
                accessToken,
                dateStart,
                dateEnd,
                undefined,
                accountId,
            );

            // Prepare all insights with proper IDs
            for (const insight of insights) {
                insight.ad_id = ad.id;
                insight.adset_id = ad.adsetId;
                insight.campaign_id = ad.campaignId;
            }

            // Batch upsert daily insights
            if (insights.length > 0) {
                await this.batchUpsertDailyInsights(insights, accountId, now);
            }
            let totalInsights = insights.length;

            // If breakdown is 'all', sync other breakdowns as well
            if (breakdown === 'all') {
                // Sync device insights
                const deviceInsights = await this.facebookApi.getAdInsights(adId, accessToken, dateStart, dateEnd, 'device_platform', accountId);
                for (const insight of deviceInsights) {
                    insight.ad_id = ad.id;
                }
                if (deviceInsights.length > 0) {
                    await this.batchUpsertDeviceInsights(deviceInsights, accountId, now);
                }
                totalInsights += deviceInsights.length;

                // Sync hourly insights
                const hourlyInsights = await this.facebookApi.getAdInsights(adId, accessToken, dateStart, dateEnd, 'hourly_stats_aggregated_by_advertiser_time_zone', accountId);
                for (const insight of hourlyInsights) {
                    insight.ad_id = ad.id;
                }
                if (hourlyInsights.length > 0) {
                    await this.batchUpsertHourlyInsights(hourlyInsights, accountId, now);
                }
                totalInsights += hourlyInsights.length;
            }

            await this.crawlJobService.completeJob(job.id, totalInsights);
            this.logger.log(`Synced ${totalInsights} insights for ad ${adId}`);
            return totalInsights;
        } catch (error) {
            await this.crawlJobService.failJob(job.id, error.message);
            throw error;
        }
    }

    // ==================== DAILY INSIGHTS ====================

    async syncDailyInsights(
        accountId: string,
        dateStart: string,
        dateEnd: string,
    ): Promise<number> {
        // Prevent overlapping INSIGHTS_DAILY jobs for same account
        if (await this.crawlJobService.hasRunningJob(accountId, CrawlJobType.INSIGHTS_DAILY)) {
            this.logger.warn(`[JobSkip] INSIGHTS_DAILY already running for account ${accountId}, skip new daily sync`);
            return 0;
        }

        // Internal use - called from processors/cron without userId context
        const accessToken = await this.tokensService.getTokenForAdAccountInternal(accountId);
        if (!accessToken) {
            throw new Error(`No valid token for account ${accountId}`);
        }

        // Get all active ads for this account
        const ads = await this.prisma.ad.findMany({
            where: { 
                accountId,
                effectiveStatus: 'ACTIVE',
            },
            select: { id: true, adsetId: true, campaignId: true },
        });

        if (ads.length === 0) {
            this.logger.log(`No active ads found for ${accountId}, skipping insights sync`);
            return 0;
        }

        const job = await this.crawlJobService.createJob({
            accountId,
            jobType: CrawlJobType.INSIGHTS_DAILY,
            dateStart: new Date(dateStart),
            dateEnd: new Date(dateEnd),
            level: 'ad',
        });

        try {
            await this.crawlJobService.startJob(job.id);
            const syncedAt = new Date();
            
            // 1. Collect ALL insights first (NO DB writes here)
            const allInsights: any[] = [];

            for (const ad of ads) {
                try {
                    const insights = await this.facebookApi.getAdInsights(
                        ad.id,
                        accessToken,
                        dateStart,
                        dateEnd,
                        undefined,
                        accountId,
                    );

                    for (const insight of insights) {
                        insight.ad_id = ad.id;
                        insight.adset_id = ad.adsetId;
                        insight.campaign_id = ad.campaignId;
                        allInsights.push(insight);
                    }
                } catch (error) {
                    this.logger.warn(`Failed to get insights for ad ${ad.id}: ${error.message}`);
                }
            }

            // 2. BATCH UPSERT all insights
            this.logger.log(`[DailySync] Batch upserting ${allInsights.length} daily insights...`);
            if (allInsights.length > 0) {
                await this.batchUpsertDailyInsights(allInsights, accountId, syncedAt);
            }

            await this.crawlJobService.completeJob(job.id, allInsights.length);
            
            // Cleanup old data
            await this.cleanupOldDailyInsights(accountId);
            await this.crawlJobService.cleanupOldJobs();
            
            this.logger.log(`[DailySync] Done! Saved ${allInsights.length} insights for ${ads.length} ads`);
            return allInsights.length;
        } catch (error) {
            await this.crawlJobService.failJob(job.id, error.message);
            throw error;
        }
    }

    /**
     * Batch upsert daily insights - single transaction for all records
     */
    private async batchUpsertDailyInsights(insights: any[], accountId: string, syncedAt: Date) {
        // Sort to prevent deadlocks (Order: date -> adId)
        insights.sort((a, b) => {
            const dateCompare = a.date_start.localeCompare(b.date_start);
            if (dateCompare !== 0) return dateCompare;
            return a.ad_id.localeCompare(b.ad_id);
        });

        await this.prisma.$transaction(
            insights.map((data) => {
                const date = this.parseLocalDate(data.date_start);
                const adId = data.ad_id;
                const metrics = this.mapInsightMetrics(data);

                return this.prisma.adInsightsDaily.upsert({
                    where: { date_adId: { date, adId } },
                    create: {
                        date,
                        adId,
                        accountId,
                        adsetId: data.adset_id,
                        campaignId: data.campaign_id,
                        ...metrics,
                        syncedAt,
                    },
                    update: {
                        ...metrics,
                        syncedAt,
                    },
                });
            })
        );
    }

    private async sendInsightToTelegram(insight: any, accountName: string, currency: string) {
        const ctr = insight.impressions > 0 
            ? ((insight.clicks / insight.impressions) * 100).toFixed(2) 
            : '0';

        const message = `
📈 <b>Ad Insight - ${insight.date_start}</b>

📊 Account: ${accountName}
🎯 Ad ID: <code>${insight.ad_id}</code>

💰 <b>Metrics:</b>
• Spend: <b>${Number(insight.spend || 0).toLocaleString()} ${currency}</b>
• Impressions: ${Number(insight.impressions || 0).toLocaleString()}
• Reach: ${Number(insight.reach || 0).toLocaleString()}
• Clicks: ${Number(insight.clicks || 0).toLocaleString()}
• CTR: ${ctr}%
`;
        await this.telegramService.sendMessage(message);
    }

    // ==================== DEVICE BREAKDOWN ====================

    async syncDeviceInsights(
        accountId: string,
        dateStart: string,
        dateEnd: string,
    ): Promise<number> {
        // Prevent overlapping INSIGHTS_DEVICE jobs for same account
        if (await this.crawlJobService.hasRunningJob(accountId, CrawlJobType.INSIGHTS_DEVICE)) {
            this.logger.warn(`[JobSkip] INSIGHTS_DEVICE already running for account ${accountId}, skip new device sync`);
            return 0;
        }

        // Internal use - called from processors/cron without userId context
        const accessToken = await this.tokensService.getTokenForAdAccountInternal(accountId);
        if (!accessToken) {
            throw new Error(`No valid token for account ${accountId}`);
        }

        const ads = await this.prisma.ad.findMany({
            where: { accountId, effectiveStatus: 'ACTIVE' },
            select: { id: true },
        });

        if (ads.length === 0) {
            this.logger.log(`No active ads found for ${accountId}, skipping device insights sync`);
            return 0;
        }

        const job = await this.crawlJobService.createJob({
            accountId,
            jobType: CrawlJobType.INSIGHTS_DEVICE,
            dateStart: new Date(dateStart),
            dateEnd: new Date(dateEnd),
            breakdown: 'device_platform',
        });

        try {
            await this.crawlJobService.startJob(job.id);
            const syncedAt = new Date();
            const allInsights: any[] = [];

            for (const ad of ads) {
                try {
                    const insights = await this.facebookApi.getAdInsights(
                        ad.id,
                        accessToken,
                        dateStart,
                        dateEnd,
                        'device_platform',
                        accountId,
                    );

                    for (const insight of insights) {
                        insight.ad_id = ad.id;
                        allInsights.push(insight);
                    }
                } catch (error) {
                    this.logger.warn(`Failed to get device insights for ad ${ad.id}: ${error.message}`);
                }
            }

            // Batch upsert
            this.logger.log(`[DeviceSync] Batch upserting ${allInsights.length} insights...`);
            if (allInsights.length > 0) {
                await this.batchUpsertDeviceInsights(allInsights, accountId, syncedAt);
            }

            await this.crawlJobService.completeJob(job.id, allInsights.length);
            await this.cleanupOldBreakdownInsights(accountId);
            
            this.logger.log(`[DeviceSync] Done! Saved ${allInsights.length} insights`);
            return allInsights.length;
        } catch (error) {
            await this.crawlJobService.failJob(job.id, error.message);
            throw error;
        }
    }

    private async batchUpsertDeviceInsights(insights: any[], accountId: string, syncedAt: Date) {
        // Sort to prevent deadlocks (Order: date -> adId -> device)
        insights.sort((a, b) => {
            const dateCompare = a.date_start.localeCompare(b.date_start);
            if (dateCompare !== 0) return dateCompare;
            const adCompare = a.ad_id.localeCompare(b.ad_id);
            if (adCompare !== 0) return adCompare;
            return (a.device_platform || '').localeCompare(b.device_platform || '');
        });

        await this.prisma.$transaction(
            insights.map((data) => {
                const date = this.parseLocalDate(data.date_start);
                const adId = data.ad_id;
                const devicePlatform = data.device_platform || 'unknown';
                return this.prisma.adInsightsDeviceDaily.upsert({
                    where: { date_adId_devicePlatform: { date, adId, devicePlatform } },
                    create: {
                        date, adId, accountId, devicePlatform,
                        ...this.mapBreakdownMetrics(data), syncedAt,
                    },
                    update: { ...this.mapBreakdownMetrics(data), syncedAt },
                });
            })
        );
    }

    // ==================== PLACEMENT BREAKDOWN ====================

    async syncPlacementInsights(
        accountId: string,
        dateStart: string,
        dateEnd: string,
    ): Promise<number> {
        // Prevent overlapping INSIGHTS_PLACEMENT jobs for same account
        if (await this.crawlJobService.hasRunningJob(accountId, CrawlJobType.INSIGHTS_PLACEMENT)) {
            this.logger.warn(`[JobSkip] INSIGHTS_PLACEMENT already running for account ${accountId}, skip new placement sync`);
            return 0;
        }

        const accessToken = await this.tokensService.getTokenForAdAccountInternal(accountId);
        if (!accessToken) {
            throw new Error(`No valid token for account ${accountId}`);
        }

        const ads = await this.prisma.ad.findMany({
            where: { accountId, effectiveStatus: 'ACTIVE' },
            select: { id: true },
        });

        if (ads.length === 0) {
            return 0;
        }

        const job = await this.crawlJobService.createJob({
            accountId,
            jobType: CrawlJobType.INSIGHTS_PLACEMENT,
            dateStart: new Date(dateStart),
            dateEnd: new Date(dateEnd),
            breakdown: 'publisher_platform,platform_position',
        });

        try {
            await this.crawlJobService.startJob(job.id);
            const syncedAt = new Date();
            const allInsights: any[] = [];

            for (const ad of ads) {
                try {
                    const insights = await this.facebookApi.getAdInsights(
                        ad.id,
                        accessToken,
                        dateStart,
                        dateEnd,
                        'publisher_platform,platform_position',
                        accountId,
                    );

                    for (const insight of insights) {
                        insight.ad_id = ad.id;
                        allInsights.push(insight);
                    }
                } catch (error) {
                    this.logger.warn(`Failed to get placement insights for ad ${ad.id}: ${error.message}`);
                }
            }

            // Batch upsert
            this.logger.log(`[PlacementSync] Batch upserting ${allInsights.length} insights...`);
            if (allInsights.length > 0) {
                await this.batchUpsertPlacementInsights(allInsights, accountId, syncedAt);
            }

            await this.crawlJobService.completeJob(job.id, allInsights.length);
            await this.cleanupOldBreakdownInsights(accountId);
            
            this.logger.log(`[PlacementSync] Done! Saved ${allInsights.length} insights`);
            return allInsights.length;
        } catch (error) {
            await this.crawlJobService.failJob(job.id, error.message);
            throw error;
        }
    }

    private async batchUpsertPlacementInsights(insights: any[], accountId: string, syncedAt: Date) {
        // Sort to prevent deadlocks
        insights.sort((a, b) => {
            const dateCompare = a.date_start.localeCompare(b.date_start);
            if (dateCompare !== 0) return dateCompare;
            const adCompare = a.ad_id.localeCompare(b.ad_id);
            if (adCompare !== 0) return adCompare;
            const pubCompare = (a.publisher_platform || '').localeCompare(b.publisher_platform || '');
            if (pubCompare !== 0) return pubCompare;
            return (a.platform_position || '').localeCompare(b.platform_position || '');
        });

        await this.prisma.$transaction(
            insights.map((data) => {
                const date = this.parseLocalDate(data.date_start);
                const adId = data.ad_id;
                const publisherPlatform = data.publisher_platform || 'unknown';
                const platformPosition = data.platform_position || 'unknown';
                return this.prisma.adInsightsPlacementDaily.upsert({
                    where: { date_adId_publisherPlatform_platformPosition: { date, adId, publisherPlatform, platformPosition } },
                    create: {
                        date, adId, accountId, publisherPlatform, platformPosition,
                        impressionDevice: data.impression_device,
                        ...this.mapBreakdownMetrics(data), syncedAt,
                    },
                    update: { ...this.mapBreakdownMetrics(data), syncedAt },
                });
            })
        );
    }

    // ==================== AGE GENDER BREAKDOWN ====================

    async syncAgeGenderInsights(
        accountId: string,
        dateStart: string,
        dateEnd: string,
    ): Promise<number> {
        // Prevent overlapping INSIGHTS_AGE_GENDER jobs for same account
        if (await this.crawlJobService.hasRunningJob(accountId, CrawlJobType.INSIGHTS_AGE_GENDER)) {
            this.logger.warn(`[JobSkip] INSIGHTS_AGE_GENDER already running for account ${accountId}, skip new age/gender sync`);
            return 0;
        }

        // Internal use - called from processors/cron without userId context
        const accessToken = await this.tokensService.getTokenForAdAccountInternal(accountId);
        if (!accessToken) {
            throw new Error(`No valid token for account ${accountId}`);
        }

        const ads = await this.prisma.ad.findMany({
            where: { accountId, effectiveStatus: 'ACTIVE' },
            select: { id: true },
        });

        if (ads.length === 0) {
            return 0;
        }

        const job = await this.crawlJobService.createJob({
            accountId,
            jobType: CrawlJobType.INSIGHTS_AGE_GENDER,
            dateStart: new Date(dateStart),
            dateEnd: new Date(dateEnd),
            breakdown: 'age,gender',
        });

        try {
            await this.crawlJobService.startJob(job.id);
            const syncedAt = new Date();
            const allInsights: any[] = [];

            for (const ad of ads) {
                try {
                    const insights = await this.facebookApi.getAdInsights(
                        ad.id,
                        accessToken,
                        dateStart,
                        dateEnd,
                        'age,gender',
                        accountId,
                    );

                    for (const insight of insights) {
                        insight.ad_id = ad.id;
                        allInsights.push(insight);
                    }
                } catch (error) {
                    this.logger.warn(`Failed to get age/gender insights for ad ${ad.id}: ${error.message}`);
                }
            }

            // Batch upsert
            this.logger.log(`[AgeGenderSync] Batch upserting ${allInsights.length} insights...`);
            if (allInsights.length > 0) {
                await this.batchUpsertAgeGenderInsights(allInsights, accountId, syncedAt);
            }

            await this.crawlJobService.completeJob(job.id, allInsights.length);
            await this.cleanupOldBreakdownInsights(accountId);
            
            this.logger.log(`[AgeGenderSync] Done! Saved ${allInsights.length} insights`);
            return allInsights.length;
        } catch (error) {
            await this.crawlJobService.failJob(job.id, error.message);
            throw error;
        }
    }

    private async batchUpsertAgeGenderInsights(insights: any[], accountId: string, syncedAt: Date) {
        // Sort: date -> adId -> age -> gender
        insights.sort((a, b) => {
            const dateCompare = a.date_start.localeCompare(b.date_start);
            if (dateCompare !== 0) return dateCompare;
            const adCompare = a.ad_id.localeCompare(b.ad_id);
            if (adCompare !== 0) return adCompare;
            const ageCompare = (a.age || '').localeCompare(b.age || '');
            if (ageCompare !== 0) return ageCompare;
            return (a.gender || '').localeCompare(b.gender || '');
        });

        await this.prisma.$transaction(
            insights.map((data) => {
                const date = this.parseLocalDate(data.date_start);
                const adId = data.ad_id;
                const age = data.age || 'unknown';
                const gender = data.gender || 'unknown';
                return this.prisma.adInsightsAgeGenderDaily.upsert({
                    where: { date_adId_age_gender: { date, adId, age, gender } },
                    create: {
                        date, adId, accountId, age, gender,
                        ...this.mapBreakdownMetrics(data), syncedAt,
                    },
                    update: { ...this.mapBreakdownMetrics(data), syncedAt },
                });
            })
        );
    }

    // ==================== REGION BREAKDOWN ====================

    async syncRegionInsights(
        accountId: string,
        dateStart: string,
        dateEnd: string,
    ): Promise<number> {
        // Prevent overlapping INSIGHTS_REGION jobs for same account
        if (await this.crawlJobService.hasRunningJob(accountId, CrawlJobType.INSIGHTS_REGION)) {
            this.logger.warn(`[JobSkip] INSIGHTS_REGION already running for account ${accountId}, skip new region sync`);
            return 0;
        }

        // Internal use - called from processors/cron without userId context
        const accessToken = await this.tokensService.getTokenForAdAccountInternal(accountId);
        if (!accessToken) {
            throw new Error(`No valid token for account ${accountId}`);
        }

        const ads = await this.prisma.ad.findMany({
            where: { accountId, effectiveStatus: 'ACTIVE' },
            select: { id: true },
        });

        if (ads.length === 0) {
            return 0;
        }

        const job = await this.crawlJobService.createJob({
            accountId,
            jobType: CrawlJobType.INSIGHTS_REGION,
            dateStart: new Date(dateStart),
            dateEnd: new Date(dateEnd),
            breakdown: 'country,region',
        });

        try {
            await this.crawlJobService.startJob(job.id);
            const syncedAt = new Date();
            const allInsights: any[] = [];

            for (const ad of ads) {
                try {
                    const insights = await this.facebookApi.getAdInsights(
                        ad.id,
                        accessToken,
                        dateStart,
                        dateEnd,
                        'country,region',
                        accountId,
                    );

                    for (const insight of insights) {
                        insight.ad_id = ad.id;
                        allInsights.push(insight);
                    }
                } catch (error) {
                    this.logger.warn(`Failed to get region insights for ad ${ad.id}: ${error.message}`);
                }
            }

            // Batch upsert
            this.logger.log(`[RegionSync] Batch upserting ${allInsights.length} insights...`);
            if (allInsights.length > 0) {
                await this.batchUpsertRegionInsights(allInsights, accountId, syncedAt);
            }

            await this.crawlJobService.completeJob(job.id, allInsights.length);
            await this.cleanupOldBreakdownInsights(accountId);
            
            this.logger.log(`[RegionSync] Done! Saved ${allInsights.length} insights`);
            return allInsights.length;
        } catch (error) {
            await this.crawlJobService.failJob(job.id, error.message);
            throw error;
        }
    }

    private async batchUpsertRegionInsights(insights: any[], accountId: string, syncedAt: Date) {
        // Sort: date -> adId -> country -> region
        insights.sort((a, b) => {
            const dateCompare = a.date_start.localeCompare(b.date_start);
            if (dateCompare !== 0) return dateCompare;
            const adCompare = a.ad_id.localeCompare(b.ad_id);
            if (adCompare !== 0) return adCompare;
            const countryCompare = (a.country || '').localeCompare(b.country || '');
            if (countryCompare !== 0) return countryCompare;
            return (a.region || '').localeCompare(b.region || '');
        });

        await this.prisma.$transaction(
            insights.map((data) => {
                const date = this.parseLocalDate(data.date_start);
                const adId = data.ad_id;
                const country = data.country || 'unknown';
                const region = data.region || null;
                return this.prisma.adInsightsRegionDaily.upsert({
                    where: { date_adId_country_region: { date, adId, country, region } },
                    create: {
                        date, adId, accountId, country, region,
                        ...this.mapBreakdownMetrics(data), syncedAt,
                    },
                    update: { ...this.mapBreakdownMetrics(data), syncedAt },
                });
            })
        );
    }

    // ==================== HOURLY BREAKDOWN ====================

    async syncHourlyInsights(
        accountId: string,
        dateStart: string,
        dateEnd: string,
    ): Promise<number> {
        // Prevent overlapping INSIGHTS_HOURLY jobs for same account
        if (await this.crawlJobService.hasRunningJob(accountId, CrawlJobType.INSIGHTS_HOURLY)) {
            this.logger.warn(`[JobSkip] INSIGHTS_HOURLY already running for account ${accountId}, skip new hourly sync`);
            return 0;
        }

        const clamped = this.clampHourlyDateRange(dateStart, dateEnd);
        if (clamped.clamped) {
            this.logger.warn(
                `[HourlySync] Requested range ${dateStart}..${dateEnd} clamped to ${clamped.dateStart}..${clamped.dateEnd} for account ${accountId}`,
            );
        }
        dateStart = clamped.dateStart;
        dateEnd = clamped.dateEnd;

        // Internal use - called from processors/cron without userId context
        const accessToken = await this.tokensService.getTokenForAdAccountInternal(accountId);
        if (!accessToken) {
            throw new Error(`No valid token for account ${accountId}`);
        }

        // Fetch ads with full info for Telegram report
        const ads = await this.prisma.ad.findMany({
            where: { accountId, effectiveStatus: 'ACTIVE' },
            select: {
                id: true,
                name: true,
                previewShareableLink: true,
                adsetId: true,
                campaignId: true,
                adset: { select: { name: true } },
                campaign: { select: { name: true } },
            },
        });

        if (ads.length === 0) {
            return 0;
        }

        const job = await this.crawlJobService.createJob({
            accountId,
            jobType: CrawlJobType.INSIGHTS_HOURLY,
            dateStart: new Date(dateStart),
            dateEnd: new Date(dateEnd),
            breakdown: 'hourly_stats_aggregated_by_advertiser_time_zone',
        });

        try {
            await this.crawlJobService.startJob(job.id);
            const now = new Date();
            let totalInsights = 0;
            const currentHour = getVietnamHour();
            const currentMinute = getVietnamMinute();
            const todayStr = getVietnamDateString();

            // Get account info for telegram message
            const account = await this.prisma.adAccount.findUnique({
                where: { id: accountId },
                select: { name: true, currency: true },
            });

            // Collect insights for the current hour (send partial data even if hour is not complete)
            const currentHourInsights: Array<{
                insight: any;
                adName: string;
                campaignName: string;
                adsetName: string;
                previewLink: string | null;
            }> = [];

            // Collect ALL insights first, then batch upsert to avoid per-row upserts (performance)
            const allInsights: any[] = [];

            for (const ad of ads) {
                try {
                    const insights = await this.facebookApi.getAdInsights(
                        ad.id,
                        accessToken,
                        dateStart,
                        dateEnd,
                        'hourly_stats_aggregated_by_advertiser_time_zone',
                        accountId,
                    );

                    for (const insight of insights) {
                        insight.ad_id = ad.id;
                        insight.adset_id = insight.adset_id ?? ad.adsetId;
                        insight.campaign_id = insight.campaign_id ?? ad.campaignId;

                        allInsights.push(insight);
                        totalInsights++;
                        
                        // Collect for Telegram (current hour of TODAY only)
                        const hourRange = insight.hourly_stats_aggregated_by_advertiser_time_zone;
                        const insightHour = hourRange ? parseInt(hourRange.split(':')[0]) : -1;
                        const insightDate = insight.date_start; // YYYY-MM-DD format
                        
                        // Only collect if: same hour + today's date + has spend
                        if (insightHour === currentHour && insightDate === todayStr && Number(insight.spend || 0) > 0) {
                            currentHourInsights.push({
                                insight,
                                adName: ad.name || ad.id,
                                campaignName: ad.campaign?.name || 'N/A',
                                adsetName: ad.adset?.name || 'N/A',
                                previewLink: ad.previewShareableLink,
                            });
                        }
                    }
                } catch (error) {
                    this.logger.warn(`Failed to get hourly insights for ad ${ad.id}: ${error.message}`);
                }
            }

            // Batch upsert ALL hours to DB (idempotent via unique index)
            if (allInsights.length > 0) {
                await this.batchUpsertHourlyInsights(allInsights, accountId, now);
            }

            // Send consolidated Telegram report for current hour
            this.logger.log(`currentHourInsights count: ${currentHourInsights.length} for hour ${currentHour} (at minute ${currentMinute})`);
            if (currentHourInsights.length > 0) {
                this.logger.log(`Sending Telegram report for ${currentHourInsights.length} ads...`);
                await this.sendConsolidatedHourlyReport(
                    currentHourInsights,
                    account?.name || accountId,
                    account?.currency || 'VND',
                    todayStr,
                    `${currentHour.toString().padStart(2, '0')}:00`,
                );
                this.logger.log(`Telegram report sent!`);
            } else {
                this.logger.log(`No ads with spend > 0 for hour ${currentHour}, skipping Telegram`);
            }

            // Cleanup old hourly insights - only keep today and yesterday
            await this.cleanupOldHourlyInsights(accountId);

            await this.crawlJobService.completeJob(job.id, totalInsights);
            return totalInsights;
        } catch (error) {
            await this.crawlJobService.failJob(job.id, error.message);
            throw error;
        }
    }

    private async sendConsolidatedHourlyReport(
        insightsData: Array<{
            insight: any;
            adName: string;
            campaignName: string;
            adsetName: string;
            previewLink: string | null;
        }>,
        accountName: string,
        currency: string,
        date: string,
        hour: string,
    ) {
        const truncate = (s: string, len: number) => s?.length > len ? s.substring(0, len) + '...' : s;
        const formatNum = (n: number) => n?.toLocaleString('vi-VN') || '0';
        const formatMoney = (n: number) => `${formatNum(n)} ${currency}`;

        // Helper to extract action value from actions array
        const getActionValue = (actions: any[], actionType: string): number => {
            if (!actions || !Array.isArray(actions)) return 0;
            const action = actions.find((a: any) => a.action_type === actionType);
            return action ? Number(action.value || 0) : 0;
        };

        // Helper to extract cost per action from cost_per_action_type array
        const getCostPerAction = (costPerActions: any[], actionType: string): number => {
            if (!costPerActions || !Array.isArray(costPerActions)) return 0;
            const cost = costPerActions.find((c: any) => c.action_type === actionType);
            return cost ? Number(cost.value || 0) : 0;
        };

        // Helper to get total results (messaging + leads + other conversions)
        const getResults = (actions: any[]): number => {
            if (!actions || !Array.isArray(actions)) return 0;
            const messagingTypes = [
                'onsite_conversion.messaging_conversation_started_7d',
                'onsite_conversion.messaging_first_reply',
                'lead',
                'omni_complete_registration',
            ];
            return messagingTypes.reduce((sum, type) => sum + getActionValue(actions, type), 0);
        };

        // Calculate totals
        let totalSpend = 0, totalImpr = 0, totalClicks = 0, totalNewMsg = 0, totalResults = 0;
        for (const { insight } of insightsData) {
            totalSpend += Number(insight.spend || 0);
            totalImpr += Number(insight.impressions || 0);
            totalClicks += Number(insight.clicks || 0);
            totalNewMsg += getActionValue(insight.actions, 'onsite_conversion.messaging_conversation_started_7d');
            totalResults += getResults(insight.actions);
        }
        const totalCtr = totalImpr > 0 ? (totalClicks / totalImpr) * 100 : 0;
        const totalCpc = totalClicks > 0 ? totalSpend / totalClicks : 0;
        const totalCpm = totalImpr > 0 ? (totalSpend / totalImpr) * 1000 : 0;
        const totalCPR = totalResults > 0 ? totalSpend / totalResults : 0;
        const totalCostPerNewMsg = totalNewMsg > 0 ? totalSpend / totalNewMsg : 0;

        // Message 1: Summary/Totals
        let summaryMsg = `📊 <b>HOURLY INSIGHTS - ${date} ${hour}</b>\n\n`;
        summaryMsg += `📈 Account: <b>${accountName}</b>\n`;
        summaryMsg += `🎯 Active Ads: <b>${insightsData.length}</b>\n\n`;
        summaryMsg += `💰 <b>HOUR TOTALS</b>\n`;
        summaryMsg += `├── 💵 Spend: <b>${formatMoney(totalSpend)}</b>\n`;
        summaryMsg += `├── 👁 Impressions: ${formatNum(totalImpr)}\n`;
        summaryMsg += `├── 👆 Clicks: ${formatNum(totalClicks)}\n`;
        summaryMsg += `├── 🎯 Results: <b>${formatNum(totalResults)}</b>\n`;
        summaryMsg += `├── 💬 New Message: <b>${formatNum(totalNewMsg)}</b>\n`;
        summaryMsg += `├── 📊 CTR: ${totalCtr.toFixed(2)}%\n`;
        summaryMsg += `├── 💳 CPC: ${formatMoney(totalCpc)}\n`;
        summaryMsg += `├── 📈 CPM: ${formatMoney(totalCpm)}\n`;
        summaryMsg += `├── 🎯 CPR: <b>${formatMoney(totalCPR)}</b>\n`;
        summaryMsg += `└── 💬 Cost/New Msg: <b>${formatMoney(totalCostPerNewMsg)}</b>`;

        // Extract hour number from hour string (e.g., "07:00" -> 7)
        const hourNumber = parseInt(hour.split(':')[0], 10);
        await this.telegramService.sendMessageWithHour(summaryMsg, hourNumber);

        // Sort ads by spend and send each ad as separate message
        const sortedAds = [...insightsData].sort((a, b) => 
            Number(b.insight.spend || 0) - Number(a.insight.spend || 0)
        );

        const top10Ads = sortedAds.slice(0, 10);
        for (const { insight, adName, campaignName, adsetName, previewLink } of top10Ads) {
            const spend = Number(insight.spend || 0);
            const impr = Number(insight.impressions || 0);
            const clicks = Number(insight.clicks || 0);
            const results = getResults(insight.actions);
            const newMsg = getActionValue(insight.actions, 'onsite_conversion.messaging_conversation_started_7d');
            const cpr = getCostPerAction(insight.cost_per_action_type, 'onsite_conversion.messaging_conversation_started_7d') || (results > 0 ? spend / results : 0);
            const costPerNewMsg = getCostPerAction(insight.cost_per_action_type, 'onsite_conversion.messaging_conversation_started_7d');
            const ctr = impr > 0 ? (clicks / impr) * 100 : 0;
            const cpc = clicks > 0 ? spend / clicks : 0;
            const cpm = impr > 0 ? (spend / impr) * 1000 : 0;

            let adMsg = `📊 <b>AD INSIGHT - ${date} ${hour}</b>\n\n`;
            adMsg += `📈 Account: ${accountName}\n`;
            adMsg += `📁 Campaign: ${campaignName}\n`;
            adMsg += `📂 Adset: ${adsetName}\n`;
            adMsg += `🎯 Ad: ${adName}\n\n`;
            adMsg += `💰 <b>METRICS</b>\n`;
            adMsg += `├── 💵 Spend: <b>${formatMoney(spend)}</b>\n`;
            adMsg += `├── 👁 Impressions: ${formatNum(impr)}\n`;
            adMsg += `├── 👆 Clicks: ${formatNum(clicks)}\n`;
            adMsg += `├── 🎯 Results: <b>${formatNum(results)}</b>\n`;
            adMsg += `├── 💬 New Message: <b>${formatNum(newMsg)}</b>\n`;
            adMsg += `├── 📊 CTR: ${ctr.toFixed(2)}%\n`;
            adMsg += `├── 💳 CPC: ${formatMoney(cpc)}\n`;
            adMsg += `├── 📈 CPM: ${formatMoney(cpm)}\n`;
            adMsg += `├── 🎯 CPR: <b>${formatMoney(cpr)}</b>\n`;
            adMsg += `└── 💬 Cost/New Msg: <b>${formatMoney(costPerNewMsg)}</b>`;
            
            if (previewLink) {
                adMsg += `\n\n🔗 <a href="${previewLink}">Preview Ad</a>`;
            }

            // Extract hour number from hour string (e.g., "07:00" -> 7)
            const hourNumber = parseInt(hour.split(':')[0], 10);
            await this.telegramService.sendMessageWithHour(adMsg, hourNumber);
        }

        // Notify if there are more ads
        if (sortedAds.length > 10) {
            const hourNumber = parseInt(hour.split(':')[0], 10);
            await this.telegramService.sendMessageWithHour(`\n➕ Còn <b>${sortedAds.length - 10}</b> ads khác có chi tiêu trong giờ này.`, hourNumber);
        }
    }

    // ==================== QUICK HOURLY SYNC (OPTIMIZED) ====================

    /**
     * Quick sync of today's hourly insights only - OPTIMIZED VERSION
     * - Only syncs today's data
     * - Uses SINGLE account-level API call (instead of per-ad calls)
     * - Uses batch transaction for faster DB writes
     * - No Telegram sending (decoupled)
     */
    async syncHourlyInsightsQuick(accountId: string): Promise<{ count: number; duration: number }> {
        const startTime = Date.now();
        const today = getVietnamDateString();
        
        // Internal use - called from processors/cron without userId context
        const accessToken = await this.tokensService.getTokenForAdAccountInternal(accountId);
        if (!accessToken) {
            throw new Error(`No valid token for account ${accountId}`);
        }

        this.logger.log(`[QuickSync] Fetching hourly insights for account ${accountId} using account-level API...`);

        const syncedAt = new Date();

        // OPTIMIZED: Single API call at account level instead of per-ad
        // This reduces API calls from O(n) to O(1), dramatically improving performance
        let allInsights: any[] = [];
        try {
            allInsights = await this.facebookApi.getInsights(
                accountId,
                accessToken,
                today,
                today,
                'ad',
                'hourly_stats_aggregated_by_advertiser_time_zone',
            );
        } catch (error) {
            this.logger.error(`[QuickSync] Failed to fetch insights for account ${accountId}: ${error.message}`);
            return { count: 0, duration: Date.now() - startTime };
        }

        if (allInsights.length === 0) {
            this.logger.log(`[QuickSync] No insights returned for account ${accountId}`);
            return { count: 0, duration: Date.now() - startTime };
        }

        this.logger.log(`[QuickSync] Collected ${allInsights.length} insights in single API call, batch saving to DB...`);

        // 2. BATCH UPSERT in single transaction
        await this.batchUpsertHourlyInsights(allInsights, accountId, syncedAt);

        // 3. Cleanup old data
        await this.cleanupOldHourlyInsights(accountId);

        const duration = Date.now() - startTime;
        this.logger.log(`[QuickSync] Done! Saved ${allInsights.length} insights in ${duration}ms`);

        return { count: allInsights.length, duration };
    }

    /**
     * Batch upsert hourly insights - single transaction for all records
     */
    private async batchUpsertHourlyInsights(insights: any[], accountId: string, syncedAt: Date) {
        // Sort: date -> adId -> hourlyStats
        insights.sort((a, b) => {
            const dateCompare = a.date_start.localeCompare(b.date_start);
            if (dateCompare !== 0) return dateCompare;
            const adCompare = a.ad_id.localeCompare(b.ad_id);
            if (adCompare !== 0) return adCompare;
            return (a.hourly_stats_aggregated_by_advertiser_time_zone || '')
                .localeCompare(b.hourly_stats_aggregated_by_advertiser_time_zone || '');
        });

        await this.prisma.$transaction(
            insights.map((data) => {
                const date = this.parseLocalDate(data.date_start);
                const adId = data.ad_id;
                const hourlyStats = data.hourly_stats_aggregated_by_advertiser_time_zone || '00:00:00 - 00:59:59';
                const metrics = this.mapInsightMetrics(data);

                return this.prisma.adInsightsHourly.upsert({
                    where: {
                        date_adId_hourlyStatsAggregatedByAdvertiserTimeZone: {
                            date,
                            adId,
                            hourlyStatsAggregatedByAdvertiserTimeZone: hourlyStats,
                        },
                    },
                    create: {
                        date,
                        adId,
                        adsetId: data.adset_id,
                        campaignId: data.campaign_id,
                        accountId,
                        hourlyStatsAggregatedByAdvertiserTimeZone: hourlyStats,
                        ...metrics,
                        syncedAt,
                    },
                    update: {
                        ...metrics,
                        syncedAt,
                    },
                });
            })
        );
    }

    /**
     * Get latest hour's insights from DB for Telegram report
     * Does NOT call Facebook API - just reads from DB
     */
    async getLatestHourInsights(hour?: number): Promise<{
        insights: Array<{
            insight: any;
            adName: string;
            campaignName: string;
            adsetName: string;
            previewLink: string | null;
        }>;
        accountName: string;
        currency: string;
        date: string;
        hour: string;
    } | null> {
        const todayStr = getVietnamDateString();
        const today = this.parseLocalDate(todayStr);
        
        let targetHour = hour;
        let rawInsights: any[] = [];
        
        // If hour is specified, use it directly
        if (targetHour !== undefined) {
            const hourString = targetHour.toString().padStart(2, '0');
            const hourlyTimeZone = `${hourString}:00:00 - ${hourString}:59:59`;
            
            rawInsights = await this.prisma.adInsightsHourly.findMany({
                where: {
                    date: today,
                    hourlyStatsAggregatedByAdvertiserTimeZone: hourlyTimeZone,
                    spend: { gt: 0 },
                },
                orderBy: { spend: 'desc' },
            });
        }
        
        // If no insights found for specified hour, or hour not specified, find latest hour with data
        if (rawInsights.length === 0) {
            // Find the latest hour that has insights data (even if it's from previous hour due to crawl delay)
            const latestInsight = await this.prisma.adInsightsHourly.findFirst({
                where: {
                    date: today,
                    spend: { gt: 0 },
                },
                orderBy: { syncedAt: 'desc' },
                select: {
                    hourlyStatsAggregatedByAdvertiserTimeZone: true,
                },
            });
            
            if (latestInsight && latestInsight.hourlyStatsAggregatedByAdvertiserTimeZone) {
                // Extract hour from timezone string (format: "HH:00:00 - HH:59:59")
                const hourMatch = latestInsight.hourlyStatsAggregatedByAdvertiserTimeZone.match(/^(\d{2}):00:00/);
                if (hourMatch) {
                    targetHour = parseInt(hourMatch[1], 10);
                    const hourString = targetHour.toString().padStart(2, '0');
                    const hourlyTimeZone = `${hourString}:00:00 - ${hourString}:59:59`;
                    
                    rawInsights = await this.prisma.adInsightsHourly.findMany({
                        where: {
                            date: today,
                            hourlyStatsAggregatedByAdvertiserTimeZone: hourlyTimeZone,
                            spend: { gt: 0 },
                        },
                        orderBy: { spend: 'desc' },
                    });
                }
            }
        }
        
        // If still no insights, try previous hour (in case crawl is delayed)
        if (rawInsights.length === 0 && targetHour !== undefined) {
            const previousHour = targetHour > 0 ? targetHour - 1 : 23;
            const hourString = previousHour.toString().padStart(2, '0');
            const hourlyTimeZone = `${hourString}:00:00 - ${hourString}:59:59`;
            
            rawInsights = await this.prisma.adInsightsHourly.findMany({
                where: {
                    date: today,
                    hourlyStatsAggregatedByAdvertiserTimeZone: hourlyTimeZone,
                    spend: { gt: 0 },
                },
                orderBy: { spend: 'desc' },
            });
            
            if (rawInsights.length > 0) {
                targetHour = previousHour;
            }
        }

        if (rawInsights.length === 0) {
            return null;
        }
        
        const hourString = (targetHour !== undefined ? targetHour : getVietnamHour()).toString().padStart(2, '0');

        // Get ad details
        const adIds = [...new Set(rawInsights.map(i => i.adId))];
        const ads = await this.prisma.ad.findMany({
            where: { id: { in: adIds } },
            select: {
                id: true,
                name: true,
                previewShareableLink: true,
                adset: { select: { name: true } },
                campaign: { select: { name: true } },
                account: { select: { name: true, currency: true } },
            },
        });
        const adMap = new Map(ads.map(a => [a.id, a]));

        // Format insights
        const insights = rawInsights.map(insight => {
            const ad = adMap.get(insight.adId);
            return {
                insight: {
                    ad_id: insight.adId,
                    spend: insight.spend,
                    impressions: insight.impressions,
                    reach: insight.reach,
                    clicks: insight.clicks,
                    ctr: insight.ctr,
                    cpc: insight.cpc,
                    cpm: insight.cpm,
                    results: insight.results,
                    costPerResult: insight.costPerResult,
                    messagingStarted: insight.messagingStarted,
                    costPerMessaging: insight.costPerMessaging,
                },
                adName: ad?.name || insight.adId,
                campaignName: ad?.campaign?.name || 'N/A',
                adsetName: ad?.adset?.name || 'N/A',
                previewLink: ad?.previewShareableLink || null,
            };
        });

        // Get account info from first ad
        const firstAd = ads[0];
        
        return {
            insights,
            accountName: firstAd?.account?.name || 'Unknown',
            currency: firstAd?.account?.currency || 'VND',
            date: todayStr,
            hour: `${hourString}:00`,
        };
    }

    /**
     * Send Telegram report for latest hour (reads from DB, no FB API call)
     * @param hour Optional hour to check (0-23). If not provided, uses current hour
     */
    async sendLatestHourTelegramReport(hour?: number): Promise<{ success: boolean; message: string }> {
        const data = await this.getLatestHourInsights(hour);
        
        if (!data || data.insights.length === 0) {
            const hourStr = hour !== undefined ? `${hour.toString().padStart(2, '0')}:00` : `${getVietnamHour()}:00`;
            return { 
                success: false, 
                message: `No insights with spend > 0 for hour ${hourStr}` 
            };
        }

        await this.sendConsolidatedHourlyReport(
            data.insights,
            data.accountName,
            data.currency,
            data.date,
            data.hour,
        );

        return { 
            success: true, 
            message: `Sent Telegram report for ${data.insights.length} ads at ${data.date} ${data.hour}` 
        };
    }

    // ==================== SYNC ALL INSIGHTS ====================

    async syncAllInsights(
        accountId: string,
        dateStart: string,
        dateEnd: string,
    ): Promise<void> {
        this.logger.log(`Syncing all insights for ${accountId}: ${dateStart} to ${dateEnd}`);

        await this.syncDailyInsights(accountId, dateStart, dateEnd);
        await this.syncDeviceInsights(accountId, dateStart, dateEnd);
        await this.syncPlacementInsights(accountId, dateStart, dateEnd);
        await this.syncAgeGenderInsights(accountId, dateStart, dateEnd);
        await this.syncRegionInsights(accountId, dateStart, dateEnd);
        await this.syncHourlyInsights(accountId, dateStart, dateEnd);

        this.logger.log(`Completed all insights sync for ${accountId}`);
    }

    // ==================== UPSERT METHODS ====================

    private async upsertDailyInsight(data: any, accountId: string, syncedAt: Date) {
        const date = this.parseLocalDate(data.date_start);
        const adId = data.ad_id;

        await this.prisma.adInsightsDaily.upsert({
            where: { date_adId: { date, adId } },
            create: {
                date,
                adId,
                accountId,
                adsetId: data.adset_id,
                campaignId: data.campaign_id,
                ...this.mapInsightMetrics(data),
                syncedAt,
            },
            update: {
                ...this.mapInsightMetrics(data),
                syncedAt,
            },
        });
    }

    private async upsertDeviceInsight(data: any, accountId: string, syncedAt: Date) {
        const date = this.parseLocalDate(data.date_start);
        const adId = data.ad_id;
        const devicePlatform = data.device_platform || 'unknown';

        await this.prisma.adInsightsDeviceDaily.upsert({
            where: { date_adId_devicePlatform: { date, adId, devicePlatform } },
            create: {
                date,
                adId,
                accountId,
                devicePlatform,
                ...this.mapBreakdownMetrics(data),
                syncedAt,
            },
            update: {
                ...this.mapBreakdownMetrics(data),
                syncedAt,
            },
        });
    }

    private async upsertPlacementInsight(data: any, accountId: string, syncedAt: Date) {
        const date = this.parseLocalDate(data.date_start);
        const adId = data.ad_id;
        const publisherPlatform = data.publisher_platform || 'unknown';
        const platformPosition = data.platform_position || 'unknown';

        await this.prisma.adInsightsPlacementDaily.upsert({
            where: {
                date_adId_publisherPlatform_platformPosition: {
                    date,
                    adId,
                    publisherPlatform,
                    platformPosition,
                },
            },
            create: {
                date,
                adId,
                accountId,
                publisherPlatform,
                platformPosition,
                impressionDevice: data.impression_device,
                ...this.mapBreakdownMetrics(data),
                syncedAt,
            },
            update: {
                impressionDevice: data.impression_device,
                ...this.mapBreakdownMetrics(data),
                syncedAt,
            },
        });
    }

    private async upsertAgeGenderInsight(data: any, accountId: string, syncedAt: Date) {
        const date = this.parseLocalDate(data.date_start);
        const adId = data.ad_id;
        const age = data.age || 'unknown';
        const gender = data.gender || 'unknown';

        await this.prisma.adInsightsAgeGenderDaily.upsert({
            where: { date_adId_age_gender: { date, adId, age, gender } },
            create: {
                date,
                adId,
                accountId,
                age,
                gender,
                ...this.mapBreakdownMetrics(data),
                syncedAt,
            },
            update: {
                ...this.mapBreakdownMetrics(data),
                syncedAt,
            },
        });
    }

    private async upsertRegionInsight(data: any, accountId: string, syncedAt: Date) {
        const date = this.parseLocalDate(data.date_start);
        const adId = data.ad_id;
        const country = data.country || 'unknown';
        const region = data.region || null;

        await this.prisma.adInsightsRegionDaily.upsert({
            where: { date_adId_country_region: { date, adId, country, region } },
            create: {
                date,
                adId,
                accountId,
                country,
                region,
                ...this.mapBreakdownMetrics(data),
                syncedAt,
            },
            update: {
                ...this.mapBreakdownMetrics(data),
                syncedAt,
            },
        });
    }

    private async upsertHourlyInsight(data: any, accountId: string, syncedAt: Date) {
        const date = this.parseLocalDate(data.date_start);
        const adId = data.ad_id;
        const hourlyStats = data.hourly_stats_aggregated_by_advertiser_time_zone || '00:00:00 - 00:59:59';

        // Map essential metrics only
        const metrics = this.mapInsightMetrics(data);

        await this.prisma.adInsightsHourly.upsert({
            where: {
                date_adId_hourlyStatsAggregatedByAdvertiserTimeZone: {
                    date,
                    adId,
                    hourlyStatsAggregatedByAdvertiserTimeZone: hourlyStats,
                },
            },
            create: {
                date,
                adId,
                adsetId: data.adset_id,
                campaignId: data.campaign_id,
                accountId,
                hourlyStatsAggregatedByAdvertiserTimeZone: hourlyStats,
                ...metrics,
                syncedAt,
            },
            update: {
                ...metrics,
                syncedAt,
            },
        });
    }

    /**
     * Cleanup old hourly insights - only keep today and yesterday
     * This prevents database from growing too large
     */
    private async cleanupOldHourlyInsights(accountId: string): Promise<number> {
        // Get today's date in Vietnam timezone (local midnight)
        const todayStr = getVietnamDateString();
        const today = this.parseLocalDate(todayStr);
        
        // Calculate yesterday
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().split('T')[0];

        // Delete all hourly insights older than yesterday
        const result = await this.prisma.adInsightsHourly.deleteMany({
            where: {
                accountId,
                date: {
                    lt: yesterday,
                },
            },
        });

        this.logger.log(
            `[HourlyCleanup] account=${accountId} keepWindow=${yesterdayStr}..${todayStr} deleted=${result.count}`,
        );

        return result.count;
    }

    /**
     * GLOBAL cleanup - cleans ALL accounts' old hourly insights
     * Call this from a scheduled cron to ensure no orphan data remains
     */
    async cleanupAllOldHourlyInsights(): Promise<number> {
        const todayStr = getVietnamDateString();
        const today = this.parseLocalDate(todayStr);
        
        // Calculate yesterday
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().split('T')[0];

        // Delete ALL hourly insights older than yesterday (no accountId filter)
        const result = await this.prisma.adInsightsHourly.deleteMany({
            where: {
                date: {
                    lt: yesterday,
                },
            },
        });

        this.logger.log(
            `[GlobalHourlyCleanup] keepWindow=${yesterdayStr}..${todayStr} deleted=${result.count}`,
        );

        return result.count;
    }

    /**
     * Cleanup old daily insights - keep only last 7 days
     * This prevents database from growing too large for Supabase free tier
     */
    private async cleanupOldDailyInsights(accountId: string): Promise<number> {
        const todayStr = getVietnamDateString();
        const today = this.parseLocalDate(todayStr);
        
        // Calculate cutoff date (7 days ago)
        const cutoffDate = new Date(today);
        cutoffDate.setDate(cutoffDate.getDate() - 7);

        const result = await this.prisma.adInsightsDaily.deleteMany({
            where: {
                accountId,
                date: {
                    lt: cutoffDate,
                },
            },
        });

        if (result.count > 0) {
            this.logger.log(`Cleaned up ${result.count} old daily insights for account ${accountId} (keeping last 7 days)`);
        }

        return result.count;
    }

    /**
     * Cleanup old breakdown insights - keep only last 7 days
     * Breakdowns (Device, Placement, AgeGender, Region) are less critical for long-term analysis
     */
    private async cleanupOldBreakdownInsights(accountId: string): Promise<number> {
        const todayStr = getVietnamDateString();
        const today = this.parseLocalDate(todayStr);
        
        // Calculate cutoff date (7 days ago)
        const cutoffDate = new Date(today);
        cutoffDate.setDate(cutoffDate.getDate() - 7);

        let totalDeleted = 0;

        // Device insights
        const deviceResult = await this.prisma.adInsightsDeviceDaily.deleteMany({
            where: {
                accountId,
                date: { lt: cutoffDate },
            },
        });
        totalDeleted += deviceResult.count;

        // Placement insights
        const placementResult = await this.prisma.adInsightsPlacementDaily.deleteMany({
            where: {
                accountId,
                date: { lt: cutoffDate },
            },
        });
        totalDeleted += placementResult.count;

        // Age/Gender insights
        const ageGenderResult = await this.prisma.adInsightsAgeGenderDaily.deleteMany({
            where: {
                accountId,
                date: { lt: cutoffDate },
            },
        });
        totalDeleted += ageGenderResult.count;

        // Region insights
        const regionResult = await this.prisma.adInsightsRegionDaily.deleteMany({
            where: {
                accountId,
                date: { lt: cutoffDate },
            },
        });
        totalDeleted += regionResult.count;

        if (totalDeleted > 0) {
            this.logger.log(`Cleaned up ${totalDeleted} old breakdown insights for account ${accountId} (keeping last 7 days)`);
        }

        return totalDeleted;
    }



    // ==================== MAPPERS ====================

    /**
     * Map only essential insight metrics (optimized)
     */
    private mapInsightMetrics(data: any) {
        // Helper to extract action value from actions array
        const getActionValue = (actions: any[], actionType: string): number => {
            if (!actions || !Array.isArray(actions)) return 0;
            const action = actions.find((a: any) => a.action_type === actionType);
            return action ? Number(action.value || 0) : 0;
        };

        // Helper to extract cost per action
        const getCostPerAction = (costPerActions: any[], actionType: string): number => {
            if (!costPerActions || !Array.isArray(costPerActions)) return 0;
            const cost = costPerActions.find((c: any) => c.action_type === actionType);
            return cost ? Number(cost.value || 0) : 0;
        };

        // Helper to get total results (messaging + leads + registrations)
        const getResults = (actions: any[]): number => {
            if (!actions || !Array.isArray(actions)) return 0;
            const resultTypes = [
                'onsite_conversion.messaging_conversation_started_7d',
                'onsite_conversion.messaging_first_reply',
                'lead',
                'omni_complete_registration',
            ];
            return resultTypes.reduce((sum, type) => sum + getActionValue(actions, type), 0);
        };

        // Extract messaging metrics
        const messagingStarted = getActionValue(data.actions, 'onsite_conversion.messaging_conversation_started_7d');
        const costPerMessaging = getCostPerAction(data.cost_per_action_type, 'onsite_conversion.messaging_conversation_started_7d');
        const results = getResults(data.actions);
        const spend = Number(data.spend || 0);
        const costPerResult = results > 0 ? spend / results : 0;

        // Return only essential fields
        return {
            impressions: data.impressions ? BigInt(data.impressions) : null,
            reach: data.reach ? BigInt(data.reach) : null,
            clicks: data.clicks ? BigInt(data.clicks) : null,
            ctr: data.ctr,
            spend: data.spend,
            cpc: data.cpc,
            cpm: data.cpm,
            messagingStarted: messagingStarted > 0 ? BigInt(messagingStarted) : null,
            costPerMessaging: costPerMessaging > 0 ? costPerMessaging : null,
            results: results > 0 ? BigInt(results) : null,
            costPerResult: costPerResult > 0 ? costPerResult : null,
        };
    }

    private mapBreakdownMetrics(data: any) {
        return {
            impressions: data.impressions ? BigInt(data.impressions) : null,
            reach: data.reach ? BigInt(data.reach) : null,
            clicks: data.clicks ? BigInt(data.clicks) : null,
            uniqueClicks: data.unique_clicks ? BigInt(data.unique_clicks) : null,
            spend: data.spend,
            actions: data.actions,
            actionValues: data.action_values,
            conversions: data.conversions,
            costPerActionType: data.cost_per_action_type,
            videoThruplayWatchedActions: data.video_thruplay_watched_actions,
        };
    }
}
