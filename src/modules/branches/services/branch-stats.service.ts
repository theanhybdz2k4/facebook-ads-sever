import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { Prisma } from '@prisma/client';

import { PlatformsService } from '../../platforms/platforms.service';

@Injectable()
export class BranchStatsService {
    private readonly logger = new Logger(BranchStatsService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly platformsService: PlatformsService,
    ) { }

    async aggregateBranchStats(branchId: number, date: string) {
        const dateObj = new Date(`${date}T00:00:00.000Z`);

        // Get all platform accounts for this branch with their platform code
        const accounts = await this.prisma.platformAccount.findMany({
            where: { branchId },
            include: { platform: { select: { code: true } } },
        });

        if (accounts.length === 0) return null;

        // Group accounts by platform
        const platformGroups = new Map<string, number[]>();
        accounts.forEach(acc => {
            const code = acc.platform.code;
            if (!platformGroups.has(code)) platformGroups.set(code, []);
            platformGroups.get(code)!.push(acc.id);
        });

        const results = [];
        for (const [platformCode, accountIds] of platformGroups.entries()) {
            // Aggregate from UnifiedInsight for this platform
            const aggregation = await this.prisma.unifiedInsight.aggregate({
                where: {
                    accountId: { in: accountIds },
                    date: dateObj,
                },
                _sum: {
                    spend: true,
                    impressions: true,
                    clicks: true,
                    results: true,
                }
            });

            // Upsert into BranchDailyStats for this platform
            const stat = await this.prisma.branchDailyStats.upsert({
                where: {
                    branchId_date_platformCode: { branchId, date: dateObj, platformCode },
                },
                create: {
                    branchId,
                    date: dateObj,
                    platformCode,
                    totalSpend: aggregation._sum.spend || 0,
                    totalImpressions: aggregation._sum.impressions || BigInt(0),
                    totalClicks: aggregation._sum.clicks || BigInt(0),
                    totalResults: aggregation._sum.results || BigInt(0),
                },
                update: {
                    totalSpend: aggregation._sum.spend || 0,
                    totalImpressions: aggregation._sum.impressions || BigInt(0),
                    totalClicks: aggregation._sum.clicks || BigInt(0),
                    totalResults: aggregation._sum.results || BigInt(0),
                }
            });
            results.push(stat);
        }

        return results;
    }

    async aggregateBranchStatsForDateRange(branchId: number, dateStart: string, dateEnd: string) {
        const startDate = new Date(`${dateStart}T00:00:00.000Z`);
        const endDate = new Date(`${dateEnd}T00:00:00.000Z`);

        // Get all unique dates where this branch has insights
        const dates = await this.prisma.unifiedInsight.findMany({
            where: {
                account: { branchId }
            },
            select: { date: true },
            distinct: ['date'],
        });

        if (dates.length === 0) return { aggregated: 0 };

        let aggregatedCount = 0;
        for (const { date } of dates) {
            const dateStr = date.toISOString().split('T')[0];
            const result = await this.aggregateBranchStats(branchId, dateStr);
            if (result) aggregatedCount++;
        }

        return { aggregated: aggregatedCount };
    }

    async rebuildStats(userId: number) {
        // Get all branches for this user
        const branches = await this.prisma.branch.findMany({
            where: { userId },
            select: { id: true, name: true }
        });

        if (branches.length === 0) return { result: { dates: 0, branches: 0 } };

        // Get date range of all insights for these branches
        const accounts = await this.prisma.platformAccount.findMany({
            where: { branchId: { in: branches.map(b => b.id) } },
            select: { id: true }
        });

        if (accounts.length === 0) return { result: { dates: 0, branches: branches.length } };
        const accountIds = accounts.map(a => a.id);

        const range = await this.prisma.unifiedInsight.aggregate({
            where: { accountId: { in: accountIds } },
            _min: { date: true },
            _max: { date: true }
        });

        if (!range._min.date || !range._max.date) return { result: { dates: 0, branches: branches.length } };

        const startDate = range._min.date;
        const endDate = range._max.date;
        let processedDates = 0;

        // Iterate through dates and aggregate
        const current = new Date(startDate);
        while (current <= endDate) {
            const dateStr = current.toISOString().split('T')[0];
            for (const branch of branches) {
                await this.aggregateBranchStats(branch.id, dateStr);
            }
            processedDates++;
            current.setDate(current.getDate() + 1);
        }

        return {
            result: {
                dates: processedDates,
                branches: branches.length
            }
        };
    }

