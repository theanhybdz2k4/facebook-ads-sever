import { Injectable } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';

@Injectable()
export class InsightsService {
    constructor(private readonly prisma: PrismaService) { }

    async getAccountInsights(accountId: number, startDate: Date, endDate: Date) {
        return this.prisma.unifiedInsight.groupBy({
            by: ['date'],
            where: {
                accountId,
                date: { gte: startDate, lte: endDate },
            },
            _sum: {
                spend: true,
                impressions: true,
                clicks: true,
                conversions: true,
                results: true,
            },
            orderBy: { date: 'asc' },
        });
    }

    async findAll(userId: number, filters: { accountId?: number; branchId?: number; dateStart?: string; dateEnd?: string }) {
        const where: any = {
            account: {
                identity: { userId },
            },
        };

        if (filters.accountId) {
            where.accountId = filters.accountId;
        }

        if (filters.branchId) {
            where.account.branchId = filters.branchId;
        }

        if (filters.dateStart || filters.dateEnd) {
            where.date = {};
            if (filters.dateStart) where.date.gte = new Date(filters.dateStart);
            if (filters.dateEnd) where.date.lte = new Date(filters.dateEnd);
        }

        return this.prisma.unifiedInsight.findMany({
            where,
            include: {
                account: { include: { platform: true } },
                campaign: true,
                adGroup: true,
                ad: true,
            },
            orderBy: { date: 'desc' },
        });
    }

    async getCampaignInsights(campaignId: string, startDate: Date, endDate: Date) {
        return this.prisma.unifiedInsight.findMany({
            where: {
                campaignId,
                date: { gte: startDate, lte: endDate },
            },
            orderBy: { date: 'asc' },
        });
    }

    async getHourlyInsights(adId: string, date: string) {
        const targetDate = new Date(date);
        return this.prisma.unifiedHourlyInsight.findMany({
            where: {
                adId,
                date: targetDate,
            },
            orderBy: { hour: 'asc' },
        });
    }
}
