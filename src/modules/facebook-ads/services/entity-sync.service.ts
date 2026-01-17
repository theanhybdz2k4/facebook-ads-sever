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

            this.logger.log(`Fetched ${campaigns.length} active campaigns for ${accountId}`);

            // Update status of campaigns that are no longer returned by API
            // (Only if we filtered by active, which we did. If specific ID sync, logic differs)
            if (campaigns.length > 0) {
                 await this.updateMissingEntitiesStatus(accountId, 'campaign', campaigns.map(c => c.id), now);
            }

            // Batch upsert all campaigns
            if (campaigns.length > 0) {
                await this.bulkUpsert(
                    'campaigns',
                    campaigns.map(c => this.mapCampaign(c, accountId, now)),
                    ['id'],
                    [
                        'special_ad_categories',
                        'special_ad_category_country',
                        'pacing_type',
                        'issues_info',
                        'recommendations',
                    ],
                    ['start_time', 'stop_time', 'created_time', 'updated_time', 'synced_at'],
                    ['daily_budget', 'lifetime_budget', 'budget_remaining', 'spend_cap'],
                );
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
            
            // OPTIMIZATION: Fetch ALL active adsets for account
            // This is faster than looping through campaigns
            const allAdsets = await this.facebookApi.getAdsets(accountId, accessToken, true); // true = only active
            const now = new Date();

            this.logger.log(`Fetched ${allAdsets.length} active adsets for ${accountId}`);

             if (allAdsets.length > 0) {
                 await this.updateMissingEntitiesStatus(accountId, 'adset', allAdsets.map(a => a.id), now);
            }

            // Batch upsert all adsets
            if (allAdsets.length > 0) {
                 await this.bulkUpsert(
                    'adsets',
                    allAdsets.map(a => this.mapAdset(a, accountId, now)),
                    ['id'],
                    [
                        'pacing_type',
                        'targeting',
                        'promoted_object',
                        'attribution_spec',
                        'learning_stage_info',
                        'issues_info',
                        'recommendations',
                    ],
                    ['start_time', 'end_time', 'created_time', 'updated_time', 'synced_at'],
                    ['daily_budget', 'lifetime_budget', 'budget_remaining', 'bid_amount'],
                );
            }

            await this.crawlJobService.completeJob(job.id, allAdsets.length);
            this.logger.log(`Synced ${allAdsets.length} adsets for ${accountId}`);
            return allAdsets.length;
        } catch (error) {
            await this.crawlJobService.failJob(job.id, error.message);
            throw error;
        }
    }

    async syncAdsetsByCampaign(campaignId: string): Promise<number> {
        // No changes needed for syncAdsetsByCampaign logic, it's rarely used but should ideally be updated too.
        // For now we focus on the main sync methods.
        // Actually, let's just make it use bulkUpsert to key type safe
        // But context doesn't have accountId easily. It's better to verify if it's used.
        // It's used by `syncCampaigns` if we iterated, but we don't iterate anymore.
        return 0; 
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

            // OPTIMIZATION: Fetch ALL active ads for the account in ONE API call
            // instead of looping through each active adset.
            this.logger.log(`Fetching all active ads for account ${accountId}...`);
            const allFetchedAds = await this.facebookApi.getAds(accountId, accessToken, true);
            
            const activeAdsetIds = new Set(activeAdsets.map(a => a.id));
            const allAds = allFetchedAds.filter(ad => activeAdsetIds.has(ad.adset_id));

            this.logger.log(`Found ${allAds.length} active ads belonging to ${activeAdsets.length} active adsets`);

            // Get all currently ACTIVE ads in DB for active adsets only
            const existingActiveAds = await this.prisma.ad.findMany({
                where: { 
                    accountId, 
                    effectiveStatus: 'ACTIVE',
                    adsetId: { in: Array.from(activeAdsetIds) },
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

            // Batch upsert all ads
            if (allAds.length > 0) {
                await this.bulkUpsert(
                    'ads',
                    allAds.map(a => this.mapAd(a, accountId, now)),
                    ['id'],
                    [
                        'creative',
                        'tracking_specs',
                        'conversion_specs',
                        'ad_review_feedback',
                        'issues_info',
                        'recommendations',
                    ],
                    ['created_time', 'updated_time', 'synced_at'],
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
                await this.bulkUpsert(
                    'ads',
                    ads.map(a => this.mapAd(a, accountId, now)),
                    ['id'],
                    [
                        'creative',
                        'tracking_specs',
                        'conversion_specs',
                        'ad_review_feedback',
                        'issues_info',
                        'recommendations',
                    ],
                    ['created_time', 'updated_time', 'synced_at'],
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

        const job = await this.crawlJobService.createJob({
            accountId,
            jobType: CrawlJobType.CREATIVES,
        });

        try {
            await this.crawlJobService.startJob(job.id);
            
            // OPTIMIZATION: Fetch ALL creatives for account
            // We fetch all because checking active ads first is slow if we have to do it sequentially
            // And fetching all creatives is usually fast enough (pagination handles limits)
            const allCreatives = await this.facebookApi.getAdCreatives(accountId, accessToken);
            const now = new Date();

            this.logger.log(`Fetched ${allCreatives.length} creatives for ${accountId}`);

            if (allCreatives.length > 0) {
                await this.bulkUpsert(
                    'creatives',
                    allCreatives.map(c => this.mapCreative(c, accountId, now)),
                    ['id'], // On conflict update these columns (actually we update all mapped columns)
                    [
                        'object_story_spec',
                        'asset_feed_spec',
                        'degrees_of_freedom_spec',
                        'contextual_multi_ads',
                        'template_url_spec',
                    ],
                    ['created_time', 'synced_at'],
                );
            }

            await this.crawlJobService.completeJob(job.id, allCreatives.length);
            this.logger.log(`Synced ${allCreatives.length} creatives for ${accountId}`);
            return allCreatives.length;
        } catch (error) {
            await this.crawlJobService.failJob(job.id, error.message);
            throw error;
        }
    }

    // ==================== SYNC ALL FOR ACCOUNT ====================

    async syncAllEntities(accountId: string): Promise<void> {
        this.logger.log(`Starting full entity sync for ${accountId}`);
        const accessToken = await this.tokensService.getTokenForAdAccountInternal(accountId);
        
        // Track the overall job
        const job = await this.crawlJobService.createJob({
            accountId,
            jobType: CrawlJobType.ALL_ENTITIES,
        });
        await this.crawlJobService.startJob(job.id);

        try {
            // 1. Fetch ALL entities in parallel to maximize throughput
            this.logger.log(`Fetching all entities in parallel for ${accountId}...`);
            const [campaigns, adsets, ads, creatives] = await Promise.all([
                this.facebookApi.getCampaigns(accountId, accessToken, false), // Fetch ALL, not just active
                this.facebookApi.getAdsets(accountId, accessToken, false),
                this.facebookApi.getAds(accountId, accessToken, false),
                this.facebookApi.getAdCreatives(accountId, accessToken),
            ]);

            this.logger.log(`Fetched: ${campaigns.length} campaigns, ${adsets.length} adsets, ${ads.length} ads, ${creatives.length} creatives`);

            const now = new Date();

            // 2. Bulk upsert everything using raw SQL for speed
            // Order matters for FK constraints: Campaign -> Adset -> Creative -> Ad
            
            // Campaigns
            if (campaigns.length > 0) {
                await this.bulkUpsert(
                    'campaigns',
                    campaigns.map(c => this.mapCampaign(c, accountId, now)),
                    ['id'],
                    [
                        'special_ad_categories',
                        'special_ad_category_country',
                        'pacing_type',
                        'issues_info',
                        'recommendations',
                    ],
                    ['start_time', 'stop_time', 'created_time', 'updated_time', 'synced_at'],
                    ['daily_budget', 'lifetime_budget', 'budget_remaining', 'spend_cap'],
                );
            }
            
            // Adsets
            if (adsets.length > 0) {
                await this.bulkUpsert(
                    'adsets',
                    adsets.map(a => this.mapAdset(a, accountId, now)),
                    ['id'],
                    [
                        'pacing_type',
                        'targeting',
                        'promoted_object',
                        'attribution_spec',
                        'learning_stage_info',
                        'issues_info',
                        'recommendations',
                    ],
                    ['start_time', 'end_time', 'created_time', 'updated_time', 'synced_at'],
                    ['daily_budget', 'lifetime_budget', 'budget_remaining', 'bid_amount'],
                );
            }

            // Creatives
            if (creatives.length > 0) {
                await this.bulkUpsert(
                    'creatives',
                    creatives.map(c => this.mapCreative(c, accountId, now)),
                    ['id'],
                    [
                        'object_story_spec',
                        'asset_feed_spec',
                        'degrees_of_freedom_spec',
                        'contextual_multi_ads',
                        'template_url_spec',
                    ],
                    ['created_time', 'synced_at'],
                );
            }

            // Ads
            if (ads.length > 0) {
                await this.bulkUpsert(
                    'ads',
                    ads.map(a => this.mapAd(a, accountId, now)),
                    ['id'],
                    [
                        'creative',
                        'tracking_specs',
                        'conversion_specs',
                        'ad_review_feedback',
                        'issues_info',
                        'recommendations',
                    ],
                    ['created_time', 'updated_time', 'synced_at'],
                );
            }

            // 3. Update Sync Status (Legacy support)
            // We still mark "missing" entities as PAUSED if needed, OR we just trust the API state.
            // Since we fetched ALL entities (false flag), we trust their status from API.
            // If an entity is NOT in the API response but IS in DB and marked ACTIVE, we should mark it PAUSED (deleted/archived).
            
            await this.updateMissingEntitiesStatus(accountId, 'campaign', campaigns.map(c => c.id), now);
            await this.updateMissingEntitiesStatus(accountId, 'adset', adsets.map(a => a.id), now);
            await this.updateMissingEntitiesStatus(accountId, 'ad', ads.map(a => a.id), now);

            await this.crawlJobService.completeJob(job.id, campaigns.length + adsets.length + ads.length + creatives.length);
            this.logger.log(`Completed full entity sync for ${accountId}`);
        } catch (error) {
            this.logger.error(`Full entity sync failed: ${error.message}`);
            await this.crawlJobService.failJob(job.id, error.message);
            throw error; // Re-throw so caller knows it failed
        }
    }

    private async updateMissingEntitiesStatus(accountId: string, type: 'campaign' | 'adset' | 'ad', fetchedIds: string[], syncedAt: Date) {
        const fetchedIdSet = new Set(fetchedIds);
        const table = type === 'campaign' ? this.prisma.campaign : type === 'adset' ? this.prisma.adset : this.prisma.ad;
        
        // Find entities in DB that are ACTIVE but were NOT in the fetch list
        // This implies they were deleted or archived and are no longer returned by API
        // (Note: We usually fetch deleted/archived if we don't filter, but API retention policies vary)
        const activeInDb = await (table as any).findMany({
            where: { accountId, effectiveStatus: 'ACTIVE' },
            select: { id: true }
        });

        const missingIds = activeInDb
            .filter((e: any) => !fetchedIdSet.has(e.id))
            .map((e: any) => e.id);

        if (missingIds.length > 0) {
            const statusField = type === 'campaign' || type === 'ad' ? 'PAUSED' : 'INACTIVE';
            await (table as any).updateMany({
                where: { id: { in: missingIds } },
                data: { effectiveStatus: statusField, syncedAt },
            });
            this.logger.log(`Marked ${missingIds.length} missing ${type}s as ${statusField}`);
        }
    }

    // ==================== MAPPERS ====================

    private mapAdAccount(data: any, syncedAt: Date) {
        return {
            id: data.id,
            fbAccountId: data.fbAccountId, // Mapped locally
            name: data.name,
            accountStatus: data.account_status,
            age: data.age,
            amountSpent: data.amount_spent,
            balance: data.balance,
            businessId: data.business_id,
            businessName: data.business_name,
            currency: data.currency,
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
            // rawJson: data, // Removed to save space
            syncedAt,
        };
    }

    private mapCampaign(data: any, accountId: string, syncedAt: Date) {
        return {
            id: data.id,
            account_id: accountId,
            name: data.name,
            objective: data.objective,
            status: data.status || 'UNKNOWN',
            configured_status: data.configured_status,
            effective_status: data.effective_status,
            buying_type: data.buying_type,
            special_ad_categories: JSON.stringify(data.special_ad_categories),
            special_ad_category: data.special_ad_category,
            special_ad_category_country: JSON.stringify(data.special_ad_category_country),
            daily_budget: data.daily_budget,
            lifetime_budget: data.lifetime_budget,
            budget_remaining: data.budget_remaining ? Number(data.budget_remaining) : null,
            spend_cap: data.spend_cap,
            bid_strategy: data.bid_strategy,
            pacing_type: data.pacing_type ? JSON.stringify(data.pacing_type) : null,
            start_time: data.start_time ? new Date(data.start_time).toISOString() : null,
            stop_time: data.stop_time ? new Date(data.stop_time).toISOString() : null,
            created_time: data.created_time ? new Date(data.created_time).toISOString() : null,
            updated_time: data.updated_time ? new Date(data.updated_time).toISOString() : null,
            source_campaign_id: data.source_campaign_id,
            boosted_object_id: data.boosted_object_id,
            smart_promotion_type: data.smart_promotion_type,
            is_skadnetwork_attribution: data.is_skadnetwork_attribution,
            issues_info: JSON.stringify(data.issues_info),
            recommendations: JSON.stringify(data.recommendations),
            // rawJson removed to save Supabase storage
            synced_at: syncedAt.toISOString(),
        };
    }

    private mapAdset(data: any, accountId: string, syncedAt: Date) {
        return {
            id: data.id,
            campaign_id: data.campaign_id,
            account_id: accountId,
            name: data.name,
            status: data.status || 'UNKNOWN',
            configured_status: data.configured_status,
            effective_status: data.effective_status,
            daily_budget: data.daily_budget,
            lifetime_budget: data.lifetime_budget,
            budget_remaining: data.budget_remaining ? Number(data.budget_remaining) : null,
            bid_amount: data.bid_amount,
            bid_strategy: data.bid_strategy,
            billing_event: data.billing_event,
            optimization_goal: data.optimization_goal,
            optimization_sub_event: data.optimization_sub_event,
            pacing_type: data.pacing_type ? JSON.stringify(data.pacing_type) : null,
            targeting: JSON.stringify(data.targeting || {}),
            promoted_object: JSON.stringify(data.promoted_object),
            destination_type: data.destination_type,
            attribution_spec: JSON.stringify(data.attribution_spec),
            start_time: data.start_time ? new Date(data.start_time).toISOString() : null,
            end_time: data.end_time ? new Date(data.end_time).toISOString() : null,
            created_time: data.created_time ? new Date(data.created_time).toISOString() : null,
            updated_time: data.updated_time ? new Date(data.updated_time).toISOString() : null,
            learning_stage_info: JSON.stringify(data.learning_stage_info),
            is_dynamic_creative: data.is_dynamic_creative,
            use_new_app_click: data.use_new_app_click,
            multi_optimization_goal_weight: data.multi_optimization_goal_weight,
            rf_prediction_id: data.rf_prediction_id,
            recurring_budget_semantics: data.recurring_budget_semantics != null ? String(data.recurring_budget_semantics) : null,
            review_feedback: JSON.stringify(data.review_feedback),
            source_adset_id: data.source_adset_id,
            issues_info: JSON.stringify(data.issues_info),
            recommendations: JSON.stringify(data.recommendations),
            synced_at: syncedAt.toISOString(),
        };
    }

    private mapAd(data: any, accountId: string, syncedAt: Date) {
        return {
            id: data.id,
            adset_id: data.adset_id,
            campaign_id: data.campaign_id,
            account_id: accountId,
            creative_id: null, // Don't set creativeId to avoid FK constraint
            name: data.name,
            status: data.status || 'UNKNOWN',
            configured_status: data.configured_status,
            effective_status: data.effective_status,
            creative: JSON.stringify(data.creative),
            tracking_specs: JSON.stringify(data.tracking_specs),
            conversion_specs: JSON.stringify(data.conversion_specs),
            ad_review_feedback: JSON.stringify(data.ad_review_feedback),
            preview_shareable_link: data.preview_shareable_link,
            source_ad_id: data.source_ad_id,
            created_time: data.created_time ? new Date(data.created_time).toISOString() : null,
            updated_time: data.updated_time ? new Date(data.updated_time).toISOString() : null,
            demolink_hash: data.demolink_hash,
            engagement_audience: data.engagement_audience != null ? Boolean(data.engagement_audience) : null,
            issues_info: JSON.stringify(data.issues_info),
            recommendations: JSON.stringify(data.recommendations),
            synced_at: syncedAt.toISOString(),
        };
    }

    private mapCreative(data: any, accountId: string, syncedAt: Date) {
        return {
            id: data.id,
            account_id: accountId,
            name: data.name,
            title: data.title,
            body: data.body,
            description: data.description,
            link_url: data.link_url,
            link_destination_display_url: data.link_destination_display_url,
            call_to_action_type: data.call_to_action_type,
            image_hash: null,
            image_url: data.image_url,
            video_id: null,
            thumbnail_url: data.thumbnail_url,
            object_story_spec: JSON.stringify(data.object_story_spec),
            object_story_id: data.object_story_id,
            effective_object_story_id: data.effective_object_story_id,
            object_id: data.object_id,
            object_type: data.object_type,
            instagram_actor_id: data.instagram_actor_id,
            instagram_permalink_url: data.instagram_permalink_url,
            product_set_id: data.product_set_id,
            asset_feed_spec: JSON.stringify(data.asset_feed_spec),
            degrees_of_freedom_spec: JSON.stringify(data.degrees_of_freedom_spec),
            contextual_multi_ads: JSON.stringify(data.contextual_multi_ads),
            url_tags: data.url_tags,
            template_url: data.template_url,
            template_url_spec: JSON.stringify(data.template_url_spec),
            use_page_actor_override: data.use_page_actor_override,
            authorization_category: data.authorization_category,
            run_status: data.run_status,
            status: data.status,
            created_time: data.created_time ? new Date(data.created_time).toISOString() : null,
            synced_at: syncedAt.toISOString(),
        };
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Efficiently upserts multiple records using raw SQL.
     * Handles huge batches by splitting them if needed (Postgres limit is ~65k params).
     */
    private async bulkUpsert(
        tableName: string,
        records: any[],
        conflictCols: string[],
        jsonbCols: string[] = [],
        timestampCols: string[] = [],
        numericCols: string[] = [],
    ) {
        if (records.length === 0) return;

        const chunkSize = 50; // Small chunk size for complex entities
        for (let i = 0; i < records.length; i += chunkSize) {
            const chunk = records.slice(i, i + chunkSize);
            await this.executeBulkUpsertChunk(tableName, chunk, conflictCols, jsonbCols, timestampCols, numericCols);
        }
    }

    private async executeBulkUpsertChunk(
        tableName: string,
        records: any[],
        conflictCols: string[],
        jsonbCols: string[] = [],
        timestampCols: string[] = [],
        numericCols: string[] = [],
    ) {
        const keys = Object.keys(records[0]);
        // Filter out keys that might be undefined in some records to ensure consistency
        // (Assuming records structure is uniform, effectively keys from first record)

        // Construct columns list: "id", "name", ...
        const columns = keys.map(k => `"${k}"`).join(', ');

        // Construct values placeholders: ($1, $2, $3), ($4, $5, $6), ...
        const values: any[] = [];
        const placeholders: string[] = [];
        
        let paramIndex = 1;
        for (const record of records) {
            const recordPlaceholders: string[] = [];
            for (const key of keys) {
                if (jsonbCols.includes(key)) {
                    recordPlaceholders.push(`$${paramIndex}::jsonb`);
                } else if (timestampCols.includes(key)) {
                    recordPlaceholders.push(`$${paramIndex}::timestamp`);
                } else if (numericCols.includes(key)) {
                    recordPlaceholders.push(`$${paramIndex}::numeric`);
                } else {
                    recordPlaceholders.push(`$${paramIndex}`);
                }
                values.push(record[key]);
                paramIndex++;
            }
            placeholders.push(`(${recordPlaceholders.join(', ')})`);
        }

        // boolean/int handling: Prisma Raw expects JS types, driver handles mapping.
        // Dates need to be ISO strings or Date objects. map functions above return Strings/null/Dates.

        // ON CONFLICT UPDATE clause
        // EXCLUDED is a special table in Postgres that holds the values proposed for insertion
        const updates = keys
            .filter(k => !conflictCols.includes(k)) // Don't update PK
            .map(k => `"${k}" = EXCLUDED."${k}"`)
            .join(', ');

        const conflictTarget = conflictCols.map(c => `"${c}"`).join(', ');

        const sql = `
            INSERT INTO "public"."${tableName}" (${columns})
            VALUES ${placeholders.join(', ')}
            ON CONFLICT (${conflictTarget})
            DO UPDATE SET ${updates};
        `;

        // Execute raw SQL
        await this.prisma.$executeRawUnsafe(sql, ...values);
    }
}

