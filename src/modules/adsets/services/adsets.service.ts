import { Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';

@Injectable()
export class AdSetsService {
    constructor(private readonly prisma: PrismaService) { }

    async getAdsets(userId: number, filters?: {
        accountId?: string;
        campaignId?: string;
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

        // Build where clause with proper ACTIVE filtering
        // Facebook API returns effective_status = ACTIVE even for ended adsets
        const isFilteringActive = filters?.effectiveStatus === 'ACTIVE';

        return this.prisma.adset.findMany({
            where: {
                ...(filters?.accountId && { accountId: filters.accountId }),
                ...(filters?.campaignId && { campaignId: filters.campaignId }),
                ...(filters?.effectiveStatus && { effectiveStatus: filters.effectiveStatus }),
                // When filtering ACTIVE, exclude adsets that have ended (endTime in the past)
                ...(isFilteringActive && {
                    OR: [
                        { endTime: null },  // No end time set
                        { endTime: { gte: new Date() } },  // End time in the future
                    ],
                }),
                ...(filters?.search && {
                    OR: [
                        { name: { contains: filters.search, mode: 'insensitive' } },
                        { id: { contains: filters.search } },
                    ],
                }),
                // Only show adsets where parent campaign is truly ACTIVE (not ended)
                campaign: {
                    effectiveStatus: 'ACTIVE',
                    OR: [
                        { stopTime: null },
                        { stopTime: { gte: new Date() } },
                    ],
                },
                account: accountFilter,
            },
            include: {
                account: { select: { id: true, name: true } },
                campaign: { select: { id: true, name: true } },
                _count: { select: { ads: true } },
            },
            orderBy: { syncedAt: 'desc' },
            take: 100,
        });
    }

    async getAdset(adsetId: string, userId: number) {
        const adset = await this.prisma.adset.findFirst({
            where: {
                id: adsetId,
                account: { fbAccount: { userId } },
            },
            include: {
                account: { select: { id: true, name: true } },
                campaign: { select: { id: true, name: true } },
            },
        });

        if (!adset) {
            throw new ForbiddenException('Adset not found or access denied');
        }

        return adset;
    }

    async verifyAccess(userId: number, adsetId: string): Promise<boolean> {
        const adset = await this.prisma.adset.findFirst({
            where: {
                id: adsetId,
                account: { fbAccount: { userId } },
            },
        });
        return !!adset;
    }
}

