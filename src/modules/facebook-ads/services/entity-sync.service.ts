import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { FacebookApiService } from '../../shared/services/facebook-api.service';
import { TokensService } from '../../tokens/services/tokens.service';
import { CrawlJobService } from '../../jobs/services/crawl-job.service';
import { CrawlJobType } from '@prisma/client';
import { ACCOUNT_DELAY_MS } from '../../shared/constants/facebook-api.constants';

@Injectable()
export class EntitySyncService {
    private readonly logger = new Logger(EntitySyncService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly facebookApi: FacebookApiService,
        private readonly tokensService: TokensService,
        private readonly crawlJobService: CrawlJobService,
    ) { }

    // ==================== AD ACCOUNTS ====================

    async syncAdAccounts(fbAccountId: number, accessToken: string): Promise<number> {
        if (!accessToken) {
            throw new Error('No valid access token available');
        }

        this.logger.log('Syncing ad accounts...');
        const accounts = await this.facebookApi.getAdAccounts(accessToken);
        const now = new Date();

        // Batch upsert all accounts in single transaction
        if (accounts.length > 0) {
            await this.prisma.$transaction(
                accounts.map((account) =>
                    this.prisma.adAccount.upsert({
                        where: { id: account.id },
                        create: this.mapAdAccount(account, now),
                        update: this.mapAdAccount(account, now),
                    })
                )
            );
        }

        this.logger.log(`Synced ${accounts.length} ad accounts`);
        return accounts.length;
    }

    // ==================== CAMPAIGNS ====================

    async syncCampaigns(accountId: string): Promise<number> {
        // Internal use - called from processors/cron without userId context
        const accessToken = await this.tokensService.getTokenForAdAccountInternal(accountId);
        if (!accessToken) {
            throw new Error(`No valid token for account ${accountId}`);
        }

        const job = await this.crawlJobService.createJob({
            accountId,
            jobType: CrawlJobType.CAMPAIGNS,
        });

        try {
            await this.crawlJobService.startJob(job.id);
            // Only fetch ACTIVE campaigns - paused/ended campaigns will be replaced by new ones
            const campaigns = await this.facebookApi.getCampaigns(accountId, accessToken, true);
            const now = new Date();

            // Get all currently ACTIVE campaigns in DB for this account
            const existingActiveCampaigns = await this.prisma.campaign.findMany({
                where: { accountId, effectiveStatus: 'ACTIVE' },
                select: { id: true },
            });
            const fetchedIds = new Set(campaigns.map(c => c.id));

            // Mark campaigns no longer returned as ACTIVE -> PAUSED
            const missingIds = existingActiveCampaigns
                .filter(c => !fetchedIds.has(c.id))
                .map(c => c.id);

            if (missingIds.length > 0) {
                await this.prisma.campaign.updateMany({
                    where: { id: { in: missingIds } },
                    data: { effectiveStatus: 'PAUSED', syncedAt: now },
                });
                this.logger.log(`Marked ${missingIds.length} campaigns as PAUSED for ${accountId}`);
            }

            // Batch upsert all campaigns in a single transaction
            if (campaigns.length > 0) {
                await this.prisma.$transaction(
                    campaigns.map((campaign) =>
                        this.prisma.campaign.upsert({
                            where: { id: campaign.id },
                            create: this.mapCampaign(campaign, accountId, now),
                            update: this.mapCampaign(campaign, accountId, now),
                        })
                    )
                );
            }

            // Mark campaigns that have ended (stopTime in the past) as PAUSED
            const endedCampaignsResult = await this.prisma.campaign.updateMany({
                where: {
                    accountId,
                    effectiveStatus: 'ACTIVE',
                    stopTime: { lt: now },
                },
                data: { effectiveStatus: 'PAUSED', syncedAt: now },
            });
            if (endedCampaignsResult.count > 0) {
                this.logger.log(`Marked ${endedCampaignsResult.count} ended campaigns as PAUSED for ${accountId}`);
            }

            await this.crawlJobService.completeJob(job.id, campaigns.length);
            this.logger.log(`Synced ${campaigns.length} campaigns for ${accountId}`);
            return campaigns.length;
        } catch (error) {
            await this.crawlJobService.failJob(job.id, error.message);
            throw error;
        }
    }

