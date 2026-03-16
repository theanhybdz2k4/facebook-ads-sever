import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { FacebookApiService } from '../api/facebook-api.service';
import { TokenService } from '../accounts/token.service';

@Injectable()
export class InsightsSyncService {
    private readonly logger = new Logger(InsightsSyncService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly facebookApi: FacebookApiService,
        private readonly tokenService: TokenService,
    ) { }

    /**
     * Đồng bộ insights cho 1 account
     */
    async syncInsightsForAdAccount(
        platformAccountId: number,
        granularity: 'daily' | 'hourly' | 'both',
        dateStart?: string,
        dateEnd?: string,
    ) {
        const token = await this.tokenService.getTokenForAdAccount(platformAccountId);
        if (!token) throw new Error('No token found');

        const account = await this.prisma.platformAccount.findUnique({
            where: { id: platformAccountId },
        });
        if (!account) throw new NotFoundException('Account not found');

        const now = new Date();
        const start = dateStart || new Date().toISOString().split('T')[0];
        const end = dateEnd || new Date().toISOString().split('T')[0];
        const offset = ["VND", "JPY", "KRW", "CLP", "PYG", "ISK"].includes(account.currency?.toUpperCase()) ? 1 : 100;

        // Hierarchical Active Filtering: Fetch only ads that are ACTIVE throughout the entire hierarchy
        const activeAds = await this.prisma.unifiedAd.findMany({
            where: {
                platformAccountId,
                status: 'ACTIVE',
                adGroup: {
                    status: 'ACTIVE',
                    campaign: {
                        status: 'ACTIVE'
                    }
                }
            },
            select: { id: true, externalId: true, unifiedAdGroupId: true, adGroup: { select: { unifiedCampaignId: true } } }
        });

        if (activeAds.length === 0) {
            this.logger.log(`No active ads found in hierarchy for account #${platformAccountId}. Skipping insights sync.`);
            return { count: 0 };
        }

        const adIds = activeAds.map(a => a.externalId);
        const adMap = new Map(activeAds.map(a => [a.externalId, a]));

        // Fetch insights using corrected signature and parameters
        const fbInsights = await this.facebookApi.getInsights(
            account.externalId,
            token,
            start,
            end,
            'ad',
            granularity === 'hourly' ? 'hour' : undefined
        );

        let upsertedCount = 0;
        for (const record of fbInsights) {
            // Find ad in local map or self-heal
            let ad = adMap.get(record.ad_id);

            if (!ad) {
                // Self-healing: Ad might be in FB but not in our activeAds list (e.g. status mismatch or missing)
                this.logger.log(`Self-healing for insight ad ${record.ad_id}...`);
                // This would involve calling EntitySync logic or creating ad-hoc
                // For insights parity, we should ensure the ad exists if we want to store its data
                const adRecord = await this.prisma.unifiedAd.findUnique({
                    where: { id: record.ad_id },
                    include: { adGroup: true }
                });
                
                if (adRecord) {
                    ad = {
                        id: adRecord.id,
                        externalId: adRecord.externalId,
                        unifiedAdGroupId: adRecord.unifiedAdGroupId,
                        adGroup: { unifiedCampaignId: adRecord.adGroup?.unifiedCampaignId }
                    } as any;
                } else {
                    this.logger.warn(`Ad ${record.ad_id} not found locally even after checking DB. Skipping insight.`);
                    continue;
                }
            }

            const metrics = this.mapFbMetrics(record, offset);

            if (granularity === 'daily' || granularity === 'both') {
                await this.prisma.unifiedInsight.upsert({
                    where: {
                        platformAccountId_unifiedAdId_date: {
                            platformAccountId,
                            unifiedAdId: ad.id,
                            date: new Date(record.date_start),
                        }
                    },
                    create: {
                        platformAccountId,
                        unifiedAdId: ad.id,
                        unifiedAdGroupId: ad.unifiedAdGroupId,
                        unifiedCampaignId: ad.adGroup?.unifiedCampaignId,
                        date: new Date(record.date_start),
                        impressions: metrics.impressions,
                        clicks: metrics.clicks,
                        spend: metrics.spend,
                        reach: metrics.reach,
                        results: metrics.results,
                        conversions: metrics.conversions,
                        messagingTotal: metrics.messagingTotal,
                        messagingNew: metrics.messagingNew,
                        purchaseValue: metrics.purchaseValue,
                        syncedAt: now,
                    },
                    update: {
                        impressions: metrics.impressions,
                        clicks: metrics.clicks,
                        spend: metrics.spend,
                        reach: metrics.reach,
                        results: metrics.results,
                        conversions: metrics.conversions,
                        messagingTotal: metrics.messagingTotal,
                        messagingNew: metrics.messagingNew,
                        purchaseValue: metrics.purchaseValue,
                        syncedAt: now,
                    }
                });
                upsertedCount++;
            }

            if (granularity === 'hourly' || (granularity === 'both' && record.hour)) {
                const hour = parseInt(record.hour || '0');
                await this.prisma.unifiedHourlyInsight.upsert({
                    where: {
                        platformAccountId_unifiedAdId_date_hour: {
                            platformAccountId,
                            unifiedAdId: ad.id,
                            date: new Date(record.date_start),
                            hour,
                        }
                    },
                    create: {
                        platformAccountId,
                        unifiedAdId: ad.id,
                        unifiedAdGroupId: ad.unifiedAdGroupId,
                        unifiedCampaignId: ad.adGroup?.unifiedCampaignId,
                        date: new Date(record.date_start),
                        hour,
                        impressions: metrics.impressions,
                        clicks: metrics.clicks,
                        spend: metrics.spend,
                        results: metrics.results,
                        conversions: metrics.conversions,
                        messagingTotal: metrics.messagingTotal,
                        messagingNew: metrics.messagingNew,
                        purchaseValue: metrics.purchaseValue,
                        syncedAt: now,
                    },
                    update: {
                        impressions: metrics.impressions,
                        clicks: metrics.clicks,
                        spend: metrics.spend,
                        results: metrics.results,
                        conversions: metrics.conversions,
                        messagingTotal: metrics.messagingTotal,
                        messagingNew: metrics.messagingNew,
                        purchaseValue: metrics.purchaseValue,
                        syncedAt: now,
                    }
                });
            }
        }

        return { count: fbInsights.length, upsertedCount };
    }

