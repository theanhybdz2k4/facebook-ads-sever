import { Injectable, Logger, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { FacebookApiService } from '../../shared/services/facebook-api.service';
import { TokensService } from '../../tokens/services/tokens.service';
import { CrawlJobService } from '../../jobs/services/crawl-job.service';
import { CrawlJobType } from '@prisma/client';

@Injectable()
export class AdSetsSyncService {
    private readonly logger = new Logger(AdSetsSyncService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly facebookApi: FacebookApiService,
        private readonly tokensService: TokensService,
        private readonly crawlJobService: CrawlJobService,
    ) { }

    async syncAdsets(accountId: string, userId: number): Promise<number> {
        const hasAccess = await this.verifyAccountAccess(userId, accountId);
        if (!hasAccess) {
            throw new ForbiddenException('Ad account not found or access denied');
        }

        const accessToken = await this.tokensService.getTokenForAdAccount(accountId, userId);
        if (!accessToken) {
            throw new BadRequestException(`No valid token for account ${accountId}`);
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

    async syncAdsetsByCampaign(campaignId: string, userId: number): Promise<number> {
        const campaign = await this.prisma.campaign.findFirst({
            where: {
                id: campaignId,
                account: { fbAccount: { userId } },
            },
        });

        if (!campaign) {
            throw new ForbiddenException('Campaign not found or access denied');
        }

        const accountId = campaign.accountId;
        const accessToken = await this.tokensService.getTokenForAdAccount(accountId, userId);
        if (!accessToken) {
            throw new BadRequestException(`No valid token for account ${accountId}`);
        }

        const job = await this.crawlJobService.createJob({
            accountId,
            jobType: CrawlJobType.ADSETS,
        });

        try {
            await this.crawlJobService.startJob(job.id);
            // Fetch ALL adsets under this campaign
            const adsets = await this.facebookApi.getAdsetsByCampaign(campaignId, accessToken, accountId, false);
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
            syncedAt,
        };
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

