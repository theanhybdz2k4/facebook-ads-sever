import { Injectable, Logger, NotFoundException, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { PlatformsService } from '../../platforms/platforms.service';
import { FacebookInsightAdapter } from '../../platforms/implementations/facebook/facebook-insight.adapter';
import { CampaignsSyncService } from '../../campaigns/campaigns-sync.service';
import { AdsSyncService } from '../../ads/services/ads-sync.service';
import { BranchStatsService } from '../../branches/services/branch-stats.service';
import { BulkUpsertService } from '../../shared/services/bulk-upsert.service';

@Injectable()
export class InsightsSyncService {
  private readonly logger = new Logger(InsightsSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly platformsService: PlatformsService,
    private readonly fbInsightAdapter: FacebookInsightAdapter,
    private readonly campaignsSync: CampaignsSyncService,
    private readonly adsSync: AdsSyncService,
    @Inject(forwardRef(() => BranchStatsService))
    private readonly branchStatsService: BranchStatsService,
    private readonly bulkUpsert: BulkUpsertService,
  ) { }

  async syncBranch(branchId: number, dateStart: string, dateEnd: string, granularity: 'DAILY' | 'HOURLY' = 'DAILY', forceFullSync = false) {
    this.logger.debug(`Starting ${granularity} sync for branch ${branchId} from ${dateStart} to ${dateEnd}`);

    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      include: { accounts: true },
    });

    if (!branch) throw new NotFoundException('Branch not found');

    const results = {
      accounts: 0,
      campaigns: 0,
      ads: 0,
      insights: 0,
      errors: [],
    };

    for (const account of branch.accounts) {
      const accountId = account.id;
      try {
        const insightResult = await (granularity === 'HOURLY'
          ? this.syncAccountHourlyInsights(accountId, dateStart, dateEnd, forceFullSync)
          : this.syncAccountInsights(accountId, dateStart, dateEnd, forceFullSync));

        results.insights += insightResult.count;
        results.accounts++;
      } catch (e) {
        this.logger.error(`Failed to sync account ${accountId} in branch ${branchId}: ${e.message}`);
        results.errors.push({ accountId, error: e.message });
      }
    }

    if (granularity === 'DAILY') {
      try {
        await this.branchStatsService.aggregateBranchStats(branchId, dateEnd);
      } catch (e) {
        this.logger.error(`Failed to aggregate stats for branch ${branchId}: ${e.message}`);
      }
    }

    return results;
  }

  async syncAccountInsights(accountId: number, dateStart: string, dateEnd: string, forceFullSync = false, targetAdExternalIds?: string[]) {
    return this.syncInternal(accountId, dateStart, dateEnd, 'DAILY', forceFullSync, targetAdExternalIds);
  }

  async syncAccountHourlyInsights(accountId: number, dateStart: string, dateEnd: string, forceFullSync = false, targetAdExternalIds?: string[]) {
    return this.syncInternal(accountId, dateStart, dateEnd, 'HOURLY', forceFullSync, targetAdExternalIds);
  }

  private async syncInternal(
    accountId: number,
    dateStart: string,
    dateEnd: string,
    granularity: 'DAILY' | 'HOURLY',
    forceFullSync = false,
    targetAdExternalIds?: string[]
  ) {
    // 0. Ensure campaigns and ads are synced first
    // If we have targetAdExternalIds, we could theoretically sync only those ads,
    // but for now we keep account-level hierarchy sync to ensure everything is consistent.
    // However, if targetAdExternalIds is provided, we might want to skip hierarchy sync to be "only that ad"
    const skipHierarchySync = !!targetAdExternalIds;

    if (!skipHierarchySync) {
      await this.campaignsSync.syncByAccount(accountId, forceFullSync, true); // skip update here
      await this.adsSync.syncByAccount(accountId, forceFullSync);

      // Update syncedAt once hierarchy is done
      await this.prisma.platformAccount.update({
        where: { id: accountId },
        data: { syncedAt: new Date() }
      });
    }

    const account = await this.prisma.platformAccount.findUnique({
      where: { id: accountId },
      include: {
        platform: true,
        identity: { include: { credentials: { where: { credentialType: 'access_token', isActive: true } } } }
      },
    });

    if (!account) throw new NotFoundException('Account not found');
    const credential = account.identity.credentials[0];
    if (!credential) throw new Error('No active credential found');

    const adapter = this.platformsService.getAdapter(account.platform.code);

    // Relaxed: Fetch insights for all ads that exist for this account
    this.logger.debug(`Fetching ads for account ${account.externalId} to sync insights`);
    const activeAds = await this.prisma.unifiedAd.findMany({
      where: {
        accountId: account.id,
        externalId: targetAdExternalIds ? { in: targetAdExternalIds } : undefined,
        deletedAt: null,
      },
      select: { id: true, externalId: true, adGroupId: true, adGroup: { select: { campaignId: true } } }
    });

    if (activeAds.length === 0) {
      this.logger.warn(`No active ads found for account ${account.externalId}. Skipping Insights sync.`);
      return { count: 0 };
    }

    const activeAdExternalIds = activeAds.map(ad => ad.externalId);
    // Map for faster lookup later
    const adMap = new Map(activeAds.map(a => [a.externalId, a]));

    const chunkSize = 50; // Ad chunk size
    let totalInsights = 0;

    for (let i = 0; i < activeAdExternalIds.length; i += chunkSize) {
      const chunk = activeAdExternalIds.slice(i, i + chunkSize);
      this.logger.debug(`Fetching Insights for Ad chunk ${i / chunkSize + 1} (${chunk.length} ads)`);

      const rawInsights = await adapter.fetchInsights!({
        externalAccountId: account.externalId,
        token: credential.credentialValue,
        level: 'ad',
        dateRange: { start: dateStart, end: dateEnd },
        granularity,
        // Pass chunk as adIds, and undefined for campaignIds
        adIds: chunk
      });

      if (rawInsights.length === 0) continue;

      // We already have the adMap from the initial query, no need to query again unless we suspect mapped mismatch
      // But since we filtered fetch by these IDs, they should be in our map.


      const entitiesToBatch = [];
      const mapper = account.platform.code === 'facebook' ? this.fbInsightAdapter : null;
      if (!mapper) throw new Error(`No insight mapper for platform ${account.platform.code}`);

      const updateColsHourly = ['spend', 'impressions', 'clicks', 'reach', 'results', 'platform_metrics', 'synced_at'];

      if (granularity === 'HOURLY') {
      for (const raw of rawInsights) {
        const mapped = mapper.mapToUnifiedHourly(raw, account.timezone);
        // Robust mapping: Use ad_id from API, or fallback to the single target ad if applicable
        const ad_id = raw.ad_id || (targetAdExternalIds?.length === 1 ? targetAdExternalIds[0] : null);
        const internalAd = ad_id ? adMap.get(ad_id) : null;

        if (!internalAd) {
          this.logger.warn(`Skipping hourly insight for ad_id "${ad_id}" (could not map to internal ad)`);
          continue;
        }

        entitiesToBatch.push({
          id: (mapped as any).id || ('hi' + Math.random().toString(36).substring(2, 25)),
          platform_account_id: account.id,
          unified_campaign_id: internalAd.adGroup?.campaignId || null,
          unified_ad_group_id: internalAd.adGroupId || null,
          unified_ad_id: internalAd.id,
          date: mapped.date,
          hour: (mapped as any).hour,
          spend: mapped.spend,
          impressions: mapped.impressions,
          clicks: mapped.clicks,
          results: mapped.results,
          platform_metrics: (mapped as any).platformMetrics,
          synced_at: mapped.syncedAt,
        });
      }

        if (entitiesToBatch.length > 0) {
          // Hourly insights do not have 'reach' in the schema
          const updateColsHourly = ['spend', 'impressions', 'clicks', 'results', 'platform_metrics', 'synced_at'];
          await this.bulkUpsert.execute(
            'unified_hourly_insights',
            entitiesToBatch,
            ['platform_account_id', 'unified_campaign_id', 'unified_ad_group_id', 'unified_ad_id', 'date', 'hour'],
            updateColsHourly
          );
          totalInsights += entitiesToBatch.length;
        }
      } else {
        for (const raw of rawInsights) {
        const mapped = mapper.mapToUnified(raw);
        // Robust mapping: Use ad_id from API, or fallback to the single target ad if applicable
        const ad_id = raw.ad_id || (targetAdExternalIds?.length === 1 ? targetAdExternalIds[0] : null);
        const internalAd = ad_id ? adMap.get(ad_id) : null;

        if (!internalAd) {
          this.logger.warn(`Skipping insight for ad_id "${ad_id}" (could not map to internal ad)`);
          continue;
        }

        entitiesToBatch.push({
          id: (mapped as any).id || ('i' + Math.random().toString(36).substring(2, 25)),
          platform_account_id: account.id,
          unified_campaign_id: internalAd.adGroup?.campaignId || null,
          unified_ad_group_id: internalAd.adGroupId || null,
          unified_ad_id: internalAd.id,
          date: mapped.date,
          spend: mapped.spend,
          impressions: mapped.impressions,
          clicks: mapped.clicks,
          reach: mapped.reach,
          results: mapped.results,
          conversions: mapped.conversions,
          platform_metrics: (mapped as any).platformMetrics,
          synced_at: mapped.syncedAt,
        });
      }

        if (entitiesToBatch.length > 0) {
          const updateCols = ['spend', 'impressions', 'clicks', 'reach', 'results', 'conversions', 'platform_metrics', 'synced_at'];
          await this.bulkUpsert.execute(
            'unified_insights',
            entitiesToBatch,
            ['platform_account_id', 'unified_campaign_id', 'unified_ad_group_id', 'unified_ad_id', 'date'],
            updateCols
          );
          totalInsights += entitiesToBatch.length;
        }
      }
    } // End chunk loop

    return { count: totalInsights };
  }
  async syncAdInsights(adId: string, dateStart: string, dateEnd: string, breakdown?: string) {
    const ad = await this.prisma.unifiedAd.findUnique({
      where: { id: adId },
    });
    if (!ad) throw new NotFoundException('Ad not found');

    // Sync account insights (Daily)
    const dailyResult = await this.syncAccountInsights(ad.accountId, dateStart, dateEnd, false, [ad.externalId]);
    
    // Sync hourly if requested
    if (breakdown === 'all' || breakdown === 'hourly') {
      await this.syncAccountHourlyInsights(ad.accountId, dateStart, dateEnd, false, [ad.externalId]);
    }

    return dailyResult.count;
  }
}
