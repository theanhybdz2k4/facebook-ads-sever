import { Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';

@Injectable()
export class CampaignsService {
    constructor(private readonly prisma: PrismaService) { }

    /**
     * List campaigns for a user
     */
    async getCampaigns(userId: number, filters?: {
        accountId?: string;
        effectiveStatus?: string;
        search?: string;
    }) {
        return this.prisma.campaign.findMany({
            where: {
                ...(filters?.accountId && { accountId: filters.accountId }),
                ...(filters?.effectiveStatus && { effectiveStatus: filters.effectiveStatus }),
                ...(filters?.search && {
                    OR: [
                        { name: { contains: filters.search, mode: 'insensitive' } },
                        { id: { contains: filters.search } },
                    ],
                }),
                account: { fbAccount: { userId } },
            },
            include: {
                account: {
                    select: {
                        id: true,
                        name: true,
                    },
                },
                _count: {
                    select: {
                        adsets: true,
                        ads: true,
                    },
                },
            },
            orderBy: { syncedAt: 'desc' },
            take: 100,
        });
    }

    /**
     * Get campaign by ID (with ownership check)
     */
    async getCampaign(campaignId: string, userId: number) {
        const campaign = await this.prisma.campaign.findFirst({
            where: {
                id: campaignId,
                account: { fbAccount: { userId } },
            },
            include: {
                account: {
                    select: {
                        id: true,
                        name: true,
                    },
                },
            },
        });

        if (!campaign) {
            throw new ForbiddenException('Campaign not found or access denied');
        }

        return campaign;
    }

    /**
     * Verify user has access to campaign
     */
    async verifyAccess(userId: number, campaignId: string): Promise<boolean> {
        const campaign = await this.prisma.campaign.findFirst({
            where: {
                id: campaignId,
                account: { fbAccount: { userId } },
            },
        });
        return !!campaign;
    }
}

