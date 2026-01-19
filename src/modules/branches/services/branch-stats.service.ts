import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class BranchStatsService {
    private readonly logger = new Logger(BranchStatsService.name);

    constructor(private readonly prisma: PrismaService) { }

    async aggregateBranchStats(branchId: number, date: string) {
        const dateObj = new Date(`${date}T00:00:00.000Z`);

        // Get all platform accounts for this branch
        const accounts = await this.prisma.platformAccount.findMany({
            where: { branchId },
            select: { id: true },
        });

        if (accounts.length === 0) return null;
        const accountIds = accounts.map(a => a.id);

        // Aggregate from UnifiedInsight
        const result = await this.prisma.unifiedInsight.aggregate({
            where: {
                accountId: { in: accountIds },
                date: dateObj,
            },
            _sum: {
                spend: true,
                impressions: true,
                results: true,
            }
        });

        // Upsert into BranchDailyStats
        return this.prisma.branchDailyStats.upsert({
            where: {
                branchId_date: { branchId, date: dateObj },
            },
            create: {
                branchId,
                date: dateObj,
                totalSpend: result._sum.spend || 0,
                totalImpressions: result._sum.impressions || BigInt(0),
                totalResults: result._sum.results || BigInt(0),
            },
            update: {
                totalSpend: result._sum.spend || 0,
                totalImpressions: result._sum.impressions || BigInt(0),
                totalResults: result._sum.results || BigInt(0),
            }
        });
    }

    async getDashboardStats(userId: number, dateStart: string, dateEnd: string) {
        const start = new Date(`${dateStart}T00:00:00.000Z`);
        const end = new Date(`${dateEnd}T00:00:00.000Z`);

        const branches = await this.prisma.branch.findMany({
            where: { userId },
            include: {
                stats: {
                    where: {
                        date: { gte: start, lte: end }
                    },
                    orderBy: { date: 'asc' }
                }
            }
        });

        return branches.map(b => ({
            id: b.id,
            name: b.name,
            code: b.code,
            stats: b.stats.map(s => ({
                date: s.date.toISOString().split('T')[0],
                spend: Number(s.totalSpend),
                impressions: Number(s.totalImpressions),
                results: Number(s.totalResults),
            }))
        }));
    }
}
