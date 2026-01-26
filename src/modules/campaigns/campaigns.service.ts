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
        dateStart?: string;
        dateEnd?: string;
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

        // ✅ Optimization: Fetch count and data in parallel
        const [total, data] = await Promise.all([
            this.prisma.unifiedCampaign.count({ where }),
            this.prisma.unifiedCampaign.findMany({
                where,
                select: {
                    id: true,
                    externalId: true,
                    name: true,
                    status: true,
                    objective: true,
                    dailyBudget: true,
                    lifetimeBudget: true,
                    startTime: true,
                    endTime: true,
                    effectiveStatus: true,
                    syncedAt: true,
                    createdAt: true,
                    accountId: true,
                    account: { 
                        select: { 
                            id: true, 
                            name: true,
                            platform: { select: { code: true, name: true } },
                        } 
                    },
                    _count: { select: { adGroups: true } },
                },
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit,
            }),
        ]);

        // ✅ Optimization: Use aggregation instead of fetching all insights
        const campaignIds = data.map(c => c.id);
        
        const statsWhere: any = { campaignId: { in: campaignIds } };
        if (filters.dateStart || filters.dateEnd) {
            statsWhere.date = {};
            if (filters.dateStart) statsWhere.date.gte = new Date(filters.dateStart);
            if (filters.dateEnd) statsWhere.date.lte = new Date(filters.dateEnd);
        }

        const stats = await this.prisma.unifiedInsight.groupBy({
            by: ['campaignId'],
            where: statsWhere,
            _sum: {
                spend: true,
                impressions: true,
                clicks: true,
                results: true,
            },
        });

        const statsMap = new Map(stats.map(s => [s.campaignId, s._sum]));

        const dataWithStats = data.map((campaign) => {
            const campaignStats = statsMap.get(campaign.id) || {
                spend: 0,
                impressions: 0,
                clicks: 0,
                results: 0,
            };
            
            const { _count, ...rest } = campaign;
            return {
                ...rest,
                stats: {
                    spend: Number(campaignStats.spend || 0),
                    impressions: Number(campaignStats.impressions || 0),
                    clicks: Number(campaignStats.clicks || 0),
                    results: Number(campaignStats.results || 0),
                },
                adGroupCount: _count.adGroups,
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
