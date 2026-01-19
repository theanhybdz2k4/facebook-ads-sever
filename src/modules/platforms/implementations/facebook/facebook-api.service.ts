import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class FacebookApiService {
  private readonly logger = new Logger(FacebookApiService.name);
  private readonly baseUrl = 'https://graph.facebook.com/v19.0';

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) { }

  async get<T>(endpoint: string, accessToken: string, params: any = {}): Promise<T> {
    try {
      const response = await firstValueFrom(
        this.http.get<T>(`${this.baseUrl}${endpoint}`, {
          params: {
            ...params,
            access_token: accessToken,
          },
        }),
      );
      return response.data;
    } catch (error) {
      const message = error.response?.data?.error?.message || error.message;
      this.logger.error(`Facebook API Error: ${message}`, error.response?.data);
      throw new BadRequestException(`Facebook API: ${message}`);
    }
  }

  async post<T>(endpoint: string, accessToken: string, data: any = {}): Promise<T> {
    try {
      const response = await firstValueFrom(
        this.http.post<T>(`${this.baseUrl}${endpoint}`, data, {
          params: { access_token: accessToken },
        }),
      );
      return response.data;
    } catch (error) {
      const message = error.response?.data?.error?.message || error.message;
      this.logger.error(`Facebook API Post Error: ${message}`, error.response?.data);
      throw new BadRequestException(`Facebook API: ${message}`);
    }
  }

  async getAdAccounts(accessToken: string) {
    const data = await this.get<{ data: any[] }>('/me/adaccounts', accessToken, {
      fields: 'id,name,account_status,currency,timezone_name,business_id,business_name',
      limit: 500,
    });
    return data.data;
  }

  async getCampaigns(externalAccountId: string, accessToken: string, since?: number) {
    const params: any = {
      fields: 'id,account_id,name,objective,status,effective_status,daily_budget,lifetime_budget,start_time,stop_time,buying_type,bid_strategy,issues_info',
      limit: 1000,
    };
    if (since) {
      params.filtering = JSON.stringify([{ field: 'updated_time', operator: 'GREATER_THAN', value: since }]);
    }
    const data = await this.get<{ data: any[] }>(`/${externalAccountId}/campaigns`, accessToken, params);
    return data.data;
  }

  async getAdSets(externalAccountId: string, accessToken: string, since?: number, campaignIds?: string[]) {
    const params: any = {
      fields: 'id,campaign_id,name,status,effective_status,daily_budget,lifetime_budget,start_time,stop_time,targeting,bid_amount,billing_event,optimization_goal',
      limit: 1000,
    };

    const filters = [];
    if (since) {
      filters.push({ field: 'updated_time', operator: 'GREATER_THAN', value: since });
    }
    if (campaignIds && campaignIds.length > 0) {
      filters.push({ field: 'campaign_id', operator: 'IN', value: campaignIds });
    }

    if (filters.length > 0) {
      params.filtering = JSON.stringify(filters);
    }

    const data = await this.get<{ data: any[] }>(`/${externalAccountId}/adsets`, accessToken, params);
    return data.data;
  }

  async getAds(externalAccountId: string, accessToken: string, since?: number, campaignIds?: string[], adsetIds?: string[]) {
    const params: any = {
      fields: 'id,adset_id,campaign_id,name,status,effective_status,creative,created_time,updated_time',
      limit: 1000,
    };

    const filters = [];
    if (since) {
      filters.push({ field: 'updated_time', operator: 'GREATER_THAN', value: since });
    }
    if (campaignIds && campaignIds.length > 0) {
      filters.push({ field: 'campaign.id', operator: 'IN', value: campaignIds });
    }
    if (adsetIds && adsetIds.length > 0) {
      filters.push({ field: 'adset.id', operator: 'IN', value: adsetIds });
    }

    if (filters.length > 0) {
      params.filtering = JSON.stringify(filters);
    }
    const data = await this.get<{ data: any[] }>(`/${externalAccountId}/ads`, accessToken, params);
    return data.data;
  }

  async getAdCreatives(externalAccountId: string, accessToken: string, adIds?: string[]) {
    // If adIds are provided, fetch creatives VIA the ads to ensure context and availability
    if (adIds && adIds.length > 0) {
      const data = await this.get<Record<string, any>>('/', accessToken, {
        ids: adIds.join(','),
        fields: 'id,creative{id,thumbnail_url,image_url,object_story_spec{link_data{picture},video_data{image_url}}}',
      });
      return Object.values(data);
    }

    const fields = 'id,thumbnail_url,image_url,object_story_spec{link_data{picture},video_data{image_url}}';
    const data = await this.get<{ data: any[] }>(`/${externalAccountId}/adcreatives`, accessToken, {
      fields,
      limit: 1000,
    });
    return data.data;
  }

  async getInsights(
    externalId: string,
    accessToken: string,
    level: string,
    dateRange: { start: string; end: string },
    granularity: 'DAILY' | 'HOURLY' = 'DAILY',
    campaignIds?: string[],
    adIds?: string[]
  ) {
    const params: any = {
      level,
      time_range: JSON.stringify({ since: dateRange.start, until: dateRange.end }),
      fields: 'ad_id,adset_id,campaign_id,date_start,date_stop,spend,impressions,clicks,reach,actions,action_values',
      limit: 1000,
    };

    const filters = [];
    if (campaignIds && campaignIds.length > 0) {
      filters.push({ field: 'campaign.id', operator: 'IN', value: campaignIds });
    }
    if (adIds && adIds.length > 0) {
      filters.push({ field: 'ad.id', operator: 'IN', value: adIds });
    }

    if (filters.length > 0) {
      params.filtering = JSON.stringify(filters);
    }

    if (granularity === 'HOURLY') {
      params.breakdowns = 'hourly_stats_aggregated_by_advertiser_time_zone';
    } else {
      params.time_increment = 1;
    }

    const data = await this.get<{ data: any[] }>(`/${externalId}/insights`, accessToken, params);
    return data.data;
  }
}