    // ==================== ADSETS ====================

    async syncAdsets(accountId: string): Promise<number> {
        // Internal use - called from processors/cron without userId context
        const accessToken = await this.tokensService.getTokenForAdAccountInternal(accountId);
        if (!accessToken) {
            throw new Error(`No valid token for account ${accountId}`);
        }

        const job = await this.crawlJobService.createJob({
            accountId,
            jobType: CrawlJobType.ADSETS,
        });

        try {
            await this.crawlJobService.startJob(job.id);
            const now = new Date();

            // Only sync adsets from ACTIVE campaigns
            const activeCampaigns = await this.prisma.campaign.findMany({
                where: { accountId, effectiveStatus: 'ACTIVE' },
                select: { id: true },
            });

            if (activeCampaigns.length === 0) {
                this.logger.log(`No active campaigns for ${accountId}, skipping adsets sync`);
                await this.crawlJobService.completeJob(job.id, 0);
                return 0;
            }

            // Fetch adsets for all active campaigns
            const allAdsets: any[] = [];
            for (const campaign of activeCampaigns) {
                const adsets = await this.facebookApi.getAdsetsByCampaign(campaign.id, accessToken, accountId);
                allAdsets.push(...adsets);
            }

            // Get all currently ACTIVE adsets in DB for active campaigns only
            const activeCampaignIds = activeCampaigns.map(c => c.id);
            const existingActiveAdsets = await this.prisma.adset.findMany({
                where: { 
                    accountId, 
                    effectiveStatus: 'ACTIVE',
                    campaignId: { in: activeCampaignIds },
                },
                select: { id: true },
            });
            const fetchedIds = new Set(allAdsets.map(a => a.id));

            // Mark adsets no longer returned as ACTIVE -> INACTIVE
            const missingIds = existingActiveAdsets
                .filter(a => !fetchedIds.has(a.id))
                .map(a => a.id);

            if (missingIds.length > 0) {
                await this.prisma.adset.updateMany({
                    where: { id: { in: missingIds } },
                    data: { effectiveStatus: 'INACTIVE', syncedAt: now },
                });
                this.logger.log(`Marked ${missingIds.length} adsets as INACTIVE for ${accountId}`);
            }

            // Batch upsert all adsets in a single transaction
            if (allAdsets.length > 0) {
                await this.prisma.$transaction(
                    allAdsets.map((adset) =>
                        this.prisma.adset.upsert({
                            where: { id: adset.id },
                            create: this.mapAdset(adset, accountId, now),
                            update: this.mapAdset(adset, accountId, now),
                        })
                    )
                );
            }

            // Mark adsets that have ended (endTime in the past) as INACTIVE
            const endedAdsetsResult = await this.prisma.adset.updateMany({
                where: {
                    accountId,
                    effectiveStatus: 'ACTIVE',
                    endTime: { lt: now },
                },
                data: { effectiveStatus: 'INACTIVE', syncedAt: now },
            });
            if (endedAdsetsResult.count > 0) {
                this.logger.log(`Marked ${endedAdsetsResult.count} ended adsets as INACTIVE for ${accountId}`);
            }

            await this.crawlJobService.completeJob(job.id, allAdsets.length);
            this.logger.log(`Synced ${allAdsets.length} adsets from ${activeCampaigns.length} active campaigns for ${accountId}`);
            return allAdsets.length;
        } catch (error) {
            await this.crawlJobService.failJob(job.id, error.message);
            throw error;
        }
    }

