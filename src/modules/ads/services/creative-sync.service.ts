import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { PlatformsService } from '../../platforms/platforms.service';
import { BulkUpsertService } from '../../shared/services/bulk-upsert.service';

@Injectable()
export class CreativeSyncService {
  private readonly logger = new Logger(CreativeSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly platformsService: PlatformsService,
    private readonly bulkUpsert: BulkUpsertService,
  ) { }

  /**
   * Sync creatives for all ACTIVE ads in a platform account
   */
  async syncByAccount(accountId: number) {
    this.logger.debug(`Starting creative sync for account ID: ${accountId}`);

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

    // Only fetch creatives for ACTIVE ads that are currently running
    const activeAds = await this.prisma.unifiedAd.findMany({
      where: {
        accountId: account.id,
        effectiveStatus: 'ACTIVE',
        deletedAt: null,
      },
      select: { id: true, externalId: true, accountId: true, adGroupId: true }
    });

    if (activeAds.length === 0) {
      this.logger.debug(`No active ads found for creative sync in account ${accountId}`);
      return { count: 0 };
    }

    return this.syncAdsCreatives(account, credential.credentialValue, adapter, activeAds);
  }

  /**
   * Sync creative for a specific set of ads
   */
  async syncByIds(adIds: string[]) {
    if (adIds.length === 0) return { count: 0 };

    const ads = await this.prisma.unifiedAd.findMany({
      where: { id: { in: adIds } },
      include: {
        account: {
          include: {
            platform: true,
            identity: {
              include: {
                credentials: {
                  where: { credentialType: 'access_token', isActive: true }
                }
              }
            }
          }
        }
      }
    });

    if (ads.length === 0) throw new NotFoundException('No ads found for provided IDs');

    // Group ads by account to minimize API calls if possible (though we usually have 1 account context)
    const account = ads[0].account;
    const credential = account.identity.credentials[0];
    const adapter = this.platformsService.getAdapter(account.platform.code);

    return this.syncAdsCreatives(account, credential.credentialValue, adapter, ads);
  }

  private async syncAdsCreatives(account: any, token: string, adapter: any, ads: any[]) {
    try {
      const adExternalIds = ads.map(ad => ad.externalId);

      const chunkSize = 50;
      let allFetchedAds = [];
      for (let i = 0; i < adExternalIds.length; i += chunkSize) {
        const chunk = adExternalIds.slice(i, i + chunkSize);
        const chunkResult = await adapter.fetchAdCreatives(account.externalId, token, chunk);
        allFetchedAds = allFetchedAds.concat(chunkResult);
      }

      this.logger.debug(`Fetched ${allFetchedAds.length} ads with creative details for account ${account.externalId}`);

      const rawCreativesToUpsert = [];
      const seenCreativeIds = new Set();

      for (const item of allFetchedAds) {
        const creative = item.creative;
        if (creative && !seenCreativeIds.has(creative.id)) {
          seenCreativeIds.add(creative.id);

          // Unified logic for thumbnail extraction
          const spec = creative.object_story_spec || {};
          const assetFeed = creative.asset_feed_spec || {};

          const thumbnailUrl = creative.thumbnail_url ||
            spec.link_data?.picture ||
            spec.video_data?.image_url ||
            (assetFeed.images && assetFeed.images[0]?.url) ||
            (creative.image_hash ? `https://graph.facebook.com/v19.0/${creative.image_hash}/thumbnails` : null);

          rawCreativesToUpsert.push({
            id: 'cr' + Math.random().toString(36).substring(2, 25), // Generate simple ID to avoid null constraint
            platform_account_id: account.id,
            external_id: creative.id,
            name: creative.name,
            image_url: creative.image_url || thumbnailUrl,
            thumbnail_url: thumbnailUrl,
            platform_data: creative,
            synced_at: new Date()
          });
        }
      }

      if (rawCreativesToUpsert.length > 0) {
        await this.bulkUpsert.execute(
          'unified_ad_creatives',
          rawCreativesToUpsert,
          ['platform_account_id', 'external_id'],
          ['name', 'image_url', 'thumbnail_url', 'platform_data', 'synced_at']
        );

        // Fetch internal IDs for linkage
        const internalCreatives = await this.prisma.unifiedAdCreative.findMany({
          where: { accountId: account.id, externalId: { in: Array.from(seenCreativeIds) as string[] } },
          select: { id: true, externalId: true }
        });
        const creativeIdMap = new Map(internalCreatives.map(c => [c.externalId, c.id]));

        const adsToUpdate = [];
        for (const ad of ads) {
          const fetchedAd = allFetchedAds.find(a => a.id === ad.externalId);
          const creativeExternalId = fetchedAd?.creative?.id;
          const internalId = creativeExternalId ? creativeIdMap.get(creativeExternalId) : null;

          if (internalId) {
            adsToUpdate.push({
              id: ad.id,
              platform_account_id: ad.accountId,
              external_id: ad.externalId,
              unified_ad_group_id: ad.adGroupId,
              unified_ad_creative_id: internalId,
              synced_at: new Date()
            });
          }
        }

        if (adsToUpdate.length > 0) {
          await this.bulkUpsert.execute(
            'unified_ads',
            adsToUpdate,
            ['platform_account_id', 'external_id'],
            ['unified_ad_creative_id', 'synced_at']
          );
        }
      }

      return { count: seenCreativeIds.size, linkedAds: ads.length };
    } catch (error) {
      this.logger.error(`Failed to sync creatives: ${error.message}`);
      throw error;
    }
  }
}
