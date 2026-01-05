import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { RateLimiterService } from './rate-limiter.service';
import {
    FB_GRAPH_API_URL,
    AD_ACCOUNT_FIELDS,
    CAMPAIGN_FIELDS,
    ADSET_FIELDS,
    AD_FIELDS,
    CREATIVE_FIELDS,
    INSIGHTS_FIELDS,
    INSIGHTS_BREAKDOWN_FIELDS,
    ACCOUNT_DELAY_MS,
} from '../constants/facebook-api.constants';

interface FbApiResponse<T> {
    data: T[];
    paging?: {
        cursors?: { before?: string; after?: string };
        next?: string;
    };
}

@Injectable()
export class FacebookApiService {
    private readonly logger = new Logger(FacebookApiService.name);

    constructor(
        private readonly httpService: HttpService,
        private readonly rateLimiter: RateLimiterService,
    ) { }

    /**
     * Make a GET request to Facebook Graph API
     */
    async get<T>(
        endpoint: string,
        accessToken: string,
        params: Record<string, string> = {},
        accountId?: string,
    ): Promise<{ data: T; headers: Record<string, string> }> {
        // Wait if rate limited
        if (accountId) {
            await this.rateLimiter.waitIfNeeded(accountId);
        }

        const url = `${FB_GRAPH_API_URL}${endpoint}`;
        try {
            const response = await firstValueFrom(
                this.httpService.get<T>(url, {
                    params: { ...params, access_token: accessToken },
                }),
            );

            // Parse throttle header
            if (accountId) {
                const throttleHeader = response.headers['x-fb-ads-insights-throttle'];
                this.rateLimiter.parseThrottleHeader(throttleHeader, accountId);
            }

            return {
                data: response.data,
                headers: response.headers as Record<string, string>,
            };
        } catch (error) {
            // Log the actual Facebook API error for debugging
            if (error.response?.data) {
                this.logger.error(`Facebook API Error: ${JSON.stringify(error.response.data)}`);
            }
            throw error;
        }
    }

    /**
     * Fetch all pages of data from a paginated endpoint
     */
    async getAllPages<T>(
        endpoint: string,
        accessToken: string,
        params: Record<string, string> = {},
        accountId?: string,
    ): Promise<T[]> {
        const allData: T[] = [];
        let nextUrl: string | null = null;
        let isFirst = true;

        do {
            let response: FbApiResponse<T>;
            let headers: Record<string, string>;

            if (isFirst) {
                const result = await this.get<FbApiResponse<T>>(
                    endpoint,
                    accessToken,
                    params,
                    accountId,
                );
                response = result.data;
                headers = result.headers;
                isFirst = false;
            } else if (nextUrl) {
                // Wait if rate limited
                if (accountId) {
                    await this.rateLimiter.waitIfNeeded(accountId);
                }
                const result = await firstValueFrom(
                    this.httpService.get<FbApiResponse<T>>(nextUrl),
                );
                response = result.data;
                headers = result.headers as Record<string, string>;

                if (accountId) {
                    const throttleHeader = headers['x-fb-ads-insights-throttle'];
                    this.rateLimiter.parseThrottleHeader(throttleHeader, accountId);
                }
            } else {
                break;
            }

            if (response.data) {
                allData.push(...response.data);
            }

            nextUrl = response.paging?.next || null;

            // Small delay between pages
            if (nextUrl) {
                await this.delay(1000);
            }
        } while (nextUrl);

        return allData;
    }

    // ==================== AD ACCOUNTS ====================

    async getAdAccounts(accessToken: string): Promise<any[]> {
        return this.getAllPages(
            '/me/adaccounts',
            accessToken,
            { fields: AD_ACCOUNT_FIELDS, limit: '100' },
        );
    }

    async getAdAccount(accountId: string, accessToken: string): Promise<any> {
        const { data } = await this.get<any>(
            `/${accountId}`,
            accessToken,
            { fields: AD_ACCOUNT_FIELDS },
            accountId,
        );
        return data;
    }

    // ==================== CAMPAIGNS ====================

    async getCampaigns(accountId: string, accessToken: string, onlyActive = true): Promise<any[]> {
        const params: Record<string, string> = { fields: CAMPAIGN_FIELDS, limit: '100' };
        if (onlyActive) {
            params.effective_status = JSON.stringify(['ACTIVE']);
        }
        return this.getAllPages(
            `/${accountId}/campaigns`,
            accessToken,
            params,
            accountId,
        );
    }

    // ==================== ADSETS ====================

    async getAdsets(accountId: string, accessToken: string, onlyActive = true): Promise<any[]> {
        const params: Record<string, string> = { fields: ADSET_FIELDS, limit: '100' };
        if (onlyActive) {
            params.effective_status = JSON.stringify(['ACTIVE']);
        }
        return this.getAllPages(
            `/${accountId}/adsets`,
            accessToken,
            params,
            accountId,
        );
    }

