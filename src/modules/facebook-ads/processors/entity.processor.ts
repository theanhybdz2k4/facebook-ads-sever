import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PgBossService } from '../../../pgboss/pgboss.service';
import { EntitySyncService } from '../services/entity-sync.service';

export interface EntitySyncJobData {
    accountId?: string;
    campaignId?: string;
    adsetId?: string;
    entityType: 'campaigns' | 'adsets' | 'ads' | 'creatives' | 'all' | 'adsets-by-campaign' | 'ads-by-adset';
}

@Injectable()
export class EntityProcessor implements OnModuleInit {
    private readonly logger = new Logger(EntityProcessor.name);

    constructor(
        private readonly pgBoss: PgBossService,
        private readonly entitySyncService: EntitySyncService,
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
