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

interface BatchResponse {
    code: number;
    headers: { name: string; value: string }[];
    body: string;
}

@Injectable()
export class FacebookApiService {
    private readonly logger = new Logger(FacebookApiService.name);

    constructor(
        private readonly httpService: HttpService,
        private readonly rateLimiter: RateLimiterService,
    ) { }

    /**
     * Make a GET request to Facebook Graph API with robust error handling
     */
    async get<T>(
        endpoint: string,
        accessToken: string,
        params: Record<string, string> = {},
        accountId?: string,
    ): Promise<{ data: T; headers: Record<string, string> }> {
        let retryCount = 0;
        const maxRetries = 3;

        while (true) {
            // Wait if rate limited by internal limiter
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
                const fbError = error.response?.data?.error;
                if (fbError) {
                    const code = fbError.code || fbError.error_subcode;
                    // Rate limit codes: 17, 4, 80004
                    if ((code === 17 || code === 80004 || code === 4) && retryCount < maxRetries) {
                        retryCount++;
                        const waitMs = Math.pow(2, retryCount) * 2000; // 4s, 8s, 16s
                        this.logger.warn(`Facebook API Rate Limited (${code}). Waiting ${waitMs}ms before retry ${retryCount}/${maxRetries}...`);
                        await new Promise(r => setTimeout(r, waitMs));
                        continue;
                    }
                    this.logger.error(`Facebook API Error (${endpoint}): ${fbError.message} (code: ${fbError.code})`);
                    if (code === 17 || code === 80004) {
                        throw new Error(`FACEBOOK_RATE_LIMIT: ${fbError.message}`);
                    }
                }
                throw error;
            }
        }
    }

    /**
     * Raw GET request without data wrapper (used for flexible queries like IDs list)
     */
    async getRaw<T = any>(
        endpoint: string,
        accessToken: string,
        params: Record<string, string> = {},
        accountId?: string,
    ): Promise<T> {
        if (accountId) await this.rateLimiter.waitIfNeeded(accountId);

        const url = `${FB_GRAPH_API_URL}${endpoint}`;
        try {
            const response = await firstValueFrom(
                this.httpService.get<T>(url, {
                    params: { ...params, access_token: accessToken },
                }),
            );

            if (accountId) {
                const throttleHeader = response.headers['x-fb-ads-insights-throttle'];
                this.rateLimiter.parseThrottleHeader(throttleHeader, accountId);
            }

            return response.data;
        } catch (error) {
            this.logger.error(`Facebook API Raw Error (${endpoint}): ${error.message}`);
            throw error;
        }
    }

    /**
     * Fetch all pages of data from a paginated endpoint (Optimized from Edge Functions)
     */
    async getAllPages<T>(
        endpoint: string,
        accessToken: string,
        params: Record<string, string> = {},
        accountId?: string,
    ): Promise<T[]> {
        let allData: T[] = [];
        let nextUrl: string | null = null;
        let isFirst = true;
        let retryCount = 0;
        const maxRetries = 3;

        do {
            try {
                let responseData: any;
                let responseHeaders: Record<string, string>;

                if (isFirst) {
                    const result = await this.get<any>(endpoint, accessToken, params, accountId);
                    responseData = result.data;
                    responseHeaders = result.headers;
                    isFirst = false;
                } else if (nextUrl) {
                    if (accountId) await this.rateLimiter.waitIfNeeded(accountId);
                    
                    const response = await firstValueFrom(this.httpService.get<any>(nextUrl));
                    responseData = response.data;
                    responseHeaders = response.headers as Record<string, string>;

                    if (accountId) {
                        const throttleHeader = responseHeaders['x-fb-ads-insights-throttle'];
                        this.rateLimiter.parseThrottleHeader(throttleHeader, accountId);
                    }
                } else {
                    break;
                }

                if (responseData.data) {
                    allData.push(...responseData.data);
                }

                nextUrl = responseData.paging?.next || null;
                retryCount = 0; // Reset on success

                // Add small delay between pages to avoid rate limit (code 17)
                if (nextUrl) {
                    await new Promise(r => setTimeout(r, 200)); // Reduced from 800
                }
            } catch (error) {
                const fbError = error.response?.data?.error;
                if (fbError && (fbError.code === 17 || fbError.code === 4) && retryCount < maxRetries) {
                    retryCount++;
                    const waitMs = Math.pow(2, retryCount) * 2000;
                    this.logger.warn(`Pagination Rate Limited. Waiting ${waitMs}ms...`);
                    await new Promise(r => setTimeout(r, waitMs));
                    continue; // Retry current page
                }
                this.logger.error(`Error fetching page for ${endpoint}: ${error.message}`);
                throw error;
            }
        } while (nextUrl);

        return allData;
    }

    /**
     * Fetch insights for multiple objects in parallel using the Facebook Batch API
     */
    async getBatchInsights(ids: string[], accessToken: string, params: Record<string, string> = {}, accountId?: string): Promise<any[]> {
        if (ids.length === 0) return [];
        
        const chunkSize = 50; // Facebook limit
        const allInsights: any[] = [];

        for (let i = 0; i < ids.length; i += chunkSize) {
            const chunk = ids.slice(i, i + chunkSize);
            const batch = chunk.map(id => ({
                method: 'GET',
                relative_url: `${id}/insights?${new URLSearchParams(params).toString()}`
            }));

            if (accountId) await this.rateLimiter.waitIfNeeded(accountId);

            try {
                const response = await firstValueFrom(
                    this.httpService.post<BatchResponse[]>(FB_GRAPH_API_URL, new URLSearchParams({
                        access_token: accessToken,
                        batch: JSON.stringify(batch)
                    }).toString(), {
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                    })
                );

                for (const res of response.data) {
                    if (res.code === 200) {
                        const body = JSON.parse(res.body);
                        if (body.data) {
                            allInsights.push(...body.data);
                        }
                    } else {
                        const body = JSON.parse(res.body);
                        this.logger.warn(`Batch item failed with code ${res.code}: ${body?.error?.message}`);
                    }
                }
            } catch (error) {
                this.logger.error(`Error in getBatchInsights: ${error.message}`);
                throw error;
            }

            if (i + chunkSize < ids.length) {
                await new Promise(r => setTimeout(r, 300));
            }
        }
        return allInsights;
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

    async getCampaigns(accountId: string, accessToken: string, since?: number): Promise<any[]> {
        const params: Record<string, string> = { 
            fields: CAMPAIGN_FIELDS, 
            limit: '500',
            filtering: JSON.stringify([
                { field: 'effective_status', operator: 'NOT_IN', value: ['ARCHIVED', 'DELETED'] }
            ])
        };
        
        if (since) {
            const currentFilters = JSON.parse(params.filtering);
            currentFilters.push({ field: 'updated_time', operator: 'GREATER_THAN', value: since });
            params.filtering = JSON.stringify(currentFilters);
        }

        return this.getAllPages(
            `/${accountId}/campaigns`,
            accessToken,
            params,
            accountId,
        );
    }

    // ==================== ADSETS ====================

    async getAdsets(accountId: string, accessToken: string, since?: number): Promise<any[]> {
        const params: Record<string, string> = { 
            fields: ADSET_FIELDS, 
            limit: '500',
            filtering: JSON.stringify([
                { field: 'effective_status', operator: 'NOT_IN', value: ['ARCHIVED', 'DELETED'] }
            ])
        };

        if (since) {
            const currentFilters = JSON.parse(params.filtering);
            currentFilters.push({ field: 'updated_time', operator: 'GREATER_THAN', value: since });
            params.filtering = JSON.stringify(currentFilters);
        }

        return this.getAllPages(
            `/${accountId}/adsets`,
            accessToken,
            params,
            accountId,
        );
    }

    async getAdsetsByCampaign(campaignId: string, accessToken: string, accountId: string): Promise<any[]> {
        return this.getAllPages(
            `/${campaignId}/adsets`,
            accessToken,
            { 
                fields: ADSET_FIELDS, 
                limit: '500',
                filtering: JSON.stringify([{ field: 'effective_status', operator: 'NOT_IN', value: ['ARCHIVED', 'DELETED'] }])
            },
            accountId,
        );
    }

    // ==================== ADS ====================

    async getAds(accountId: string, accessToken: string, since?: number): Promise<any[]> {
        const params: Record<string, string> = { 
            fields: AD_FIELDS, 
            limit: '500',
            filtering: JSON.stringify([
                { field: 'effective_status', operator: 'NOT_IN', value: ['ARCHIVED', 'DELETED'] }
            ])
        };

        if (since) {
            const currentFilters = JSON.parse(params.filtering);
            currentFilters.push({ field: 'updated_time', operator: 'GREATER_THAN', value: since });
            params.filtering = JSON.stringify(currentFilters);
        }

        return this.getAllPages(
            `/${accountId}/ads`,
            accessToken,
            params,
            accountId,
        );
    }

    async getAdsByAdset(adsetId: string, accessToken: string, accountId: string): Promise<any[]> {
        return this.getAllPages(
            `/${adsetId}/ads`,
            accessToken,
            { 
                fields: AD_FIELDS, 
                limit: '500',
                filtering: JSON.stringify([{ field: 'effective_status', operator: 'NOT_IN', value: ['ARCHIVED', 'DELETED'] }])
            },
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
            limit: '500',
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