    async getDashboardStats(userId: number, dateStart: string, dateEnd: string, platformCode?: string) {
        const start = new Date(`${dateStart}T00:00:00.000Z`);
        const end = new Date(`${dateEnd}T00:00:00.000Z`);
        const isAllPlatforms = !platformCode || platformCode === 'all';

        // Fetch everything in parallel to minimize roundtrip latency
        const [branches, allAccounts, allStats, deviceStatsRaw, ageGenderStatsRaw, regionStatsRaw] = await Promise.all([
            this.prisma.branch.findMany({
                where: { userId },
                select: { id: true, name: true, code: true }
            }),
            this.prisma.platformAccount.findMany({
                where: {
                    branch: { userId },
                    platform: isAllPlatforms ? undefined : { code: platformCode }
                },
                select: { id: true, branchId: true }
            }),
            this.prisma.branchDailyStats.findMany({
                where: {
                    branch: { userId },
                    date: { gte: start, lte: end },
                    platformCode: isAllPlatforms ? undefined : platformCode
                },
                orderBy: { date: 'asc' }
            }),
            this.prisma.unifiedInsightDevice.groupBy({
                by: ['device'],
                where: {
                    insight: {
                        account: { branch: { userId } },
                        date: { gte: start, lte: end }
                    }
                },
                _sum: { spend: true, impressions: true, clicks: true, results: true }
            }),
            this.prisma.unifiedInsightAgeGender.groupBy({
                by: ['age', 'gender'],
                where: {
                    insight: {
                        account: { branch: { userId } },
                        date: { gte: start, lte: end }
                    }
                },
                _sum: { spend: true, impressions: true, clicks: true, results: true }
            }),
            this.prisma.unifiedInsightRegion.groupBy({
                by: ['region', 'country'],
                where: {
                    insight: {
                        account: { branch: { userId } },
                        date: { gte: start, lte: end }
                    }
                },
                _sum: { spend: true, impressions: true, clicks: true, results: true }
            })
        ]);

        // Efficiently map stats
        const mapStats = (stats: any[], keys: string[]) => stats.map(s => {
            const result: any = {
                key: keys.map(k => s[k]).join('|'),
                spend: Number(s._sum.spend || 0),
                impressions: Number(s._sum.impressions || 0),
                clicks: Number(s._sum.clicks || 0),
                results: Number(s._sum.results || 0)
            };
            keys.forEach(k => result[k] = s[k]);
            return result;
        });

        const device = mapStats(deviceStatsRaw, ['device']);
        const ageGender = mapStats(ageGenderStatsRaw, ['age', 'gender']);
        const region = mapStats(regionStatsRaw, ['region', 'country']);

        // Group accounts and stats by branchId for fast lookup
        const accountsByBranch = new Map<number, any[]>();
        allAccounts.forEach(acc => {
            if (!accountsByBranch.has(acc.branchId)) accountsByBranch.set(acc.branchId, []);
            accountsByBranch.get(acc.branchId).push(acc);
        });

        const statsByBranch = new Map<number, any[]>();
        allStats.forEach(stat => {
            if (!statsByBranch.has(stat.branchId)) statsByBranch.set(stat.branchId, []);
            statsByBranch.get(stat.branchId).push(stat);
        });

        const mappedBranches = branches.map(b => {
            const branchStats = statsByBranch.get(b.id) || [];
            const platformMap = new Map<string, any>();
            let totalSpend = 0;
            let totalImpressions = 0;
            let totalClicks = 0;
            let totalResults = 0;

            branchStats.forEach(s => {
                const sSpend = Number(s.totalSpend);
                const sImpressions = Number(s.totalImpressions);
                const sClicks = Number(s.totalClicks);
                const sResults = Number(s.totalResults);

                totalSpend += sSpend;
                totalImpressions += sImpressions;
                totalClicks += sClicks;
                totalResults += sResults;

                if (s.platformCode !== 'all') {
                    if (!platformMap.has(s.platformCode)) {
                        platformMap.set(s.platformCode, {
                            code: s.platformCode,
                            spend: 0,
                            impressions: 0,
                            clicks: 0,
                            results: 0
                        });
                    }
                    const p = platformMap.get(s.platformCode);
                    p.spend += sSpend;
                    p.impressions += sImpressions;
                    p.clicks += sClicks;
                    p.results += sResults;
                }
            });

            const platforms = Array.from(platformMap.values());
            if (platforms.length === 0) {
                const allRows = branchStats.filter(s => s.platformCode === 'all');
                if (allRows.length > 0) {
                    platforms.push({
                        code: 'all',
                        spend: allRows.reduce((sum, s) => sum + Number(s.totalSpend), 0),
                        impressions: allRows.reduce((sum, s) => sum + Number(s.totalImpressions), 0),
                        clicks: allRows.reduce((sum, s) => sum + Number(s.totalClicks), 0),
                        results: allRows.reduce((sum, s) => sum + Number(s.totalResults), 0)
                    });
                }
            }

            return {
                id: b.id,
                name: b.name,
                code: b.code,
                totalSpend,
                totalImpressions,
                totalClicks,
                totalResults,
                totalMessaging: totalResults,
                platforms,
                stats: branchStats.map(s => ({
                    date: s.date.toISOString().split('T')[0],
                    platformCode: s.platformCode,
                    spend: Number(s.totalSpend),
                    impressions: Number(s.totalImpressions),
                    clicks: Number(s.totalClicks),
                    results: Number(s.totalResults),
                    messaging: Number(s.totalResults),
                }))
            };
        });

        return {
            branches: mappedBranches,
            breakdowns: {
                device,
                ageGender,
                region
            }
        };
    }

