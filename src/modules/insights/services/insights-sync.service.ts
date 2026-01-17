import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { FacebookApiService } from '../../shared/services/facebook-api.service';
import { TokensService } from '../../tokens/services/tokens.service';
import { CrawlJobService } from '../../jobs/services/crawl-job.service';
import { TelegramService } from '../../telegram/services/telegram.service';
import { BranchStatsService } from '../../branches/services/branch-stats.service';
import { CrawlJobType } from '@prisma/client';
import { getVietnamDateString, getVietnamHour, getVietnamMinute } from '@n-utils';

@Injectable()
export class InsightsSyncService {
    private readonly logger = new Logger(InsightsSyncService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly facebookApi: FacebookApiService,
        private readonly tokenService: TokensService,
        private readonly crawlJobService: CrawlJobService,
        private readonly telegramService: TelegramService,
        @Inject(forwardRef(() => BranchStatsService))
        private readonly branchStatsService: BranchStatsService,
    ) { }

    // ... existing code ...

    /**
     * Sync all insights (daily + breakdowns) for all accounts in a branch
     */
    async syncBranch(
        branchId: number,
        userId: number,
        dateStart: string,
        dateEnd: string,
    ): Promise<void> {
        this.logger.log(`[BranchSync] Starting sync for branch ${branchId} (${dateStart} - ${dateEnd})`);

        // 1. Get all ad accounts for this branch
        const adAccounts = await this.prisma.adAccount.findMany({
            where: { branchId },
            select: { id: true, name: true },
        });

        if (adAccounts.length === 0) {
            this.logger.warn(`No ad accounts found for branch ${branchId}`);
            return;
        }

        // 2. Sync ALL accounts in PARALLEL
        await Promise.all(adAccounts.map(async (account) => {
            try {
                this.logger.log(`[BranchSync] Syncing account ${account.name} (${account.id})...`);
                
                // Parallelize Daily Insights and Breakdowns for each account
                await Promise.all([
                    this.syncDailyInsights(account.id, userId, dateStart, dateEnd),
                    this.syncAccountBreakdowns(account.id, userId, dateStart, dateEnd),
                    this.syncPlacementInsights(account.id, userId, dateStart, dateEnd),
                ]);
            } catch (error) {
                this.logger.error(`[BranchSync] Failed to sync account ${account.id}: ${error.message}`);
                // Continue with other accounts even if one fails
            }
        }));

        // 3. Aggregate stats for the branch - each day in range
        const start = new Date(dateStart);
        const end = new Date(dateEnd);
        for (let d = start; d <= end; d.setDate(d.getDate() + 1)) {
            const dateStr = d.toISOString().split('T')[0];
            await this.branchStatsService.aggregateBranchStats(branchId, dateStr);
        }

        this.logger.log(`[BranchSync] Completed sync for branch ${branchId}`);
    }

    /**
     * Parse YYYY-MM-DD date string to UTC midnight Date
     * This ensures consistent date storage regardless of server timezone
     * Example: '2026-01-04' -> 2026-01-04T00:00:00.000Z (always same result)
     */
    private parseLocalDate(dateStr: string): Date {
        // Parse as UTC midnight for consistent storage across all environments
        return new Date(`${dateStr}T00:00:00.000Z`);
    }

