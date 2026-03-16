import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma/prisma.service';
import { FacebookApiService } from '../api/facebook-api.service';
import { TokenService } from '../accounts/token.service';
import { CreativeSyncService } from './creative-sync.service';
import { UnifiedStatus } from '@prisma/client';

@Injectable()
export class EntitySyncService {
    private readonly logger = new Logger(EntitySyncService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly facebookApi: FacebookApiService,
        private readonly tokenService: TokenService,
        private readonly creativeSyncService: CreativeSyncService,
    ) { }

    private mapStatus(fbStatus: string): UnifiedStatus {
        switch (fbStatus) {
            case 'ACTIVE': return UnifiedStatus.ACTIVE;
            case 'PAUSED': return UnifiedStatus.PAUSED;
            case 'ARCHIVED': return UnifiedStatus.ARCHIVED;
            case 'DELETED': return UnifiedStatus.DELETED;
            default: return UnifiedStatus.UNKNOWN;
        }
    }

    private getOffset(currency: string): number {
        const unitsOnly = ["VND", "JPY", "KRW", "CLP", "PYG", "ISK"];
        return unitsOnly.includes(currency?.toUpperCase()) ? 1 : 100;
    }

    /**
     * Đồng bộ Campaign
     */
    async syncCampaigns(platformAccountId: number, since?: number) {
        const token = await this.tokenService.getTokenForAdAccount(platformAccountId);
        if (!token) throw new Error('No token found');

        const account = await this.prisma.platformAccount.findUnique({
            where: { id: platformAccountId }
        });
        if (!account) throw new Error('Account not found');

        const campaigns = await this.facebookApi.getCampaigns(account.externalId, token, since);
        const now = new Date();
        const offset = this.getOffset(account.currency);

        for (const camp of campaigns) {
            await this.prisma.unifiedCampaign.upsert({
                where: { externalId: camp.id },
                create: {
                    platformAccountId,
                    externalId: camp.id,
                    name: camp.name,
                    objective: camp.objective,
                    dailyBudget: camp.daily_budget ? Number(camp.daily_budget) / offset : null,
                    lifetimeBudget: camp.lifetime_budget ? Number(camp.lifetime_budget) / offset : null,
                    startTime: camp.start_time ? new Date(camp.start_time) : null,
                    endTime: camp.end_time ? new Date(camp.end_time) : null,
                    status: this.mapStatus(camp.status),
                    effectiveStatus: camp.effective_status,
                    platformData: camp,
                    syncedAt: now,
                },
                update: {
                    name: camp.name,
                    objective: camp.objective,
                    dailyBudget: camp.daily_budget ? Number(camp.daily_budget) / offset : null,
                    lifetimeBudget: camp.lifetime_budget ? Number(camp.lifetime_budget) / offset : null,
                    startTime: camp.start_time ? new Date(camp.start_time) : null,
                    endTime: camp.end_time ? new Date(camp.end_time) : null,
                    status: this.mapStatus(camp.status),
                    effectiveStatus: camp.effective_status,
                    platformData: camp,
                    syncedAt: now,
                }
            });
        }

        // Staleness Cleanup: Mark missing campaigns as ARCHIVED
        if (!since) {
            const fbIds = campaigns.map(c => c.id);
            await this.prisma.unifiedCampaign.updateMany({
                where: {
                    platformAccountId,
                    externalId: { notIn: fbIds },
                    status: { not: UnifiedStatus.ARCHIVED }
                },
                data: { status: UnifiedStatus.ARCHIVED }
            });
        }

        return { synced: campaigns.length };
    }

    /**
     * Đồng bộ AdSets (UnifiedAdGroup)
     */
    async syncAdGroups(platformAccountId: number, since?: number) {
        const token = await this.tokenService.getTokenForAdAccount(platformAccountId);
        if (!token) throw new Error('No token found');

        const account = await this.prisma.platformAccount.findUnique({
            where: { id: platformAccountId }
        });
        if (!account) throw new Error('Account not found');

        const adsets = await this.facebookApi.getAdsets(account.externalId, token, since);
        const now = new Date();
        const offset = this.getOffset(account.currency);

        for (const set of adsets) {
            // Self-Healing: Check parent campaign
            let campaign = await this.prisma.unifiedCampaign.findUnique({
                where: { externalId: set.campaign_id }
            });

            if (!campaign) {
                this.logger.log(`Self-healing: Campaign ${set.campaign_id} missing for adset ${set.id}. Fetching...`);
                const { data } = await this.facebookApi.get<any>(`/${set.campaign_id}`, token, { fields: 'id,account_id,name,objective,status,effective_status,daily_budget,lifetime_budget,start_time,stop_time' }, account.externalId);
                if (data) {
                    campaign = await this.prisma.unifiedCampaign.create({
                        data: {
                            platformAccountId,
                            externalId: data.id,
                            name: data.name,
                            objective: data.objective,
                            dailyBudget: data.daily_budget ? Number(data.daily_budget) / offset : null,
                            lifetimeBudget: data.lifetime_budget ? Number(data.lifetime_budget) / offset : null,
                            status: this.mapStatus(data.status),
                            effectiveStatus: data.effective_status,
                            syncedAt: now,
                        }
                    });
                }
            }

            if (!campaign) {
                this.logger.warn(`Failed to self-heal campaign ${set.campaign_id}, skipping adset ${set.id}`);
                continue;
            }

            await this.prisma.unifiedAdGroup.upsert({
                where: { externalId: set.id },
                create: {
                    unifiedCampaignId: campaign.id,
                    platformAccountId,
                    externalId: set.id,
                    name: set.name,
                    dailyBudget: set.daily_budget ? Number(set.daily_budget) / offset : null,
                    status: this.mapStatus(set.status),
                    effectiveStatus: set.effective_status,
                    optimizationGoal: set.optimization_goal,
                    startTime: set.start_time ? new Date(set.start_time) : null,
                    endTime: set.end_time ? new Date(set.end_time) : null,
                    platformData: set,
                    syncedAt: now,
                },
                update: {
                    unifiedCampaignId: campaign.id,
                    name: set.name,
                    dailyBudget: set.daily_budget ? Number(set.daily_budget) / offset : null,
                    status: this.mapStatus(set.status),
                    effectiveStatus: set.effective_status,
                    optimizationGoal: set.optimization_goal,
                    startTime: set.start_time ? new Date(set.start_time) : null,
                    endTime: set.end_time ? new Date(set.end_time) : null,
                    platformData: set,
                    syncedAt: now,
                }
            });
        }

        // Staleness Cleanup
        if (!since) {
            const fbIds = adsets.map(s => s.id);
            await this.prisma.unifiedAdGroup.updateMany({
                where: {
                    platformAccountId,
                    externalId: { notIn: fbIds },
                    status: { not: UnifiedStatus.ARCHIVED }
                },
                data: { status: UnifiedStatus.ARCHIVED }
            });
        }

        return { synced: adsets.length };
    }

