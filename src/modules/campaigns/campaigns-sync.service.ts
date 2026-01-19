import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { PlatformsService } from '../platforms/platforms.service';
import { FacebookCampaignAdapter } from '../platforms/implementations/facebook/facebook-campaign.adapter';
import { BulkUpsertService } from '../shared/services/bulk-upsert.service';

@Injectable()
export class CampaignsSyncService {
  private readonly logger = new Logger(CampaignsSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly platformsService: PlatformsService,
    private readonly fbCampaignAdapter: FacebookCampaignAdapter,
    private readonly bulkUpsert: BulkUpsertService,
  ) { }

  async syncByAccount(accountId: number, forceFullSync = false, skipSyncedAtUpdate = false) {
    this.logger.debug(`Starting campaign sync for account ID: ${accountId} (Full sync: ${forceFullSync})`);

    const account = await this.prisma.platformAccount.findUnique({
      where: { id: accountId },
      include: {
        platform: true,
        identity: {
          include: {
            credentials: {
              where: { credentialType: 'access_token', isActive: true }
            }
          }
        }
      },
    });

    if (!account) throw new NotFoundException('Account not found');
    const credential = account.identity.credentials[0];
    if (!credential) throw new Error('No active credential found for platform account');

    const adapter = this.platformsService.getAdapter(account.platform.code);

    try {
      this.logger.debug(`Fetching campaigns for account ${account.externalId}`);

      let since: number | undefined;
      
      // Check if we have any campaigns for this account. If not, we MUST do a full sync once.
      const campaignCount = await this.prisma.unifiedCampaign.count({ where: { accountId: account.id } });
      const effectiveForceFullSync = forceFullSync || campaignCount === 0;

      if (!effectiveForceFullSync && account.syncedAt) {
        since = Math.floor(account.syncedAt.getTime() / 1000) - 3600;
        this.logger.debug(`Incremental sync since: ${new Date(since * 1000).toISOString()}`);
      } else {
        this.logger.debug(`Performing FULL sync for account ${account.name} (Count: ${campaignCount}, Force: ${forceFullSync})`);
      }

      const rawCampaigns = await adapter.fetchCampaigns(account.externalId, credential.credentialValue, since);
      const mapper = account.platform.code === 'facebook' ? this.fbCampaignAdapter : null;
      if (!mapper) throw new Error(`No campaign mapper for platform ${account.platform.code}`);

      const entitiesToUpsert = [];
      const syncedExternalIds = [];
      let activeCount = 0;
      const now = new Date();

      for (const raw of rawCampaigns) {
        try {
          const uc = mapper.mapToUnified(raw);
          syncedExternalIds.push(uc.externalId);

          const isLive = uc.status === 'ACTIVE' &&
            uc.effectiveStatus === 'ACTIVE' &&
            (!uc.endTime || new Date(uc.endTime) > now);
          if (isLive) activeCount++;

          entitiesToUpsert.push({
            id: (uc as any).id || ('cm' + Math.random().toString(36).substring(2, 25)),
            platform_account_id: account.id,
            external_id: uc.externalId,
            name: uc.name,
            status: uc.status,
            objective: uc.objective,
            daily_budget: uc.dailyBudget,
            lifetime_budget: uc.lifetimeBudget,
            start_time: uc.startTime,
            end_time: uc.endTime,
            effective_status: uc.effectiveStatus,
            platform_data: uc.platformData,
            synced_at: uc.syncedAt,
            deleted_at: null
          });
        } catch (e) {
          this.logger.debug(`Failed to map campaign ${raw.id}: ${e.message}`);
        }
      }

      if (entitiesToUpsert.length > 0) {
        await this.bulkUpsert.execute(
          'unified_campaigns',
          entitiesToUpsert,
          ['platform_account_id', 'external_id'],
          ['name', 'status', 'objective', 'daily_budget', 'lifetime_budget', 'start_time', 'end_time', 'effective_status', 'platform_data', 'synced_at', 'deleted_at']
        );
      }

      let deletedCount = 0;
      if (effectiveForceFullSync) {
        const deleteResult = await this.prisma.unifiedCampaign.updateMany({
          where: {
            accountId: account.id,
            externalId: { notIn: syncedExternalIds },
            deletedAt: null,
          },
          data: { deletedAt: new Date(), status: 'DELETED' }
        });
        deletedCount = deleteResult.count;
      }

      if (!skipSyncedAtUpdate) {
        await this.prisma.platformAccount.update({
          where: { id: account.id },
          data: { syncedAt: new Date() },
        });
      }

      this.logger.log(`Sync Summary for ${account.name} (Campaigns): Fetched ${rawCampaigns.length}, Bulk Upserted ${entitiesToUpsert.length}, Active ${activeCount}, Deleted ${deletedCount}`);

      return { count: entitiesToUpsert.length, active: activeCount, deleted: deletedCount };
    } catch (error) {
      this.logger.error(`Campaign synchronization failed for account ${accountId}: ${error.message}`, error.stack);
      throw error;
    }
  }
}
