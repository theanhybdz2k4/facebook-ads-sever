import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PgBossService } from '../../../pgboss/pgboss.service';
import { EntitySyncService } from '../services/entity-sync.service';
import { RateLimiterService } from '../../shared/services/rate-limiter.service';

export interface EntitySyncJobData {
    accountId?: string;
    campaignId?: string;
    adsetId?: string;
    entityType: 'campaigns' | 'adsets' | 'ads' | 'creatives' | 'all' | 'adsets-by-campaign' | 'ads-by-adset';
    retryCount?: number;
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 60000; // 1 minute base delay for rate limit

@Injectable()
export class EntityProcessor implements OnModuleInit {
    private readonly logger = new Logger(EntityProcessor.name);

    constructor(
        private readonly pgBoss: PgBossService,
        private readonly entitySyncService: EntitySyncService,
        private readonly rateLimiter: RateLimiterService,
    ) { }

    async onModuleInit() {
        try {
            await this.pgBoss.work<EntitySyncJobData>('fb-entity-sync', async (job) => {
                this.logger.log(`Processing job ${job.id}: ${job.data.entityType}`);
                await this.process(job.data);
                this.logger.log(`Completed job ${job.id}`);
            });
            this.logger.log('EntityProcessor worker registered for fb-entity-sync');
        } catch (error) {
            this.logger.error(`EntityProcessor: Failed to register worker: ${error.message}`, error.stack);
        }
    }

    async process(data: EntitySyncJobData): Promise<any> {
        const { accountId, campaignId, adsetId, entityType } = data;
        const retryCount = data.retryCount || 0;

        this.logger.log(`Processing entity sync job: ${entityType} for ${adsetId || campaignId || accountId}`);

        // Check rate limit before processing
        const targetAccountId = accountId || await this.getAccountIdFromEntity(campaignId, adsetId);
        if (targetAccountId) {
            const pauseTime = this.rateLimiter.getPauseTimeMs(targetAccountId);
            if (pauseTime > 0) {
                this.logger.log(`Rate limited, waiting ${pauseTime}ms before processing...`);
                await this.delay(pauseTime);
            }
        }

        try {
            switch (entityType) {
                case 'campaigns':
                    return await this.entitySyncService.syncCampaigns(accountId!);

                case 'adsets':
                    return await this.entitySyncService.syncAdsets(accountId!);

                case 'adsets-by-campaign':
                    return await this.entitySyncService.syncAdsetsByCampaign(campaignId!);

                case 'ads':
                    return await this.entitySyncService.syncAds(accountId!);

                case 'ads-by-adset':
                    return await this.entitySyncService.syncAdsByAdset(adsetId!);

                case 'creatives':
                    return await this.entitySyncService.syncCreatives(accountId!);

                case 'all':
                    return await this.entitySyncService.syncAllEntities(accountId!);

                default:
                    throw new Error(`Unknown entity type: ${entityType}`);
            }
        } catch (error) {
            // Check if this is a Facebook rate limit error (80004)
            const isRateLimitError = this.isRateLimitError(error);

            if (isRateLimitError && retryCount < MAX_RETRIES) {
                // Exponential backoff: 1min, 2min, 4min
                const delayMs = BASE_DELAY_MS * Math.pow(2, retryCount);
                this.logger.warn(
                    `Rate limit hit for ${entityType}. Retry ${retryCount + 1}/${MAX_RETRIES} after ${delayMs / 1000}s`
                );

                // Wait and retry
                await this.delay(delayMs);
                return this.process({ ...data, retryCount: retryCount + 1 });
            }

            this.logger.error(`Entity sync job failed: ${error.message}`, error.stack);
            throw error;
        }
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

    private async getAccountIdFromEntity(campaignId?: string, adsetId?: string): Promise<string | null> {
        // For now, return null - can be enhanced to lookup account from DB
        return null;
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
