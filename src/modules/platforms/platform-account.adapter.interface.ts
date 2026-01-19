export interface IPlatformAdapter {
  readonly platformCode: string;

  /**
   * Validate a platform-specific token (e.g. FB Access Token)
   */
  validateToken(token: string): Promise<{
    externalId: string;
    name: string;
    metadata?: any;
  }>;

  /**
   * Fetch all ad accounts associated with the token/identity
   */
  fetchAdAccounts(token: string): Promise<Array<{
    externalId: string;
    name: string;
    currency: string;
    timezone?: string;
    status: string;
    metadata?: any;
  }>>;

  /**
   * Fetch campaigns for a specific ad account (externalId)
   */
  fetchCampaigns(externalAccountId: string, token: string, since?: number): Promise<Array<any>>;

  /**
   * Fetch insights for various levels
   */
  fetchInsights?(params: {
    externalAccountId: string;
    token: string;
    level: 'account' | 'campaign' | 'adset' | 'ad';
    dateRange: { start: string; end: string };
    granularity?: 'DAILY' | 'HOURLY';
    campaignIds?: string[];
    adIds?: string[];
  }): Promise<Array<any>>;

  /**
   * Fetch ad groups for a specific ad account
   */
  fetchAdGroups(externalAccountId: string, token: string, since?: number, campaignIds?: string[]): Promise<Array<any>>;

  /**
   * Fetch ads for a specific ad account
   */
  fetchAds(externalAccountId: string, token: string, since?: number, campaignIds?: string[], adsetIds?: string[]): Promise<Array<any>>;

  /**
   * Fetch ad creatives for a specific ad account
   */
  fetchAdCreatives(externalAccountId: string, token: string, creativeIds?: string[]): Promise<Array<any>>;
}