    async syncAdsetsByCampaign(campaignId: string): Promise<number> {
        // First get the campaign to find its accountId
        const campaign = await this.prisma.campaign.findUnique({
            where: { id: campaignId },
        });

        if (!campaign) {
            throw new Error(`Campaign ${campaignId} not found`);
        }

        const accountId = campaign.accountId;
        // Internal use - called from processors/cron without userId context
        const accessToken = await this.tokensService.getTokenForAdAccountInternal(accountId);
        if (!accessToken) {
            throw new Error(`No valid token for account ${accountId}`);
        }

        const job = await this.crawlJobService.createJob({
            accountId,
            jobType: CrawlJobType.ADSETS,
        });

        try {
            await this.crawlJobService.startJob(job.id);
            const adsets = await this.facebookApi.getAdsetsByCampaign(campaignId, accessToken, accountId);
            const now = new Date();

            // Get all currently ACTIVE adsets in DB for this campaign
            const existingActiveAdsets = await this.prisma.adset.findMany({
                where: { campaignId, effectiveStatus: 'ACTIVE' },
                select: { id: true },
            });
            const fetchedIds = new Set(adsets.map(a => a.id));

            // Mark adsets no longer returned as ACTIVE -> INACTIVE
            const missingIds = existingActiveAdsets
                .filter(a => !fetchedIds.has(a.id))
                .map(a => a.id);

            if (missingIds.length > 0) {
                await this.prisma.adset.updateMany({
                    where: { id: { in: missingIds } },
                    data: { effectiveStatus: 'INACTIVE', syncedAt: now },
                });
                this.logger.log(`Marked ${missingIds.length} adsets as INACTIVE for campaign ${campaignId}`);
            }

            // Batch upsert all adsets in a single transaction
            if (adsets.length > 0) {
                await this.prisma.$transaction(
                    adsets.map((adset) =>
                        this.prisma.adset.upsert({
                            where: { id: adset.id },
                            create: this.mapAdset(adset, accountId, now),
                            update: this.mapAdset(adset, accountId, now),
                        })
                    )
                );
            }

            await this.crawlJobService.completeJob(job.id, adsets.length);
            this.logger.log(`Synced ${adsets.length} adsets for campaign ${campaignId}`);
            return adsets.length;
        } catch (error) {
            await this.crawlJobService.failJob(job.id, error.message);
            throw error;
        }
    }

    // ==================== ADS ====================

    async syncAds(accountId: string): Promise<number> {
        // Internal use - called from processors/cron without userId context
        const accessToken = await this.tokensService.getTokenForAdAccountInternal(accountId);
        if (!accessToken) {
            throw new Error(`No valid token for account ${accountId}`);
        }

        const job = await this.crawlJobService.createJob({
            accountId,
            jobType: CrawlJobType.ADS,
        });

        try {
            await this.crawlJobService.startJob(job.id);
            const now = new Date();

            // Only sync ads from ACTIVE adsets
            const activeAdsets = await this.prisma.adset.findMany({
                where: { accountId, effectiveStatus: 'ACTIVE' },
                select: { id: true },
            });

            if (activeAdsets.length === 0) {
                this.logger.log(`No active adsets for ${accountId}, skipping ads sync`);
                await this.crawlJobService.completeJob(job.id, 0);
                return 0;
            }

            // Fetch ads for all active adsets
            const allAds: any[] = [];
            for (const adset of activeAdsets) {
                const ads = await this.facebookApi.getAdsByAdset(adset.id, accessToken, accountId);
                allAds.push(...ads);
            }

            // Get all currently ACTIVE ads in DB for active adsets only
            const activeAdsetIds = activeAdsets.map(a => a.id);
            const existingActiveAds = await this.prisma.ad.findMany({
                where: { 
                    accountId, 
                    effectiveStatus: 'ACTIVE',
                    adsetId: { in: activeAdsetIds },
                },
                select: { id: true },
            });
            const fetchedIds = new Set(allAds.map(a => a.id));

            // Mark ads no longer returned as ACTIVE -> INACTIVE
            const missingIds = existingActiveAds
                .filter(a => !fetchedIds.has(a.id))
                .map(a => a.id);

            if (missingIds.length > 0) {
                await this.prisma.ad.updateMany({
                    where: { id: { in: missingIds } },
                    data: { effectiveStatus: 'INACTIVE', syncedAt: now },
                });
                this.logger.log(`Marked ${missingIds.length} ads as INACTIVE for ${accountId}`);
            }

            // Batch upsert all ads in single transaction
            if (allAds.length > 0) {
                await this.prisma.$transaction(
                    allAds.map((ad) =>
                        this.prisma.ad.upsert({
                            where: { id: ad.id },
                            create: this.mapAd(ad, accountId, now),
                            update: this.mapAd(ad, accountId, now),
                        })
                    )
                );
            }

            await this.crawlJobService.completeJob(job.id, allAds.length);
            this.logger.log(`Synced ${allAds.length} ads from ${activeAdsets.length} active adsets for ${accountId}`);
            return allAds.length;
        } catch (error) {
            await this.crawlJobService.failJob(job.id, error.message);
            throw error;
        }
    }

