import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma/prisma.service';
import { FacebookApiService } from '../api/facebook-api.service';

@Injectable()
export class CreativeSyncService {
    private readonly logger = new Logger(CreativeSyncService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly facebookApi: FacebookApiService,
    ) {}

    async syncCreativesForAccount(platformAccountId: number, adIds?: string[]) {
        const account = await this.prisma.platformAccount.findUnique({
            where: { id: platformAccountId },
            include: {
                identity: {
                    include: {
                        credentials: true,
                    },
                },
            },
        });

        if (!account) {
            throw new Error(`Account ${platformAccountId} not found`);
        }

        const token = account.identity.credentials.find(
            (c) => c.credentialType === 'access_token' && c.isActive,
        )?.credentialValue;

        if (!token) {
            throw new Error(`No active token for account ${platformAccountId}`);
        }

        // 1. Xác định danh sách ads cần sync
        let adsToSync: { id: string; externalId: string }[] = [];
        if (adIds && adIds.length > 0) {
            adsToSync = await this.prisma.unifiedAd.findMany({
                where: {
                    externalId: { in: adIds },
                    platformAccountId: account.id,
                },
                select: { id: true, externalId: true },
            });
        } else {
            adsToSync = await this.prisma.unifiedAd.findMany({
                where: {
                    platformAccountId: account.id,
                    effectiveStatus: 'ACTIVE',
                },
                select: { id: true, externalId: true },
            });
        }

        if (adsToSync.length === 0) {
            this.logger.log(`No ads found to sync creatives for account ${account.id}`);
            return { count: 0 };
        }

        // 2. Fetch từ Facebook (Chunking 50 ads mỗi lần)
        const chunkSize = 50;
        const rawCreatives = [];
        const adToCreativeMap: { adId: string; creativeExtId: string }[] = [];

        for (let i = 0; i < adsToSync.length; i += chunkSize) {
            const chunk = adsToSync.slice(i, i + chunkSize);
            const ids = chunk.map((a) => a.externalId).join(',');
            
            try {
                const fbRes = await this.facebookApi.getRaw('', token, {
                    ids,
                    fields: 'id,creative{id,name,object_story_spec,asset_feed_spec,image_url,thumbnail_url,image_hash}',
                });

                for (const adExtId in fbRes) {
                    const creative = fbRes[adExtId].creative;
                    if (!creative) continue;

                    const spec = creative.object_story_spec || {};
                    const assetFeed = creative.asset_feed_spec || {};
                    
                    const thumbnailUrl = creative.thumbnail_url ||
                        spec.link_data?.picture ||
                        spec.video_data?.image_url ||
                        (assetFeed.images && assetFeed.images[0]?.url) ||
                        (creative.image_hash ? `https://graph.facebook.com/v24.0/${creative.image_hash}/thumbnails?access_token=${token}` : null);

                    rawCreatives.push({
                        platformAccountId: account.id,
                        externalId: creative.id,
                        name: creative.name,
                        imageUrl: creative.image_url || thumbnailUrl,
                        thumbnailUrl: thumbnailUrl,
                        platformData: creative,
                        syncedAt: new Date(),
                    });

                    const internalAdId = chunk.find((a) => a.externalId === adExtId)?.id;
                    if (internalAdId) {
                        adToCreativeMap.push({ adId: internalAdId, creativeExtId: creative.id });
                    }
                }
            } catch (e) {
                this.logger.error(`Failed to fetch creatives for chunk ${i}: ${e.message}`);
            }
        }

        // 3. Upsert Creatives
        let upsertedCount = 0;
        const creativeExtToInternalMap: Record<string, string> = {};

        for (const creative of rawCreatives) {
            const saved = await this.prisma.unifiedAdCreative.upsert({
                where: {
                    platformAccountId_externalId: {
                        platformAccountId: creative.platformAccountId,
                        externalId: creative.externalId,
                    },
                },
                update: creative,
                create: creative,
            });
            creativeExtToInternalMap[creative.externalId] = saved.id;
            upsertedCount++;
        }

        // 4. Link Ads to Creatives
        let linkedCount = 0;
        for (const item of adToCreativeMap) {
            const internalCreativeId = creativeExtToInternalMap[item.creativeExtId];
            if (internalCreativeId) {
                await this.prisma.unifiedAd.update({
                    where: { id: item.adId },
                    data: {
                        unifiedAdCreativeId: internalCreativeId,
                        syncedAt: new Date(),
                    },
                });
                linkedCount++;
            }
        }

        return {
            creativesFetched: rawCreatives.length,
            creativesUpserted: upsertedCount,
            adsLinked: linkedCount,
        };
    }
}
