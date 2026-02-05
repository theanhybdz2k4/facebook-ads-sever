/**
 * Facebook Sync - Insights (BATCH OPTIMIZED)
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";
import { verify } from "https://deno.land/x/djwt@v3.0.1/mod.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const JWT_SECRET = Deno.env.get("JWT_SECRET");
const supabase = createClient(supabaseUrl, supabaseKey);

const FB_BASE_URL = "https://graph.facebook.com/v24.0";

function getVietnamToday(): string {
    const vn = new Date(Date.now() + 7 * 60 * 60 * 1000);
    return `${vn.getUTCFullYear()}-${String(vn.getUTCMonth() + 1).padStart(2, '0')}-${String(vn.getUTCDate()).padStart(2, '0')}`;
}

function getVietnamYesterday(): string {
    const vn = new Date(Date.now() + 7 * 60 * 60 * 1000 - 86400000);
    return `${vn.getUTCFullYear()}-${String(vn.getUTCMonth() + 1).padStart(2, '0')}-${String(vn.getUTCDate()).padStart(2, '0')}`;
}

function getVietnamTime(): string {
    const vn = new Date(Date.now() + 7 * 60 * 60 * 1000);
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

    // Public method to fetch any FB API endpoint
    async request<T>(endpoint: string): Promise<T> {
        const url = FB_BASE_URL + endpoint + (endpoint.includes("?") ? "&" : "?") + "access_token=" + this.accessToken;
        const res = await fetch(url);
        const data = await res.json();
        if (data.error) throw new Error("FB API: " + data.error.message);
        return data;
    }

    async getCampaign(campaignId: string): Promise<any> {
        return this.request<any>("/" + campaignId + "?fields=id,account_id,name,objective,status,effective_status,daily_budget,lifetime_budget,start_time,stop_time");
    }

    async getAdSet(adsetId: string): Promise<any> {
        return this.request<any>("/" + adsetId + "?fields=id,campaign_id,name,status,effective_status,daily_budget,optimization_goal,start_time,end_time");
    }

    async getAd(adId: string): Promise<any> {
        return this.request<any>("/" + adId + "?fields=id,adset_id,campaign_id,name,status,effective_status,created_time,updated_time");
    }

    async getInsights(entityId: string, level: string, dateRange: { start: string; end: string }, granularity: "DAILY" | "HOURLY" = "DAILY", breakdowns?: string): Promise<any[]> {
        if (granularity === "HOURLY" && dateRange.start !== dateRange.end) {
            const arr = [];
            const dt = new Date(dateRange.start);
            const end = new Date(dateRange.end);
            while (dt <= end) {
                arr.push(dt.toISOString().split("T")[0]);
                dt.setDate(dt.getDate() + 1);
            }

            let all: any[] = [];
            for (const d of arr) {
                const chunk = await this.getInsights(entityId, level, { start: d, end: d }, granularity, breakdowns);
                all = all.concat(chunk);
            }
            return all;
        }

        const fields = ["ad_id", "adset_id", "campaign_id", "date_start", "date_stop", "spend", "impressions", "clicks", "actions", "action_values"];
        if (granularity !== "HOURLY") fields.push("reach");

        const params: any = {
            level,
            time_range: JSON.stringify({ since: dateRange.start, until: dateRange.end }),
            fields: fields.join(","),
            limit: "1000",
        };

        if (granularity === "HOURLY") params.breakdowns = "hourly_stats_aggregated_by_advertiser_time_zone";
        else {
            params.time_increment = "1";
            if (breakdowns) {
                if (breakdowns === "device") params.breakdowns = "device_platform";
                else if (breakdowns === "age_gender") params.breakdowns = "age,gender";
                else if (breakdowns === "region") params.breakdowns = "region";
                else params.breakdowns = breakdowns;
            }
        }

        const url = new URL(FB_BASE_URL + "/" + entityId + "/insights");
        url.searchParams.set("access_token", this.accessToken);
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v as string);

        let allData: any[] = [];
        let nextUrl: string | null = url.toString();

        let retryCount = 0;
        const maxRetries = 3;

        while (nextUrl) {
            try {
                const response = await fetch(nextUrl);
                const data = await response.json();

                if (data.error) {
                    // Rate limit error (17 or 4) or "too much data" warning
                    if (data.error.code === 17 || data.error.code === 4 || data.error.message?.includes("reduce the amount of data")) {
                        if (retryCount < maxRetries) {
                            retryCount++;
                            const waitMs = Math.pow(2, retryCount) * 1000;
                            console.log("[Insights] Rate limited, waiting " + waitMs + "ms before retry " + retryCount + "/" + maxRetries);
                            await new Promise(r => setTimeout(r, waitMs));
                            continue;
                        }
                    }
                    throw new Error("FB API: " + data.error.message);
                }

                retryCount = 0;
                if (data.data) allData = allData.concat(data.data);
                nextUrl = data.paging?.next || null;

                if (nextUrl) await new Promise(r => setTimeout(r, 100)); // Small pause

            } catch (e: any) {
                if (retryCount < maxRetries) {
                    retryCount++;
                    const waitMs = Math.pow(2, retryCount) * 1000;
                    console.log("[Insights] Request failed, retrying in " + waitMs + "ms: " + e.message);
                    await new Promise(r => setTimeout(r, waitMs));
                    continue;
                }
                throw e;
            }
        }
        return allData;
    }

    async getAdCreatives(adIds: string[]): Promise<any[]> {
        const url = new URL(FB_BASE_URL + "/");
        url.searchParams.set("access_token", this.accessToken);
        url.searchParams.set("ids", adIds.join(","));
        url.searchParams.set("fields", "id,creative{id,object_story_spec,thumbnail_url,name}");
        const response = await fetch(url.toString());
        const data = await response.json();
        if (data.error) throw new Error("Facebook API Error: " + data.error.message);
        return Object.values(data);
    }
}

function extractResults(raw: any): number {
    if (!raw.actions) return 0;
    // Priority order: pick the FIRST matching type, don't sum all
    // These action types often overlap (same conversion counted multiple ways)
    const priorityTypes = [
        "onsite_conversion.messaging_first_reply",  // Most accurate for messaging
        "onsite_conversion.messaging_conversation_started_7d",
        "lead",
        "onsite_conversion.lead",
        "onsite_web_lead",
        "purchase",
        "onsite_conversion.purchase",
        "onsite_web_purchase",
        "offsite_complete_registration_add_meta_leads"
    ];

    for (const type of priorityTypes) {
        const action = raw.actions.find((a: any) => a.action_type === type);
        if (action) {
            return Number(action.value);
        }
    }
    return 0;
}

function extractMessagingTotal(raw: any): number {
    if (!raw.actions) return 0;
    const action = raw.actions.find((a: any) => a.action_type === "onsite_conversion.total_messaging_connection");
    return action ? Number(action.value) : 0;
}

function extractMessagingNew(raw: any): number {
    if (!raw.actions) return 0;
    const action = raw.actions.find((a: any) => a.action_type === "onsite_conversion.messaging_first_reply");
    return action ? Number(action.value) : 0;
}

const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-client-info, apikey, x-service-key",
};

// CRITICAL: DO NOT REMOVE THIS AUTH LOGIC. 
// IT PRIORITIZES auth_tokens TABLE FOR CUSTOM AUTHENTICATION.
async function verifyAuth(req: Request) {
    const authHeader = req.headers.get("Authorization");
    const serviceKeyHeader = req.headers.get("x-service-key") || req.headers.get("x-master-key");
    const masterKey = Deno.env.get("MASTER_KEY") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const authSecret = Deno.env.get("AUTH_SECRET") || "";
    const legacyToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxuY2dtYXh0cWpmYmN5cG5jZm9lIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NzM0NzQxMywiZXhwIjoyMDgyOTIzNDEzfQ.zalV6mnyd1Iit0KbHnqLxemnBKFPbKz2159tkHtodJY";

    if (serviceKeyHeader === serviceKey || serviceKeyHeader === masterKey || serviceKeyHeader === legacyToken) {
        return { userId: 1 };
    }

    if (authHeader?.startsWith("Bearer ")) {
        const token = authHeader.substring(7).trim();
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
const jsonResponse = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: corsHeaders });

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

    const auth = await verifyAuth(req);
    if (!auth) return jsonResponse({ success: false, error: "Unauthorized" }, 401);

    const url = new URL(req.url);
    try {
        if (req.method === "GET") {
            const dateStart = url.searchParams.get("dateStart");
            const dateEnd = url.searchParams.get("dateEnd");
            const adId = url.searchParams.get("adId");
            const accountId = url.searchParams.get("accountId");
            const branchId = url.searchParams.get("branchId");
            const platformCode = url.searchParams.get("platformCode");

            // Get platform_id from platforms table if filtering by specific platform
            let platformId: number | null = null;
            if (platformCode && platformCode !== "all") {
                const { data: platform } = await supabase.from("platforms").select("id").eq("code", platformCode).single();
                platformId = platform?.id || null;
            }

            let selectString = "*, unified_ads(id, name, external_id), unified_ad_groups(id, name), unified_campaigns(id, name), platform_accounts!inner(id, branch_id, platform_id, platform_identities!inner(user_id))";

            let query = supabase
                .from("unified_insights")
                .select(selectString)
                .eq("platform_accounts.platform_identities.user_id", auth.userId);

            if (dateStart) query = query.gte("date", dateStart);
            if (dateEnd) query = query.lte("date", dateEnd);
            if (adId) query = query.eq("unified_ad_id", adId);
            if (accountId) query = query.eq("platform_account_id", accountId);
            if (branchId && branchId !== "all") query = query.eq("platform_accounts.branch_id", branchId);
            if (platformId) query = query.eq("platform_accounts.platform_id", platformId);

            // Only return insights that have an ad ID (exclude orphan records)
            query = query.not("unified_ad_id", "is", null);

            const { data, error } = await query.order("date", { ascending: false }).limit(20000);
            if (error) throw error;

            // Map to camelCase for frontend
            const mapped = (data || []).map((i: any) => ({
                id: i.id,
                date: i.date,
                adId: i.unified_ad_id,
                impressions: i.impressions,
                clicks: i.clicks,
                spend: i.spend,
                reach: i.reach,
                results: i.results,
                ad: i.unified_ads ? {
                    id: i.unified_ads.id,
                    name: i.unified_ads.name,
                    externalId: i.unified_ads.external_id,
                    account: i.unified_ads.platform_account_id
                } : null
            }));

            return jsonResponse(mapped);
        }

        if (req.method === "POST") {
            const body = await req.json();
            const {
                accountId: bodyAccountId,
                adId: bodyAdId,
                dateStart = getVietnamYesterday(),
                dateEnd = getVietnamToday(),
                granularity = "BOTH",
                breakdown
            } = body;

            let targetAccountId = bodyAccountId;
            let fbEntityId: string | null = null;

            if (bodyAdId) {
                const { data: ad } = await supabase.from("unified_ads").select("external_id, platform_account_id").eq("id", bodyAdId).single();
                if (ad) { targetAccountId = ad.platform_account_id; fbEntityId = ad.external_id; }
            }

            if (!targetAccountId) return jsonResponse({ success: false, error: "Missing accountId" }, 400);

            const { data: account, error: accountError } = await supabase.from("platform_accounts").select(`id, external_id, platform_identities!inner(platform_credentials(credential_value))`).eq("id", targetAccountId).single();

            if (accountError || !account) return jsonResponse({ success: false, error: "Account not found" }, 404);

            if (!fbEntityId) fbEntityId = account.external_id;

            const token = account?.platform_identities?.platform_credentials?.find((c: any) => c.credential_value)?.credential_value;
            if (!token) return jsonResponse({ success: false, error: "No token" }, 401);

            const fb = new FacebookApiClient(token);
            const vnNow = getVietnamTime();
            console.log("[Insights] Sync start at VN Time: " + vnNow);
            const result: any = { insights: 0, hourly: 0, breakdowns: 0, debug: { vnNow } };

            // Auto-assign branch if missing AND Verify ownership
            const { data: accForBranch, error: branchErr } = await supabase
                .from("platform_accounts")
                .select("id, name, branch_id, platform_identities!inner(user_id)")
                .eq("id", targetAccountId)
                .maybeSingle();

            if (branchErr || !accForBranch) return jsonResponse({ success: false, error: "Account not found or access denied" }, 404);

            const accountUserId = (accForBranch.platform_identities as any).user_id;
            // Strict check: account user_id must match auth.userId (unless it's system user ID 1)
            if (accountUserId !== auth.userId && auth.userId !== 1) {
                return jsonResponse({ success: false, error: "Unauthorized: You do not own this account" }, 403);
            }

            const { data: campaigns } = await supabase.from("unified_campaigns").select("id, external_id").eq("platform_account_id", targetAccountId).limit(2000);
            const { data: adGroups } = await supabase.from("unified_ad_groups").select("id, external_id").eq("platform_account_id", targetAccountId).limit(5000);
            const { data: ads } = await supabase.from("unified_ads").select("id, external_id, status, effective_status, end_time").eq("platform_account_id", targetAccountId).limit(10000);

            const campaignMap = new Map(campaigns?.map((c: any) => [c.external_id, c.id]));
            const adGroupMap = new Map(adGroups?.map((ag: any) => [ag.external_id, ag.id]));
            const adMap = new Map(ads?.map((a: any) => [a.external_id, a.id]));

            if (granularity === "DAILY" || granularity === "BOTH") {
                const fbInsights = await fb.getInsights(fbEntityId as string, "ad", { start: dateStart, end: dateEnd });
                if (fbInsights.length > 0) {
                    const aggregated = new Map<string, any>();

                    for (const raw of fbInsights) {
                        const cid = campaignMap.get(raw.campaign_id) || null;
                        const agid = adGroupMap.get(raw.adset_id) || null;
                        let adid = adMap.get(raw.ad_id) || null;

                        // If ad doesn't exist, fetch real ad data from FB API and insert it
                        // Also create campaign and ad_group if they don't exist
                        if (!adid && raw.ad_id) {
                            try {
                                const adRes = await fb.getAd(raw.ad_id);
                                if (adRes && adRes.id) {
                                    // First ensure campaign exists
                                    let campId = campaignMap.get(adRes.campaign_id);
                                    if (!campId && adRes.campaign_id) {
                                        try {
                                            const campRes = await fb.getCampaign(adRes.campaign_id);
                                            if (campRes && campRes.id) {
                                                const newCampId = crypto.randomUUID();
                                                await supabase.from("unified_campaigns").upsert({
                                                    id: newCampId,
                                                    external_id: campRes.id,
                                                    platform_account_id: targetAccountId,
                                                    name: campRes.name || "Campaign " + campRes.id,
                                                    objective: campRes.objective,
                                                    status: campRes.status || "UNKNOWN",
                                                    effective_status: campRes.effective_status || "UNKNOWN",
                                                    platform_data: campRes,
                                                    synced_at: getVietnamTime(),
                                                }, { onConflict: "platform_account_id,external_id" });
                                                campaignMap.set(campRes.id, newCampId);
                                                campId = newCampId;
                                                console.log("[InsightSync] Auto-created campaign " + campRes.id);
                                            }
                                        } catch (ce: any) {
                                            console.log("[InsightSync] Failed to create campaign: " + ce.message);
                                        }
                                    }

                                    // Then ensure ad_group exists
                                    let agId = adGroupMap.get(adRes.adset_id);
                                    if (!agId && adRes.adset_id) {
                                        try {
                                            const agRes = await fb.getAdSet(adRes.adset_id);
                                            if (agRes && agRes.id) {
                                                const newAgId = crypto.randomUUID();
                                                const parentCampId = campaignMap.get(agRes.campaign_id) || campId;
                                                await supabase.from("unified_ad_groups").upsert({
                                                    id: newAgId,
                                                    external_id: agRes.id,
                                                    platform_account_id: targetAccountId,
                                                    unified_campaign_id: parentCampId,
                                                    name: agRes.name || "AdSet " + agRes.id,
                                                    status: agRes.status || "UNKNOWN",
                                                    effective_status: agRes.effective_status || "UNKNOWN",
                                                    daily_budget: agRes.daily_budget ? parseFloat(agRes.daily_budget) : null,
                                                    optimization_goal: agRes.optimization_goal,
                                                    start_time: agRes.start_time || null,
                                                    end_time: agRes.end_time || null,
                                                    platform_data: agRes,
                                                    synced_at: getVietnamTime(),
                                                }, { onConflict: "platform_account_id,external_id" });
                                                adGroupMap.set(agRes.id, newAgId);
                                                agId = newAgId;
                                                console.log("[InsightSync] Auto-created ad_group " + agRes.id);
                                            }
                                        } catch (age: any) {
                                            console.log("[InsightSync] Failed to create ad_group: " + age.message);
                                        }
                                    }

                                    // Finally create the ad
                                    if (agId) {
                                        const newAdId = crypto.randomUUID();
                                        const { error } = await supabase.from("unified_ads").upsert({
                                            id: newAdId,
                                            external_id: adRes.id,
                                            platform_account_id: targetAccountId,
                                            unified_ad_group_id: agId,
                                            name: adRes.name || raw.ad_name,
                                            status: adRes.status || "UNKNOWN",
                                            effective_status: adRes.effective_status || "UNKNOWN",
                                            synced_at: getVietnamTime()
                                        }, { onConflict: "platform_account_id,external_id" });
                                        if (!error) {
                                            adid = newAdId;
                                            adMap.set(raw.ad_id, newAdId);
                                            console.log("[InsightSync] Auto-created ad " + raw.ad_id + " (" + (adRes.name || raw.ad_name) + ")");
                                        } else {
                                            console.log("[InsightSync] Failed to insert ad " + raw.ad_id + ": " + error.message);
                                        }
                                    }
                                }
                            } catch (e: any) {
                                console.log("[InsightSync] Failed to fetch ad " + raw.ad_id + ": " + e.message);
                            }
                        }

                        if (!adid) {
                            console.log("[InsightSync] Skipping insight for unknown ad " + raw.ad_id);
                            continue;
                        }

                        const key = targetAccountId + "|" + cid + "|" + agid + "|" + adid + "|" + raw.date_start;

                        function extractRevenue(raw: any): number {
                            if (!raw.action_values) return 0;
                            const types = ["purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase", "offsite_conversion.custom.1234"]; // Standard purchase types
                            return raw.action_values
                                .filter((a: any) => types.includes(a.action_type) || a.action_type.includes("purchase"))
                                .reduce((s: number, a: any) => s + Number(a.value), 0);
                        }

                        // ... inside Deno.serve ...

                        const current = aggregated.get(key) || {
                            platform_account_id: targetAccountId,
                            unified_campaign_id: cid,
                            unified_ad_group_id: agid,
                            unified_ad_id: adid,
                            date: raw.date_start,
                            spend: 0,
                            impressions: 0,
                            clicks: 0,
                            reach: 0,
                            results: 0,
                            messaging_total: 0,
                            messaging_new: 0,
                            purchase_value: 0,
                            platform_metrics: { raw_actions: [] }
                        };

                        current.spend += parseFloat(raw.spend || "0");
                        current.impressions += parseInt(raw.impressions || "0", 10);
                        current.clicks += parseInt(raw.clicks || "0", 10);
                        current.reach = Math.max(current.reach, parseInt(raw.reach || "0", 10));
                        current.results += extractResults(raw);
                        current.messaging_total += extractMessagingTotal(raw);
                        current.messaging_new += extractMessagingNew(raw);
                        current.purchase_value += extractRevenue(raw);

                        // Debug Revenue
                        if (raw.action_values && raw.action_values.length > 0) {
                            console.log("[Revenue Debug] Account " + targetAccountId + " Date " + raw.date_start + ": Found action_values", JSON.stringify(raw.action_values));
                        }

                        if (raw.actions) {
                            current.platform_metrics.raw_actions.push(...raw.actions);
                        }

                        aggregated.set(key, current);
                    }

                    const upserts = Array.from(aggregated.values()).map(i => ({
                        ...i,
                        synced_at: getVietnamTime()
                    }));

                    // FIXED: Use simpler unique constraint to prevent duplicates when campaign_id/adgroup_id vary
                    const { data: saved, error: insErr } = await supabase.from("unified_insights").upsert(upserts, { onConflict: "platform_account_id,unified_ad_id,date" }).select("id, platform_account_id, unified_campaign_id, unified_ad_group_id, unified_ad_id, date");
                    if (insErr) {
                        console.error("Insight Upsert Error:", insErr);
                        result.debug.insightError = insErr.message;
                    }
                    if (saved) {
                        result.insights = saved.length;
                    }
                }
            }

            if (granularity === "HOURLY" || granularity === "BOTH") {
                // For hourly sync, only sync truly active ads:
                // status='ACTIVE' AND effective_status='ACTIVE' AND (end_time IS NULL OR end_time > NOW())
                const nowStr = new Date().toISOString();
                const { data: activeAdsForHourly } = await supabase
                    .from("unified_ads")
                    .select("id, external_id")
                    .eq("platform_account_id", targetAccountId)
                    .eq("status", "ACTIVE")
                    .eq("effective_status", "ACTIVE")
                    .or("end_time.is.null,end_time.gt." + nowStr);

                let adList = bodyAdId ? ads : (activeAdsForHourly || ads || []);
                if (bodyAdId) {
                    const specificAd = adList.find((a: any) => a.id === bodyAdId);
                    if (specificAd) adList = [specificAd];
                    else {
                        const { data: adData } = await supabase.from("unified_ads").select("id, external_id").eq("id", bodyAdId).single();
                        if (adData) adList = [adData];
                        else adList = [];
                    }
                }

                console.log("[Insights] Syncing hourly for " + adList.length + " ads: " + dateStart + " to " + dateEnd);

                // Process ads in batches. Use small batch or single if targeting one ad.
                const CONCURRENCY = bodyAdId ? 1 : 30;
                for (let i = 0; i < adList.length; i += CONCURRENCY) {
                    const chunk = adList.slice(i, i + CONCURRENCY);
                    await Promise.all(chunk.map(async (ad: any) => {
                        try {
                            const fbHourly = await fb.getInsights(ad.external_id, "ad", { start: dateStart, end: dateEnd }, "HOURLY");

                            if (fbHourly.length > 0) {
                                const hAggregated = new Map<string, any>();

                                for (const raw of fbHourly) {
                                    const cid = campaignMap.get(raw.campaign_id) || null;
                                    const agid = adGroupMap.get(raw.adset_id) || null;
                                    const adid = ad.id;
                                    const hrRaw = raw.hourly_stats_aggregated_by_advertiser_time_zone || "0:0";
                                    const hr = parseInt(hrRaw.split(":")[0], 10);
                                    const key = targetAccountId + "|" + cid + "|" + agid + "|" + adid + "|" + raw.date_start + "|" + hr;

                                    const current = hAggregated.get(key) || {
                                        platform_account_id: targetAccountId,
                                        unified_campaign_id: cid,
                                        unified_ad_group_id: agid,
                                        unified_ad_id: adid,
                                        date: raw.date_start,
                                        hour: hr,
                                        spend: 0,
                                        impressions: 0,
                                        clicks: 0,
                                        results: 0,
                                        messaging_total: 0,
                                        messaging_new: 0,
                                        synced_at: getVietnamTime()
                                    };

                                    current.spend += parseFloat(raw.spend || "0");
                                    current.impressions += parseInt(raw.impressions || "0", 10);
                                    current.clicks += parseInt(raw.clicks || "0", 10);
                                    current.results += extractResults(raw);
                                    current.messaging_total += extractMessagingTotal(raw);
                                    current.messaging_new += extractMessagingNew(raw);

                                    hAggregated.set(key, current);
                                }

                                const hUpserts = Array.from(hAggregated.values());

                                console.log("[Insights] Upserting " + hUpserts.length + " aggregated hourly items for ad " + ad.id);
                                const { error: hrErr } = await supabase.from("unified_hourly_insights").upsert(hUpserts, {
                                    onConflict: "platform_account_id,unified_ad_id,date,hour"
                                });

                                if (hrErr) {
                                    console.error("[Insights] Hourly upsert error for ad " + ad.id + ": " + hrErr.message);
                                } else {
                                    result.hourly += hUpserts.length;
                                }
                            }
                        } catch (e: any) {
                            console.error("[Insights] Error syncing hourly for ad " + ad.id + ":", e.message);
                        }
                    }));
                }
            }

            if (breakdown) {
                const fbBreakdowns = await fb.getInsights(fbEntityId as string, "ad", { start: dateStart, end: dateEnd }, "DAILY", breakdown);
                result.debug.fbBreakdownsCount = fbBreakdowns.length;
                if (fbBreakdowns.length > 0) {
                    const parentUpserts = Array.from(new Map(fbBreakdowns.map(raw => {
                        const cid = campaignMap.get(raw?.campaign_id) || null;
                        const agid = adGroupMap.get(raw?.adset_id) || null;
                        const adid = adMap.get(raw.ad_id) || null;
                        const key = targetAccountId + "|" + cid + "|" + agid + "|" + adid + "|" + raw.date_start;
                        return [key, {
                            platform_account_id: targetAccountId,
                            unified_campaign_id: cid,
                            unified_ad_group_id: agid,
                            unified_ad_id: adid,
                            date: raw.date_start,
                            synced_at: getVietnamTime()
                        }];
                    })).values());

                    const { data: parents, error: pErr } = await supabase.from("unified_insights").upsert(parentUpserts, { onConflict: "platform_account_id,unified_ad_id,date" }).select("id, date, unified_ad_id");
                    result.debug.parentsCount = parents?.length || 0;
                    if (pErr) {
                        console.error("[Insights] Parent upsert error:", pErr);
                        result.debug.parentError = pErr.message;
                    }

                    if (parents) {
                        const getParentId = (raw: any) => {
                            const dbAdId = adMap.get(raw.ad_id);
                            // Find match by date and ad UUID
                            const match = parents.find((p: any) => p.date === raw.date_start && (p.unified_ad_id === dbAdId));
                            if (!match) {
                                console.log("[Insights] No parent match found for ad " + raw.ad_id + " (local: " + dbAdId + ") on " + raw.date_start + " in " + parents.length + " parents");
                            }
                            return match?.id;
                        };

                        if (breakdown === "device") {
                            const deviceUpserts = fbBreakdowns.map(raw => ({
                                unified_insight_id: getParentId(raw),
                                device: raw.device_platform,
                                spend: parseFloat(raw.spend || "0"),
                                impressions: parseInt(raw.impressions || "0", 10),
                                clicks: parseInt(raw.clicks || "0", 10),
                                results: extractResults(raw)
                            })).filter(u => u.unified_insight_id);
                            const { error: devErr } = await supabase.from("unified_insight_devices").upsert(deviceUpserts, { onConflict: "unified_insight_id,device" });
                            if (devErr) result.debug.deviceError = devErr.message;
                            else result.breakdowns += deviceUpserts.length;
                        } else if (breakdown === "age_gender") {
                            const agUpserts = fbBreakdowns.map(raw => ({
                                unified_insight_id: getParentId(raw),
                                age: raw.age, gender: raw.gender,
                                spend: parseFloat(raw.spend || "0"),
                                impressions: parseInt(raw.impressions || "0", 10),
                                clicks: parseInt(raw.clicks || "0", 10),
                                results: extractResults(raw)
                            })).filter(u => u.unified_insight_id);
                            const { error: agErr } = await supabase.from("unified_insight_age_gender").upsert(agUpserts, { onConflict: "unified_insight_id,age,gender" });
                            if (agErr) result.debug.agError = agErr.message;
                            else result.breakdowns += agUpserts.length;
                        } else if (breakdown === "region") {
                            const regUpserts = fbBreakdowns.map(raw => ({
                                unified_insight_id: getParentId(raw),
                                region: raw.region, country: raw.country,
                                spend: parseFloat(raw.spend || "0"),
                                impressions: parseInt(raw.impressions || "0", 10),
                                clicks: parseInt(raw.clicks || "0", 10),
                                results: extractResults(raw)
                            })).filter(u => u.unified_insight_id);
                            const { error: regErr } = await supabase.from("unified_insight_regions").upsert(regUpserts, { onConflict: "unified_insight_id,region" });
                            if (regErr) result.debug.regError = regErr.message;
                            else result.breakdowns += regUpserts.length;
                        }
                    }
                }
            }

            // NEW: Batch Sync Creatives for Active Ads or specific target ad
            try {
                // Only sync creatives for truly active ads
                const nowDate = new Date();
                const adsToSyncCreative = bodyAdId
                    ? ads?.filter((a: any) => a.id === bodyAdId)
                    : ads?.filter((a: any) => {
                        const isStatusActive = a.status === "ACTIVE";
                        const isEffectiveActive = a.effective_status === "ACTIVE";
                        const endTime = a.end_time ? new Date(a.end_time) : null;
                        const isNotExpired = !endTime || endTime > nowDate;
                        return isStatusActive && isEffectiveActive && isNotExpired;
                    });

                if (adsToSyncCreative && adsToSyncCreative.length > 0) {
                    const extIds = adsToSyncCreative.map((a: any) => a.external_id).filter(Boolean);
                    const chunks = [];
                    for (let i = 0; i < extIds.length; i += 50) chunks.push(extIds.slice(i, i + 50));

                    for (const chunk of chunks) {
                        const creativeData = await fb.getAdCreatives(chunk);
                        const creativeToAdMap = new Map<string, string>();

                        const creativeUpserts = creativeData.map(item => {
                            const c = item.creative;
                            if (!c) return null;
                            creativeToAdMap.set(c.id, item.id);
                            return {
                                external_id: c.id,
                                platform_account_id: targetAccountId,
                                name: c.name || "Creative " + c.id,
                                thumbnail_url: c.thumbnail_url || null,
                                platform_data: c,
                                synced_at: getVietnamTime(),
                            };
                        }).filter(Boolean);

                        if (creativeUpserts.length > 0) {
                            const { data: upserted, error: creErr } = await supabase
                                .from("unified_ad_creatives")
                                .upsert(creativeUpserts as any[], { onConflict: "platform_account_id,external_id" })
                                .select("id, external_id");

                            if (!creErr && upserted) {
                                result.creatives = (result.creatives || 0) + upserted.length;
                                const adLinks = upserted.map((c: any) => {
                                    const adExtId = creativeToAdMap.get(c.external_id);
                                    if (!adExtId) return null;
                                    return { platform_account_id: targetAccountId, external_id: adExtId, unified_ad_creative_id: c.id };
                                }).filter(Boolean);
                                if (adLinks.length > 0) {
                                    await supabase.from("unified_ads").upsert(adLinks as any[], { onConflict: "platform_account_id,external_id" });
                                }
                            }
                        }
                    }
                }
            } catch (ce: any) {
                console.error("[Insights] Creative sync failed:", ce.message);
                result.debug.creativeError = ce.message;
            }

            // Update account sync timestamp
            await supabase.from("platform_accounts").update({ synced_at: getVietnamTime() }).eq("id", targetAccountId);

            return jsonResponse({ success: true, data: result });
        }
        return jsonResponse({ success: false, error: "Invalid method" }, 405);
    } catch (error: any) {
        return jsonResponse({ success: false, error: error.message }, 500);
    }
});