    async syncAdsByAdset(adsetId: string): Promise<number> {
        // First get the adset to find its accountId
        const adset = await this.prisma.adset.findUnique({
            where: { id: adsetId },
        });

        if (!adset) {
            throw new Error(`Adset ${adsetId} not found`);
        }

        const accountId = adset.accountId;
        // Internal use - called from processors/cron without userId context
        const accessToken = await this.tokensService.getTokenForAdAccountInternal(accountId);
        if (!accessToken) {
            throw new Error(`No valid token for account ${accountId}`);
        }

        const job = await this.crawlJobService.createJob({
            accountId,
            jobType: CrawlJobType.ADS,
        });

        try {
            await this.crawlJobService.startJob(job.id);
            const ads = await this.facebookApi.getAdsByAdset(adsetId, accessToken, accountId);
            const now = new Date();

            // Get all currently ACTIVE ads in DB for this adset
            const existingActiveAds = await this.prisma.ad.findMany({
                where: { adsetId, effectiveStatus: 'ACTIVE' },
                select: { id: true },
            });
            const fetchedIds = new Set(ads.map(a => a.id));

            // Mark ads no longer returned as ACTIVE -> INACTIVE
            const missingIds = existingActiveAds
                .filter(a => !fetchedIds.has(a.id))
                .map(a => a.id);

            if (missingIds.length > 0) {
                await this.prisma.ad.updateMany({
                    where: { id: { in: missingIds } },
                    data: { effectiveStatus: 'INACTIVE', syncedAt: now },
                });
                this.logger.log(`Marked ${missingIds.length} ads as INACTIVE for adset ${adsetId}`);
            }

            // Since we're syncing by adset, the adset already exists - just batch upsert
            if (ads.length > 0) {
                await this.prisma.$transaction(
                    ads.map((ad) =>
                        this.prisma.ad.upsert({
                            where: { id: ad.id },
                            create: this.mapAd(ad, accountId, now),
                            update: this.mapAd(ad, accountId, now),
                        })
                    )
                );
            }

            await this.crawlJobService.completeJob(job.id, ads.length);
            this.logger.log(`Synced ${ads.length} ads for adset ${adsetId}`);
            return ads.length;
        } catch (error) {
            await this.crawlJobService.failJob(job.id, error.message);
            throw error;
        }
    }

    async syncCreatives(accountId: string): Promise<number> {
        // Internal use - called from processors/cron without userId context
        const accessToken = await this.tokensService.getTokenForAdAccountInternal(accountId);
        if (!accessToken) {
            throw new Error(`No valid token for account ${accountId}`);
        }

        // Only sync creatives for ACTIVE ads to avoid fetching 9K+ unused creatives
        const activeAds = await this.prisma.ad.findMany({
            where: { accountId, effectiveStatus: 'ACTIVE' },
            select: { creative: true },
        });

        // Extract creative IDs from ads' creative JSON
        const creativeIds = activeAds
            .map(ad => (ad.creative as any)?.id)
            .filter((id): id is string => Boolean(id));

        if (creativeIds.length === 0) {
            this.logger.log(`No active ads with creatives for ${accountId}, skipping creatives sync`);
            return 0;
        }

        const job = await this.crawlJobService.createJob({
            accountId,
            jobType: CrawlJobType.CREATIVES,
        });

        try {
            await this.crawlJobService.startJob(job.id);
            
            // Fetch all creatives but only upsert ones linked to active ads
            const allCreatives = await this.facebookApi.getAdCreatives(accountId, accessToken);
            const now = new Date();

            // Filter to only creatives used by active ads
            const creativeIdSet = new Set(creativeIds);
            const relevantCreatives = allCreatives.filter(c => creativeIdSet.has(c.id));

            this.logger.log(`Filtered ${relevantCreatives.length} relevant creatives from ${allCreatives.length} total`);

            // Batch upsert only relevant creatives
            if (relevantCreatives.length > 0) {
                await this.prisma.$transaction(
                    relevantCreatives.map((creative) =>
                        this.prisma.creative.upsert({
                            where: { id: creative.id },
                            create: this.mapCreative(creative, accountId, now),
                            update: this.mapCreative(creative, accountId, now),
                        })
                    )
                );
            }

            await this.crawlJobService.completeJob(job.id, relevantCreatives.length);
            this.logger.log(`Synced ${relevantCreatives.length} creatives for ${accountId}`);
            return relevantCreatives.length;
        } catch (error) {
            await this.crawlJobService.failJob(job.id, error.message);
            throw error;
        }
    }

