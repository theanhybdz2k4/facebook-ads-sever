import { Injectable, Logger, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { FacebookApiService } from '../../shared/services/facebook-api.service';
import { TokensService } from '../../tokens/services/tokens.service';
import { CrawlJobService } from '../../jobs/services/crawl-job.service';
import { CrawlJobType } from '@prisma/client';

@Injectable()
export class CampaignsSyncService {
    private readonly logger = new Logger(CampaignsSyncService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly facebookApi: FacebookApiService,
        private readonly tokensService: TokensService,
        private readonly crawlJobService: CrawlJobService,
    ) { }

    /**
     * Sync campaigns for an ad account
     */
    async syncCampaigns(accountId: string, userId: number): Promise<number> {
        // Verify ownership
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
            jobType: CrawlJobType.CAMPAIGNS,
        });

        try {
            await this.crawlJobService.startJob(job.id);
            // Fetch ALL campaigns so that `effective_status` in DB always
            // reflects the latest state on Meta (ACTIVE, PAUSED, DELETED, ...)
            const campaigns = await this.facebookApi.getCampaigns(accountId, accessToken, false);
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

            await this.crawlJobService.completeJob(job.id, campaigns.length);
            this.logger.log(`Synced ${campaigns.length} campaigns for ${accountId}`);
            return campaigns.length;
        } catch (error) {
            await this.crawlJobService.failJob(job.id, error.message);
            throw error;
        }
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

