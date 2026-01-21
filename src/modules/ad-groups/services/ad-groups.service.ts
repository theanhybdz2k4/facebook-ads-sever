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
        campaign: true
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    });

    return {
      data,
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