    /**
     * Hourly insights retention is strictly 2 days (today + yesterday).
     * This helper clamps any requested date range to that window to prevent
     * accidentally syncing large historical ranges (wasteful + can bloat DB temporarily).
     */
    private clampHourlyDateRange(dateStart: string, dateEnd: string): { dateStart: string; dateEnd: string; clamped: boolean } {
        const todayStr = getVietnamDateString(); // YYYY-MM-DD
        const today = this.parseLocalDate(todayStr);
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().split('T')[0]; // YYYY-MM-DD

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
        userId: number | undefined,
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

        // Verify ownership if userId is provided
        if (userId) {
            const hasAccess = await this.verifyAccountAccess(userId, accountId);
            if (!hasAccess) {
                throw new Error(`Ad account ${accountId} not found or access denied`);
            }
        }

        const accessToken = userId
            ? await this.tokenService.getTokenForAdAccount(accountId, userId)
            : await this.tokenService.getTokenForAdAccountInternal(accountId);

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

                // Sync placement insights
                const placementInsights = await this.facebookApi.getAdInsights(adId, accessToken, dateStart, dateEnd, 'publisher_platform,platform_position', accountId);
                for (const insight of placementInsights) {
                    insight.ad_id = ad.id;
                }
                if (placementInsights.length > 0) {
                    await this.batchUpsertPlacementInsights(placementInsights, accountId, now);
                }
                totalInsights += placementInsights.length;

                // Sync age/gender insights
                const ageGenderInsights = await this.facebookApi.getAdInsights(adId, accessToken, dateStart, dateEnd, 'age,gender', accountId);
                for (const insight of ageGenderInsights) {
                    insight.ad_id = ad.id;
                }
                if (ageGenderInsights.length > 0) {
                    await this.batchUpsertAgeGenderInsights(ageGenderInsights, accountId, now);
                }
                totalInsights += ageGenderInsights.length;

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
        userId: number | undefined,
        dateStart: string,
        dateEnd: string,
    ): Promise<number> {
        // Prevent overlapping INSIGHTS_DAILY jobs for same account
        if (await this.crawlJobService.hasRunningJob(accountId, CrawlJobType.INSIGHTS_DAILY)) {
            this.logger.warn(`[JobSkip] INSIGHTS_DAILY already running for account ${accountId}, skip new daily sync`);
            return 0;
        }

        // Verify ownership if userId is provided
        if (userId) {
            const hasAccess = await this.verifyAccountAccess(userId, accountId);
            if (!hasAccess) {
                throw new Error(`Ad account ${accountId} not found or access denied`);
            }
        }

        const accessToken = userId
            ? await this.tokenService.getTokenForAdAccount(accountId, userId)
            : await this.tokenService.getTokenForAdAccountInternal(accountId);

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
            const syncedAt = new Date();

            // 1. Bulk fetch ALL insights at account level (much faster than per-ad)
            // We fetch directly from Facebook without filtering by what our DB thinks is active
            this.logger.log(`[DailySync] Fetching bulk insights for account ${accountId}...`);
            const allInsights = await this.facebookApi.getInsights(
                accountId,
                accessToken,
                dateStart,
                dateEnd,
                'ad',
            );

            if (allInsights.length === 0) {
                this.logger.log(`[DailySync] No insights returned for account ${accountId} in range ${dateStart} to ${dateEnd}`);
                await this.crawlJobService.completeJob(job.id, 0);
                return 0;
            }

            // 2. BATCH UPSERT all insights
            this.logger.log(`[DailySync] Batch upserting ${allInsights.length} daily insights...`);
            await this.batchUpsertDailyInsights(allInsights, accountId, syncedAt);

            await this.crawlJobService.completeJob(job.id, allInsights.length);

            // Aggregate branch stats if insights were synced (no Telegram - use insight_branch type for that)
            if (allInsights.length > 0) {
                try {
                    // Get account info (including branch)
                    const account = await this.prisma.adAccount.findUnique({
                        where: { id: accountId },
                        select: {
                            branchId: true,
                        },
                    });

                    // Aggregate branch stats for all affected dates (if account belongs to a branch)
                    if (account?.branchId) {
                        const dates = Array.from(
                            new Set(
                                allInsights
                                    .map((insight) => insight.date_start || insight.date || dateStart)
                                    .filter(Boolean),
                            ),
                        ) as string[];

                        for (const d of dates) {
                            await this.branchStatsService.aggregateBranchStats(account.branchId, d);
                        }
                    }
                } catch (error) {
                    this.logger.error(`Post-sync hooks failed: ${error.message}`);
                    // Don't fail the sync if aggregation fails
                }
            }

            // Cleanup old data
            await this.cleanupOldDailyInsights(accountId);
            await this.crawlJobService.cleanupOldJobs();

            this.logger.log(`[DailySync] Done! Saved ${allInsights.length} insights for ${accountId}`);
            return allInsights.length;
        } catch (error) {
            await this.crawlJobService.failJob(job.id, error.message);
            throw error;
        }
    }

    /**
     * Batch upsert daily insights using raw SQL for performance (optimized schema)
     */
    private async batchUpsertDailyInsights(insights: any[], accountId: string, syncedAt: Date) {
        if (insights.length === 0) return;

        // CRITICAL: Filter out insights without ad_id (would violate NOT NULL constraint)
        const validInsights = insights.filter(i => i.ad_id);
        if (validInsights.length === 0) {
            this.logger.warn(`[DailySync] No valid insights (all missing ad_id) for account ${accountId}`);
            return;
        }
        if (validInsights.length < insights.length) {
            this.logger.warn(`[DailySync] Filtered out ${insights.length - validInsights.length} insights without ad_id`);
        }

        // Process in chunks to avoid query size limits
        const batchSize = 1000;

        for (let i = 0; i < validInsights.length; i += batchSize) {
            const batch = validInsights.slice(i, i + batchSize);

            const values = batch.map((data) => {
                const date = this.parseLocalDate(data.date_start).toISOString();
                const metrics = this.mapInsightMetrics(data);

                return Prisma.sql`(
                    ${date}::date,
                    ${data.ad_id}::text,
                    ${data.adset_id}::text,
                    ${data.campaign_id}::text,
                    ${accountId}::text,
                    ${metrics.impressions}::bigint,
                    ${metrics.reach}::bigint,
                    ${metrics.clicks}::bigint,
                    ${metrics.ctr}::decimal,
                    ${metrics.spend}::decimal,
                    ${metrics.cpc}::decimal,
                    ${metrics.cpm}::decimal,
                    ${metrics.messagingStarted}::bigint,
                    ${metrics.costPerMessaging}::decimal,
                    ${metrics.results}::bigint,
                    ${metrics.costPerResult}::decimal,
                    ${syncedAt}::timestamp,
                    NOW()
                )`;
            });

            await this.prisma.$executeRaw`
                INSERT INTO ad_insights_daily (
                    date, ad_id, adset_id, campaign_id, account_id,
                    impressions, reach, clicks, ctr,
                    spend, cpc, cpm,
                    messaging_started, cost_per_messaging, results, cost_per_result,
                    synced_at, created_at
                )
                VALUES ${Prisma.join(values)}
                ON CONFLICT (date, ad_id)
                DO UPDATE SET
                    adset_id = EXCLUDED.adset_id,
                    campaign_id = EXCLUDED.campaign_id,
                    account_id = EXCLUDED.account_id,
                    impressions = EXCLUDED.impressions,
                    reach = EXCLUDED.reach,
                    clicks = EXCLUDED.clicks,
                    ctr = EXCLUDED.ctr,
                    spend = EXCLUDED.spend,
                    cpc = EXCLUDED.cpc,
                    cpm = EXCLUDED.cpm,
                    messaging_started = EXCLUDED.messaging_started,
                    cost_per_messaging = EXCLUDED.cost_per_messaging,
                    results = EXCLUDED.results,
                    cost_per_result = EXCLUDED.cost_per_result,
                    synced_at = EXCLUDED.synced_at
            `;
        }
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
• Spend: <b>${Number(insight.spend || 0).toLocaleString('en-US')} ${currency}</b>
• Impressions: ${Number(insight.impressions || 0).toLocaleString('en-US')}
• Reach: ${Number(insight.reach || 0).toLocaleString('en-US')}
• Clicks: ${Number(insight.clicks || 0).toLocaleString('en-US')}
• CTR: ${ctr}%
`;
        await this.telegramService.sendMessage(message);
    }

    // ==================== DEVICE BREAKDOWN ====================

    async syncDeviceInsights(
        accountId: string,
        userId: number | undefined,
        dateStart: string,
        dateEnd: string,
    ): Promise<number> {
        // Prevent overlapping INSIGHTS_DEVICE jobs for same account
        if (await this.crawlJobService.hasRunningJob(accountId, CrawlJobType.INSIGHTS_DEVICE)) {
            this.logger.warn(`[JobSkip] INSIGHTS_DEVICE already running for account ${accountId}, skip new device sync`);
            return 0;
        }

        // Verify ownership if userId is provided
        if (userId) {
            const hasAccess = await this.verifyAccountAccess(userId, accountId);
            if (!hasAccess) {
                throw new Error(`Ad account ${accountId} not found or access denied`);
            }
        }

        const accessToken = userId
            ? await this.tokenService.getTokenForAdAccount(accountId, userId)
            : await this.tokenService.getTokenForAdAccountInternal(accountId);

        if (!accessToken) {
            throw new Error(`No valid token for account ${accountId}`);
        }

        const now = new Date();
        const ads = await this.prisma.ad.findMany({
            where: {
                accountId,
                effectiveStatus: 'ACTIVE',
                adset: {
                    effectiveStatus: 'ACTIVE',
                    OR: [
                        { endTime: null },
                        { endTime: { gte: now } },
                    ],
                },
            },
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

            // 1. Bulk fetch at account level
            this.logger.log(`[DeviceSync] Fetching bulk device insights for account ${accountId}...`);
            const allInsights = await this.facebookApi.getInsights(
                accountId,
                accessToken,
                dateStart,
                dateEnd,
                'ad',
                'device_platform',
            );

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
        if (insights.length === 0) return;

        // CRITICAL: Filter out insights without ad_id (would violate NOT NULL constraint)
        const validInsights = insights.filter(i => i.ad_id);
        if (validInsights.length === 0) return;

        const batchSize = 1000;

        for (let i = 0; i < validInsights.length; i += batchSize) {
            const batch = validInsights.slice(i, i + batchSize);
            const values = batch.map((data) => {
                const date = this.parseLocalDate(data.date_start).toISOString();
                const metrics = this.mapBreakdownMetrics(data);

                return Prisma.sql`(
                    ${date}::date,
                    ${data.ad_id}::text,
                    ${accountId}::text,
                    ${data.device_platform || 'unknown'}::text,
                    ${metrics.impressions}::bigint,
                    ${metrics.reach}::bigint,
                    ${metrics.clicks}::bigint,
                    ${metrics.uniqueClicks}::bigint,
                    ${metrics.spend}::decimal,
                    ${JSON.stringify(metrics.actions)}::jsonb,
                    ${JSON.stringify(metrics.actionValues)}::jsonb,
                    ${JSON.stringify(metrics.conversions)}::jsonb,
                    ${JSON.stringify(metrics.costPerActionType)}::jsonb,
                    ${JSON.stringify(metrics.videoThruplayWatchedActions)}::jsonb,
                    ${syncedAt}::timestamp,
                    NOW()
                )`;
            });

            await this.prisma.$executeRaw`
                INSERT INTO ad_insights_device_daily (
                    date, ad_id, account_id, device_platform,
                    impressions, reach, clicks, unique_clicks, spend,
                    actions, action_values, conversions, cost_per_action_type,
                    video_thruplay_watched_actions,
                    synced_at, created_at
                )
                VALUES ${Prisma.join(values)}
                ON CONFLICT (date, ad_id, device_platform)
                DO UPDATE SET
                    account_id = EXCLUDED.account_id,
                    impressions = EXCLUDED.impressions,
                    reach = EXCLUDED.reach,
                    clicks = EXCLUDED.clicks,
                    unique_clicks = EXCLUDED.unique_clicks,
                    spend = EXCLUDED.spend,
                    actions = EXCLUDED.actions,
                    action_values = EXCLUDED.action_values,
                    conversions = EXCLUDED.conversions,
                    cost_per_action_type = EXCLUDED.cost_per_action_type,
                    video_thruplay_watched_actions = EXCLUDED.video_thruplay_watched_actions,
                    synced_at = EXCLUDED.synced_at
            `;
        }
    }

    // ==================== REGION BREAKDOWN ====================

    private async batchUpsertRegionInsights(insights: any[], accountId: string, syncedAt: Date) {
        if (insights.length === 0) return;

        // CRITICAL: Filter out insights without ad_id (would violate NOT NULL constraint)
        const validInsights = insights.filter(i => i.ad_id);
        if (validInsights.length === 0) return;

        const batchSize = 1000;

        for (let i = 0; i < validInsights.length; i += batchSize) {
            const batch = validInsights.slice(i, i + batchSize);
            const values = batch.map((data) => {
                const date = this.parseLocalDate(data.date_start).toISOString();
                const metrics = this.mapBreakdownMetrics(data);

                return Prisma.sql`(
                    ${date}::date,
                    ${data.ad_id}::text,
                    ${accountId}::text,
                    ${data.region || null}::text,
                    ${data.country || 'unknown'}::text,
                    ${metrics.impressions}::bigint,
                    ${metrics.reach}::bigint,
                    ${metrics.clicks}::bigint,
                    ${metrics.uniqueClicks}::bigint,
                    ${metrics.spend}::decimal,
                    ${JSON.stringify(metrics.actions)}::jsonb,
                    ${JSON.stringify(metrics.actionValues)}::jsonb,
                    ${JSON.stringify(metrics.conversions)}::jsonb,
                    ${JSON.stringify(metrics.costPerActionType)}::jsonb,
                    ${syncedAt}::timestamp,
                    NOW()
                )`;
            });

            await this.prisma.$executeRaw`
                INSERT INTO ad_insights_region_daily (
                    date, ad_id, account_id, region, country,
                    impressions, reach, clicks, unique_clicks, spend,
                    actions, action_values, conversions, cost_per_action_type,
                    synced_at, created_at
                )
                VALUES ${Prisma.join(values)}
                ON CONFLICT (date, ad_id, region, country)
                DO UPDATE SET
                    account_id = EXCLUDED.account_id,
                    impressions = EXCLUDED.impressions,
                    reach = EXCLUDED.reach,
                    clicks = EXCLUDED.clicks,
                    unique_clicks = EXCLUDED.unique_clicks,
                    spend = EXCLUDED.spend,
                    actions = EXCLUDED.actions,
                    action_values = EXCLUDED.action_values,
                    conversions = EXCLUDED.conversions,
                    cost_per_action_type = EXCLUDED.cost_per_action_type,
                    synced_at = EXCLUDED.synced_at
            `;
        }
    }

    // ==================== BULK SYNC BREAKDOWNS ====================

    /**
     * Efficiently syncs all breakdowns for an entire account by querying graph API with level='ad' and breakdowns.
     */
    async syncAccountBreakdowns(
        accountId: string,
        userId: number | undefined,
        dateStart: string,
        dateEnd: string,
    ): Promise<void> {
        // Verify ownership if userId is provided
        if (userId) {
            const hasAccess = await this.verifyAccountAccess(userId, accountId);
            if (!hasAccess) {
                throw new Error(`Ad account ${accountId} not found or access denied`);
            }
        }

        const accessToken = userId
            ? await this.tokenService.getTokenForAdAccount(accountId, userId)
            : await this.tokenService.getTokenForAdAccountInternal(accountId);

        if (!accessToken) {
            throw new Error(`No valid token for account ${accountId}`);
        }

        const now = new Date();

        // Parallelize all breakdown syncs
        await Promise.all([
            // 1. Sync Device Breakdown
            (async () => {
                this.logger.log(`[BulkSync] Fetching DEVICE breakdown for account ${accountId}...`);
                const deviceInsights = await this.facebookApi.getInsights(
                    accountId,
                    accessToken,
                    dateStart,
                    dateEnd,
                    'ad',
                    'device_platform'
                );
                if (deviceInsights.length > 0) {
                    this.logger.log(`[BulkSync] Upserting ${deviceInsights.length} device insights...`);
                    await this.batchUpsertDeviceInsights(deviceInsights, accountId, now);
                }
            })(),

            // 2. Sync Age/Gender Breakdown
            (async () => {
                this.logger.log(`[BulkSync] Fetching AGE/GENDER breakdown for account ${accountId}...`);
                const ageGenderInsights = await this.facebookApi.getInsights(
                    accountId,
                    accessToken,
                    dateStart,
                    dateEnd,
                    'ad',
                    'age,gender'
                );
                if (ageGenderInsights.length > 0) {
                    this.logger.log(`[BulkSync] Upserting ${ageGenderInsights.length} age/gender insights...`);
                    await this.batchUpsertAgeGenderInsights(ageGenderInsights, accountId, now);
                } else {
                    this.logger.warn(`[BulkSync] No age/gender insights returned for account ${accountId} (${dateStart} - ${dateEnd})`);
                }
            })(),

            // 3. Sync Region Breakdown
            (async () => {
                this.logger.log(`[BulkSync] Fetching REGION breakdown for account ${accountId}...`);
                const regionInsights = await this.facebookApi.getInsights(
                    accountId,
                    accessToken,
                    dateStart,
                    dateEnd,
                    'ad',
                    'country,region'
                );
                if (regionInsights.length > 0) {
                    this.logger.log(`[BulkSync] Upserting ${regionInsights.length} region insights...`);
                    await this.batchUpsertRegionInsights(regionInsights, accountId, now);
                } else {
                    this.logger.warn(`[BulkSync] No region insights returned for account ${accountId} (${dateStart} - ${dateEnd})`);
                }
            })()
        ]);
        
        this.logger.log(`[BulkSync] Completed breakdown sync for account ${accountId}`);
    }    

    // ==================== PLACEMENT BREAKDOWN ====================

    async syncPlacementInsights(
        accountId: string,
        userId: number | undefined,
        dateStart: string,
        dateEnd: string,
    ): Promise<number> {
        // Prevent overlapping INSIGHTS_PLACEMENT jobs for same account
        if (await this.crawlJobService.hasRunningJob(accountId, CrawlJobType.INSIGHTS_PLACEMENT)) {
            this.logger.warn(`[JobSkip] INSIGHTS_PLACEMENT already running for account ${accountId}, skip new placement sync`);
            return 0;
        }

        // Verify ownership if userId is provided
        if (userId) {
            const hasAccess = await this.verifyAccountAccess(userId, accountId);
            if (!hasAccess) {
                throw new Error(`Ad account ${accountId} not found or access denied`);
            }
        }

        const accessToken = userId
            ? await this.tokenService.getTokenForAdAccount(accountId, userId)
            : await this.tokenService.getTokenForAdAccountInternal(accountId);

        if (!accessToken) {
            throw new Error(`No valid token for account ${accountId}`);
        }

        const now = new Date();
        const ads = await this.prisma.ad.findMany({
            where: {
                accountId,
                effectiveStatus: 'ACTIVE',
                adset: {
                    effectiveStatus: 'ACTIVE',
                    OR: [
                        { endTime: null },
                        { endTime: { gte: now } },
                    ],
                },
            },
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

            // 1. Bulk fetch at account level
            this.logger.log(`[PlacementSync] Fetching bulk placement insights for account ${accountId}...`);
            const allInsights = await this.facebookApi.getInsights(
                accountId,
                accessToken,
                dateStart,
                dateEnd,
                'ad',
                'publisher_platform,platform_position',
            );

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
        if (insights.length === 0) return;

        // CRITICAL: Filter out insights without ad_id (would violate NOT NULL constraint)
        const validInsights = insights.filter(i => i.ad_id);
        if (validInsights.length === 0) return;

        const batchSize = 1000;

        for (let i = 0; i < validInsights.length; i += batchSize) {
            const batch = validInsights.slice(i, i + batchSize);
            const values = batch.map((data) => {
                const date = this.parseLocalDate(data.date_start).toISOString();
                const metrics = this.mapBreakdownMetrics(data);

                return Prisma.sql`(
                    ${date}::date,
                    ${data.ad_id}::text,
                    ${accountId}::text,
                    ${data.publisher_platform || 'unknown'}::text,
                    ${data.platform_position || 'unknown'}::text,
                    ${data.impression_device}::text,
                    ${metrics.impressions}::bigint,
                    ${metrics.reach}::bigint,
                    ${metrics.clicks}::bigint,
                    ${metrics.uniqueClicks}::bigint,
                    ${metrics.spend}::decimal,
                    ${JSON.stringify(metrics.actions)}::jsonb,
                    ${JSON.stringify(metrics.actionValues)}::jsonb,
                    ${JSON.stringify(metrics.conversions)}::jsonb,
                    ${JSON.stringify(metrics.costPerActionType)}::jsonb,
                    ${JSON.stringify(metrics.videoThruplayWatchedActions)}::jsonb,
                    ${syncedAt}::timestamp,
                    NOW()
                )`;
            });

            await this.prisma.$executeRaw`
                INSERT INTO ad_insights_placement_daily (
                    date, ad_id, account_id, publisher_platform, platform_position, impression_device,
                    impressions, reach, clicks, unique_clicks, spend,
                    actions, action_values, conversions, cost_per_action_type,
                    video_thruplay_watched_actions,
                    synced_at, created_at
                )
                VALUES ${Prisma.join(values)}
                ON CONFLICT (date, ad_id, publisher_platform, platform_position)
                DO UPDATE SET
                    account_id = EXCLUDED.account_id,
                    impression_device = EXCLUDED.impression_device,
                    impressions = EXCLUDED.impressions,
                    reach = EXCLUDED.reach,
                    clicks = EXCLUDED.clicks,
                    unique_clicks = EXCLUDED.unique_clicks,
                    spend = EXCLUDED.spend,
                    actions = EXCLUDED.actions,
                    action_values = EXCLUDED.action_values,
                    conversions = EXCLUDED.conversions,
                    cost_per_action_type = EXCLUDED.cost_per_action_type,
                    video_thruplay_watched_actions = EXCLUDED.video_thruplay_watched_actions,
                    synced_at = EXCLUDED.synced_at
            `;
        }
    }

    // ==================== AGE GENDER BREAKDOWN ====================

    async syncAgeGenderInsights(
        accountId: string,
        userId: number | undefined,
        dateStart: string,
        dateEnd: string,
    ): Promise<number> {
        // Prevent overlapping INSIGHTS_AGE_GENDER jobs for same account
        if (await this.crawlJobService.hasRunningJob(accountId, CrawlJobType.INSIGHTS_AGE_GENDER)) {
            this.logger.warn(`[JobSkip] INSIGHTS_AGE_GENDER already running for account ${accountId}, skip new age/gender sync`);
            return 0;
        }

        // Verify ownership if userId is provided
        if (userId) {
            const hasAccess = await this.verifyAccountAccess(userId, accountId);
            if (!hasAccess) {
                throw new Error(`Ad account ${accountId} not found or access denied`);
            }
        }

        const accessToken = userId
            ? await this.tokenService.getTokenForAdAccount(accountId, userId)
            : await this.tokenService.getTokenForAdAccountInternal(accountId);

        if (!accessToken) {
            throw new Error(`No valid token for account ${accountId}`);
        }

        const now = new Date();
        const ads = await this.prisma.ad.findMany({
            where: {
                accountId,
                effectiveStatus: 'ACTIVE',
                adset: {
                    effectiveStatus: 'ACTIVE',
                    OR: [
                        { endTime: null },
                        { endTime: { gte: now } },
                    ],
                },
            },
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

            // 1. Bulk fetch at account level
            this.logger.log(`[AgeGenderSync] Fetching bulk age/gender insights for account ${accountId}...`);
            const allInsights = await this.facebookApi.getInsights(
                accountId,
                accessToken,
                dateStart,
                dateEnd,
                'ad',
                'age,gender',
            );

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
        if (insights.length === 0) return;

        // CRITICAL: Filter out insights without ad_id (would violate NOT NULL constraint)
        const validInsights = insights.filter(i => i.ad_id);
        if (validInsights.length === 0) return;

        const batchSize = 1000;

        for (let i = 0; i < validInsights.length; i += batchSize) {
            const batch = validInsights.slice(i, i + batchSize);
            const values = batch.map((data) => {
                const date = this.parseLocalDate(data.date_start).toISOString();
                const metrics = this.mapBreakdownMetrics(data);

                return Prisma.sql`(
                    ${date}::date,
                    ${data.ad_id}::text,
                    ${accountId}::text,
                    ${data.age || 'unknown'}::text,
                    ${data.gender || 'unknown'}::text,
                    ${metrics.impressions}::bigint,
                    ${metrics.reach}::bigint,
                    ${metrics.clicks}::bigint,
                    ${metrics.uniqueClicks}::bigint,
                    ${metrics.spend}::decimal,
                    ${JSON.stringify(metrics.actions)}::jsonb,
                    ${JSON.stringify(metrics.actionValues)}::jsonb,
                    ${JSON.stringify(metrics.conversions)}::jsonb,
                    ${JSON.stringify(metrics.costPerActionType)}::jsonb,
                    ${syncedAt}::timestamp,
                    NOW()
                )`;
            });

            await this.prisma.$executeRaw`
                INSERT INTO ad_insights_age_gender_daily (
                    date, ad_id, account_id, age, gender,
                    impressions, reach, clicks, unique_clicks, spend,
                    actions, action_values, conversions, cost_per_action_type,
                    synced_at, created_at
                )
                VALUES ${Prisma.join(values)}
                ON CONFLICT (date, ad_id, age, gender)
                DO UPDATE SET
                    account_id = EXCLUDED.account_id,
                    impressions = EXCLUDED.impressions,
                    reach = EXCLUDED.reach,
                    clicks = EXCLUDED.clicks,
                    unique_clicks = EXCLUDED.unique_clicks,
                    spend = EXCLUDED.spend,
                    actions = EXCLUDED.actions,
                    action_values = EXCLUDED.action_values,
                    conversions = EXCLUDED.conversions,
                    cost_per_action_type = EXCLUDED.cost_per_action_type,
                    synced_at = EXCLUDED.synced_at
            `;
        }
    }

    // ==================== REGION BREAKDOWN ====================

    async syncRegionInsights(
        accountId: string,
        userId: number | undefined,
        dateStart: string,
        dateEnd: string,
    ): Promise<number> {
        // Prevent overlapping INSIGHTS_REGION jobs for same account
        if (await this.crawlJobService.hasRunningJob(accountId, CrawlJobType.INSIGHTS_REGION)) {
            this.logger.warn(`[JobSkip] INSIGHTS_REGION already running for account ${accountId}, skip new region sync`);
            return 0;
        }

        // Verify ownership if userId is provided
        if (userId) {
            const hasAccess = await this.verifyAccountAccess(userId, accountId);
            if (!hasAccess) {
                throw new Error(`Ad account ${accountId} not found or access denied`);
            }
        }

        const accessToken = userId
            ? await this.tokenService.getTokenForAdAccount(accountId, userId)
            : await this.tokenService.getTokenForAdAccountInternal(accountId);

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

            // 1. Bulk fetch at account level
            this.logger.log(`[RegionSync] Fetching bulk region insights for account ${accountId}...`);
            const allInsights = await this.facebookApi.getInsights(
                accountId,
                accessToken,
                dateStart,
                dateEnd,
                'ad',
                'country,region',
            );

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



    // ==================== HOURLY BREAKDOWN ====================

    async syncHourlyInsights(
        accountId: string,
        userId: number | undefined,
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

        // Verify ownership if userId is provided
        if (userId) {
            const hasAccess = await this.verifyAccountAccess(userId, accountId);
            if (!hasAccess) {
                throw new Error(`Ad account ${accountId} not found or access denied`);
            }
        }

        const accessToken = userId
            ? await this.tokenService.getTokenForAdAccount(accountId, userId)
            : await this.tokenService.getTokenForAdAccountInternal(accountId);

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

            // 1. Bulk fetch hourly insights at account level
            this.logger.log(`[HourlySync] Fetching bulk hourly insights for account ${accountId}...`);
            const allInsights = await this.facebookApi.getInsights(
                accountId,
                accessToken,
                dateStart,
                dateEnd,
                'ad',
                'hourly_stats_aggregated_by_advertiser_time_zone',
            );

            // 2. Process for Telegram (current hour of TODAY only)
            const currentHourInsights: Array<{
                insight: any;
                adName: string;
                campaignName: string;
                adsetName: string;
                previewLink: string | null;
            }> = [];

            // Map ads for quick lookup
            const adMap = new Map(ads.map(ad => [ad.id, ad]));

            for (const insight of allInsights) {
                const adId = insight.ad_id;
                const ad = adMap.get(adId);

                // Note: insight already has ad_id, but might need parent IDs from our DB if FB doesn't provide them at ad level
                insight.adset_id = insight.adset_id || ad?.adsetId;
                insight.campaign_id = insight.campaign_id || ad?.campaignId;

                totalInsights++;

                const hourRange = insight.hourly_stats_aggregated_by_advertiser_time_zone;
                const insightHour = hourRange ? parseInt(hourRange.split(':')[0]) : -1;
                const insightDate = insight.date_start;

                if (insightHour === currentHour && insightDate === todayStr && Number(insight.spend || 0) > 0 && ad) {
                    currentHourInsights.push({
                        insight,
                        adName: ad.name || ad.id,
                        campaignName: ad.campaign?.name || 'N/A',
                        adsetName: ad.adset?.name || 'N/A',
                        previewLink: ad.previewShareableLink,
                    });
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
            totalNewMsg += Number(insight.messagingStarted || 0);
            totalResults += Number(insight.results || 0);
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

        await this.telegramService.sendMessage(summaryMsg);

        // Sort ads by spend and send each ad as separate message
        const sortedAds = [...insightsData].sort((a, b) =>
            Number(b.insight.spend || 0) - Number(a.insight.spend || 0)
        );

        const top10Ads = sortedAds.slice(0, 10);
        for (const { insight, adName, campaignName, adsetName, previewLink } of top10Ads) {
            const spend = Number(insight.spend || 0);
            const impr = Number(insight.impressions || 0);
            const clicks = Number(insight.clicks || 0);
            const results = Number(insight.results || 0);
            const newMsg = Number(insight.messagingStarted || 0);
            const cpr = Number(insight.costPerResult || 0) || (results > 0 ? spend / results : 0);
            const costPerNewMsg = Number(insight.costPerMessaging || 0);
            const ctr = Number(insight.ctr || 0) || (impr > 0 ? (clicks / impr) * 100 : 0);
            const cpc = Number(insight.cpc || 0) || (clicks > 0 ? spend / clicks : 0);
            const cpm = Number(insight.cpm || 0) || (impr > 0 ? (spend / impr) * 1000 : 0);

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

            await this.telegramService.sendMessage(adMsg);
        }

        // Notify if there are more ads
        if (sortedAds.length > 10) {
            await this.telegramService.sendMessage(`\n➕ Còn <b>${sortedAds.length - 10}</b> ads khác có chi tiêu trong giờ này.`);
        }
    }

    // ==================== QUICK HOURLY SYNC (OPTIMIZED) ====================

    /**
     * Quick sync of today's hourly insights only - OPTIMIZED VERSION
     * - Only syncs today's data
     * - Uses batch transaction for faster DB writes
     * - No Telegram sending (decoupled)
     */
    async syncHourlyInsightsQuick(accountId: string, userId?: number): Promise<{ count: number; duration: number }> {
        const startTime = Date.now();
        const today = getVietnamDateString();

        const accessToken = userId
            ? await this.tokenService.getTokenForAdAccount(accountId, userId)
            : await this.tokenService.getTokenForAdAccountInternal(accountId);

        if (!accessToken) {
            throw new Error(`No valid token for account ${accountId}`);
        }

        // Get all active ads
        const ads = await this.prisma.ad.findMany({
            where: { accountId, effectiveStatus: 'ACTIVE' },
            select: { id: true, adsetId: true, campaignId: true },
        });

        if (ads.length === 0) {
            return { count: 0, duration: Date.now() - startTime };
        }

        this.logger.log(`[QuickSync] Fetching bulk hourly insights for account ${accountId}...`);

        // 1. Bulk fetch at account level
        const allInsights = await this.facebookApi.getInsights(
            accountId,
            accessToken,
            today,
            today,
            'ad',
            'hourly_stats_aggregated_by_advertiser_time_zone',
        );

        const syncedAt = new Date();
        const adMap = new Map(ads.map(ad => [ad.id, ad]));

        for (const insight of allInsights) {
            const ad = adMap.get(insight.ad_id);
            if (ad) {
                insight.adset_id = insight.adset_id || ad.adsetId;
                insight.campaign_id = insight.campaign_id || ad.campaignId;
            }
        }

        this.logger.log(`[QuickSync] Collected ${allInsights.length} insights, batch saving to DB...`);

        // 2. BATCH UPSERT in single transaction
        if (allInsights.length > 0) {
            await this.batchUpsertHourlyInsights(allInsights, accountId, syncedAt);
        }

        // 3. Cleanup old data
        await this.cleanupOldHourlyInsights(accountId);

        const duration = Date.now() - startTime;
        this.logger.log(`[QuickSync] Done! Saved ${allInsights.length} insights in ${duration}ms`);

        return { count: allInsights.length, duration };
    }

    /**
     * Batch upsert hourly insights - single transaction for all records
     */
    /**
     * Batch upsert hourly insights using raw SQL for performance (optimized schema)
     */
    private async batchUpsertHourlyInsights(insights: any[], accountId: string, syncedAt: Date) {
        if (insights.length === 0) return;

        // CRITICAL: Filter out insights without ad_id (would violate NOT NULL constraint)
        const validInsights = insights.filter(i => i.ad_id);
        if (validInsights.length === 0) {
            this.logger.warn(`[HourlySync] No valid insights (all missing ad_id) for account ${accountId}`);
            return;
        }
        if (validInsights.length < insights.length) {
            this.logger.warn(`[HourlySync] Filtered out ${insights.length - validInsights.length} insights without ad_id`);
        }

        // Sort to reduce chances of deadlocks: date -> ad_id -> hourlyStats
        validInsights.sort((a, b) => {
            const dateCompare = (a.date_start || '').localeCompare(b.date_start || '');
            if (dateCompare !== 0) return dateCompare;
            const adCompare = (a.ad_id || '').localeCompare(b.ad_id || '');
            if (adCompare !== 0) return adCompare;
            return (a.hourly_stats_aggregated_by_advertiser_time_zone || '')
                .localeCompare(b.hourly_stats_aggregated_by_advertiser_time_zone || '');
        });

        const batchSize = 1000;

        for (let i = 0; i < validInsights.length; i += batchSize) {
            const batch = validInsights.slice(i, i + batchSize);
            const values = batch.map((data) => {
                const date = this.parseLocalDate(data.date_start).toISOString();
                const hourlyStats = data.hourly_stats_aggregated_by_advertiser_time_zone || '00:00:00 - 00:59:59';
                const metrics = this.mapInsightMetrics(data);

                return Prisma.sql`(
                    ${date}::date,
                    ${data.ad_id}::text,
                    ${data.adset_id}::text,
                    ${data.campaign_id}::text,
                    ${accountId}::text,
                    ${hourlyStats}::text,
                    ${metrics.impressions}::bigint,
                    ${metrics.reach}::bigint,
                    ${metrics.clicks}::bigint,
                    ${metrics.ctr}::decimal,
                    ${metrics.spend}::decimal,
                    ${metrics.cpc}::decimal,
                    ${metrics.cpm}::decimal,
                    ${metrics.messagingStarted}::bigint,
                    ${metrics.costPerMessaging}::decimal,
                    ${metrics.results}::bigint,
                    ${metrics.costPerResult}::decimal,
                    ${syncedAt}::timestamp,
                    NOW()
                )`;
            });

            await this.prisma.$executeRaw`
                INSERT INTO ad_insights_hourly (
                    date, ad_id, adset_id, campaign_id, account_id,
                    hourly_stats_aggregated_by_advertiser_time_zone,
                    impressions, reach, clicks, ctr,
                    spend, cpc, cpm,
                    messaging_started, cost_per_messaging, results, cost_per_result,
                    synced_at, created_at
                )
                VALUES ${Prisma.join(values)}
                ON CONFLICT (date, ad_id, hourly_stats_aggregated_by_advertiser_time_zone)
                DO UPDATE SET
                    adset_id = EXCLUDED.adset_id,
                    campaign_id = EXCLUDED.campaign_id,
                    account_id = EXCLUDED.account_id,
                    impressions = EXCLUDED.impressions,
                    reach = EXCLUDED.reach,
                    clicks = EXCLUDED.clicks,
                    ctr = EXCLUDED.ctr,
                    spend = EXCLUDED.spend,
                    cpc = EXCLUDED.cpc,
                    cpm = EXCLUDED.cpm,
                    messaging_started = EXCLUDED.messaging_started,
                    cost_per_messaging = EXCLUDED.cost_per_messaging,
                    results = EXCLUDED.results,
                    cost_per_result = EXCLUDED.cost_per_result,
                    synced_at = EXCLUDED.synced_at
            `;
        }
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
        const currentHour = hour ?? getVietnamHour();
        const todayStr = getVietnamDateString();
        const today = this.parseLocalDate(todayStr);

        // Format hour for query
        const hourString = currentHour.toString().padStart(2, '0');
        const hourlyTimeZone = `${hourString}:00:00 - ${hourString}:59:59`;

        // Get hourly insights for current hour with spend > 0
        const rawInsights = await this.prisma.adInsightsHourly.findMany({
            where: {
                date: today,
                hourlyStatsAggregatedByAdvertiserTimeZone: hourlyTimeZone,
                spend: { gt: 0 },
            },
            orderBy: { spend: 'desc' },
        });

        if (rawInsights.length === 0) {
            return null;
        }

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
     */
    async sendLatestHourTelegramReport(hour?: number): Promise<{ success: boolean; message: string }> {
        const data = await this.getLatestHourInsights(hour);

        if (!data || data.insights.length === 0) {
            return {
                success: false,
                message: `No insights with spend > 0 for current hour (${getVietnamHour()}:00)`
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
        userId: number | undefined,
        dateStart: string,
        dateEnd: string,
    ): Promise<void> {
        this.logger.log(`Syncing all insights for ${accountId}: ${dateStart} to ${dateEnd}`);

        // Define groups of tasks to run in parallel batches
        // This is "Throttled Parallelism" to avoid hitting rate limits too fast
        const taskGroups = [
            [
                () => this.syncDailyInsights(accountId, userId, dateStart, dateEnd),
                () => this.syncDeviceInsights(accountId, userId, dateStart, dateEnd),
            ],
            [
                () => this.syncPlacementInsights(accountId, userId, dateStart, dateEnd),
                () => this.syncAgeGenderInsights(accountId, userId, dateStart, dateEnd),
            ],
            [
                () => this.syncRegionInsights(accountId, userId, dateStart, dateEnd),
                () => this.syncHourlyInsights(accountId, userId, dateStart, dateEnd),
            ],
        ];

        for (const group of taskGroups) {
            await Promise.all(group.map(task => task()));
            // Small jitter delay between batches to respect Meta rate limits
            await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000));
        }

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

        // Get previous hour's data for growth calculation
        const previousHourSlot = this.getPreviousHourSlot(hourlyStats, date);
        const previousData = await this.prisma.adInsightsHourly.findFirst({
            where: {
                adId,
                date: previousHourSlot.date,
                hourlyStatsAggregatedByAdvertiserTimeZone: previousHourSlot.hourSlot,
            },
        });

        // Map all metrics (same as Daily)
        const metrics = this.mapInsightMetrics(data);

        // Calculate growth compared to previous hour
        const growth = this.calculateGrowth(data, previousData);

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
                ...growth,
                syncedAt,
            },
            update: {
                ...metrics,
                ...growth,
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

    private getPreviousHourSlot(currentHourSlot: string, currentDate: Date): { date: Date; hourSlot: string } {
        // Parse hour from "HH:00:00 - HH:59:59" format
        const currentHour = parseInt(currentHourSlot.split(':')[0]);

        if (currentHour === 0) {
            // Previous hour is 23:00 of yesterday
            const previousDate = new Date(currentDate);
            previousDate.setDate(previousDate.getDate() - 1);
            return { date: previousDate, hourSlot: '23:00:00 - 23:59:59' };
        }

        // Build previous hour slot string
        const prevHour = currentHour - 1;
        const prevHourStr = prevHour.toString().padStart(2, '0');
        return { date: currentDate, hourSlot: `${prevHourStr}:00:00 - ${prevHourStr}:59:59` };
    }

    private calculateGrowth(current: any, previous: any) {
        const safeBigIntDiff = (curr: any, prev: any) => {
            if (!curr) return null;
            if (!prev) return BigInt(curr);
            return BigInt(curr) - BigInt(prev);
        };

        const safeDecimalDiff = (curr: any, prev: any) => {
            if (!curr) return null;
            if (!prev) return parseFloat(curr);
            return parseFloat(curr) - parseFloat(prev);
        };

        return {
            impressionsGrowth: safeBigIntDiff(current.impressions, previous?.impressions),
            reachGrowth: safeBigIntDiff(current.reach, previous?.reach),
            frequencyGrowth: safeDecimalDiff(current.frequency, previous?.frequency),
            clicksGrowth: safeBigIntDiff(current.clicks, previous?.clicks),
            uniqueClicksGrowth: safeBigIntDiff(current.unique_clicks, previous?.uniqueClicks),
            inlineLinkClicksGrowth: safeBigIntDiff(current.inline_link_clicks, previous?.inlineLinkClicks),
            uniqueInlineLinkClicksGrowth: safeBigIntDiff(current.unique_inline_link_clicks, previous?.uniqueInlineLinkClicks),
            ctrGrowth: safeDecimalDiff(current.ctr, previous?.ctr),
            uniqueCtrGrowth: safeDecimalDiff(current.unique_ctr, previous?.uniqueCtr),
            spendGrowth: safeDecimalDiff(current.spend, previous?.spend),
            cpcGrowth: safeDecimalDiff(current.cpc, previous?.cpc),
            cpmGrowth: safeDecimalDiff(current.cpm, previous?.cpm),
            inlinePostEngagementGrowth: safeBigIntDiff(current.inline_post_engagement, previous?.inlinePostEngagement),
            uniqueInlinePostEngagementGrowth: safeBigIntDiff(current.unique_inline_post_engagement, previous?.uniqueInlinePostEngagement),
            // JSON fields growth (store as new actions in this hour)
            actionsGrowth: current.actions,
            actionValuesGrowth: current.action_values,
            conversionsGrowth: current.conversions,
            conversionValuesGrowth: current.conversion_values,
        };
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
            ctr: data.ctr != null ? Number(data.ctr) : null,
            spend: data.spend != null ? Number(data.spend) : 0,
            cpc: data.cpc != null ? Number(data.cpc) : null,
            cpm: data.cpm != null ? Number(data.cpm) : null,
            messagingStarted: messagingStarted > 0 ? BigInt(messagingStarted) : null,
            costPerMessaging: costPerMessaging > 0 ? Number(costPerMessaging) : null,
            results: results > 0 ? BigInt(results) : null,
            costPerResult: costPerResult > 0 ? Number(costPerResult) : null,
        };
    }

    private mapBreakdownMetrics(data: any) {
        return {
            impressions: data.impressions ? BigInt(data.impressions) : null,
            reach: data.reach ? BigInt(data.reach) : null,
            clicks: data.clicks ? BigInt(data.clicks) : null,
            uniqueClicks: data.unique_clicks ? BigInt(data.unique_clicks) : null,
            spend: data.spend != null ? Number(data.spend) : 0,
            actions: data.actions || [],
            actionValues: data.action_values || [],
            conversions: data.conversions || [],
            costPerActionType: data.cost_per_action_type || [],
            videoThruplayWatchedActions: data.video_thruplay_watched_actions || [],
        };
    }

    async cleanupAllOldHourlyInsights(): Promise<number> {
        // Get today's date in Vietnam timezone
        const todayStr = getVietnamDateString();
        const today = this.parseLocalDate(todayStr);

        // Calculate yesterday
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);

        // Delete all hourly insights older than yesterday (strict 2-day retention)
        const result = await this.prisma.adInsightsHourly.deleteMany({
            where: {
                date: {
                    lt: yesterday,
                },
            },
        });

        this.logger.log(`[GlobalHourlyCleanup] Deleted ${result.count} old hourly records`);
        return result.count;
    }

    private async verifyAccountAccess(userId: number, accountId: string): Promise<boolean> {
        const account = await this.prisma.adAccount.findFirst({
            where: {
                id: accountId,
                fbAccount: { userId },
            },
        });
        return !!account;
    }
}
