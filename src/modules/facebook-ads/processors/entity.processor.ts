import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { EntitySyncService } from '../sync/entity-sync.service';
import { CreativeSyncService } from '../sync/creative-sync.service';

export interface EntitySyncJobData {
    accountId?: number;
    platformIdentityId?: number;
    campaignId?: string;
    adsetId?: string;
    entityType: 'campaigns' | 'adsets' | 'ads' | 'creatives' | 'all' | 'adsets-by-campaign' | 'ads-by-adset';
}

@Processor('fb-entity-sync')
export class EntityProcessor extends WorkerHost {
    private readonly logger = new Logger(EntityProcessor.name);

    constructor(
        private readonly entitySyncService: EntitySyncService,
        private readonly creativeSyncService: CreativeSyncService,
    ) {
        super();
    }

    async process(job: Job<EntitySyncJobData>): Promise<any> {
        const { accountId, campaignId, adsetId, entityType } = job.data;
        this.logger.log(`Processing entity sync job: ${entityType} for account ${accountId}`);

        try {
            switch (entityType) {
                case 'campaigns':
                    return await this.entitySyncService.syncCampaigns(accountId!);

                case 'adsets':
                    return await this.entitySyncService.syncAdGroups(accountId!);

                case 'ads':
                    return await this.entitySyncService.syncAds(accountId!);

                case 'creatives':
                    return await this.creativeSyncService.syncCreativesForAccount(accountId!);

                case 'all':
                    await this.entitySyncService.syncCampaigns(accountId!);
                    await this.entitySyncService.syncAdGroups(accountId!);
                    await this.entitySyncService.syncAds(accountId!);
                    return await this.creativeSyncService.syncCreativesForAccount(accountId!);

                default:
                    throw new Error(`Unknown entity type: ${entityType}`);
            }
        } catch (error) {
            this.logger.error(`Entity sync job failed: ${error.message}`, error.stack);
            throw error;
        }
    }
}
