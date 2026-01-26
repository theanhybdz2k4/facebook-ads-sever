import { Injectable } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';

@Injectable()
export class AdGroupsService {
  constructor(private readonly prisma: PrismaService) { }

  async findByCampaign(campaignId: string) {
    return this.prisma.unifiedAdGroup.findMany({
      where: { campaignId },
      include: { _count: { select: { ads: true } } },
    });
  }

  async findAll(userId: number, filters: {
    accountId?: number;
    campaignId?: string;
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

    if (filters.campaignId) {
      where.campaignId = filters.campaignId;
    }

    if (filters.status && filters.status !== 'all') {
      where.status = filters.status;
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
      this.prisma.unifiedAdGroup.count({ where }),
      this.prisma.unifiedAdGroup.findMany({
        where,
        select: {
          id: true,
          externalId: true,
          name: true,
          status: true,
          dailyBudget: true,
          optimizationGoal: true,
          effectiveStatus: true,
          createdAt: true,
          accountId: true,
          campaignId: true,
          account: { 
            select: { 
              id: true, 
              name: true,
              platform: { select: { code: true, name: true } },
            } 
          },
          campaign: { select: { id: true, name: true } },
          _count: { select: { ads: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);

    // ✅ Optimization: Use aggregation instead of fetching all insights
    const adGroupIds = data.map(ag => ag.id);
    const stats = await this.prisma.unifiedInsight.groupBy({
      by: ['adGroupId'],
      where: { adGroupId: { in: adGroupIds } },
      _sum: {
        spend: true,
        impressions: true,
        clicks: true,
        results: true,
      },
    });

    const statsMap = new Map(stats.map(s => [s.adGroupId, s._sum]));

    const dataWithStats = data.map((adGroup) => {
        const adGroupStats = statsMap.get(adGroup.id) || {
            spend: 0,
            impressions: 0,
            clicks: 0,
            results: 0,
        };
        
        const { _count, ...rest } = adGroup as any;
        return {
            ...rest,
            stats: {
                spend: Number(adGroupStats.spend || 0),
                impressions: Number(adGroupStats.impressions || 0),
                clicks: Number(adGroupStats.clicks || 0),
                results: Number(adGroupStats.results || 0),
            },
            adCount: _count.ads,
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

  async findByAccount(accountId: number) {
    return this.prisma.unifiedAdGroup.findMany({
      where: { accountId },
      select: { id: true, externalId: true },
    });
  }
}
