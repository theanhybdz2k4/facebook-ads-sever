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
            const ads = await this.facebookApi.getAds(accountId, accessToken);
            const now = new Date();

            // Filter out ads with missing parent adsets
            let skippedCount = 0;
            const validAds = [];
            for (const ad of ads) {
                const adsetExists = await this.prisma.adset.findUnique({
                    where: { id: ad.adset_id },
                });
                if (adsetExists) {
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
            const ads = await this.facebookApi.getAdsByAdset(adsetId, accessToken, accountId);
            const now = new Date();

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

