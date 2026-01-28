/**
 * Facebook Sync - Campaigns (BATCH OPTIMIZED)
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const supabase = createClient(supabaseUrl, supabaseKey);

const FB_API_VERSION = "v24.0";
const FB_BASE_URL = `https://graph.facebook.com/${FB_API_VERSION}`;

function getVietnamTime(): string {
    const vn = new Date(new Date().getTime() + 7 * 60 * 60 * 1000);
    const y = vn.getUTCFullYear();
    const m = String(vn.getUTCMonth() + 1).padStart(2, '0');
    const d = String(vn.getUTCDate()).padStart(2, '0');
    const h = String(vn.getUTCHours()).padStart(2, '0');
    const min = String(vn.getUTCMinutes()).padStart(2, '0');
    const s = String(vn.getUTCSeconds()).padStart(2, '0');
    return `${y}-${m}-${d} ${h}:${min}:${s}`;
}

class FacebookApiClient {
    constructor(private accessToken: string) { }

    private async request<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
        const url = new URL(`${FB_BASE_URL}${endpoint}`);
        url.searchParams.set("access_token", this.accessToken);
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined && value !== null) url.searchParams.set(key, value);
        }
        const response = await fetch(url.toString());
        const data = await response.json();
        if (data.error) throw new Error(`Facebook API Error: ${data.error.message}`);
        return data;
    }

    async getCampaigns(accountId: string, since?: number): Promise<any[]> {
        const params: Record<string, string> = {
            fields: "id,account_id,name,objective,status,effective_status,daily_budget,lifetime_budget,start_time,stop_time",
            limit: "1000",
        };
        if (since) params.filtering = JSON.stringify([{ field: "updated_time", operator: "GREATER_THAN", value: since }]);
        const res = await this.request<{ data: any[] }>(`/${accountId}/campaigns`, params);
        return res.data || [];
    }

    async getAdSets(accountId: string, since?: number): Promise<any[]> {
        const params: Record<string, string> = {
            fields: "id,campaign_id,name,status,effective_status,daily_budget,optimization_goal,start_time,end_time",
            limit: "1000",
        };
        if (since) params.filtering = JSON.stringify([{ field: "updated_time", operator: "GREATER_THAN", value: since }]);
        const res = await this.request<{ data: any[] }>(`/${accountId}/adsets`, params);
        return res.data || [];
    }
}

const corsHeaders = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" };
const jsonResponse = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: corsHeaders });

function mapStatus(fbStatus: string): string {
    return { ACTIVE: "ACTIVE", PAUSED: "PAUSED", DELETED: "DELETED", ARCHIVED: "ARCHIVED" }[fbStatus] || "UNKNOWN";
}

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

    try {
        const { accountId, skipUpdate = false } = await req.json();
        if (!accountId) return jsonResponse({ success: false, error: "accountId is required" }, 400);

        const { data: account, error: accountError } = await supabase
            .from("platform_accounts")
            .select(`id, external_id, currency, synced_at, platform_identities!inner (id, platform_credentials (credential_type, credential_value, is_active))`)
            .eq("id", accountId).single();

        if (accountError || !account) return jsonResponse({ success: false, error: "Account not found" }, 404);

        const creds = account.platform_identities?.platform_credentials || [];
        const tokenCred = creds.find((c: any) => c.credential_type === "access_token" && c.is_active);
        if (!tokenCred) return jsonResponse({ success: false, error: "No access token" }, 401);

        const fb = new FacebookApiClient(tokenCred.credential_value);
        const result = { campaigns: 0, adGroups: 0, errors: [] as string[] };
        const since = skipUpdate ? undefined : account.synced_at ? Math.floor(new Date(account.synced_at).getTime() / 1000) : undefined;
        const offset = ["VND", "JPY", "KRW", "CLP", "PYG", "ISK"].includes(account.currency?.toUpperCase()) ? 1 : 100;

        // BATCH SYNC CAMPAIGNS
        const fbCampaigns = await fb.getCampaigns(account.external_id, since);
        if (fbCampaigns.length > 0) {
            const { data: existingCamps } = await supabase.from("unified_campaigns").select("id, external_id").eq("platform_account_id", accountId).limit(5000);
            const campaignIdMap = new Map((existingCamps || []).map(c => [c.external_id, c.id]));

            const campUpserts = fbCampaigns.map(c => ({
                id: campaignIdMap.get(c.id) || crypto.randomUUID(),
                external_id: c.id,
                platform_account_id: accountId,
                name: c.name,
                objective: c.objective,
                status: mapStatus(c.status),
                effective_status: c.effective_status,
                daily_budget: c.daily_budget ? parseFloat(c.daily_budget) / offset : null,
                lifetime_budget: c.lifetime_budget ? parseFloat(c.lifetime_budget) / offset : null,
                start_time: c.start_time || null,
                end_time: c.stop_time || null,
                platform_data: c,
                synced_at: getVietnamTime(),
            }));

            const { error: campErr } = await supabase.from("unified_campaigns").upsert(campUpserts, { onConflict: "platform_account_id,external_id" });
            if (campErr) result.errors.push(`Campaign Batch Error: ${campErr.message}`);
            else result.campaigns = campUpserts.length;
        }

        // BATCH SYNC ADSETS
        console.log(`[CampaignSync] Fetching adsets for ${account.external_id}, since=${since}`);
        const fbAdSets = await fb.getAdSets(account.external_id, since);
        console.log(`[CampaignSync] Got ${fbAdSets.length} adsets from FB`);
        if (fbAdSets.length > 0) {
            const { data: allCamps } = await supabase.from("unified_campaigns").select("id, external_id").eq("platform_account_id", accountId).limit(5000);
            const fullCampaignMap = new Map((allCamps || []).map((c: any) => [c.external_id, c.id]));
            console.log(`[CampaignSync] Found ${allCamps?.length || 0} campaigns in DB for matching`);

            const { data: existingAdGroups } = await supabase.from("unified_ad_groups").select("id, external_id").eq("platform_account_id", accountId).limit(5000);
            const adGroupIdMap = new Map((existingAdGroups || []).map(ag => [ag.external_id, ag.id]));

            const adSetUpserts = fbAdSets.map(adset => {
                const campaignId = fullCampaignMap.get(adset.campaign_id);
                if (!campaignId) {
                    console.log(`[CampaignSync] Adset ${adset.id} skipped - campaign ${adset.campaign_id} not found in DB`);
                    return null;
                }
                return {
                    id: adGroupIdMap.get(adset.id) || crypto.randomUUID(),
                    external_id: adset.id,
                    platform_account_id: accountId,
                    unified_campaign_id: campaignId,
                    name: adset.name,
                    status: mapStatus(adset.status),
                    effective_status: adset.effective_status,
                    daily_budget: adset.daily_budget ? parseFloat(adset.daily_budget) / offset : null,
                    optimization_goal: adset.optimization_goal,
                    start_time: adset.start_time || null,
                    end_time: adset.end_time || null,
                    platform_data: adset,  // Store full FB data including start/end time
                    synced_at: getVietnamTime(),
                };
            }).filter(Boolean);

            if (adSetUpserts.length > 0) {
                const { error: adsetErr } = await supabase.from("unified_ad_groups").upsert(adSetUpserts as any[], { onConflict: "platform_account_id,external_id" });
                if (adsetErr) result.errors.push(`AdSet Batch Error: ${adsetErr.message}`);
                else result.adGroups = adSetUpserts.length;
            }
        }

        await supabase.from("platform_accounts").update({ synced_at: getVietnamTime() }).eq("id", accountId);
        return jsonResponse({ success: true, data: result });
    } catch (error: any) {
        return jsonResponse({ success: false, error: error.message }, 500);
    }
});
