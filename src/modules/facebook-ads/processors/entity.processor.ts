import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { EntitySyncService } from '../services/entity-sync.service';

export interface EntitySyncJobData {
    accountId?: string;
    campaignId?: string;
    adsetId?: string;
    entityType: 'campaigns' | 'adsets' | 'ads' | 'creatives' | 'all' | 'adsets-by-campaign' | 'ads-by-adset';
}

@Processor('fb-entity-sync')
export class EntityProcessor extends WorkerHost {
    private readonly logger = new Logger(EntityProcessor.name);

    constructor(private readonly entitySyncService: EntitySyncService) {
        super();
    }

    async process(job: Job<EntitySyncJobData>): Promise<any> {
        const { accountId, campaignId, adsetId, entityType } = job.data;
        this.logger.log(`Processing entity sync job: ${entityType} for ${adsetId || campaignId || accountId}`);

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
            this.logger.error(`Entity sync job failed: ${error.message}`, error.stack);
            throw error;
        }
    }
}