    async getBranchStatsByCode(userId: number, branchCode: string, dateStart: string, dateEnd: string, platformCode?: string) {
        const start = new Date(`${dateStart}T00:00:00.000Z`);
        const end = new Date(`${dateEnd}T00:00:00.000Z`);
        const isAllPlatforms = !platformCode || platformCode === 'all';
        const branchFilter = isNaN(Number(branchCode)) ? { code: branchCode } : { id: Number(branchCode) };

        // Fetch everything in parallel
        const [branch, deviceStatsRaw, ageGenderStatsRaw, regionStatsRaw] = await Promise.all([
            this.prisma.branch.findFirst({
                where: { userId, OR: [branchFilter] },
                include: {
                    accounts: {
                        where: isAllPlatforms ? undefined : { platform: { code: platformCode } },
                        select: { id: true }
                    },
                    stats: {
                        where: {
                            date: { gte: start, lte: end },
                            platformCode: isAllPlatforms ? undefined : platformCode
                        },
                        orderBy: { date: 'asc' }
                    }
                }
            }),
            this.prisma.unifiedInsightDevice.groupBy({
                by: ['device'],
                where: {
                    insight: {
                        account: { branch: { ...branchFilter, userId } },
                        date: { gte: start, lte: end }
                    }
                },
                _sum: { spend: true, impressions: true, clicks: true, results: true }
            }),
            this.prisma.unifiedInsightAgeGender.groupBy({
                by: ['age', 'gender'],
                where: {
                    insight: {
                        account: { branch: { ...branchFilter, userId } },
                        date: { gte: start, lte: end }
                    }
                },
                _sum: { spend: true, impressions: true, clicks: true, results: true }
            }),
            this.prisma.unifiedInsightRegion.groupBy({
                by: ['region', 'country'],
                where: {
                    insight: {
                        account: { branch: { ...branchFilter, userId } },
                        date: { gte: start, lte: end }
                    }
                },
                _sum: { spend: true, impressions: true, clicks: true, results: true }
            })
        ]);

        if (!branch) throw new Error(`Branch with code/id "${branchCode}" not found`);

        const mapStats = (stats: any[], keys: string[]) => stats.map(s => {
            const result: any = {
                key: keys.map(k => s[k]).join('|'),
                spend: Number(s._sum.spend || 0),
                impressions: Number(s._sum.impressions || 0),
                clicks: Number(s._sum.clicks || 0),
                results: Number(s._sum.results || 0)
            };
            keys.forEach(k => result[k] = s[k]);
            return result;
        });

        const deviceStats = mapStats(deviceStatsRaw, ['device']);
        const ageGenderStats = mapStats(ageGenderStatsRaw, ['age', 'gender']);
        const regionStats = mapStats(regionStatsRaw, ['region', 'country']);

        const platformMap = new Map<string, any>();
        let totalSpend = 0;
        let totalImpressions = 0;
        let totalClicks = 0;
        let totalResults = 0;

        branch.stats.forEach(s => {
            const sSpend = Number(s.totalSpend);
            const sImpressions = Number(s.totalImpressions);
            const sClicks = Number(s.totalClicks);
            const sResults = Number(s.totalResults);

            totalSpend += sSpend;
            totalImpressions += sImpressions;
            totalClicks += sClicks;
            totalResults += sResults;

            if (s.platformCode !== 'all') {
                if (!platformMap.has(s.platformCode)) {
                    platformMap.set(s.platformCode, {
                        code: s.platformCode,
                        spend: 0,
                        impressions: 0,
                        clicks: 0,
                        results: 0
                    });
                }
                const p = platformMap.get(s.platformCode);
                p.spend += sSpend;
                p.impressions += sImpressions;
                p.clicks += sClicks;
                p.results += sResults;
            }
        });

        const platforms = Array.from(platformMap.values());
        if (platforms.length === 0) {
            const allRows = branch.stats.filter(s => s.platformCode === 'all');
            if (allRows.length > 0) {
                platforms.push({
                    code: 'all',
                    spend: allRows.reduce((sum, s) => sum + Number(s.totalSpend), 0),
                    impressions: allRows.reduce((sum, s) => sum + Number(s.totalImpressions), 0),
                    clicks: allRows.reduce((sum, s) => sum + Number(s.totalClicks), 0),
                    results: allRows.reduce((sum, s) => sum + Number(s.totalResults), 0)
                });
            }
        }

        return {
            branch: {
                id: branch.id,
                name: branch.name,
                code: branch.code,
                totalSpend,
                totalImpressions,
                totalClicks,
                totalResults,
                totalMessaging: totalResults,
                platforms,
                stats: branch.stats.map(s => ({
                    date: s.date.toISOString().split('T')[0],
                    platformCode: s.platformCode,
                    spend: Number(s.totalSpend),
                    impressions: Number(s.totalImpressions),
                    clicks: Number(s.totalClicks),
                    results: Number(s.totalResults),
                    messaging: Number(s.totalResults),
                }))
            },
            breakdowns: {
                device: mapStats(deviceStats, ['device']),
                ageGender: mapStats(ageGenderStats, ['age', 'gender']),
                region: mapStats(regionStats, ['region', 'country'])
            }
        };
    }