    async getAdsetsByCampaign(campaignId: string, accessToken: string, accountId: string, onlyActive = true): Promise<any[]> {
        const params: Record<string, string> = { fields: ADSET_FIELDS, limit: '100' };
        if (onlyActive) {
            params.effective_status = JSON.stringify(['ACTIVE']);
        }
        return this.getAllPages(
            `/${campaignId}/adsets`,
            accessToken,
            params,
            accountId,
        );
    }

    // ==================== ADS ====================

    async getAds(accountId: string, accessToken: string, onlyActive = true): Promise<any[]> {
        const params: Record<string, string> = { fields: AD_FIELDS, limit: '100' };
        if (onlyActive) {
            params.effective_status = JSON.stringify(['ACTIVE']);
        }
        return this.getAllPages(
            `/${accountId}/ads`,
            accessToken,
            params,
            accountId,
        );
    }

    async getAdsByAdset(adsetId: string, accessToken: string, accountId: string, onlyActive = true): Promise<any[]> {
        const params: Record<string, string> = { fields: AD_FIELDS, limit: '100' };
        if (onlyActive) {
            params.effective_status = JSON.stringify(['ACTIVE']);
        }
        return this.getAllPages(
            `/${adsetId}/ads`,
            accessToken,
            params,
            accountId,
        );
    }

    // ==================== CREATIVES ====================

    async getAdCreatives(accountId: string, accessToken: string): Promise<any[]> {
        return this.getAllPages(
            `/${accountId}/adcreatives`,
            accessToken,
            { fields: CREATIVE_FIELDS, limit: '100' },
            accountId,
        );
    }

    // ==================== INSIGHTS ====================

    /**
     * Get insights for a single ad
     */
    async getAdInsights(
        adId: string,
        accessToken: string,
        dateStart: string,
        dateEnd: string,
        breakdown?: string,
        accountId?: string,
    ): Promise<any[]> {
        const params: Record<string, string> = {
            fields: breakdown ? INSIGHTS_BREAKDOWN_FIELDS : INSIGHTS_FIELDS,
            time_range: JSON.stringify({ since: dateStart, until: dateEnd }),
            time_increment: '1',
        };

        if (breakdown) {
            params.breakdowns = breakdown;
        }

        return this.getAllPages(
            `/${adId}/insights`,
            accessToken,
            params,
            accountId,
        );
    }

    /**
     * Get insights at account level (for campaigns/adsets or bulk queries)
     */
    async getInsights(
        accountId: string,
        accessToken: string,
        dateStart: string,
        dateEnd: string,
        level: 'ad' | 'adset' | 'campaign' = 'ad',
        breakdown?: string,
    ): Promise<any[]> {
        const params: Record<string, string> = {
            fields: breakdown ? INSIGHTS_BREAKDOWN_FIELDS : INSIGHTS_FIELDS,
            level,
            time_range: JSON.stringify({ since: dateStart, until: dateEnd }),
            time_increment: '1',
            limit: '500',
        };

        if (breakdown) {
            params.breakdowns = breakdown;
        }

        return this.getAllPages(
            `/${accountId}/insights`,
            accessToken,
            params,
            accountId,
        );
    }

    async getInsightsAsync(
        accountId: string,
        accessToken: string,
        dateStart: string,
        dateEnd: string,
        level: 'ad' | 'adset' | 'campaign' = 'ad',
        breakdown?: string,
    ): Promise<string> {
        const params: Record<string, string> = {
            fields: breakdown ? INSIGHTS_BREAKDOWN_FIELDS : INSIGHTS_FIELDS,
            level,
            time_range: JSON.stringify({ since: dateStart, until: dateEnd }),
            time_increment: '1',
        };

        if (breakdown) {
            params.breakdowns = breakdown;
        }

        const url = `${FB_GRAPH_API_URL}/${accountId}/insights`;
        const response = await firstValueFrom(
            this.httpService.post(url, null, {
                params: { ...params, access_token: accessToken },
            }),
        );

        return response.data.report_run_id;
    }

    async getAsyncReportStatus(
        reportRunId: string,
        accessToken: string,
    ): Promise<{ status: string; percentComplete: number }> {
        const { data } = await this.get<any>(
            `/${reportRunId}`,
            accessToken,
            { fields: 'async_status,async_percent_completion' },
        );

        return {
            status: data.async_status,
            percentComplete: data.async_percent_completion,
        };
    }

    async getAsyncReportResults(
        reportRunId: string,
        accessToken: string,
    ): Promise<any[]> {
        return this.getAllPages(`/${reportRunId}/insights`, accessToken, { limit: '500' });
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

