import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { FacebookApiService } from './facebook-api.service';
import { TokenService } from './token.service';
import { CrawlJobService } from './crawl-job.service';
import { TelegramService } from './telegram.service';
import { CrawlJobType } from '@prisma/client';

@Injectable()
export class InsightsSyncService {
    private readonly logger = new Logger(InsightsSyncService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly facebookApi: FacebookApiService,
        private readonly tokenService: TokenService,
        private readonly crawlJobService: CrawlJobService,
        private readonly telegramService: TelegramService,
    ) { }

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
        const accessToken = await this.tokenService.getTokenForAdAccount(accountId);
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
            let totalInsights = 0;

            const insights = await this.facebookApi.getAdInsights(
                adId,
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
                await this.upsertDailyInsight(insight, accountId, now);
                totalInsights++;
            }

            // If breakdown is 'all', sync other breakdowns as well
            if (breakdown === 'all') {
                // Sync device insights
                const deviceInsights = await this.facebookApi.getAdInsights(adId, accessToken, dateStart, dateEnd, 'device_platform', accountId);
                for (const insight of deviceInsights) {
                    insight.ad_id = ad.id;
                    await this.upsertDeviceInsight(insight, accountId, now);
                    totalInsights++;
                }

                // Sync hourly insights
                const hourlyInsights = await this.facebookApi.getAdInsights(adId, accessToken, dateStart, dateEnd, 'hourly_stats_aggregated_by_advertiser_time_zone', accountId);
                for (const insight of hourlyInsights) {
                    insight.ad_id = ad.id;
                    await this.upsertHourlyInsight(insight, accountId, now);
                    totalInsights++;
                }
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
        const accessToken = await this.tokenService.getTokenForAdAccount(accountId);
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
            const now = new Date();
            let totalInsights = 0;

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
                        // Set ad/adset/campaign IDs from our database record
                        insight.ad_id = ad.id;
                        insight.adset_id = ad.adsetId;
                        insight.campaign_id = ad.campaignId;
                        
                        // Save to DB (upsert - create or update)
                        await this.upsertDailyInsight(insight, accountId, now);
                        totalInsights++;
                    }
                } catch (error) {
                    this.logger.warn(`Failed to get insights for ad ${ad.id}: ${error.message}`);
                }
            }

            await this.crawlJobService.completeJob(job.id, totalInsights);
            this.logger.log(`Synced ${totalInsights} daily insights for ${ads.length} ads in ${accountId}`);
            return totalInsights;
        } catch (error) {
            await this.crawlJobService.failJob(job.id, error.message);
            throw error;
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
        const accessToken = await this.tokenService.getTokenForAdAccount(accountId);
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
            const now = new Date();
            let totalInsights = 0;

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
                        await this.upsertDeviceInsight(insight, accountId, now);
                        totalInsights++;
                    }
                } catch (error) {
                    this.logger.warn(`Failed to get device insights for ad ${ad.id}: ${error.message}`);
                }
            }

            await this.crawlJobService.completeJob(job.id, totalInsights);
            return totalInsights;
        } catch (error) {
            await this.crawlJobService.failJob(job.id, error.message);
            throw error;
        }
    }

    // ==================== PLACEMENT BREAKDOWN ====================

    async syncPlacementInsights(
        accountId: string,
        dateStart: string,
        dateEnd: string,
    ): Promise<number> {
        const accessToken = await this.tokenService.getTokenForAdAccount(accountId);
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
            const now = new Date();
            let totalInsights = 0;

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
                        await this.upsertPlacementInsight(insight, accountId, now);
                        totalInsights++;
                    }
                } catch (error) {
                    this.logger.warn(`Failed to get placement insights for ad ${ad.id}: ${error.message}`);
                }
            }

            await this.crawlJobService.completeJob(job.id, totalInsights);
            return totalInsights;
        } catch (error) {
            await this.crawlJobService.failJob(job.id, error.message);
            throw error;
        }
    }

    // ==================== AGE GENDER BREAKDOWN ====================

    async syncAgeGenderInsights(
        accountId: string,
        dateStart: string,
        dateEnd: string,
    ): Promise<number> {
        const accessToken = await this.tokenService.getTokenForAdAccount(accountId);
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
            const now = new Date();
            let totalInsights = 0;

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
                        await this.upsertAgeGenderInsight(insight, accountId, now);
                        totalInsights++;
                    }
                } catch (error) {
                    this.logger.warn(`Failed to get age/gender insights for ad ${ad.id}: ${error.message}`);
                }
            }

            await this.crawlJobService.completeJob(job.id, totalInsights);
            return totalInsights;
        } catch (error) {
            await this.crawlJobService.failJob(job.id, error.message);
            throw error;
        }
    }

    // ==================== REGION BREAKDOWN ====================

    async syncRegionInsights(
        accountId: string,
        dateStart: string,
        dateEnd: string,
    ): Promise<number> {
        const accessToken = await this.tokenService.getTokenForAdAccount(accountId);
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
            const now = new Date();
            let totalInsights = 0;

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
                        await this.upsertRegionInsight(insight, accountId, now);
                        totalInsights++;
                    }
                } catch (error) {
                    this.logger.warn(`Failed to get region insights for ad ${ad.id}: ${error.message}`);
                }
            }

            await this.crawlJobService.completeJob(job.id, totalInsights);
            return totalInsights;
        } catch (error) {
            await this.crawlJobService.failJob(job.id, error.message);
            throw error;
        }
    }

    // ==================== HOURLY BREAKDOWN ====================

    async syncHourlyInsights(
        accountId: string,
        dateStart: string,
        dateEnd: string,
    ): Promise<number> {
        const accessToken = await this.tokenService.getTokenForAdAccount(accountId);
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
            const currentHour = new Date().getHours();
            const prevHour = currentHour - 1;

            // Get account info for telegram message
            const account = await this.prisma.adAccount.findUnique({
                where: { id: accountId },
                select: { name: true, currency: true },
            });

            // Collect insights for the previous hour
            const prevHourInsights: Array<{
                insight: any;
                adName: string;
                campaignName: string;
                adsetName: string;
                previewLink: string | null;
            }> = [];

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
                        
                        // Save ALL hours to DB
                        await this.upsertHourlyInsight(insight, accountId, now);
                        totalInsights++;

                        // Collect for Telegram (only previous hour)
                        const hourRange = insight.hourly_stats_aggregated_by_advertiser_time_zone;
                        const insightHour = hourRange ? parseInt(hourRange.split(':')[0]) : -1;
                        
                        if (insightHour === prevHour && Number(insight.spend || 0) > 0) {
                            prevHourInsights.push({
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

            // Send consolidated Telegram report
            this.logger.log(`prevHourInsights count: ${prevHourInsights.length} for hour ${prevHour}`);
            if (prevHourInsights.length > 0) {
                this.logger.log(`Sending Telegram report for ${prevHourInsights.length} ads...`);
                // Use today's date for Telegram message
                const today = new Date().toISOString().split('T')[0];
                await this.sendConsolidatedHourlyReport(
                    prevHourInsights,
                    account?.name || accountId,
                    account?.currency || 'VND',
                    today,
                    `${prevHour.toString().padStart(2, '0')}:00`,
                );
                this.logger.log(`Telegram report sent!`);
            } else {
                this.logger.log(`No ads with spend > 0 for hour ${prevHour}, skipping Telegram`);
            }

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

        // Calculate totals
        let totalSpend = 0, totalImpr = 0, totalClicks = 0, totalMessaging = 0;
        for (const { insight } of insightsData) {
            totalSpend += Number(insight.spend || 0);
            totalImpr += Number(insight.impressions || 0);
            totalClicks += Number(insight.clicks || 0);
            totalMessaging += getActionValue(insight.actions, 'onsite_conversion.messaging_conversation_started_7d');
        }
        const totalCtr = totalImpr > 0 ? (totalClicks / totalImpr) * 100 : 0;
        const totalCpc = totalClicks > 0 ? totalSpend / totalClicks : 0;
        const totalCpm = totalImpr > 0 ? (totalSpend / totalImpr) * 1000 : 0;
        const totalCostPerMessaging = totalMessaging > 0 ? totalSpend / totalMessaging : 0;

        // Message 1: Summary/Totals
        let summaryMsg = `📊 <b>HOURLY INSIGHTS - ${date} ${hour}</b>\n\n`;
        summaryMsg += `📈 Account: <b>${accountName}</b>\n`;
        summaryMsg += `🎯 Active Ads: <b>${insightsData.length}</b>\n\n`;
        summaryMsg += `💰 <b>HOUR TOTALS</b>\n`;
        summaryMsg += `├── 💵 Spend: <b>${formatMoney(totalSpend)}</b>\n`;
        summaryMsg += `├── 👁 Impressions: ${formatNum(totalImpr)}\n`;
        summaryMsg += `├── 👆 Clicks: ${formatNum(totalClicks)}\n`;
        summaryMsg += `├── 💬 Messaging: <b>${formatNum(totalMessaging)}</b>\n`;
        summaryMsg += `├── 📊 CTR: ${totalCtr.toFixed(2)}%\n`;
        summaryMsg += `├── 💳 CPC: ${formatMoney(totalCpc)}\n`;
        summaryMsg += `├── 📈 CPM: ${formatMoney(totalCpm)}\n`;
        summaryMsg += `└── 💬 Cost/Msg: <b>${formatMoney(totalCostPerMessaging)}</b>`;

        await this.telegramService.sendMessage(summaryMsg);

        // Sort ads by spend and send each ad as separate message
        const sortedAds = [...insightsData].sort((a, b) => 
            Number(b.insight.spend || 0) - Number(a.insight.spend || 0)
        );

        // Send individual ad messages (ALL ads)
        for (const { insight, adName, campaignName, adsetName, previewLink } of sortedAds) {
            const spend = Number(insight.spend || 0);
            const impr = Number(insight.impressions || 0);
            const clicks = Number(insight.clicks || 0);
            const messaging = getActionValue(insight.actions, 'onsite_conversion.messaging_conversation_started_7d');
            const costPerMessaging = getCostPerAction(insight.cost_per_action_type, 'onsite_conversion.messaging_conversation_started_7d');
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
            adMsg += `├── 💬 Messaging: <b>${formatNum(messaging)}</b>\n`;
            adMsg += `├── 📊 CTR: ${ctr.toFixed(2)}%\n`;
            adMsg += `├── 💳 CPC: ${formatMoney(cpc)}\n`;
            adMsg += `├── 📈 CPM: ${formatMoney(cpm)}\n`;
            adMsg += `└── 💬 Cost/Msg: <b>${formatMoney(costPerMessaging)}</b>`;
            
            if (previewLink) {
                adMsg += `\n\n🔗 <a href="${previewLink}">Preview Ad</a>`;
            }

            await this.telegramService.sendMessage(adMsg);
        }
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
        const date = new Date(data.date_start);
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
        const date = new Date(data.date_start);
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
        const date = new Date(data.date_start);
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
        const date = new Date(data.date_start);
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
        const date = new Date(data.date_start);
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
        const date = new Date(data.date_start);
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

    private mapInsightMetrics(data: any) {
        return {
            impressions: data.impressions ? BigInt(data.impressions) : null,
            reach: data.reach ? BigInt(data.reach) : null,
            frequency: data.frequency,
            clicks: data.clicks ? BigInt(data.clicks) : null,
            uniqueClicks: data.unique_clicks ? BigInt(data.unique_clicks) : null,
            inlineLinkClicks: data.inline_link_clicks ? BigInt(data.inline_link_clicks) : null,
            uniqueInlineLinkClicks: data.unique_inline_link_clicks ? BigInt(data.unique_inline_link_clicks) : null,
            outboundClicks: data.outbound_clicks,
            uniqueOutboundClicks: data.unique_outbound_clicks,
            ctr: data.ctr,
            uniqueCtr: data.unique_ctr,
            inlineLinkClickCtr: data.inline_link_click_ctr,
            uniqueLinkClicksCtr: data.unique_link_clicks_ctr,
            outboundClicksCtr: data.outbound_clicks_ctr,
            spend: data.spend,
            cpc: data.cpc,
            cpm: data.cpm,
            cpp: data.cpp,
            costPerUniqueClick: data.cost_per_unique_click,
            costPerInlineLinkClick: data.cost_per_inline_link_click,
            costPerUniqueInlineLinkClick: data.cost_per_unique_inline_link_click,
            costPerOutboundClick: data.cost_per_outbound_click,
            costPerUniqueOutboundClick: data.cost_per_unique_outbound_click,
            actions: data.actions,
            actionValues: data.action_values,
            conversions: data.conversions,
            conversionValues: data.conversion_values,
            costPerActionType: data.cost_per_action_type,
            costPerConversion: data.cost_per_conversion,
            costPerUniqueActionType: data.cost_per_unique_action_type,
            purchaseRoas: data.purchase_roas,
            websitePurchaseRoas: data.website_purchase_roas,
            mobileAppPurchaseRoas: data.mobile_app_purchase_roas,
            videoPlayActions: data.video_play_actions,
            videoP25WatchedActions: data.video_p25_watched_actions,
            videoP50WatchedActions: data.video_p50_watched_actions,
            videoP75WatchedActions: data.video_p75_watched_actions,
            videoP95WatchedActions: data.video_p95_watched_actions,
            videoP100WatchedActions: data.video_p100_watched_actions,
            video30SecWatchedActions: data.video_30_sec_watched_actions,
            videoAvgTimeWatchedActions: data.video_avg_time_watched_actions,
            videoTimeWatchedActions: data.video_time_watched_actions,
            videoPlayCurveActions: data.video_play_curve_actions,
            videoThruplayWatchedActions: data.video_thruplay_watched_actions,
            videoContinuous2SecWatchedActions: data.video_continuous_2_sec_watched_actions,
            socialSpend: data.social_spend,
            inlinePostEngagement: data.inline_post_engagement ? BigInt(data.inline_post_engagement) : null,
            uniqueInlinePostEngagement: data.unique_inline_post_engagement ? BigInt(data.unique_inline_post_engagement) : null,
            qualityRanking: data.quality_ranking,
            engagementRateRanking: data.engagement_rate_ranking,
            conversionRateRanking: data.conversion_rate_ranking,
            canvasAvgViewTime: data.canvas_avg_view_time,
            canvasAvgViewPercent: data.canvas_avg_view_percent,
            catalogSegmentActions: data.catalog_segment_actions,
            catalogSegmentValue: data.catalog_segment_value,
            estimatedAdRecallers: data.estimated_ad_recallers ? BigInt(data.estimated_ad_recallers) : null,
            estimatedAdRecallRate: data.estimated_ad_recall_rate,
            instantExperienceClicksToOpen: data.instant_experience_clicks_to_open,
            instantExperienceClicksToStart: data.instant_experience_clicks_to_start,
            instantExperienceOutboundClicks: data.instant_experience_outbound_clicks,
            fullViewReach: data.full_view_reach ? BigInt(data.full_view_reach) : null,
            fullViewImpressions: data.full_view_impressions ? BigInt(data.full_view_impressions) : null,
            dateStart: data.date_start ? new Date(data.date_start) : null,
            dateStop: data.date_stop ? new Date(data.date_stop) : null,
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
