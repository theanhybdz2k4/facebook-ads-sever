import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { InsightsSyncService } from '../services/insights-sync.service';

export interface InsightsSyncJobData {
    accountId?: string;
    adId?: string;
    dateStart: string;
    dateEnd: string;
    breakdown?: 'daily' | 'device' | 'placement' | 'age_gender' | 'region' | 'hourly' | 'all';
}

@Processor('fb-insights-sync')
export class InsightsProcessor extends WorkerHost {
    private readonly logger = new Logger(InsightsProcessor.name);

    constructor(private readonly insightsSyncService: InsightsSyncService) {
        super();
    }

    async process(job: Job<InsightsSyncJobData>): Promise<any> {
        const { accountId, adId, dateStart, dateEnd, breakdown = 'all' } = job.data;

        // Handle sync by adId
        if (adId) {
            this.logger.log(`Processing insights sync job for ad: ${adId}`);
            return await this.insightsSyncService.syncInsightsForAd(adId, dateStart, dateEnd, breakdown);
        }

        // Handle sync by accountId
        this.logger.log(`Processing insights sync job: ${breakdown} for ${accountId}`);

        try {
            switch (breakdown) {
                case 'daily':
                    return await this.insightsSyncService.syncDailyInsights(accountId!, dateStart, dateEnd);

                case 'device':
                    return await this.insightsSyncService.syncDeviceInsights(accountId!, dateStart, dateEnd);

                case 'placement':
                    return await this.insightsSyncService.syncPlacementInsights(accountId!, dateStart, dateEnd);

                case 'age_gender':
                    return await this.insightsSyncService.syncAgeGenderInsights(accountId!, dateStart, dateEnd);

                case 'region':
                    return await this.insightsSyncService.syncRegionInsights(accountId!, dateStart, dateEnd);

                case 'hourly':
                    return await this.insightsSyncService.syncHourlyInsights(accountId!, dateStart, dateEnd);

                case 'all':
                    return await this.insightsSyncService.syncAllInsights(accountId!, dateStart, dateEnd);

                default:
                    throw new Error(`Unknown breakdown type: ${breakdown}`);
            }
        } catch (error) {
            this.logger.error(`Insights sync job failed: ${error.message}`, error.stack);
            throw error;
        }
    }
}

