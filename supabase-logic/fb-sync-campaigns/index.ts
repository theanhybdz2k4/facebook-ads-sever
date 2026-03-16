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

// CRITICAL: Robust Auth Logic
// Robust Auth Logic (DB-Only: auth_tokens & refresh_tokens)
async function verifyAuth(req: Request) {
    const authHeader = req.headers.get("Authorization");
    const masterKey = Deno.env.get("MASTER_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    // 1. SYSTEM FALLBACK (Service/Master Key)
    if (authHeader?.startsWith("Bearer ")) {
        const token = authHeader.substring(7).trim();
        if ((masterKey && token === masterKey) || (serviceKey && token === serviceKey)) {
            return { userId: 1, isSystem: true, isServiceRole: true };
        }
    }

    if (!authHeader?.startsWith("Bearer ")) return null;
    const token = authHeader.substring(7).trim();

    // 2. USER AUTH (Database lookup)
    // Check auth_tokens
    try {
        const { data: authToken } = await supabase
            .from("auth_tokens")
            .select("user_id, expires_at, is_active")
            .eq("token", token)
            .maybeSingle();

        if (authToken && authToken.is_active !== false) {
            if (!authToken.expires_at || new Date(authToken.expires_at) > new Date()) {
                return { userId: authToken.user_id, isSystem: false };
            }
        }
    } catch (e: any) {
        console.error("[Auth] auth_tokens check error:", e.message);
    }

    // Check refresh_tokens
    try {
        const { data: refreshToken } = await supabase
            .from("refresh_tokens")
            .select("user_id, expires_at, deleted_at")
            .eq("token", token)
            .maybeSingle();

        if (refreshToken && !refreshToken.deleted_at) {
            if (!refreshToken.expires_at || new Date(refreshToken.expires_at) > new Date()) {
                return { userId: refreshToken.user_id, isSystem: false };
            }
        }
    } catch (e: any) {
        console.error("[Auth] refresh_tokens check error:", e.message);
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
                const code = data.error.code || data.error.error_subcode;
                if (code === 17 || code === 80004) {
                    throw new Error(`FACEBOOK_RATE_LIMIT: ${data.error.message}`);
                }
                throw new Error(`Facebook API Error (${endpoint}): ${data.error.message}`);
            }
            if (data.data) all = all.concat(data.data);
            nextUrl = data.paging?.next || null;

            // Thêm delay nhỏ giữa các trang để tránh rate limit (code 17)
            if (nextUrl) await new Promise(r => setTimeout(r, 800));
        }
        return all;
    }

    async getCampaigns(accountId: string, since?: number): Promise<any[]> {
        const params: Record<string, string> = {
            fields: "id,account_id,name,objective,status,effective_status,daily_budget,lifetime_budget,start_time,stop_time",
            limit: "500",
        };
        // OPTIMIZATION: Only fetch non-archived/deleted campaigns
        const filters: any[] = [{ field: "effective_status", operator: "NOT_IN", value: ["ARCHIVED", "DELETED"] }];
        if (since) filters.push({ field: "updated_time", operator: "GREATER_THAN", value: since });
        params.filtering = JSON.stringify(filters);
        return this.request("/" + accountId + "/campaigns", params);
    }

    async getAdSets(accountId: string, since?: number): Promise<any[]> {
        const params: Record<string, string> = {
            fields: "id,campaign_id,name,status,effective_status,daily_budget,optimization_goal,start_time,end_time",
            limit: "500",
        };
        // OPTIMIZATION: Only fetch non-archived/deleted adsets
        const filters: any[] = [{ field: "effective_status", operator: "NOT_IN", value: ["ARCHIVED", "DELETED"] }];
        if (since) filters.push({ field: "updated_time", operator: "GREATER_THAN", value: since });
        params.filtering = JSON.stringify(filters);
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
        const { accountId, target = "all" } = await req.json();
        if (!accountId) return jsonResponse({ success: false, error: "accountId is required" }, 400);

        const isCampaignSync = target === "all" || target === "campaign";
        const isAdSetSync = target === "all" || target === "adset";

        let query = supabase
            .from("platform_accounts")
            .select("id, external_id, currency, synced_at, platform_identities!inner (id, user_id, platform_credentials (credential_type, credential_value, is_active))")
            .eq("id", accountId);

        if (auth.userId !== 1) {
            query = query.eq("platform_identities.user_id", auth.userId);
        }

        const { data: account, error: accountError } = await query.maybeSingle();
        if (accountError) {
            console.error(`[CampaignSync] DB Error looking up account ${accountId}:`, accountError);
            return jsonResponse({ success: false, error: "Database error looking up account" }, 500);
        }

        if (!account) {
            console.warn(`[CampaignSync] Account ${accountId} not found or access denied for user ${auth.userId}`);
            return jsonResponse({ success: false, error: "Account not found or access denied" }, 404);
        }

        const creds = account.platform_identities?.platform_credentials || [];
        const tokenCred = creds.find((c: any) => c.credential_type === "access_token" && c.is_active);
        if (!tokenCred) return jsonResponse({ success: false, error: "No access token" }, 401);

        const fb = new FacebookApiClient(tokenCred.credential_value);

        // CREATE SYNC JOB RECORD
        const { data: job, error: jobErr } = await supabase
            .from("sync_jobs")
            .insert({
                platform_account_id: accountId,
                job_type: target === "all" ? "campaigns" : target,
                status: "RUNNING",
                started_at: new Date().toISOString()
            })
            .select("id")
            .single();

        const jobId = job?.id;
        const result = { campaigns: 0, adGroups: 0, errors: [] as string[] };

        try {
            const since = account.synced_at ? Math.floor(new Date(account.synced_at).getTime() / 1000) : undefined;
            const offset = ["VND", "JPY", "KRW", "CLP", "PYG", "ISK"].includes(account.currency?.toUpperCase()) ? 1 : 100;

            // Helper for batch upserting
            const batchUpsert = async (table: string, data: any[], onConflict: string) => {
                const BATCH_SIZE = 500;
                for (let i = 0; i < data.length; i += BATCH_SIZE) {
                    const batch = data.slice(i, i + BATCH_SIZE);
                    console.log(`[CampaignSync] Upserting batch ${Math.floor(i / BATCH_SIZE) + 1} of ${Math.ceil(data.length / BATCH_SIZE)} to ${table}`);
                    const { error } = await supabase.from(table).upsert(batch, { onConflict });
                    if (error) throw new Error(`${table} Batch Error: ${error.message}`);
                }
            };

            if (isCampaignSync) {
                // BATCH SYNC CAMPAIGNS
                const fbCampaigns = await fb.getCampaigns(account.external_id, since);
                console.log(`[CampaignSync] Got ${fbCampaigns.length} campaigns from FB`);
                if (fbCampaigns.length > 0) {
                    const { data: existingCamps } = await supabase.from("unified_campaigns").select("id, external_id").eq("platform_account_id", accountId).limit(10000);
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

                    try {
                        await batchUpsert("unified_campaigns", campUpserts, "platform_account_id,external_id");
                        result.campaigns = campUpserts.length;
                        // Cập nhật mốc sync sau khi xong phần campaigns để giảm tải cho lần sau nếu adsets lỗi
                        await supabase.from("platform_accounts").update({ synced_at: getVietnamTime() }).eq("id", accountId);
                    } catch (err: any) {
                        result.errors.push(err.message);
                        if (err.message.includes("FACEBOOK_RATE_LIMIT")) throw err;
                    }
                }
            }

            if (isAdSetSync) {
                // BATCH SYNC ADSETS
                console.log("[CampaignSync] Fetching adsets for " + account.external_id + ", since=" + since);
                const fbAdSets = await fb.getAdSets(account.external_id, since);
                console.log("[CampaignSync] Got " + fbAdSets.length + " adsets from FB");
                if (fbAdSets.length > 0) {
                    const { data: allCamps } = await supabase.from("unified_campaigns").select("id, external_id").eq("platform_account_id", accountId).limit(10000);
                    const fullCampaignMap = new Map((allCamps || []).map((c: any) => [c.external_id, c.id]));
                    console.log("[CampaignSync] Found " + (allCamps?.length || 0) + " campaigns in DB for matching");

                    const { data: existingAdGroups } = await supabase.from("unified_ad_groups").select("id, external_id").eq("platform_account_id", accountId).limit(20000);
                    const adGroupIdMap = new Map((existingAdGroups || []).map(ag => [ag.external_id, ag.id]));

                    const adSetUpserts = fbAdSets.map(adset => {
                        const campaignId = fullCampaignMap.get(adset.campaign_id);
                        if (!campaignId) return null;
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
                            platform_data: adset,
                            synced_at: getVietnamTime(),
                        };
                    }).filter(Boolean);

                    if (adSetUpserts.length > 0) {
                        try {
                            await batchUpsert("unified_ad_groups", adSetUpserts as any[], "platform_account_id,external_id");
                            result.adGroups = adSetUpserts.length;
                        } catch (err: any) {
                            result.errors.push(err.message);
                            if (err.message.includes("FACEBOOK_RATE_LIMIT")) throw err;
                        }
                    }
                }
            }

            // FINAL UPDATE: Job completed
            if (jobId) {
                await supabase.from("sync_jobs").update({
                    status: "COMPLETED",
                    completed_at: new Date().toISOString()
                }).eq("id", jobId);
            }

            return jsonResponse({ success: true, data: result });
        } catch (syncErr: any) {
            console.error(`[CampaignSync] Inner Error:`, syncErr);
            if (jobId) {
                await supabase.from("sync_jobs").update({
                    status: "FAILED",
                    error_message: syncErr.message,
                    completed_at: new Date().toISOString()
                }).eq("id", jobId);
            }
            throw syncErr;
        }
    } catch (error: any) {
        console.error(`[CampaignSync] Fatal Error:`, error);
        const status = error.message.includes("FACEBOOK_RATE_LIMIT") ? 200 : 500;
        return jsonResponse({ success: false, error: error.message }, status);
    }
});