    // ==================== SYNC ALL FOR ACCOUNT ====================

    async syncAllEntities(accountId: string): Promise<void> {
        this.logger.log(`Starting full entity sync for ${accountId}`);

        await this.syncCampaigns(accountId);
        await this.delay(ACCOUNT_DELAY_MS);

        await this.syncAdsets(accountId);
        await this.delay(ACCOUNT_DELAY_MS);

        // Sync creatives BEFORE ads (ads have FK to creatives)
        await this.syncCreatives(accountId);
        await this.delay(ACCOUNT_DELAY_MS);

        await this.syncAds(accountId);

        this.logger.log(`Completed full entity sync for ${accountId}`);
    }

    // ==================== MAPPERS ====================

    private mapAdAccount(data: any, syncedAt: Date) {
        return {
            id: data.id,
            name: data.name,
            accountStatus: data.account_status || 1,
            age: data.age,
            amountSpent: data.amount_spent,
            balance: data.balance,
            businessId: data.business?.id,
            businessName: data.business?.name,
            currency: data.currency || 'USD',
            timezoneName: data.timezone_name,
            timezoneOffsetHoursUtc: data.timezone_offset_hours_utc,
            disableReason: data.disable_reason,
            fundingSource: data.funding_source,
            minCampaignGroupSpendCap: data.min_campaign_group_spend_cap,
            minDailyBudget: data.min_daily_budget,
            spendCap: data.spend_cap,
            owner: data.owner,
            isPrepayAccount: data.is_prepay_account,
            createdTime: data.created_time ? new Date(data.created_time) : null,
            endAdvertiser: data.end_advertiser,
            endAdvertiserName: data.end_advertiser_name,
            // rawJson removed to save Supabase storage
            syncedAt,
        };
    }

    private mapCampaign(data: any, accountId: string, syncedAt: Date) {
        return {
            id: data.id,
            accountId: accountId,
            name: data.name,
            objective: data.objective,
            status: data.status || 'UNKNOWN',
            configuredStatus: data.configured_status,
            effectiveStatus: data.effective_status,
            buyingType: data.buying_type,
            specialAdCategories: data.special_ad_categories,
            specialAdCategory: data.special_ad_category,
            specialAdCategoryCountry: data.special_ad_category_country,
            dailyBudget: data.daily_budget,
            lifetimeBudget: data.lifetime_budget,
            budgetRemaining: data.budget_remaining,
            spendCap: data.spend_cap,
            bidStrategy: data.bid_strategy,
            pacingType: data.pacing_type,
            startTime: data.start_time ? new Date(data.start_time) : null,
            stopTime: data.stop_time ? new Date(data.stop_time) : null,
            createdTime: data.created_time ? new Date(data.created_time) : null,
            updatedTime: data.updated_time ? new Date(data.updated_time) : null,
            sourceCampaignId: data.source_campaign_id,
            boostedObjectId: data.boosted_object_id,
            smartPromotionType: data.smart_promotion_type,
            isSkadnetworkAttribution: data.is_skadnetwork_attribution,
            issuesInfo: data.issues_info,
            recommendations: data.recommendations,
            // rawJson removed to save Supabase storage
            syncedAt,
        };
    }

