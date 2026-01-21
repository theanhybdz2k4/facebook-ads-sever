import { Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';

@Injectable()
export class InsightsQueryService {
  constructor(private readonly prisma: PrismaService) {}

  private parseDate(dateStr: string): Date {
    return new Date(`${dateStr}T00:00:00.000Z`);
  }

  async getDailyInsights(userId: number, filters?: {
    accountId?: number;
    dateStart?: string;
    dateEnd?: string;
    branchId?: number;
    page?: number;
    limit?: number;
  }) {
    const page = filters?.page || 1;
    const limit = filters?.limit || 50;
    const skip = (page - 1) * limit;

    const where: any = {};

    if (filters?.dateStart && filters?.dateEnd) {
      where.date = {
        gte: this.parseDate(filters.dateStart),
        lte: this.parseDate(filters.dateEnd),
      };
    }

    if (filters?.accountId) {
      where.accountId = filters.accountId;
    }

    if (filters?.branchId) {
      where.account = { branchId: filters.branchId };
    }

    // Verify user access via identity
    where.account = {
      ...where.account,
      identity: { userId },
    };

    const total = await this.prisma.unifiedInsight.count({ where });

    const data = await this.prisma.unifiedInsight.findMany({
      where,
      include: {
        account: { select: { id: true, name: true, platform: { select: { code: true, name: true } } } },
        campaign: { select: { name: true } },
        ad: { 
          select: { 
            id: true, 
            name: true, 
            externalId: true,
            account: { select: { platform: { select: { code: true } } } }
          } 
        }
      },
      orderBy: { date: 'desc' },
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

  async getBranchAggregatedStats(userId: number, dateStart: string, dateEnd: string) {
    const start = this.parseDate(dateStart);
    const end = this.parseDate(dateEnd);

    const stats = await this.prisma.branchDailyStats.findMany({
      where: {
        branch: { userId },
        date: { gte: start, lte: end },
      },
      include: { branch: true },
      orderBy: { date: 'asc' },
    });

    return stats.map(s => ({
      ...s,
      totalSpend: Number(s.totalSpend),
      totalImpressions: Number(s.totalImpressions),
      totalResults: Number(s.totalResults),
    }));
  }
  async getAdAnalytics(userId: number, adId: string, dateStart?: string, dateEnd?: string) {
    // Verify user access
    const ad = await this.prisma.unifiedAd.findFirst({
      where: {
        id: adId,
        account: { identity: { userId } }
      }
    });
    if (!ad) throw new ForbiddenException('Access denied or ad not found');

    const end = dateEnd ? this.parseDate(dateEnd) : new Date();
    const start = dateStart ? this.parseDate(dateStart) : new Date(end.getTime() - 6 * 24 * 60 * 60 * 1000); // Default 7 days

    const dailyInsights = await this.prisma.unifiedInsight.findMany({
      where: { adId, date: { gte: start, lte: end } },
      orderBy: { date: 'asc' },
    });

    const mappedInsights = dailyInsights.map(i => {
      const spend = Number(i.spend || 0);
      const impressions = Number(i.impressions || 0);
      const clicks = Number(i.clicks || 0);
      const results = Number(i.results || 0);
      const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
      const cpc = clicks > 0 ? spend / clicks : 0;
      const cpm = impressions > 0 ? (spend / impressions) * 1000 : 0;
      const costPerResult = results > 0 ? spend / results : 0;

      return {
        date: i.date.toISOString().split('T')[0],
        spend,
        impressions,
        reach: Number(i.reach || 0),
        clicks,
        results,
        conversions: Number(i.conversions || 0),
        ctr,
        cpc,
        cpm,
        costPerResult,
      };
    });

    // Summary calculation
    const totalSpend = mappedInsights.reduce((sum, i) => sum + i.spend, 0);
    const totalImpressions = mappedInsights.reduce((sum, i) => sum + i.impressions, 0);
    const totalClicks = mappedInsights.reduce((sum, i) => sum + i.clicks, 0);
    const totalResults = mappedInsights.reduce((sum, i) => sum + i.results, 0);
    const totalReach = mappedInsights.reduce((sum, i) => sum + i.reach, 0);
    
    // We don't have messages count explicitly in schema, using results for now or platformMetrics
    const totalMessages = totalResults; 

    const summary = {
      totalSpend,
      totalImpressions,
      totalReach,
      totalClicks,
      totalResults,
      totalMessages,
      avgCtr: totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0,
      avgCpc: totalClicks > 0 ? totalSpend / totalClicks : 0,
      avgCpm: totalImpressions > 0 ? (totalSpend / totalImpressions) * 1000 : 0,
      avgCpr: totalResults > 0 ? totalSpend / totalResults : 0,
      avgCostPerMessage: totalMessages > 0 ? totalSpend / totalMessages : 0,
    };

    return {
      summary,
      dailyInsights: mappedInsights,
      deviceBreakdown: [], // TODO: Implement if needed
      placementBreakdown: [], // TODO: Implement if needed
      ageGenderBreakdown: [], // TODO: Implement if needed
    };
  }

  async getAdHourly(userId: number, adId: string, date?: string) {
    // Verify user access
    const ad = await this.prisma.unifiedAd.findFirst({
      where: {
        id: adId,
        account: { identity: { userId } }
      }
    });
    if (!ad) throw new ForbiddenException('Access denied or ad not found');

    const targetDate = date ? this.parseDate(date) : new Date();
    targetDate.setUTCHours(0, 0, 0, 0);

    const hourlyInsights = await this.prisma.unifiedHourlyInsight.findMany({
      where: { adId, date: targetDate },
      orderBy: { hour: 'asc' },
    });

    return hourlyInsights.map(i => {
      const spend = Number(i.spend || 0);
      const impressions = Number(i.impressions || 0);
      const clicks = Number(i.clicks || 0);
      const results = Number(i.results || 0);

      return {
        hour: i.hour,
        dateStart: i.date.toISOString().split('T')[0],
        spend,
        impressions,
        clicks,
        results,
        ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
        cpc: clicks > 0 ? spend / clicks : 0,
        cpm: impressions > 0 ? (spend / impressions) * 1000 : 0,
        costPerResult: results > 0 ? spend / results : 0,
      };
    });
  }
}
