import { Injectable, BadRequestException } from '@nestjs/common';
import { IPlatformAdapter } from '../../platform-account.adapter.interface';
import { FacebookApiService } from './facebook-api.service';

@Injectable()
export class FacebookAdapter implements IPlatformAdapter {
    readonly platformCode = 'facebook';

    constructor(private readonly facebookApi: FacebookApiService) { }

    async validateToken(token: string): Promise<{ externalId: string; name: string; metadata?: any }> {
        try {
            const user = await this.facebookApi.get<any>('/me', token, {
                fields: 'id,name',
            });
            return {
                externalId: user.id,
                name: user.name,
            };
        } catch (error) {
            throw new BadRequestException(`Invalid Facebook token: ${error.message}`);
        }
    }

    async fetchAdAccounts(token: string): Promise<Array<{
        externalId: string;
        name: string;
        currency: string;
        timezone?: string;
        status: string;
        metadata?: any;
    }>> {
        const rawAccounts = await this.facebookApi.getAdAccounts(token);

        return rawAccounts.map(acc => ({
            externalId: acc.id,
            name: acc.name,
            currency: acc.currency || 'USD',
            timezone: acc.timezone_name,
            status: this.mapStatus(acc.account_status),
            metadata: {
                business_id: acc.business_id,
                business_name: acc.business_name,
            },
        }));
    }

    private mapStatus(fbStatus: number | string): string {
        const status = Number(fbStatus);
        switch (status) {
            case 1: return 'ACTIVE';
            case 2: return 'DISABLED';
            case 3: return 'PENDING_REVIEW';
            case 7: return 'PENDING_SETTLEMENT';
            case 9: return 'IN_GRACE_PERIOD';
            case 100: return 'PENDING_CLOSURE';
            case 101: return 'CLOSED';
            default: return 'DISABLED';
        }
    }

    async fetchCampaigns(externalAccountId: string, token: string, since?: number): Promise<Array<any>> {
        return this.facebookApi.getCampaigns(externalAccountId, token, since);
    }

    async fetchInsights(params: {
        externalAccountId: string;
        token: string;
        level: 'account' | 'campaign' | 'adset' | 'ad';
        dateRange: { start: string; end: string };
        granularity?: 'DAILY' | 'HOURLY';
        campaignIds?: string[];
        adIds?: string[];
        breakdowns?: string | string[];
    }): Promise<Array<any>> {
        return this.facebookApi.getInsights(
            params.externalAccountId,
            params.token,
            params.level,
            params.dateRange,
            params.granularity || 'DAILY',
            params.campaignIds,
            params.adIds,
            params.breakdowns,
        );
    }

    async fetchAdGroups(externalAccountId: string, token: string, since?: number, campaignIds?: string[]): Promise<Array<any>> {
        return this.facebookApi.getAdSets(externalAccountId, token, since, campaignIds);
    }

    async fetchAds(externalAccountId: string, token: string, since?: number, campaignIds?: string[], adsetIds?: string[]): Promise<Array<any>> {
        return this.facebookApi.getAds(externalAccountId, token, since, campaignIds, adsetIds);
    }

    async fetchAdCreatives(externalAccountId: string, token: string, creativeIds?: string[]): Promise<Array<any>> {
        return this.facebookApi.getAdCreatives(externalAccountId, token, creativeIds);
    }
}
