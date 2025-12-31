import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PgBossService } from '../../../pgboss/pgboss.service';
import { InsightsSyncService } from '../services/insights-sync.service';

export interface InsightsSyncJobData {
    accountId?: string;
    adId?: string;
    dateStart: string;
    dateEnd: string;
    breakdown?: 'daily' | 'device' | 'placement' | 'age_gender' | 'region' | 'hourly' | 'all';
}

@Injectable()
export class InsightsProcessor implements OnModuleInit {
    private readonly logger = new Logger(InsightsProcessor.name);

    constructor(
        private readonly pgBoss: PgBossService,
        private readonly insightsSyncService: InsightsSyncService,
    ) { }

    async onModuleInit() {
        await this.pgBoss.work<InsightsSyncJobData>('fb-insights-sync', async (job) => {
            await this.process(job.data);
        });
        this.logger.log('InsightsProcessor worker registered for fb-insights-sync');
    }

    async process(data: InsightsSyncJobData): Promise<any> {
        const { accountId, adId, dateStart, dateEnd, breakdown = 'all' } = data;

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