    private mapAdset(data: any, accountId: string, syncedAt: Date) {
        return {
            id: data.id,
            campaignId: data.campaign_id,
            accountId: accountId,
            name: data.name,
            status: data.status || 'UNKNOWN',
            configuredStatus: data.configured_status,
            effectiveStatus: data.effective_status,
            dailyBudget: data.daily_budget,
            lifetimeBudget: data.lifetime_budget,
            budgetRemaining: data.budget_remaining,
            bidAmount: data.bid_amount,
            bidStrategy: data.bid_strategy,
            billingEvent: data.billing_event,
            optimizationGoal: data.optimization_goal,
            optimizationSubEvent: data.optimization_sub_event,
            pacingType: data.pacing_type,
            targeting: data.targeting || {},
            promotedObject: data.promoted_object,
            destinationType: data.destination_type,
            attributionSpec: data.attribution_spec,
            startTime: data.start_time ? new Date(data.start_time) : null,
            endTime: data.end_time ? new Date(data.end_time) : null,
            createdTime: data.created_time ? new Date(data.created_time) : null,
            updatedTime: data.updated_time ? new Date(data.updated_time) : null,
            learningStageInfo: data.learning_stage_info,
            isDynamicCreative: data.is_dynamic_creative,
            useNewAppClick: data.use_new_app_click,
            multiOptimizationGoalWeight: data.multi_optimization_goal_weight,
            rfPredictionId: data.rf_prediction_id,
            recurringBudgetSemantics: data.recurring_budget_semantics != null ? String(data.recurring_budget_semantics) : null,
            reviewFeedback: data.review_feedback,
            sourceAdsetId: data.source_adset_id,
            issuesInfo: data.issues_info,
            recommendations: data.recommendations,
            // rawJson removed to save Supabase storage
            syncedAt,
        };
    }

    private mapAd(data: any, accountId: string, syncedAt: Date) {
        return {
            id: data.id,
            adsetId: data.adset_id,
            campaignId: data.campaign_id,
            accountId: accountId,
            // Don't set creativeId to avoid FK constraint - creative data is in the 'creative' JSON field
            creativeId: null,
            name: data.name,
            status: data.status || 'UNKNOWN',
            configuredStatus: data.configured_status,
            effectiveStatus: data.effective_status,
            creative: data.creative,
            trackingSpecs: data.tracking_specs,
            conversionSpecs: data.conversion_specs,
            adReviewFeedback: data.ad_review_feedback,
            previewShareableLink: data.preview_shareable_link,
            sourceAdId: data.source_ad_id,
            createdTime: data.created_time ? new Date(data.created_time) : null,
            updatedTime: data.updated_time ? new Date(data.updated_time) : null,
            demolinkHash: data.demolink_hash,
            engagementAudience: data.engagement_audience,
            issuesInfo: data.issues_info,
            recommendations: data.recommendations,
            // rawJson removed to save Supabase storage
            syncedAt,
        };
    }

    private mapCreative(data: any, accountId: string, syncedAt: Date) {
        return {
            id: data.id,
            accountId: accountId,
            name: data.name,
            title: data.title,
            body: data.body,
            description: data.description,
            linkUrl: data.link_url,
            linkDestinationDisplayUrl: data.link_destination_display_url,
            callToActionType: data.call_to_action_type,
            // Set imageHash and videoId to null to avoid FK constraint errors
            // The raw image_hash and video_id are preserved in rawJson
            imageHash: null,
            imageUrl: data.image_url,
            videoId: null,
            thumbnailUrl: data.thumbnail_url,
            objectStorySpec: data.object_story_spec,
            objectStoryId: data.object_story_id,
            effectiveObjectStoryId: data.effective_object_story_id,
            objectId: data.object_id,
            objectType: data.object_type,
            instagramActorId: data.instagram_actor_id,
            instagramPermalinkUrl: data.instagram_permalink_url,
            productSetId: data.product_set_id,
            assetFeedSpec: data.asset_feed_spec,
            degreesOfFreedomSpec: data.degrees_of_freedom_spec,
            contextualMultiAds: data.contextual_multi_ads,
            urlTags: data.url_tags,
            templateUrl: data.template_url,
            templateUrlSpec: data.template_url_spec,
            usePageActorOverride: data.use_page_actor_override,
            authorizationCategory: data.authorization_category,
            runStatus: data.run_status,
            status: data.status,
            createdTime: data.created_time ? new Date(data.created_time) : null,
            // rawJson removed to save Supabase storage
            syncedAt,
        };
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
