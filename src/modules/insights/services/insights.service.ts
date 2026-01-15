import { Injectable } from '@nestjs/common';
import { InsightsSyncService } from './insights-sync.service';
import { InsightsQueryService } from './insights-query.service';

@Injectable()
export class InsightsService {
    constructor(
        private readonly insightsSyncService: InsightsSyncService,
        private readonly insightsQueryService: InsightsQueryService,
    ) { }

    // Delegate to sync service
    async syncInsightsForAd(adId: string, userId: number, dateStart: string, dateEnd: string, breakdown?: string) {
        return this.insightsSyncService.syncInsightsForAd(adId, userId, dateStart, dateEnd, breakdown || 'all');
    }

    async syncDailyInsights(accountId: string, userId: number, dateStart: string, dateEnd: string) {
        return this.insightsSyncService.syncDailyInsights(accountId, userId, dateStart, dateEnd);
    }

    // Delegate to query service
    async getDailyInsights(userId: number, filters?: { accountId?: string; dateStart?: string; dateEnd?: string; branchId?: string }) {
        return this.insightsQueryService.getDailyInsights(userId, filters);
    }

    async getAdAnalytics(adId: string, userId: number, dateStart?: string, dateEnd?: string) {
        return this.insightsQueryService.getAdAnalytics(adId, userId, dateStart, dateEnd);
    }

    async getHourlyInsights(adId: string, userId: number, date?: string) {
        return this.insightsQueryService.getHourlyInsights(adId, userId, date);
    }
}

