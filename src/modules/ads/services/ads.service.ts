import { Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';

@Injectable()
export class AdsService {
    constructor(private readonly prisma: PrismaService) { }

    async getAds(userId: number, filters?: {
        accountId?: string;
        adsetId?: string;
        effectiveStatus?: string;
        search?: string;
        branchId?: string;
    }) {
        const accountFilter: any = {
            fbAccount: { userId },
        };

        if (filters?.branchId && filters.branchId !== 'all') {
            const parsedBranchId = Number(filters.branchId);
            if (!Number.isNaN(parsedBranchId)) {
                accountFilter.branchId = parsedBranchId;
            }
        }

        const ads = await this.prisma.ad.findMany({
            where: {
                ...(filters?.accountId && { accountId: filters.accountId }),
                ...(filters?.adsetId && { adsetId: filters.adsetId }),
                ...(filters?.effectiveStatus && { effectiveStatus: filters.effectiveStatus }),
                ...(filters?.search && {
                    OR: [
                        { name: { contains: filters.search, mode: 'insensitive' } },
                        { id: { contains: filters.search } },
                    ],
                }),
                // Only show ads where parent adset is truly ACTIVE (not ended)
                adset: {
                    effectiveStatus: 'ACTIVE',
                    OR: [
                        { endTime: null },
                        { endTime: { gte: new Date() } },
                    ],
                },
                account: accountFilter,
            },
            include: {
                account: { select: { id: true, name: true } },
                adset: { select: { id: true, name: true } },
                campaign: { select: { id: true, name: true } },
            },
            orderBy: { syncedAt: 'desc' },
            take: 100,
        });

        // Extract creative IDs and fetch thumbnails
        const creativeIds = ads
            .map((ad) => {
                const creative = ad.creative as Record<string, any> | null;
                return creative?.id;
            })
            .filter((id): id is string => !!id);

        const [creatives, insights] = await Promise.all([
            this.prisma.creative.findMany({
                where: { id: { in: creativeIds } },
                select: {
                    id: true,
                    imageUrl: true,
                    thumbnailUrl: true,
                },
            }),
            this.prisma.adInsightsDaily.groupBy({
                by: ['adId'],
                where: {
                    adId: { in: ads.map(a => a.id) }
                },
                _sum: {
                    spend: true,
                    results: true,
                    messagingStarted: true
                }
            })
        ]);

        const creativeMap = new Map(creatives.map((c) => [c.id, c]));
        const insightsMap = new Map(insights.map(i => [i.adId, i]));

        return ads.map((ad) => {
            let thumbnailUrl: string | null = null;
            const creativeJson = ad.creative as Record<string, any> | null;

            if (creativeJson?.id) {
                const creative = creativeMap.get(creativeJson.id);
                if (creative) {
                    thumbnailUrl = creative.thumbnailUrl || creative.imageUrl || null;
                }
            }

            if (!thumbnailUrl && creativeJson) {
                thumbnailUrl =
                    creativeJson.thumbnail_url ||
                    creativeJson.image_url ||
                    null;
            }

            // Calculate metrics
            const adInsights = insightsMap.get(ad.id);
            const totalSpend = Number(adInsights?._sum?.spend || 0);
            const totalResults = Number(adInsights?._sum?.results || 0);
            const totalMessaging = Number(adInsights?._sum?.messagingStarted || 0);

            const metrics = {
                results: totalResults,
                costPerResult: totalResults > 0 ? totalSpend / totalResults : 0,
                messagingStarted: totalMessaging,
                costPerMessaging: totalMessaging > 0 ? totalSpend / totalMessaging : 0,
            };

            return {
                ...ad,
                thumbnailUrl,
                metrics
            };
        });
    }

    async getAd(adId: string, userId: number) {
        const ad = await this.prisma.ad.findFirst({
            where: {
                id: adId,
                account: { fbAccount: { userId } },
            },
            include: {
                account: { select: { name: true, currency: true } },
                adset: { select: { name: true } },
                campaign: { select: { name: true } },
            },
        });

        if (!ad) {
            throw new ForbiddenException('Ad not found or access denied');
        }

        // Get thumbnail from creative
        let thumbnailUrl: string | null = null;
        const creativeJson = ad.creative as Record<string, any> | null;
        if (creativeJson?.id) {
            const creative = await this.prisma.creative.findUnique({
                where: { id: creativeJson.id },
                select: { thumbnailUrl: true, imageUrl: true },
            });
            if (creative) {
                thumbnailUrl = creative.thumbnailUrl || creative.imageUrl || null;
            }
        }

        return { ...ad, thumbnailUrl };
    }

    async verifyAccess(userId: number, adId: string): Promise<boolean> {
        const ad = await this.prisma.ad.findFirst({
            where: {
                id: adId,
                account: { fbAccount: { userId } },
            },
        });
        return !!ad;
    }
}

