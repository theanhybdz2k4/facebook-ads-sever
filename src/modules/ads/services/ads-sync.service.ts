import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { PlatformsService } from '../../platforms/platforms.service';
import { FacebookAdGroupAdapter } from '../../platforms/implementations/facebook/facebook-ad-group.adapter';
import { FacebookAdAdapter } from '../../platforms/implementations/facebook/facebook-ad.adapter';
import { CampaignsService } from '../../campaigns/campaigns.service';
import { AdGroupsService } from '../../ad-groups/services/ad-groups.service';
import { BulkUpsertService } from '../../shared/services/bulk-upsert.service';
import { CreativeSyncService } from './creative-sync.service';

@Injectable()
export class AdsSyncService {
  private readonly logger = new Logger(AdsSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly platformsService: PlatformsService,
    private readonly campaignsService: CampaignsService,
    private readonly adGroupsService: AdGroupsService,
    private readonly fbAdGroupAdapter: FacebookAdGroupAdapter,
    private readonly fbAdAdapter: FacebookAdAdapter,
    private readonly bulkUpsert: BulkUpsertService,
    private readonly creativeSync: CreativeSyncService,
  ) { }

  async syncByAccount(accountId: number, forceFullSync = false) {
    this.logger.debug(`Starting ad/adgroup sync for account ID: ${accountId} (Full sync: ${forceFullSync})`);

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

    let since: number | undefined;

    // Check if we have any ad groups or ads. If missing either, force full sync once.
    const adGroupCount = await this.prisma.unifiedAdGroup.count({ where: { accountId: account.id } });
    const adCount = await this.prisma.unifiedAd.count({ where: { accountId: account.id } });
    const effectiveForceFullSync = forceFullSync || adGroupCount === 0 || adCount === 0;

    if (!effectiveForceFullSync && account.syncedAt) {
      since = Math.floor(account.syncedAt.getTime() / 1000) - 3600;
    }

    try {
      // 1. Sync Ad Groups (AdSets in FB)
      // Standardized: Fetch ALL AdSets for the account to ensure we don't accidentally delete paused ones.
      this.logger.debug(`Fetching AdSets for account ${account.externalId}`);

      const rawAdGroups = await adapter.fetchAdGroups(account.externalId, credential.credentialValue, since);
      const adGroupMapper = account.platform.code === 'facebook' ? this.fbAdGroupAdapter : null;
      if (!adGroupMapper) throw new Error(`No AdGroup mapper for platform ${account.platform.code}`);

      const matchedAdGroups = [];
      const syncedAdGroupExternalIds = [];

      // Need to map campaign external ID to internal ID for ALL campaigns in this account
      const allCampaigns = await this.prisma.unifiedCampaign.findMany({
        where: { accountId: account.id },
        select: { id: true, externalId: true }
      });
      const campaignIdMap = new Map(allCampaigns.map(c => [c.externalId, c.id]));

      for (const raw of rawAdGroups) {
        try {
          const mapped = adGroupMapper.mapToUnified(raw);
          syncedAdGroupExternalIds.push(mapped.externalId);
          const internalCampaignId = campaignIdMap.get(raw.campaign_id);

          if (internalCampaignId) {
            matchedAdGroups.push({
              id: (mapped as any).id || ('ag' + Math.random().toString(36).substring(2, 25)),
              unified_campaign_id: internalCampaignId,
              platform_account_id: account.id,
              external_id: mapped.externalId,
              name: mapped.name,
              status: mapped.status,
              daily_budget: mapped.dailyBudget,
              optimization_goal: (mapped as any).optimizationGoal,
              effective_status: mapped.effectiveStatus,
              platform_data: mapped.platformData,
              synced_at: mapped.syncedAt,
              deleted_at: null
            });
          }
        } catch (e) {
          this.logger.debug(`Failed to map ad group ${raw.id}: ${e.message}`);
        }
      }

      if (matchedAdGroups.length > 0) {
        await this.bulkUpsert.execute(
          'unified_ad_groups',
          matchedAdGroups,
          ['platform_account_id', 'external_id'],
          ['name', 'status', 'daily_budget', 'optimization_goal', 'effective_status', 'platform_data', 'synced_at', 'deleted_at', 'unified_campaign_id']
        );
      }

      let deletedGroupsCount = 0;
      if (effectiveForceFullSync) {
        const deleteAdGroupResult = await this.prisma.unifiedAdGroup.updateMany({
          where: { accountId: account.id, externalId: { notIn: syncedAdGroupExternalIds }, deletedAt: null },
          data: { deletedAt: new Date(), status: 'DELETED' }
        });
        deletedGroupsCount = deleteAdGroupResult.count;
      }

      // 2. Sync Ads
      // Standardized: Fetch ALL Ads for the account to ensure data integrity
      this.logger.debug(`Fetching Ads for account ${account.externalId}`);
      const adMapper = account.platform.code === 'facebook' ? this.fbAdAdapter : null;
      if (!adMapper) throw new Error(`No Ad mapper for platform ${account.platform.code}`);

      const rawAds = await adapter.fetchAds(account.externalId, credential.credentialValue, since);
      const totalRawAds = rawAds.length;

      const adEntities = [];
      const syncedAdExternalIds = [];

      // Map ad group external ID to internal ID for ALL ad groups in this account
      const allAdGroups = await this.prisma.unifiedAdGroup.findMany({
        where: { accountId: account.id },
        select: { id: true, externalId: true }
      });
      const adGroupIdMap = new Map(allAdGroups.map(ag => [ag.externalId, ag.id]));

      for (const raw of rawAds) {
        try {
          const mapped = adMapper.mapToUnified(raw);
          syncedAdExternalIds.push(mapped.externalId);
          const internalAdGroupId = adGroupIdMap.get(raw.adset_id);

          if (internalAdGroupId) {
            adEntities.push({
              id: (mapped as any).id || ('ad' + Math.random().toString(36).substring(2, 25)),
              unified_ad_group_id: internalAdGroupId,
              platform_account_id: account.id,
              external_id: mapped.externalId,
              name: mapped.name,
              status: mapped.status,
              effective_status: mapped.effectiveStatus,
              platform_data: mapped.platformData,
              synced_at: mapped.syncedAt,
              deleted_at: null
            });
          }
        } catch (e) {
          this.logger.debug(`Failed to map ad ${raw.id}: ${e.message}`);
        }
      }

      if (adEntities.length > 0) {
        await this.bulkUpsert.execute(
          'unified_ads',
          adEntities,
          ['platform_account_id', 'external_id'],
          ['name', 'status', 'effective_status', 'platform_data', 'synced_at', 'deleted_at', 'unified_ad_group_id']
        );
      }

      let deletedAdsCount = 0;
      if (effectiveForceFullSync) {
        // More aggressive pruning: Mark ads as ARCHIVED/DELETED if they are not in the current sync but belong to this account
        const deleteAdResult = await this.prisma.unifiedAd.updateMany({
          where: {
            accountId: account.id,
            externalId: { notIn: syncedAdExternalIds },
            status: { not: 'DELETED' },
            deletedAt: null
          },
          data: { deletedAt: new Date(), status: 'DELETED', effectiveStatus: 'DELETED' }
        });
        deletedAdsCount = deleteAdResult.count;
      }

      // Cleanup: Mark entities as PAUSED/INACTIVE if their parents are effectively inactive.
      // This is crucial because our optimized sync skips inactive parents, so children would otherwise remain ACTIVE forever.
      this.logger.debug('Cleaning up stale ACTIVE entities belonging to inactive parents...');

      // 1. Stale Ad Groups (Active AGs in Inactive/Paused Campaigns)
      const staleAdGroups = await this.prisma.unifiedAdGroup.updateMany({
        where: {
          accountId: account.id,
          status: 'ACTIVE',
          campaign: {
            OR: [
              { status: { not: 'ACTIVE' } },
              { effectiveStatus: { not: 'ACTIVE' } },
              { endTime: { lte: new Date() } } // Expired campaigns
            ]
          }
        },
        data: { status: 'PAUSED', effectiveStatus: 'CAMPAIGN_PAUSED', syncedAt: new Date() }
      });

      // 2. Stale Ads (Active Ads in Inactive/Paused Ad Groups)
      // This helps clean up "ghost" active ads that didn't get caught in the incremental sync
      const staleAds = await this.prisma.unifiedAd.updateMany({
        where: {
          accountId: account.id,
          status: 'ACTIVE',
          OR: [
            {
              adGroup: {
                OR: [
                  { status: { not: 'ACTIVE' } },
                  { effectiveStatus: { not: 'ACTIVE' } }
                ]
              }
            },
            {
              // Also catch ads whose external IDs were NOT in the latest fetch if it was a fairly recent full sync
              // or if they are just plain old and likely defunct. 
              // For now, let's stick to parent-based cleanup as it's safer.
            }
          ]
        },
        data: { status: 'PAUSED', effectiveStatus: 'ADSET_PAUSED', syncedAt: new Date() }
      });

      this.logger.debug(`Cleanup summary for ${account.externalId}: ${staleAdGroups.count} stale AdGroups, ${staleAds.count} stale Ads marked as paused.`);

      this.logger.log(`Sync Summary for ${account.name} (Ads/AdGroups): AdGroups Updated ${matchedAdGroups.length}, Ads Fetched ${totalRawAds}, Updated ${adEntities.length}, Deleted ${deletedAdsCount}`);

      // 3. Trigger Creative Sync via Service - ONLY for ads that are truly active
      this.logger.debug(`Triggering separate creative sync for active ads...`);
      await this.creativeSync.syncByAccount(account.id);

      return { adGroups: matchedAdGroups.length, ads: adEntities.length, deletedAds: deletedAdsCount };
    } catch (error) {
      this.logger.error(`Ad synchronization failed for account ${account.id}: ${error.message}`, error.stack);
      throw error;
    }
  }
}
