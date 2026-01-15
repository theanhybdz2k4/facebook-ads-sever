import { Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { getVietnamDateString } from '@n-utils';

@Injectable()
export class InsightsQueryService {
    constructor(private readonly prisma: PrismaService) { }
    private parseVietnamDateToUTC(dateStr: string): Date {
        return new Date(`${dateStr}T00:00:00.000Z`);
    }

    async getDailyInsights(userId: number, filters?: {
        accountId?: string;
        dateStart?: string;
        dateEnd?: string;
        branchId?: string;
    }) {
        let dateFilter = {};
        if (filters?.dateStart && filters?.dateEnd) {
            const startUTC = this.parseVietnamDateToUTC(filters.dateStart);
            const endUTC = this.parseVietnamDateToUTC(filters.dateEnd);
            const endUTCInclusive = new Date(endUTC.getTime() + 24 * 60 * 60 * 1000 - 1);
            dateFilter = { date: { gte: startUTC, lte: endUTCInclusive } };
        }

        const accountFilter: any = {
            fbAccount: { userId },
        };

        if (filters?.branchId && filters.branchId !== 'all') {
            const parsedBranchId = Number(filters.branchId);
            if (!Number.isNaN(parsedBranchId)) {
                accountFilter.branchId = parsedBranchId;
            }
        }

        return this.prisma.adInsightsDaily.findMany({
            where: {
                ...(filters?.accountId && { accountId: filters.accountId }),
                ...dateFilter,
                account: accountFilter,
            },
            include: {
                ad: {
                    select: {
                        id: true,
                        name: true,
                    },
                },
                account: {
                    select: {
                        id: true,
                        name: true,
                    },
                },
            },
            orderBy: { date: 'desc' },
            take: 100,
        });
    }

    /**
     * Get ad analytics with insights and breakdowns
     */
    async getAdAnalytics(adId: string, userId: number, dateStart?: string, dateEnd?: string) {
        // Verify access
        const ad = await this.prisma.ad.findFirst({
            where: {
                id: adId,
                account: { fbAccount: { userId } },
            },
        });

        if (!ad) {
            throw new ForbiddenException('Ad not found or access denied');
        }

        // Default to last 30 days (using Vietnam timezone UTC+7)
        // Parse dates to UTC to match DB storage format
        let endDate: Date;
        let startDate: Date;

        if (dateEnd) {
            // Parse Vietnam date to UTC for DB query
            endDate = this.parseVietnamDateToUTC(dateEnd);
        } else {
            // Use today in Vietnam timezone
            const todayVN = getVietnamDateString();
            endDate = this.parseVietnamDateToUTC(todayVN);
        }

        if (dateStart) {
            // Parse Vietnam date to UTC for DB query
            startDate = this.parseVietnamDateToUTC(dateStart);
        } else {
            // Default to 30 days ago in Vietnam timezone
            const todayVN = getVietnamDateString();
            const todayDate = this.parseVietnamDateToUTC(todayVN);
            startDate = new Date(todayDate.getTime() - 30 * 24 * 60 * 60 * 1000);
            // Normalize to UTC midnight
            const startDateStr = startDate.toISOString().split('T')[0];
            startDate = new Date(`${startDateStr}T00:00:00.000Z`);
        }

        // Daily insights
        const dailyInsights = await this.prisma.adInsightsDaily.findMany({
            where: {
                adId,
                date: { gte: startDate, lte: endDate },
            },
            orderBy: { date: 'asc' },
        });

        // Calculate summary
        const summary = {
            totalSpend: 0,
            totalImpressions: 0,
            totalReach: 0,
            totalClicks: 0,
            totalResults: 0,
            totalMessages: 0,
            avgCtr: 0,
            avgCpc: 0,
            avgCpm: 0,
            avgCpr: 0,
            avgCostPerMessage: 0,
        };

        dailyInsights.forEach((day) => {
            summary.totalSpend += Number(day.spend) || 0;
            summary.totalImpressions += Number(day.impressions) || 0;
            summary.totalReach += Number(day.reach) || 0;
            summary.totalClicks += Number(day.clicks) || 0;
            summary.totalResults += Number(day.results) || 0;
            summary.totalMessages += Number(day.messagingStarted) || 0;
        });

        if (summary.totalImpressions > 0) {
            summary.avgCtr = (summary.totalClicks / summary.totalImpressions) * 100;
            summary.avgCpm = (summary.totalSpend / summary.totalImpressions) * 1000;
        }
        if (summary.totalClicks > 0) {
            summary.avgCpc = summary.totalSpend / summary.totalClicks;
        }
        if (summary.totalResults > 0) {
            summary.avgCpr = summary.totalSpend / summary.totalResults;
        }
        if (summary.totalMessages > 0) {
            summary.avgCostPerMessage = summary.totalSpend / summary.totalMessages;
        }

        // Calculate growth rates
        const growth: Record<string, number | null> = {
            spend: null,
            impressions: null,
            reach: null,
            clicks: null,
            ctr: null,
            cpc: null,
            cpm: null,
            results: null,
            cpr: null,
            messages: null,
            costPerMessage: null,
        };

        if (dailyInsights.length >= 2) {
            const today = dailyInsights[dailyInsights.length - 1];
            const yesterday = dailyInsights[dailyInsights.length - 2];

            const calcGrowth = (todayVal: number, yesterdayVal: number): number | null => {
                if (yesterdayVal === 0) return todayVal > 0 ? 100 : null;
                return ((todayVal - yesterdayVal) / yesterdayVal) * 100;
            };

            growth.spend = calcGrowth(Number(today.spend) || 0, Number(yesterday.spend) || 0);
            growth.impressions = calcGrowth(Number(today.impressions) || 0, Number(yesterday.impressions) || 0);
            growth.reach = calcGrowth(Number(today.reach) || 0, Number(yesterday.reach) || 0);
            growth.clicks = calcGrowth(Number(today.clicks) || 0, Number(yesterday.clicks) || 0);
            growth.ctr = calcGrowth(Number(today.ctr) || 0, Number(yesterday.ctr) || 0);
            growth.cpc = calcGrowth(Number(today.cpc) || 0, Number(yesterday.cpc) || 0);
            growth.cpm = calcGrowth(Number(today.cpm) || 0, Number(yesterday.cpm) || 0);
            growth.results = calcGrowth(Number(today.results) || 0, Number(yesterday.results) || 0);
            growth.cpr = calcGrowth(Number(today.costPerResult) || 0, Number(yesterday.costPerResult) || 0);
            growth.messages = calcGrowth(Number(today.messagingStarted) || 0, Number(yesterday.messagingStarted) || 0);
            growth.costPerMessage = calcGrowth(Number(today.costPerMessaging) || 0, Number(yesterday.costPerMessaging) || 0);
        }

        // Breakdowns
        const deviceBreakdown = await this.prisma.adInsightsDeviceDaily.groupBy({
            by: ['devicePlatform'],
            where: { adId, date: { gte: startDate, lte: endDate } },
            _sum: {
                spend: true,
                impressions: true,
                clicks: true,
            },
        });

        const placementBreakdown = await this.prisma.adInsightsPlacementDaily.groupBy({
            by: ['publisherPlatform', 'platformPosition'],
            where: { adId, date: { gte: startDate, lte: endDate } },
            _sum: {
                spend: true,
                impressions: true,
                clicks: true,
            },
        });

        const ageGenderBreakdown = await this.prisma.adInsightsAgeGenderDaily.groupBy({
            by: ['age', 'gender'],
            where: { adId, date: { gte: startDate, lte: endDate } },
            _sum: {
                spend: true,
                impressions: true,
                clicks: true,
            },
        });

        return {
            summary: { ...summary, growth },
            dailyInsights: dailyInsights.map((d) => ({
                date: d.date,
                spend: Number(d.spend) || 0,
                impressions: Number(d.impressions) || 0,
                reach: Number(d.reach) || 0,
                clicks: Number(d.clicks) || 0,
                ctr: Number(d.ctr) || 0,
                cpc: Number(d.cpc) || 0,
                cpm: Number(d.cpm) || 0,
                results: Number(d.results) || 0,
                costPerResult: Number(d.costPerResult) || 0,
                messages: Number(d.messagingStarted) || 0,
                costPerMessage: Number(d.costPerMessaging) || 0,
            })),
            deviceBreakdown: deviceBreakdown.map((d) => ({
                device: d.devicePlatform,
                spend: Number(d._sum.spend) || 0,
                impressions: Number(d._sum.impressions) || 0,
                clicks: Number(d._sum.clicks) || 0,
            })),
            placementBreakdown: placementBreakdown.map((p) => ({
                platform: p.publisherPlatform,
                position: p.platformPosition,
                spend: Number(p._sum.spend) || 0,
                impressions: Number(p._sum.impressions) || 0,
                clicks: Number(p._sum.clicks) || 0,
            })),
            ageGenderBreakdown: ageGenderBreakdown.map((a) => ({
                age: a.age,
                gender: a.gender,
                spend: Number(a._sum.spend) || 0,
                impressions: Number(a._sum.impressions) || 0,
                clicks: Number(a._sum.clicks) || 0,
            })),
        };
    }

    /**
     * Get hourly insights for an ad
     */
    async getHourlyInsights(adId: string, userId: number, date?: string) {
        // Verify access
        const ad = await this.prisma.ad.findFirst({
            where: {
                id: adId,
                account: { fbAccount: { userId } },
            },
        });

        if (!ad) {
            throw new ForbiddenException('Ad not found or access denied');
        }

        let targetDate: Date;
        if (date) {
            // Parse Vietnam date to UTC for DB query
            targetDate = this.parseVietnamDateToUTC(date);
        } else {
            // Use today in Vietnam timezone
            const todayVN = getVietnamDateString();
            targetDate = this.parseVietnamDateToUTC(todayVN);
        }

        const hourlyInsights = await this.prisma.adInsightsHourly.findMany({
            where: {
                adId,
                date: targetDate,
            },
            orderBy: { hourlyStatsAggregatedByAdvertiserTimeZone: 'asc' },
        });

        return hourlyInsights.map((h) => {
            const hourString = h.hourlyStatsAggregatedByAdvertiserTimeZone;
            const hour = parseInt(hourString.split(':')[0], 10);

            return {
                hour,
                hourLabel: hourString,
                date: h.date,
                spend: Number(h.spend) || 0,
                impressions: Number(h.impressions) || 0,
                reach: Number(h.reach) || 0,
                clicks: Number(h.clicks) || 0,
                ctr: Number(h.ctr) || 0,
                cpc: Number(h.cpc) || 0,
                cpm: Number(h.cpm) || 0,
                results: Number(h.results) || 0,
                costPerResult: Number(h.costPerResult) || 0,
            };
        });
    }
}

