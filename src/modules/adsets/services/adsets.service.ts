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

        return this.prisma.adset.findMany({
            where: {
                ...(filters?.accountId && { accountId: filters.accountId }),
                ...(filters?.campaignId && { campaignId: filters.campaignId }),
                ...(filters?.effectiveStatus && { effectiveStatus: filters.effectiveStatus }),
                ...(filters?.search && {
                    OR: [
                        { name: { contains: filters.search, mode: 'insensitive' } },
                        { id: { contains: filters.search } },
                    ],
                }),
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