    async getBranchBreakdowns(branchId: number, dateStart: string, dateEnd: string, breakdown: string, platformCode?: string) {
        const start = new Date(`${dateStart}T00:00:00.000Z`);
        const end = new Date(`${dateEnd}T00:00:00.000Z`);

        const accounts = await this.prisma.platformAccount.findMany({
            where: {
                branchId,
                platform: platformCode && platformCode !== 'all' ? { code: platformCode } : undefined
            },
            select: { id: true },
        });

        if (accounts.length === 0) return [];
        const accountIds = accounts.map(a => a.id);

        const where = {
            insight: {
                accountId: { in: accountIds },
                date: { gte: start, lte: end }
            }
        };

        let rawResults: any[] = [];

        if (breakdown === 'device') {
            rawResults = await (this.prisma.unifiedInsightDevice as any).groupBy({
                by: ['device'],
                where,
                _sum: { spend: true, impressions: true, clicks: true, results: true }
            });
        } else if (breakdown === 'age-gender' || breakdown === 'age_gender') {
            rawResults = await (this.prisma.unifiedInsightAgeGender as any).groupBy({
                by: ['age', 'gender'],
                where,
                _sum: { spend: true, impressions: true, clicks: true, results: true }
            });
        } else if (breakdown === 'region') {
            rawResults = await (this.prisma.unifiedInsightRegion as any).groupBy({
                by: ['region', 'country'],
                where,
                _sum: { spend: true, impressions: true, clicks: true, results: true }
            });
        }

        return rawResults.map(s => ({
            ...s,
            spend: Number(s._sum.spend || 0),
            impressions: Number(s._sum.impressions || 0),
            clicks: Number(s._sum.clicks || 0),
            results: Number(s._sum.results || 0),
            _sum: undefined
        }));
    }

    // Removed fetchUnifiedBreakdowns and fetchBreakdownsForAccounts as they are no longer needed for dashboard
    private async fetchUnifiedBreakdowns(userId: number, dateStart: string, dateEnd: string, breakdown: string) {
        return [];
    }

    // Removed fetchBreakdownsForAccounts
    private async fetchBreakdownsForAccounts(accounts: any[], dateStart: string, dateEnd: string, breakdown: string) {
        return [];
    }
}
