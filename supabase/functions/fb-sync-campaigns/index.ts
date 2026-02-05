/**
 * Facebook Sync - Campaigns (BATCH OPTIMIZED)
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";
import { verify } from "https://deno.land/x/djwt@v3.0.1/mod.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const JWT_SECRET = Deno.env.get("JWT_SECRET");
const supabase = createClient(supabaseUrl, supabaseKey);

const FB_API_VERSION = "v24.0";
const FB_BASE_URL = "https://graph.facebook.com/" + FB_API_VERSION;

// CRITICAL: DO NOT REMOVE THIS AUTH LOGIC. 
// IT PRIORITIZES auth_tokens TABLE FOR CUSTOM AUTHENTICATION.
async function verifyAuth(req: Request) {
    const authHeader = req.headers.get("Authorization");
    const serviceKeyHeader = req.headers.get("x-service-key") || req.headers.get("x-master-key");
    const masterKey = Deno.env.get("MASTER_KEY") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const authSecret = Deno.env.get("AUTH_SECRET") || "";
    const legacyToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxuY2dtYXh0cWpmYmN5cG5jZm9lIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NzM0NzQxMywiZXhwIjoyMDgyOTIzNDEzfQ.zalV6mnyd1Iit0KbHnqLxemnBKFPbKz2159tkHtodJY";

    // 1. Check Service/Master Key in specialized headers
    if (serviceKeyHeader === serviceKey || serviceKeyHeader === masterKey || serviceKeyHeader === legacyToken) {
        return { userId: 1 };
    }

    if (authHeader?.startsWith("Bearer ")) {
        const token = authHeader.substring(7).trim();

        // 2. Check Service/Master/Auth secrets as Bearer token
        if ((serviceKey !== "" && token === serviceKey) || (masterKey !== "" && token === masterKey) || (authSecret !== "" && token === authSecret) || token === legacyToken) {
            return { userId: 1 };
        }

        // 3. PRIORITY: Check custom auth_tokens table
        try {
            const { data: tokenData } = await supabase.from("auth_tokens").select("user_id").eq("token", token).maybeSingle();
            if (tokenData) return { userId: tokenData.user_id };
        } catch (e) {
            // Fallback
        }

        // 4. FALLBACK 1: Manual JWT verification
        try {
            const secret = Deno.env.get("JWT_SECRET");
            if (secret) {
                const encoder = new TextEncoder();
                const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
                const payload = await verify(token, key);

                if (payload.role === "service_role") return { userId: 1 };

                const sub = payload.sub as string;
                if (sub) {
                    const userIdNum = parseInt(sub, 10);
                    return { userId: isNaN(userIdNum) ? sub : userIdNum };
                }
            }
        } catch (e) {
            // Fallback
        }

        // 5. FALLBACK 2: Supabase Auth (for valid Supabase JWTs)
        try {
            const { data: { user } } = await supabase.auth.getUser(token);
            if (user) return { userId: user.id };
        } catch (e) {
            // Final fail
        }
    }
    return null;
}

function getVietnamTime(): string {
    // ... existing getVietnamTime code
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

    private async request<T>(endpoint: string, params: Record<string, string> = {}): Promise<any[]> {
        const url = new URL(FB_BASE_URL + endpoint);
        url.searchParams.set("access_token", this.accessToken);
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined && value !== null) url.searchParams.set(key, value);
        }

        let all: any[] = [];
        let nextUrl: string | null = url.toString();

        while (nextUrl) {
            const response = await fetch(nextUrl);
            const data = await response.json();
            if (data.error) {
                console.error(`[ApiClient] FB Error on ${endpoint}:`, data.error);
                throw new Error(`Facebook API Error (${endpoint}): ${data.error.message}`);
            }
            if (data.data) all = all.concat(data.data);
            nextUrl = data.paging?.next || null;
        }
        return all;
    }

    async getCampaigns(accountId: string, since?: number): Promise<any[]> {
        const params: Record<string, string> = {
            fields: "id,account_id,name,objective,status,effective_status,daily_budget,lifetime_budget,start_time,stop_time",
            limit: "500",
        };
        if (since) params.filtering = JSON.stringify([{ field: "updated_time", operator: "GREATER_THAN", value: since }]);
        return this.request("/" + accountId + "/campaigns", params);
    }

    async getAdSets(accountId: string, since?: number): Promise<any[]> {
        const params: Record<string, string> = {
            fields: "id,campaign_id,name,status,effective_status,daily_budget,optimization_goal,start_time,end_time",
            limit: "500",
        };
        if (since) params.filtering = JSON.stringify([{ field: "updated_time", operator: "GREATER_THAN", value: since }]);
        return this.request("/" + accountId + "/adsets", params);
    }

    async getAccount(accountId: string): Promise<any> {
        const params: Record<string, string> = {
            fields: "id,name,account_status,currency,amount_spent,balance,timezone_name",
        };
        const url = new URL(FB_BASE_URL + "/" + accountId);
        url.searchParams.set("access_token", this.accessToken);
        for (const [key, value] of Object.entries(params)) {
            url.searchParams.set(key, value);
        }

        const response = await fetch(url.toString());
        const data = await response.json();
        if (data.error) {
            console.error(`[ApiClient] FB Error on /${accountId}:`, data.error);
            throw new Error(`Facebook API Error (Account): ${data.error.message}`);
        }
        return data;
    }
}

const corsHeaders = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" };
const jsonResponse = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: corsHeaders });

function mapStatus(fbStatus: string): string {
    return { ACTIVE: "ACTIVE", PAUSED: "PAUSED", DELETED: "DELETED", ARCHIVED: "ARCHIVED" }[fbStatus] || "UNKNOWN";
}

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

    const auth = await verifyAuth(req);
    if (!auth) return jsonResponse({ success: false, error: "Unauthorized" }, 401);

    try {
        const { accountId, skipUpdate = false } = await req.json();
        if (!accountId) return jsonResponse({ success: false, error: "accountId is required" }, 400);

        const { data: account, error: accountError } = await supabase
            .from("platform_accounts")
            .select("id, external_id, currency, synced_at, platform_identities!inner (id, user_id, platform_credentials (credential_type, credential_value, is_active))")
            .eq("id", accountId)
            .eq("platform_identities.user_id", auth.userId)
            .maybeSingle();

        if (accountError || !account) return jsonResponse({ success: false, error: "Account not found or access denied" }, 404);

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

            const campUpserts = fbCampaigns.map(c => {
                const existingId = campaignIdMap.get(c.id);
                const isArchived = c.effective_status === 'ARCHIVED' || c.effective_status === 'DELETED';

                return {
                    id: existingId || crypto.randomUUID(),
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
                    platform_data: (!isArchived || !existingId) ? c : undefined, // Only store full data for active or new
                    synced_at: getVietnamTime(),
                };
            });

            const { error: campErr } = await supabase.from("unified_campaigns").upsert(campUpserts, { onConflict: "platform_account_id,external_id" });
            if (campErr) result.errors.push("Campaign Batch Error: " + campErr.message);
            else result.campaigns = campUpserts.length;
        }

        // BATCH SYNC ADSETS
        console.log("[CampaignSync] Fetching adsets for " + account.external_id + ", since=" + since);
        const fbAdSets = await fb.getAdSets(account.external_id, since);
        console.log("[CampaignSync] Got " + fbAdSets.length + " adsets from FB");
        if (fbAdSets.length > 0) {
            const { data: allCamps } = await supabase.from("unified_campaigns").select("id, external_id").eq("platform_account_id", accountId).limit(5000);
            const fullCampaignMap = new Map((allCamps || []).map((c: any) => [c.external_id, c.id]));
            console.log("[CampaignSync] Found " + (allCamps?.length || 0) + " campaigns in DB for matching");

            const { data: existingAdGroups } = await supabase.from("unified_ad_groups").select("id, external_id").eq("platform_account_id", accountId).limit(5000);
            const adGroupIdMap = new Map((existingAdGroups || []).map(ag => [ag.external_id, ag.id]));

            const adSetUpserts = fbAdSets.map(adset => {
                const campaignId = fullCampaignMap.get(adset.campaign_id);
                if (!campaignId) {
                    console.log("[CampaignSync] Adset " + adset.id + " skipped - campaign " + adset.campaign_id + " not found in DB");
                    return null;
                }
                const existingId = adGroupIdMap.get(adset.id);
                const isArchived = adset.effective_status === 'ARCHIVED' || adset.effective_status === 'DELETED';

                return {
                    id: existingId || crypto.randomUUID(),
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
                    platform_data: (!isArchived || !existingId) ? adset : undefined, // Only store full data for active or new
                    synced_at: getVietnamTime(),
                };
            }).filter(Boolean);

            if (adSetUpserts.length > 0) {
                const { error: adsetErr } = await supabase.from("unified_ad_groups").upsert(adSetUpserts as any[], { onConflict: "platform_account_id,external_id" });
                if (adsetErr) result.errors.push("AdSet Batch Error: " + adsetErr.message);
                else result.adGroups = adSetUpserts.length;
            }
        }

        // FETCH & UPDATE ACCOUNT DETAILS (Spend, Balance, Status)
        try {
            const fbAccount = await fb.getAccount(account.external_id);
            if (fbAccount) {
                await supabase.from("platform_accounts").update({
                    amount_spent: fbAccount.amount_spent ? parseFloat(fbAccount.amount_spent) / offset : 0,
                    // balance: fbAccount.balance ? parseFloat(fbAccount.balance) / offset : 0, // Optional: Update balance if field exists
                    account_status: fbAccount.account_status ? String(fbAccount.account_status) : undefined,
                    name: fbAccount.name, // Keep name updated
                    synced_at: getVietnamTime()
                }).eq("id", accountId);
            }
        } catch (accErr: any) {
            result.errors.push("Account Sync Error: " + accErr.message);
            // Fallback: still update synced_at
            await supabase.from("platform_accounts").update({ synced_at: getVietnamTime() }).eq("id", accountId);
        }

        return jsonResponse({ success: true, data: result });
    } catch (error: any) {
        return jsonResponse({ success: false, error: error.message }, 500);
    }
});