    /**
     * Đồng bộ Ads
     */
    async syncAds(platformAccountId: number, since?: number) {
        const token = await this.tokenService.getTokenForAdAccount(platformAccountId);
        if (!token) throw new Error('No token found');

        const account = await this.prisma.platformAccount.findUnique({
            where: { id: platformAccountId }
        });
        if (!account) throw new Error('Account not found');

        const ads = await this.facebookApi.getAds(account.externalId, token, since);
        const now = new Date();
        const offset = this.getOffset(account.currency);

        for (const ad of ads) {
            // Self-Healing Recursion
            let adGroup = await this.prisma.unifiedAdGroup.findUnique({
                where: { externalId: ad.adset_id }
            });

            if (!adGroup) {
                this.logger.log(`Self-healing: AdGroup ${ad.adset_id} missing for ad ${ad.id}. Fetching...`);
                // Fetch AdSet
                const { data: setData } = await this.facebookApi.get<any>(`/${ad.adset_id}`, token, { fields: 'id,campaign_id,name,status,effective_status,daily_budget,optimization_goal,start_time,end_time' }, account.externalId);
                if (setData) {
                    // Check Campaign inside AdSet self-healing
                    let campaign = await this.prisma.unifiedCampaign.findUnique({ where: { externalId: setData.campaign_id } });
                    if (!campaign) {
                        const { data: campData } = await this.facebookApi.get<any>(`/${setData.campaign_id}`, token, { fields: 'id,name,objective,status,effective_status,daily_budget' }, account.externalId);
                        if (campData) {
                            campaign = await this.prisma.unifiedCampaign.create({
                                data: {
                                    platformAccountId,
                                    externalId: campData.id,
                                    name: campData.name,
                                    objective: campData.objective,
                                    status: this.mapStatus(campData.status),
                                    effectiveStatus: campData.effective_status,
                                    syncedAt: now,
                                }
                            });
                        }
                    }

                    if (campaign) {
                        adGroup = await this.prisma.unifiedAdGroup.create({
                            data: {
                                unifiedCampaignId: campaign.id,
                                platformAccountId,
                                externalId: setData.id,
                                name: setData.name,
                                dailyBudget: setData.daily_budget ? Number(setData.daily_budget) / offset : null,
                                status: this.mapStatus(setData.status),
                                effectiveStatus: setData.effective_status,
                                syncedAt: now,
                            }
                        });
                    }
                }
            }

            if (!adGroup) {
                this.logger.warn(`Failed to self-heal AdGroup ${ad.adset_id} for ad ${ad.id}, skipping`);
                continue;
            }

            await this.prisma.unifiedAd.upsert({
                where: { id: ad.id },
                create: {
                    id: ad.id,
                    unifiedAdGroupId: adGroup.id,
                    platformAccountId,
                    externalId: ad.id,
                    name: ad.name,
                    status: this.mapStatus(ad.status),
                    effectiveStatus: ad.effective_status,
                    syncedAt: now,
                    platformData: ad,
                },
                update: {
                    unifiedAdGroupId: adGroup.id,
                    name: ad.name,
                    status: this.mapStatus(ad.status),
                    effectiveStatus: ad.effective_status,
                    syncedAt: now,
                    platformData: ad,
                }
            });
        }

        // Staleness Cleanup
        if (!since) {
            const fbIds = ads.map(a => a.id);
            await this.prisma.unifiedAd.updateMany({
                where: {
                    platformAccountId,
                    externalId: { notIn: fbIds },
                    status: { not: UnifiedStatus.ARCHIVED }
                },
                data: { status: UnifiedStatus.ARCHIVED }
            });
        }

        // Tự động sync Creatives sau khi sync Ads
        await this.creativeSyncService.syncCreativesForAccount(platformAccountId);

        return { synced: ads.length };
    }
}
