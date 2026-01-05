import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PgBossService } from '../../../pgboss/pgboss.service';
import { InsightsSyncService } from '../services/insights-sync.service';
import { RateLimiterService } from '../../shared/services/rate-limiter.service';

export interface InsightsSyncJobData {
    accountId?: string;
    adId?: string;
    dateStart: string;
    dateEnd: string;
    breakdown?: 'daily' | 'device' | 'placement' | 'age_gender' | 'region' | 'hourly' | 'all';
    retryCount?: number;
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 60000; // 1 minute base delay for rate limit

@Injectable()
export class InsightsProcessor implements OnModuleInit {
    private readonly logger = new Logger(InsightsProcessor.name);

    constructor(
        private readonly pgBoss: PgBossService,
        private readonly insightsSyncService: InsightsSyncService,
        private readonly rateLimiter: RateLimiterService,
    ) { }

    async onModuleInit() {
        await this.pgBoss.work<InsightsSyncJobData>('fb-insights-sync', async (job) => {
            await this.process(job.data);
        });
        this.logger.log('InsightsProcessor worker registered for fb-insights-sync');
    }

    async process(data: InsightsSyncJobData): Promise<any> {
        const { accountId, adId, dateStart, dateEnd, breakdown = 'all' } = data;
        const retryCount = data.retryCount || 0;

        // Check rate limit before processing
        const targetAccountId = accountId || await this.getAccountIdFromAd(adId);
        if (targetAccountId) {
            const pauseTime = this.rateLimiter.getPauseTimeMs(targetAccountId);
            if (pauseTime > 0) {
                this.logger.log(`Rate limited, waiting ${pauseTime}ms before processing...`);
                await this.delay(pauseTime);
            }
        }

        // Handle sync by adId
        if (adId) {
            this.logger.log(`Processing insights sync job for ad: ${adId}`);
            try {
                return await this.insightsSyncService.syncInsightsForAd(adId, dateStart, dateEnd, breakdown);
            } catch (error) {
                return this.handleError(error, data, retryCount);
            }
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
            return this.handleError(error, data, retryCount);
        }
    }

    private async handleError(error: any, data: InsightsSyncJobData, retryCount: number): Promise<any> {
        // Check if this is a Facebook rate limit error (80004)
        const isRateLimitError = this.isRateLimitError(error);

        if (isRateLimitError && retryCount < MAX_RETRIES) {
            // Exponential backoff: 1min, 2min, 4min
            const delayMs = BASE_DELAY_MS * Math.pow(2, retryCount);
            this.logger.warn(
                `Rate limit hit for insights sync. Retry ${retryCount + 1}/${MAX_RETRIES} after ${delayMs / 1000}s`
            );

            // Wait and retry
            await this.delay(delayMs);
            return this.process({ ...data, retryCount: retryCount + 1 });
        }

        this.logger.error(`Insights sync job failed: ${error.message}`, error.stack);
        throw error;
    }

    private isRateLimitError(error: any): boolean {
        // Check for Facebook error code 80004 (too many calls)
        const responseData = error?.response?.data;
        if (responseData?.error?.code === 80004) {
            return true;
        }
        // Also check error message
        if (error?.message?.includes('too many calls') || error?.message?.includes('rate limit')) {
            return true;
        }
        return false;
    }

    private async getAccountIdFromAd(adId?: string): Promise<string | null> {
        // For now, return null - can be enhanced to lookup account from DB
        return null;
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
