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

  async syncBranch(branchId: number, dateStart: string, dateEnd: string, granularity: 'DAILY' | 'HOURLY' = 'DAILY', forceFullSync = false, skipHierarchySync = false, skipBreakdowns = false) {
    this.logger.debug(`Starting ${granularity} sync for branch ${branchId} from ${dateStart} to ${dateEnd} (Skip Hierarchy: ${skipHierarchySync}, Skip Breakdowns: ${skipBreakdowns})`);

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
          ? this.syncAccountHourlyInsights(accountId, dateStart, dateEnd, forceFullSync, undefined, skipHierarchySync)
          : this.syncAccountInsights(accountId, dateStart, dateEnd, forceFullSync, undefined, skipHierarchySync, skipBreakdowns));

        results.insights += insightResult.count;
        results.accounts++;
      } catch (e) {
        this.logger.error(`Failed to sync account ${accountId} in branch ${branchId}: ${e.message}`);
        results.errors.push({ accountId, error: e.message });
      }
    }

    if (granularity === 'DAILY') {
      try {
        const start = new Date(`${dateStart}T00:00:00.000Z`);
        const end = new Date(`${dateEnd}T00:00:00.000Z`);
        const current = new Date(start);

        while (current <= end) {
          const dateStr = current.toISOString().split('T')[0];
          await this.branchStatsService.aggregateBranchStats(branchId, dateStr);
          current.setDate(current.getDate() + 1);
        }
      } catch (e) {
        this.logger.error(`Failed to aggregate stats for branch ${branchId}: ${e.message}`);
      }
    }

    return results;
  }

  async syncAccountInsights(accountId: number, dateStart: string, dateEnd: string, forceFullSync = false, targetAdExternalIds?: string[], skipHierarchySync = false, skipBreakdowns = false, granularity: 'DAILY' | 'HOURLY' | 'BOTH' = 'DAILY') {
    if (granularity === 'BOTH') {
      const daily = await this.syncInternal(accountId, dateStart, dateEnd, 'DAILY', forceFullSync, targetAdExternalIds, skipHierarchySync, skipBreakdowns);
      const hourly = await this.syncInternal(accountId, dateStart, dateEnd, 'HOURLY', forceFullSync, targetAdExternalIds, true, true); // skip hierarchy and breakdowns for hourly
      return { count: daily.count + hourly.count };
    }
    return this.syncInternal(accountId, dateStart, dateEnd, granularity as 'DAILY' | 'HOURLY', forceFullSync, targetAdExternalIds, skipHierarchySync, skipBreakdowns);
  }

  async syncAccountHourlyInsights(accountId: number, dateStart: string, dateEnd: string, forceFullSync = false, targetAdExternalIds?: string[], skipHierarchySync = false) {
    return this.syncInternal(accountId, dateStart, dateEnd, 'HOURLY', forceFullSync, targetAdExternalIds, skipHierarchySync);
  }

  private async syncInternal(
    accountId: number,
    dateStart: string,
    dateEnd: string,
    granularity: 'DAILY' | 'HOURLY',
    forceFullSync = false,
    targetAdExternalIds?: string[],
    skipHierarchySync = false,
    skipBreakdowns = false
  ) {
    // 0. Ensure campaigns and ads are synced first
    // If we have targetAdExternalIds, we could theoretically sync only those ads,
    // but for now we keep account-level hierarchy sync to ensure everything is consistent.
    // However, if targetAdExternalIds is provided, we might want to skip hierarchy sync to be "only that ad"
    const shouldSkipHierarchy = skipHierarchySync || !!targetAdExternalIds;
    const isHourly = granularity === 'HOURLY';

    if (!shouldSkipHierarchy) {
      await this.campaignsSync.syncByAccount(accountId, forceFullSync, true); // skip update here
      await this.adsSync.syncByAccount(accountId, forceFullSync);

      // Update syncedAt once hierarchy is done
      await this.prisma.platformAccount.update({
        where: { id: accountId },
        data: { syncedAt: new Date() }
      });
    }

    // 0.1 Prepare date range if hourly to iterate day by day
    // Facebook API aggregates hourly data across the whole range if not called per day.
    const datesToSync: string[] = [];
    if (isHourly) {
      const start = new Date(`${dateStart}T00:00:00.000Z`);
      const end = new Date(`${dateEnd}T00:00:00.000Z`);
      const current = new Date(start);
      while (current <= end) {
        datesToSync.push(current.toISOString().split('T')[0]);
        current.setDate(current.getDate() + 1);
      }
    } else {
      datesToSync.push(dateStart); // For daily, we can use the range if dateStart == dateEnd, or the range itself.
      // Wait, the daily sync also needs to handle ranges correctly, but FB API handles 'time_increment=1' for ranges.
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
        // For hourly sync, strictly filter by effectiveStatus that are delivering
        effectiveStatus: granularity === 'HOURLY' && !targetAdExternalIds ? { in: ['ACTIVE', 'IN_PROCESS', 'WITH_ISSUES'] } : undefined,
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

    // Use loop for dates if hourly, otherwise just the range
    for (const currentDate of datesToSync) {
      // For DAILY, we still use the full range [dateStart, dateEnd] because FB handles it with time_increment=1
      // For HOURLY, we use [currentDate, currentDate]
      const syncStartDate = isHourly ? currentDate : dateStart;
      const syncEndDate = isHourly ? currentDate : dateEnd;

      for (let i = 0; i < activeAdExternalIds.length; i += chunkSize) {
        const chunk = activeAdExternalIds.slice(i, i + chunkSize);
        this.logger.debug(`Fetching Insights for Ad chunk ${i / chunkSize + 1} (${chunk.length} ads) with range ${syncStartDate} - ${syncEndDate} (Granularity: ${granularity})`);

        const rawInsights = await adapter.fetchInsights!({
          externalAccountId: account.externalId,
          token: credential.credentialValue,
          level: 'ad',
          dateRange: { start: syncStartDate, end: syncEndDate },
          granularity,
          // Pass chunk as adIds, and undefined for campaignIds
          adIds: chunk
        });

        this.logger.debug(`Fetched ${rawInsights.length} raw insights items from FB for granularity ${granularity}`);

        if (rawInsights.length === 0) {
          this.logger.warn(`FB returned 0 items for account ${account.externalId} across chunk ${chunk.length} ads`);
          continue;
        }

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

            // --- SYNC BREAKDOWNS (Async/Parallel) ---
            // Only for Daily granularity as per current design
            if (entitiesToBatch.length > 0 && !skipBreakdowns) {
              await this.batchSyncBreakdowns(account, credential, syncStartDate, syncEndDate, chunk, adapter, mapper);
            }
          }
        }
      } // End chunk loop

      // If daily, we only run the chunk loop once for the whole range, 
      // so we break the dates loop after one iteration if not hourly.
      if (!isHourly) break;
    } // End date loop

    // --- AUTO-AGGREGATE BRANCH STATS ---
    // If we synced DAILY data, we should update the BranchDailyStats immediately
    // so the dashboard reflects the changes without manual rebuild.
    if (granularity === 'DAILY' && totalInsights > 0) {
      this.triggerBranchAggregation(account.branchId, dateStart, dateEnd).catch(err => {
        this.logger.error(`Background aggregation failed for branch ${account.branchId}: ${err.message}`);
      });
    }

    return { count: totalInsights };
  }

  private async triggerBranchAggregation(branchId: number | null, dateStart: string, dateEnd: string) {
    if (!branchId) return;

    const start = new Date(`${dateStart}T00:00:00.000Z`);
    const end = new Date(`${dateEnd}T00:00:00.000Z`);
    const current = new Date(start);

    while (current <= end) {
      const dateStr = current.toISOString().split('T')[0];
      await this.branchStatsService.aggregateBranchStats(branchId, dateStr);
      current.setDate(current.getDate() + 1);
    }
  }

  private async batchSyncBreakdowns(
    account: any,
    credential: any,
    dateStart: string,
    dateEnd: string,
    adChunk: string[],
    adapter: any, // Should be IPlatformAdapter but typed loosely here for now
    mapper: FacebookInsightAdapter
  ) {
    // 1. Fetch UnifiedInsight IDs for this chunk to link foreign keys
    const parentInsights = await this.prisma.unifiedInsight.findMany({
      where: {
        accountId: account.id,
        date: { gte: new Date(dateStart), lte: new Date(dateEnd) },
        ad: { externalId: { in: adChunk } }
      },
      select: { id: true, adId: true, date: true, ad: { select: { externalId: true } } }
    });

    if (parentInsights.length === 0) return;

    // Create lookup map: "ad_external_id|YYYY-MM-DD" -> unified_insight_id
    const insightMap = new Map<string, string>();
    parentInsights.forEach(pi => {
      if (pi.ad?.externalId) {
        const key = `${pi.ad.externalId}|${pi.date.toISOString().split('T')[0]}`;
        insightMap.set(key, pi.id);
      }
    });

    const parentIds = parentInsights.map(p => p.id);

    // 2. Clear old breakdown data for these insights (Delete-Insert Strategy)
    await this.prisma.$transaction([
      this.prisma.unifiedInsightDevice.deleteMany({ where: { unifiedInsightId: { in: parentIds } } }),
      this.prisma.unifiedInsightAgeGender.deleteMany({ where: { unifiedInsightId: { in: parentIds } } }),
      this.prisma.unifiedInsightRegion.deleteMany({ where: { unifiedInsightId: { in: parentIds } } }),
    ]);

    // 3. Parallel Fetch & Processing
    await Promise.all([
      this.fetchAndMapBreakdowns(account, credential, dateStart, dateEnd, adChunk, adapter, insightMap, 'impression_device', (raw, id) => mapper.mapToDeviceBreakdown(raw, id), 'unified_insight_devices'),
      this.fetchAndMapBreakdowns(account, credential, dateStart, dateEnd, adChunk, adapter, insightMap, 'age,gender', (raw, id) => mapper.mapToAgeGenderBreakdown(raw, id), 'unified_insight_age_gender'),
      this.fetchAndMapBreakdowns(account, credential, dateStart, dateEnd, adChunk, adapter, insightMap, 'region', (raw, id) => mapper.mapToRegionBreakdown(raw, id), 'unified_insight_regions'),
    ]);
  }

  private async fetchAndMapBreakdowns(
    account: any,
    credential: any,
    dateStart: string,
    dateEnd: string,
    adChunk: string[],
    adapter: any,
    insightMap: Map<string, string>,
    breakdownType: string,
    mapFn: (raw: any, id: string) => any,
    tableName: string
  ) {
    try {
      if (!adapter.fetchInsights) return;

      const rawData = await adapter.fetchInsights({
        externalAccountId: account.externalId,
        token: credential.credentialValue,
        level: 'ad',
        dateRange: { start: dateStart, end: dateEnd },
        breakdowns: breakdownType,
        adIds: adChunk,
        granularity: 'DAILY', // Ensure daily match
      });

      if (!rawData || rawData.length === 0) return;

      const entities = [];
      for (const row of rawData) {
        const adId = row.ad_id;
        const date = row.date_start; // Already YYYY-MM-DD from FB
        const key = `${adId}|${date}`;

        const parentId = insightMap.get(key);
        if (parentId) {
          entities.push(mapFn(row, parentId));
        }
      }

      if (entities.length > 0) {
        if (tableName === 'unified_insight_devices') {
          await this.prisma.unifiedInsightDevice.createMany({ data: entities });
        } else if (tableName === 'unified_insight_age_gender') {
          await this.prisma.unifiedInsightAgeGender.createMany({ data: entities });
        } else if (tableName === 'unified_insight_regions') {
          await this.prisma.unifiedInsightRegion.createMany({ data: entities });
        }
      }

    } catch (error) {
      this.logger.error(`Failed to sync breakdown ${breakdownType} for account ${account.id}: ${error.message}`);
    }
  }

  async syncAdInsights(adId: string, dateStart: string, dateEnd: string, breakdown?: string) {
    const ad = await this.prisma.unifiedAd.findUnique({
      where: { id: adId },
    });
    if (!ad) throw new NotFoundException('Ad not found');

    // Sync account insights (Daily)
    const dailyResult = await this.syncAccountInsights(ad.accountId, dateStart, dateEnd, false, [ad.externalId]);

    // Sync hourly if requested
    let hourlyCount = 0;
    if (breakdown === 'all' || breakdown === 'hourly') {
      const hourlyRes = await this.syncAccountHourlyInsights(ad.accountId, dateStart, dateEnd, false, [ad.externalId]);
      hourlyCount = hourlyRes.count;
    }

    return dailyResult.count + hourlyCount;
  }
}
