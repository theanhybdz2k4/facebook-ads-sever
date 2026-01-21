import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { PlatformsService } from '../platforms/platforms.service';

@Injectable()
export class CampaignsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly platformsService: PlatformsService,
    ) { }

    async findAll(userId: number, filters: {
        accountId?: number;
        status?: string;
        search?: string;
        branchId?: number;
        page?: number;
        limit?: number;
    }) {
        const page = filters.page || 1;
        const limit = filters.limit || 20;
        const skip = (page - 1) * limit;

        const where: any = {
            account: { identity: { userId } }
        };

        if (filters.accountId) {
            where.accountId = filters.accountId;
        }

        if (filters.status && filters.status !== 'all') {
            if (filters.status === 'ACTIVE') {
                where.status = 'ACTIVE';
                where.OR = [
                    { endTime: null },
                    { endTime: { gt: new Date() } },
                ];
            } else {
                where.status = filters.status;
            }
        }

        if (filters.branchId) {
            where.account = { ...where.account, branchId: filters.branchId };
        }

        if (filters.search) {
            where.OR = [
                { name: { contains: filters.search, mode: 'insensitive' } },
                { externalId: { contains: filters.search, mode: 'insensitive' } },
            ];
        }

        const total = await this.prisma.unifiedCampaign.count({ where });

        const data = await this.prisma.unifiedCampaign.findMany({
            where,
            include: {
                _count: { select: { adGroups: true } },
                account: { include: { platform: true } },
                insights: true,
            },
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
        });

        const dataWithStats = data.map((campaign) => {
            const stats = campaign.insights.reduce(
                (acc, curr) => {
                    return {
                        spend: acc.spend + Number(curr.spend || 0),
                        impressions: acc.impressions + Number(curr.impressions || 0),
                        clicks: acc.clicks + Number(curr.clicks || 0),
                        results: acc.results + Number(curr.results || 0),
                    };
                },
                { spend: 0, impressions: 0, clicks: 0, results: 0 },
            );

            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { insights, ...rest } = campaign;
            return {
                ...rest,
                stats,
            };
        });

        return {
            data: dataWithStats,
            meta: {
                total,
                page,
                limit,
                totalPages: Math.ceil(total / limit)
            }
        };
    }

    async findByAccountSimple(accountId: number) {
        return this.prisma.unifiedCampaign.findMany({
            where: { accountId },
            select: { id: true, externalId: true },
        });
    }

    async findOne(id: string) {
        const campaign = await this.prisma.unifiedCampaign.findUnique({
            where: { id },
            include: { adGroups: true, account: { include: { platform: true } } },
        });

        if (!campaign) throw new NotFoundException('Campaign not found');
        return campaign;
    }

    async updateStatus(id: string, status: 'ACTIVE' | 'PAUSED') {
        // 1. Update DB
        const campaign = await this.findOne(id);

        // 2. TODO: Gọi adapter tương ứng để update trực tiếp lên platform
        // const adapter = this.platformsService.getAdapter(campaign.account.platform.code);
        // await adapter.updateCampaignStatus(campaign.externalId, status);

        return this.prisma.unifiedCampaign.update({
            where: { id },
            data: { status },
        });
    }
}
