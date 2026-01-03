import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { FacebookApiService } from './facebook-api.service';
import { TokenService } from './token.service';
import { CrawlJobService } from './crawl-job.service';
import { CrawlJobType } from '@prisma/client';
import { ACCOUNT_DELAY_MS } from '../constants/facebook-api.constants';

@Injectable()
export class EntitySyncService {
    private readonly logger = new Logger(EntitySyncService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly facebookApi: FacebookApiService,
        private readonly tokenService: TokenService,
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

        for (const account of accounts) {
            await this.prisma.adAccount.upsert({
                where: { id: account.id },
                create: this.mapAdAccount(account, now),
                update: this.mapAdAccount(account, now),
            });
        }

        this.logger.log(`Synced ${accounts.length} ad accounts`);
        return accounts.length;
    }

    // ==================== CAMPAIGNS ====================

    async syncCampaigns(accountId: string): Promise<number> {
        const accessToken = await this.tokenService.getTokenForAdAccount(accountId);
        if (!accessToken) {
            throw new Error(`No valid token for account ${accountId}`);
        }

        const job = await this.crawlJobService.createJob({
            accountId,
            jobType: CrawlJobType.CAMPAIGNS,
        });

        try {
            await this.crawlJobService.startJob(job.id);
            const campaigns = await this.facebookApi.getCampaigns(accountId, accessToken);
            const now = new Date();

            // Batch upsert all campaigns in a single transaction
            await this.prisma.$transaction(
                campaigns.map((campaign) =>
                    this.prisma.campaign.upsert({
                        where: { id: campaign.id },
                        create: this.mapCampaign(campaign, accountId, now),
                        update: this.mapCampaign(campaign, accountId, now),
                    })
                )
            );

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
        const accessToken = await this.tokenService.getTokenForAdAccount(accountId);
        if (!accessToken) {
            throw new Error(`No valid token for account ${accountId}`);
        }

        const job = await this.crawlJobService.createJob({
            accountId,
            jobType: CrawlJobType.ADSETS,
        });

        try {
            await this.crawlJobService.startJob(job.id);
            const adsets = await this.facebookApi.getAdsets(accountId, accessToken);
            const now = new Date();

            // Batch upsert all adsets in a single transaction
            await this.prisma.$transaction(
                adsets.map((adset) =>
                    this.prisma.adset.upsert({
                        where: { id: adset.id },
                        create: this.mapAdset(adset, accountId, now),
                        update: this.mapAdset(adset, accountId, now),
                    })
                )
            );

            await this.crawlJobService.completeJob(job.id, adsets.length);
            this.logger.log(`Synced ${adsets.length} adsets for ${accountId}`);
            return adsets.length;
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
        const accessToken = await this.tokenService.getTokenForAdAccount(accountId);
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

            // Batch upsert all adsets in a single transaction
            await this.prisma.$transaction(
                adsets.map((adset) =>
                    this.prisma.adset.upsert({
                        where: { id: adset.id },
                        create: this.mapAdset(adset, accountId, now),
                        update: this.mapAdset(adset, accountId, now),
                    })
                )
            );

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
        const accessToken = await this.tokenService.getTokenForAdAccount(accountId);
        if (!accessToken) {
            throw new Error(`No valid token for account ${accountId}`);
        }

        const job = await this.crawlJobService.createJob({
            accountId,
            jobType: CrawlJobType.ADS,
        });

        try {
            await this.crawlJobService.startJob(job.id);
            const ads = await this.facebookApi.getAds(accountId, accessToken);
            const now = new Date();

            let successCount = 0;
            let skippedCount = 0;

            for (const ad of ads) {
                try {
                    await this.prisma.ad.upsert({
                        where: { id: ad.id },
                        create: this.mapAd(ad, accountId, now),
                        update: this.mapAd(ad, accountId, now),
                    });
                    successCount++;
                } catch (error) {
                    // Skip ads with missing parent adsets/campaigns (FK constraint errors)
                    if (error.code === 'P2003') {
                        this.logger.warn(`Skipping ad ${ad.id}: parent adset/campaign not synced yet`);
                        skippedCount++;
                    } else {
                        throw error;
                    }
                }
            }

            await this.crawlJobService.completeJob(job.id, successCount);
            this.logger.log(`Synced ${successCount} ads for ${accountId} (skipped ${skippedCount})`);
            return successCount;
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
        const accessToken = await this.tokenService.getTokenForAdAccount(accountId);
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

            let successCount = 0;
            let skippedCount = 0;

            for (const ad of ads) {
                try {
                    await this.prisma.ad.upsert({
                        where: { id: ad.id },
                        create: this.mapAd(ad, accountId, now),
                        update: this.mapAd(ad, accountId, now),
                    });
                    successCount++;
                } catch (error) {
                    if (error.code === 'P2003') {
                        this.logger.warn(`Skipping ad ${ad.id}: parent adset/campaign not synced yet`);
                        skippedCount++;
                    } else {
                        throw error;
                    }
                }
            }

            await this.crawlJobService.completeJob(job.id, successCount);
            this.logger.log(`Synced ${successCount} ads for adset ${adsetId} (skipped ${skippedCount})`);
            return successCount;
        } catch (error) {
            await this.crawlJobService.failJob(job.id, error.message);
            throw error;
        }
    }

    async syncCreatives(accountId: string): Promise<number> {
        const accessToken = await this.tokenService.getTokenForAdAccount(accountId);
        if (!accessToken) {
            throw new Error(`No valid token for account ${accountId}`);
        }

        const job = await this.crawlJobService.createJob({
            accountId,
            jobType: CrawlJobType.CREATIVES,
        });

        try {
            await this.crawlJobService.startJob(job.id);
            const creatives = await this.facebookApi.getAdCreatives(accountId, accessToken);
            const now = new Date();

            // Batch upsert all creatives in a single transaction
            await this.prisma.$transaction(
                creatives.map((creative) =>
                    this.prisma.creative.upsert({
                        where: { id: creative.id },
                        create: this.mapCreative(creative, accountId, now),
                        update: this.mapCreative(creative, accountId, now),
                    })
                )
            );

            await this.crawlJobService.completeJob(job.id, creatives.length);
            this.logger.log(`Synced ${creatives.length} creatives for ${accountId}`);
            return creatives.length;
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
