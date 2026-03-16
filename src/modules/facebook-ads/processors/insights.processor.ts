import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { SyncInsightsDto } from '../dtos';
import { InsightsSyncService } from '../sync/insights-sync.service';

export interface InsightsSyncJobData {
    accountId: number;
    dateStart?: string;
    dateEnd?: string;
    breakdown?: 'daily' | 'hourly' | 'both' | 'all';
}

@Processor('fb-insights-sync')
export class InsightsProcessor extends WorkerHost {
    private readonly logger = new Logger(InsightsProcessor.name);

    constructor(private readonly insightsSyncService: InsightsSyncService) {
        super();
    }

    async process(job: Job<InsightsSyncJobData>): Promise<any> {
        const { accountId, dateStart, dateEnd, breakdown = 'all' } = job.data;

        this.logger.log(`Processing insights sync job: ${breakdown} for account ${accountId}`);

        try {
            let granularity: 'daily' | 'hourly' | 'both';
            switch (breakdown) {
                case 'daily': granularity = 'daily'; break;
                case 'hourly': granularity = 'hourly'; break;
                default: granularity = 'both'; break;
            }

            return await this.insightsSyncService.syncInsightsForAdAccount(
                accountId,
                granularity,
                dateStart,
                dateEnd
            );
        } catch (error) {
            this.logger.error(`Insights sync job failed: ${error.message}`, error.stack);
            throw error;
        }
    }
}
