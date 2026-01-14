import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class BranchStatsService {
    private readonly logger = new Logger(BranchStatsService.name);

    constructor(private readonly prisma: PrismaService) {}

    /**
     * Parse YYYY-MM-DD date string to UTC midnight Date
     */
    private parseLocalDate(dateStr: string): Date {
        return new Date(`${dateStr}T00:00:00.000Z`);
    }

    /**
     * Aggregate daily stats for a branch from ad_insights_daily
     */
    async aggregateBranchStats(branchId: number, date: string) {
        const dateObj = this.parseLocalDate(date);

        // Get all ad accounts for this branch
        const adAccounts = await this.prisma.adAccount.findMany({
            where: { branchId },
            select: { id: true },
        });

        if (adAccounts.length === 0) {
            this.logger.log(`Branch ${branchId} has no ad accounts, skipping aggregation`);
            return null;
        }

        const accountIds = adAccounts.map(a => a.id);

        // Aggregate insights for all ad accounts in this branch
        const result = await this.prisma.adInsightsDaily.aggregate({
            where: {
                accountId: { in: accountIds },
                date: dateObj,
            },
            _sum: {
                spend: true,
                impressions: true,
                clicks: true,
                reach: true,
                results: true,
                messagingStarted: true,
            },
            _count: {
                adId: true,
            },
        });

        // Upsert the aggregated stats
        const stats = await this.prisma.branchDailyStats.upsert({
            where: {
                branchId_date: { branchId, date: dateObj },
            },
            create: {
                branchId,
                date: dateObj,
                totalSpend: result._sum.spend || 0,
                totalImpressions: result._sum.impressions || BigInt(0),
                totalClicks: result._sum.clicks || BigInt(0),
                totalReach: result._sum.reach || BigInt(0),
                totalResults: result._sum.results || BigInt(0),
                totalMessaging: result._sum.messagingStarted || BigInt(0),
                adAccountCount: accountIds.length,
                adsCount: result._count.adId,
            },
            update: {
                totalSpend: result._sum.spend || 0,
                totalImpressions: result._sum.impressions || BigInt(0),
                totalClicks: result._sum.clicks || BigInt(0),
                totalReach: result._sum.reach || BigInt(0),
                totalResults: result._sum.results || BigInt(0),
                totalMessaging: result._sum.messagingStarted || BigInt(0),
                adAccountCount: accountIds.length,
                adsCount: result._count.adId,
            },
        });

        this.logger.log(`Aggregated stats for branch ${branchId} on ${date}: spend=${stats.totalSpend}, ads=${stats.adsCount}`);
        return stats;
    }

    /**
     * Aggregate stats for all branches on a given date
     */
    async aggregateAllBranchStats(date: string) {
        const branches = await this.prisma.branch.findMany({
            where: {
                adAccounts: { some: {} }, // Only branches with ad accounts
            },
            select: { id: true, name: true },
        });

        this.logger.log(`Aggregating stats for ${branches.length} branches on ${date}`);

        const results = [];
        for (const branch of branches) {
            try {
                const stats = await this.aggregateBranchStats(branch.id, date);
                if (stats) {
                    results.push({ branchId: branch.id, branchName: branch.name, stats });
                }
            } catch (error) {
                this.logger.error(`Failed to aggregate stats for branch ${branch.id}: ${error.message}`);
            }
        }

        return results;
    }

    /**
     * Get stats for a branch within a date range
     */
    async getBranchStats(branchId: number, dateStart: string, dateEnd: string) {
        const startDate = this.parseLocalDate(dateStart);
        const endDate = this.parseLocalDate(dateEnd);

        return this.prisma.branchDailyStats.findMany({
            where: {
                branchId,
                date: {
                    gte: startDate,
                    lte: endDate,
                },
            },
            orderBy: { date: 'desc' },
        });
    }

    /**
     * Get summary of all branches for a date range
     */
    async getBranchesSummary(userId: number, dateStart: string, dateEnd: string) {
        const startDate = this.parseLocalDate(dateStart);
        const endDate = this.parseLocalDate(dateEnd);

        // Get all branches for this user with their stats
        const branches = await this.prisma.branch.findMany({
            where: { userId },
            include: {
                dailyStats: {
                    where: {
                        date: {
                            gte: startDate,
                            lte: endDate,
                        },
                    },
                },
                _count: {
                    select: { adAccounts: true },
                },
            },
        });

        // Calculate totals for each branch
        return branches.map(branch => {
            const totals = branch.dailyStats.reduce((acc, stat) => {
                acc.totalSpend += Number(stat.totalSpend);
                acc.totalImpressions += Number(stat.totalImpressions);
                acc.totalClicks += Number(stat.totalClicks);
                acc.totalReach += Number(stat.totalReach);
                acc.totalResults += Number(stat.totalResults);
                acc.totalMessaging += Number(stat.totalMessaging);
                return acc;
            }, {
                totalSpend: 0,
                totalImpressions: 0,
                totalClicks: 0,
                totalReach: 0,
                totalResults: 0,
                totalMessaging: 0,
            });

            return {
                id: branch.id,
                name: branch.name,
                code: branch.code,
                adAccountCount: branch._count.adAccounts,
                daysWithData: branch.dailyStats.length,
                ...totals,
            };
        });
    }

    /**
     * Cleanup old stats (keep only last 30 days)
     */
    async cleanupOldStats(): Promise<number> {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        thirtyDaysAgo.setHours(0, 0, 0, 0);

        const result = await this.prisma.branchDailyStats.deleteMany({
            where: {
                date: { lt: thirtyDaysAgo },
            },
        });

        if (result.count > 0) {
            this.logger.log(`Cleaned up ${result.count} old branch stats records`);
        }

        return result.count;
    }
}
