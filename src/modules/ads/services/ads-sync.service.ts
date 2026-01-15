import { Injectable, Logger, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { FacebookApiService } from '../../shared/services/facebook-api.service';
import { TokensService } from '../../tokens/services/tokens.service';
import { CrawlJobService } from '../../jobs/services/crawl-job.service';
import { CrawlJobType } from '@prisma/client';

@Injectable()
export class AdsSyncService {
    private readonly logger = new Logger(AdsSyncService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly facebookApi: FacebookApiService,
        private readonly tokensService: TokensService,
        private readonly crawlJobService: CrawlJobService,
    ) { }

    async syncAds(accountId: string, userId: number): Promise<number> {
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
            jobType: CrawlJobType.ADS,
        });

        try {
            await this.crawlJobService.startJob(job.id);
            // Fetch ALL ads so `effective_status` in DB always reflects Meta
            const ads = await this.facebookApi.getAds(accountId, accessToken, false);
            const now = new Date();

            // Get all currently ACTIVE ads in DB for this account
            const existingActiveAds = await this.prisma.ad.findMany({
                where: { accountId, effectiveStatus: 'ACTIVE' },
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
                this.logger.log(`Marked ${missingIds.length} ads as INACTIVE for ${accountId}`);
            }

            // Pre-fetch existing adset IDs to filter out orphan ads
            const existingAdsets = await this.prisma.adset.findMany({
                where: { accountId },
                select: { id: true },
            });
            const adsetIds = new Set(existingAdsets.map(a => a.id));

            // Filter out ads with missing parent adsets
            let skippedCount = 0;
            const validAds = [];
            for (const ad of ads) {
                if (adsetIds.has(ad.adset_id)) {
                    validAds.push(ad);
                } else {
                    skippedCount++;
                }
            }

            if (skippedCount > 0) {
                this.logger.warn(`Skipping ${skippedCount} ads with missing parent adsets`);
            }

            if (validAds.length > 0) {
                await this.prisma.$transaction(
                    validAds.map((ad) =>
                        this.prisma.ad.upsert({
                            where: { id: ad.id },
                            create: this.mapAd(ad, accountId, now),
                            update: this.mapAd(ad, accountId, now),
                        })
                    )
                );
            }

            await this.crawlJobService.completeJob(job.id, validAds.length);
            this.logger.log(`Synced ${validAds.length} ads for ${accountId} (skipped ${skippedCount})`);
            return validAds.length;
        } catch (error) {
            await this.crawlJobService.failJob(job.id, error.message);
            throw error;
        }
    }

    async syncAdsByAdset(adsetId: string, userId: number): Promise<number> {
        const adset = await this.prisma.adset.findFirst({
            where: {
                id: adsetId,
                account: { fbAccount: { userId } },
            },
        });

        if (!adset) {
            throw new ForbiddenException('Adset not found or access denied');
        }

        const accountId = adset.accountId;
        const accessToken = await this.tokensService.getTokenForAdAccount(accountId, userId);
        if (!accessToken) {
            throw new BadRequestException(`No valid token for account ${accountId}`);
        }

        const job = await this.crawlJobService.createJob({
            accountId,
            jobType: CrawlJobType.ADS,
        });

        try {
            await this.crawlJobService.startJob(job.id);
            // Fetch ALL ads under this adset
            const ads = await this.facebookApi.getAdsByAdset(adsetId, accessToken, accountId, false);
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

    private mapAd(data: any, accountId: string, syncedAt: Date) {
        return {
            id: data.id,
            adsetId: data.adset_id,
            campaignId: data.campaign_id,
            accountId: accountId,
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

