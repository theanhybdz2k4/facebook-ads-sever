import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';

@Injectable()
export class AdsService {
    constructor(private readonly prisma: PrismaService) { }

    async findByAdGroup(adGroupId: string) {
        return this.prisma.unifiedAd.findMany({
            where: { adGroupId },
            include: { adGroup: true, account: { include: { platform: true } } },
        });
    }

    async findAll(userId: number, filters: { accountId?: number; adGroupId?: string; status?: string; effectiveStatus?: string; search?: string; branchId?: number }) {
        const where: any = {
            account: { identity: { userId } }
        };

        if (filters.accountId) {
            where.accountId = filters.accountId;
        }

        if (filters.adGroupId) {
            where.adGroupId = filters.adGroupId;
        }

        if (filters.status && filters.status !== 'all') {
            where.status = filters.status;
        }

        if (filters.effectiveStatus && filters.effectiveStatus !== 'all') {
            where.effectiveStatus = filters.effectiveStatus;
        }

        if (filters.branchId) {
            where.account.branchId = filters.branchId;
        }

        if (filters.search) {
            where.OR = [
                { name: { contains: filters.search, mode: 'insensitive' } },
                { externalId: { contains: filters.search, mode: 'insensitive' } },
            ];
        }

        const ads = await this.prisma.unifiedAd.findMany({
            where,
            include: {
                account: { include: { platform: true } },
                adGroup: {
                    include: {
                        campaign: true
                    }
                },
                creative: true,
            },
            orderBy: { createdAt: 'desc' },
        });

        if (ads.length === 0) return [];

        const adIds = ads.map(a => a.id);

        // Fetch aggregated insights for these ads (lifetime or total for now)
        const insights = await this.prisma.unifiedInsight.groupBy({
            by: ['adId'],
            where: {
                adId: { in: adIds }
            },
            _sum: {
                spend: true,
                impressions: true,
                clicks: true,
                reach: true,
                results: true,
                conversions: true,
            }
        });

        // Map insights to ads
        const insightMap = new Map(insights.map(i => [i.adId, i]));

        return ads.map(ad => {
            const sumData = insightMap.get(ad.id);
            const totalSpend = Number(sumData?._sum?.spend || 0);
            const totalResults = Number(sumData?._sum?.results || 0);
            const totalImpressions = Number(sumData?._sum?.impressions || 0);
            const totalClicks = Number(sumData?._sum?.clicks || 0);
            const totalReach = Number(sumData?._sum?.reach || 0);

            const summary = {
                totalSpend,
                totalImpressions,
                totalClicks,
                totalReach,
                totalResults,
                avgCtr: totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0,
                avgCpc: totalClicks > 0 ? totalSpend / totalClicks : 0,
                avgCpm: totalImpressions > 0 ? (totalSpend / totalImpressions) * 1000 : 0,
                avgCpr: totalResults > 0 ? totalSpend / totalResults : 0,
            };

            return {
                ...ad,
                campaign: ad.adGroup?.campaign,
                adset: ad.adGroup,
                thumbnailUrl: (ad as any).creative?.thumbnailUrl || null,
                // Match frontend expectations for list view metrics
                metrics: {
                    results: totalResults,
                    costPerResult: summary.avgCpr,
                    messagingStarted: totalResults, // Proxy
                    costPerMessaging: summary.avgCpr,
                },
                totalSpend,
                totalResults,
                avgCpr: summary.avgCpr,
            };
        });
    }

    async findOne(id: string) {
        const ad = await this.prisma.unifiedAd.findUnique({
            where: { id },
            include: { adGroup: true },
        });
        if (!ad) throw new NotFoundException('Ad not found');
        return ad;
    }
}