    private mapFbMetrics(record: any, offset: number) {
        const actions = record.actions || [];
        const actionValues = record.action_values || [];
        
        const messagingTotal = actions.find(a => a.action_type === 'onsite_conversion.messaging_conversation_started_7d')?.value || 0;
        const messagingNew = actions.find(a => a.action_type === 'onsite_conversion.messaging_first_reply')?.value || 0;
        const purchaseValue = actionValues.find(a => a.action_type === 'purchase' || a.action_type === 'onsite_conversion.purchase')?.value || 0;
        
        // Exact logic from Supabase for results
        const results = actions.find(a => a.action_type === 'lead' || a.action_type === 'purchase' || a.action_type === 'onsite_conversion.messaging_conversation_started_7d')?.value || 0;

        return {
            impressions: record.impressions ? BigInt(record.impressions) : BigInt(0),
            clicks: record.clicks ? BigInt(record.clicks) : BigInt(0),
            spend: record.spend ? Number(record.spend) / offset : 0,
            reach: record.reach ? BigInt(record.reach) : BigInt(0),
            results: BigInt(results),
            conversions: record.conversions ? BigInt(record.conversions) : BigInt(0),
            messagingTotal: BigInt(messagingTotal),
            messagingNew: BigInt(messagingNew),
            purchaseValue: Number(purchaseValue) / offset,
        };
    }
}
