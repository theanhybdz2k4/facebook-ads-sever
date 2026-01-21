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

        const branches = await this.prisma.branch.findMany({
            where: { userId },
            include: {
                accounts: {
                    where: platformCode && platformCode !== 'all' ? { platform: { code: platformCode } } : undefined,
                    select: { id: true }
                },
                stats: {
                    where: {
                        date: { gte: start, lte: end },
                        platformCode: platformCode && platformCode !== 'all' ? platformCode : undefined
                    },
                    orderBy: { date: 'asc' }
                }
            }
        });

        const accountIds = branches.flatMap(b => b.accounts.map(a => a.id));

        const [deviceStats, ageGenderStats, regionStats] = await Promise.all([
            this.prisma.unifiedInsightDevice.groupBy({
                by: ['device'],
                where: {
                    insight: {
                        accountId: { in: accountIds },
                        date: { gte: start, lte: end }
                    }
                },
                _sum: { spend: true, impressions: true, clicks: true, results: true }
            }),
            this.prisma.unifiedInsightAgeGender.groupBy({
                by: ['age', 'gender'],
                where: {
                    insight: {
                        accountId: { in: accountIds },
                        date: { gte: start, lte: end }
                    }
                },
                _sum: { spend: true, impressions: true, clicks: true, results: true }
            }),
            this.prisma.unifiedInsightRegion.groupBy({
                by: ['region', 'country'],
                where: {
                    insight: {
                        accountId: { in: accountIds },
                        date: { gte: start, lte: end }
                    }
                },
                _sum: { spend: true, impressions: true, clicks: true, results: true }
            })
        ]);

        // Map to frontend format
        const mapStats = (stats: any[], keys: string[]) => stats.map(s => ({
            key: keys.map(k => s[k]).join('|'),
            ...keys.reduce((acc, k) => ({ ...acc, [k]: s[k] }), {}),
            spend: Number(s._sum.spend || 0),
            impressions: Number(s._sum.impressions || 0),
            clicks: Number(s._sum.clicks || 0),
            results: Number(s._sum.results || 0)
        }));

        const device = mapStats(deviceStats, ['device']);
        const ageGender = mapStats(ageGenderStats, ['age', 'gender']);
        const region = mapStats(regionStats, ['region', 'country']);

        return {
            branches: branches.map(b => {
                // Group stats by platform for this branch
                const platformMap = new Map<string, any>();
                b.stats.forEach(s => {
                    if (s.platformCode === 'all') return; // Skip migration default if we want granular data

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
                    p.spend += Number(s.totalSpend);
                    p.impressions += Number(s.totalImpressions);
                    p.clicks += Number(s.totalClicks);
                    p.results += Number(s.totalResults);
                });

                const platforms = Array.from(platformMap.values());

                // If platforms is empty, use the "all" rows (migration case)
                if (platforms.length === 0) {
                    const allRowStats = b.stats.filter(s => s.platformCode === 'all');
                    if (allRowStats.length > 0) {
                        platforms.push({
                            code: 'all',
                            spend: allRowStats.reduce((sum, s) => sum + Number(s.totalSpend), 0),
                            impressions: allRowStats.reduce((sum, s) => sum + Number(s.totalImpressions), 0),
                            clicks: allRowStats.reduce((sum, s) => sum + Number(s.totalClicks), 0),
                            results: allRowStats.reduce((sum, s) => sum + Number(s.totalResults), 0)
                        });
                    }
                }

                return {
                    id: b.id,
                    name: b.name,
                    code: b.code,
                    totalSpend: b.stats.reduce((sum, s) => sum + Number(s.totalSpend), 0),
                    totalImpressions: b.stats.reduce((sum, s) => sum + Number(s.totalImpressions), 0),
                    totalClicks: b.stats.reduce((sum, s) => sum + Number(s.totalClicks), 0),
                    totalResults: b.stats.reduce((sum, s) => sum + Number(s.totalResults), 0),
                    totalMessaging: b.stats.reduce((sum, s) => sum + Number(s.totalResults), 0),
                    platforms,
                    stats: b.stats.map(s => ({
                        date: s.date.toISOString().split('T')[0],
                        platformCode: s.platformCode,
                        spend: Number(s.totalSpend),
                        impressions: Number(s.totalImpressions),
                        clicks: Number(s.totalClicks),
                        results: Number(s.totalResults),
                        messaging: Number(s.totalResults),
                    }))
                };
            }),
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

        const branch = await this.prisma.branch.findFirst({
            where: { userId, OR: [{ code: branchCode }, { id: isNaN(Number(branchCode)) ? undefined : Number(branchCode) }] },
            include: {
                accounts: {
                    where: platformCode && platformCode !== 'all' ? { platform: { code: platformCode } } : undefined,
                    select: { id: true }
                },
                stats: {
                    where: {
                        date: { gte: start, lte: end },
                        platformCode: platformCode && platformCode !== 'all' ? platformCode : undefined
                    },
                    orderBy: { date: 'asc' }
                }
            }
        });

        if (!branch) throw new Error(`Branch with code/id "${branchCode}" not found`);

        const accountIds = branch.accounts.map(a => a.id);

        const [deviceStats, ageGenderStats, regionStats] = await Promise.all([
            this.prisma.unifiedInsightDevice.groupBy({
                by: ['device'],
                where: {
                    insight: {
                        accountId: { in: accountIds },
                        date: { gte: start, lte: end }
                    }
                },
                _sum: { spend: true, impressions: true, clicks: true, results: true }
            }),
            this.prisma.unifiedInsightAgeGender.groupBy({
                by: ['age', 'gender'],
                where: {
                    insight: {
                        accountId: { in: accountIds },
                        date: { gte: start, lte: end }
                    }
                },
                _sum: { spend: true, impressions: true, clicks: true, results: true }
            }),
            this.prisma.unifiedInsightRegion.groupBy({
                by: ['region', 'country'],
                where: {
                    insight: {
                        accountId: { in: accountIds },
                        date: { gte: start, lte: end }
                    }
                },
                _sum: { spend: true, impressions: true, clicks: true, results: true }
            })
        ]);

        const mapStats = (stats: any[], keys: string[]) => stats.map(s => ({
            key: keys.map(k => s[k]).join('|'),
            ...keys.reduce((acc, k) => ({ ...acc, [k]: s[k] }), {}),
            spend: Number(s._sum.spend || 0),
            impressions: Number(s._sum.impressions || 0),
            clicks: Number(s._sum.clicks || 0),
            results: Number(s._sum.results || 0)
        }));

        // Group stats by platform for this branch
        const platformMap = new Map<string, any>();
        branch.stats.forEach(s => {
            if (s.platformCode === 'all' && platformCode && platformCode !== 'all') return;

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
            p.spend += Number(s.totalSpend);
            p.impressions += Number(s.totalImpressions);
            p.clicks += Number(s.totalClicks);
            p.results += Number(s.totalResults);
        });

        const platforms = Array.from(platformMap.values());

        return {
            branch: {
                id: branch.id,
                name: branch.name,
                code: branch.code,
                totalSpend: branch.stats.reduce((sum, s) => sum + Number(s.totalSpend), 0),
                totalImpressions: branch.stats.reduce((sum, s) => sum + Number(s.totalImpressions), 0),
                totalClicks: branch.stats.reduce((sum, s) => sum + Number(s.totalClicks), 0),
                totalResults: branch.stats.reduce((sum, s) => sum + Number(s.totalResults), 0),
                totalMessaging: branch.stats.reduce((sum, s) => sum + Number(s.totalResults), 0),
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
