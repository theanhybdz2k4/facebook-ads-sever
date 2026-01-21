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

    const total = await this.prisma.unifiedAdGroup.count({ where });

    const data = await this.prisma.unifiedAdGroup.findMany({
      where,
      include: {
        _count: { select: { ads: true } },
        account: { include: { platform: true } },
        campaign: true,
        insights: true,
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    });

    const dataWithStats = data.map((adGroup) => {
        const stats = adGroup.insights.reduce(
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
        const { insights, ...rest } = adGroup;
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

  async findByAccount(accountId: number) {
    return this.prisma.unifiedAdGroup.findMany({
      where: { accountId },
      select: { id: true, externalId: true },
    });
  }
}
