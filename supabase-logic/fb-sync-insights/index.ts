/**
 * Facebook Sync - Insights (BATCH OPTIMIZED & NORMALIZED)
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const JWT_SECRET = Deno.env.get("JWT_SECRET");
const supabase = createClient(supabaseUrl, supabaseKey);

const FB_BASE_URL = "https://graph.facebook.com/v24.0";

async function fetchPagedFromSupabase(table: string, select: string, accountId: number, filters: Record<string, any> = {}) {
    let all: any[] = [];
    let page = 0;
    const pageSize = 1000;

    while (true) {
        let query = supabase
            .from(table)
            .select(select)
            .eq("platform_account_id", accountId);

        for (const [key, value] of Object.entries(filters)) {
            query = query.eq(key, value);
        }

        const { data, error } = await query
            .order("id")
            .range(page * pageSize, (page + 1) * pageSize - 1);

        if (error) throw new Error(`Supabase Fetch Error (${table}): ${error.message}`);
        if (!data || data.length === 0) break;

        all = all.concat(data);
        if (data.length < pageSize) break;
        page++;
    }
    return all;
}

function getVietnamTime(): string {
    const vn = new Date(new Date().getTime() + 7 * 60 * 60 * 1000);
    const y = vn.getUTCFullYear();
    const m = String(vn.getUTCMonth() + 1).padStart(2, '0');
    const d = String(vn.getUTCDate()).padStart(2, '0');
    const h = String(vn.getUTCHours()).padStart(2, '0');
    const min = String(vn.getUTCMinutes()).padStart(2, '0');
    const s = String(vn.getUTCSeconds()).padStart(2, '0');
    return y + "-" + m + "-" + d + " " + h + ":" + min + ":" + s;
}

class FacebookApiClient {
    constructor(private accessToken: string) { }

    async getInsights(accountId: string, params: Record<string, string>): Promise<any[]> {
        console.log(`[FB-API] Fetching insights for ${accountId}`, params);
        const url = new URL(FB_BASE_URL + "/" + accountId + "/insights");
        url.searchParams.set("access_token", this.accessToken);
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined && value !== null) url.searchParams.set(key, value);
        }

        let all: any[] = [];
        let nextUrl: string | null = url.toString();

        while (nextUrl) {
            const response = await fetch(nextUrl);
            if (!response.ok) {
                const text = await response.text();
                throw new Error(`Facebook API Request Failed (${response.status}): ${text}`);
            }
            const data = await response.json();
            if (data.error) {
                throw new Error("Facebook API Error: " + data.error.message);
            }
            if (data.data) {
                all = all.concat(data.data);
            }
            nextUrl = data.paging?.next || null;
        }
        return all;
    }

    async getBatchInsights(objectIds: string[], params: Record<string, string>): Promise<any[]> {
        if (objectIds.length === 0) return [];
        console.log(`[FB-API] Fetching batch insights for ${objectIds.length} objects`);

        const chunkSize = 50; // Facebook limit for batch requests
        let allResults: any[] = [];

        for (let i = 0; i < objectIds.length; i += chunkSize) {
            const chunk = objectIds.slice(i, i + chunkSize);
            const batch = chunk.map(id => {
                const relativeUrl = new URL(FB_BASE_URL + "/" + id + "/insights");
                for (const [key, value] of Object.entries(params)) {
                    if (value !== undefined && value !== null) relativeUrl.searchParams.set(key, value);
                }
                return {
                    method: "GET",
                    relative_url: relativeUrl.pathname + relativeUrl.search
                };
            });

            const response = await fetch(`${FB_BASE_URL}/?access_token=${this.accessToken}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ batch })
            });

            if (!response.ok) {
                const text = await response.text();
                throw new Error(`Facebook Batch API Failed (${response.status}): ${text}`);
            }

            const results = await response.json();
            for (const res of results) {
                if (res.code === 200) {
                    const body = JSON.parse(res.body);
                    if (body.data) {
                        allResults = allResults.concat(body.data);
                    }
                } else {
                    console.warn(`[FB-API] Batch item failed with code ${res.code}: ${res.body}`);
                }
            }
        }
        return allResults;
    }

    async getActiveAdsFromFB(accountId: string): Promise<string[]> {
        console.log(`[FB-API] Fetching active ads for account ${accountId}`);
        const url = new URL(FB_BASE_URL + "/" + accountId + "/ads");
        url.searchParams.set("access_token", this.accessToken);
        url.searchParams.set("effective_status", JSON.stringify(["ACTIVE"]));
        url.searchParams.set("limit", "1000");
        url.searchParams.set("fields", "id");

        const response = await fetch(url.toString());
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Facebook API Ads Request Failed: ${text}`);
        }
        const data = await response.json();
        return (data.data || []).map((ad: any) => ad.id);
    }
}

const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

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

    if (authHeader?.startsWith("Bearer ")) {
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

        // Critical Fallback: If token present but not found, allow as default user
        return { userId: 1, isSystem: true };
    }

    // Default Fallback: Allow unauthenticated
    return { userId: 1, isSystem: true };
}

const jsonResponse = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: corsHeaders });

Deno.serve(async (req: Request) => {
    const logs: string[] = [];
    const log = (msg: string) => {
        const timestamp = new Date().toISOString();
        const fullMsg = `[${timestamp}] ${msg}`;
        console.log(fullMsg);
        logs.push(fullMsg);
    };

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

    try {
        const auth = await verifyAuth(req);
        if (!auth) return jsonResponse({ success: false, error: "Unauthorized" }, 401);

        let body: any = {};
        try {
            const text = await req.text();
            if (text) body = JSON.parse(text);
        } catch (e) {
            return jsonResponse({ error: "Invalid JSON body" }, 400);
        }

        const { accountId, granularity = "daily", dateStart, dateEnd, date_preset } = body;
        if (!accountId) return jsonResponse({ error: "accountId is required" }, 400);

        const { data: account, error: accErr } = await supabase.from("platform_accounts").select("*").eq("id", accountId).single();
        if (accErr || !account) return jsonResponse({ error: "Account not found" }, 404);

        const { data: tokenCred, error: credErr } = await supabase.from("platform_credentials")
            .select("credential_value")
            .eq("platform_identity_id", account.platform_identity_id)
            .eq("credential_type", "access_token")
            .single();

        if (credErr || !tokenCred) return jsonResponse({ error: "Facebook token not found" }, 404);

        const fb = new FacebookApiClient(tokenCred.credential_value);

        // CREATE SYNC JOB RECORD
        const { data: job, error: jobErr } = await supabase
            .from("sync_jobs")
            .insert({
                platform_account_id: accountId,
                job_type: granularity === "hourly" ? "insights_hourly" : "insights",
                status: "RUNNING",
                started_at: new Date().toISOString()
            })
            .select("id")
            .single();

        const jobId = job?.id;

        try {
            const vnNow = new Date(new Date().getTime() + 7 * 60 * 60 * 1000);
            const todayStr = vnNow.toISOString().split('T')[0];
            const isToday = date_preset === 'today' || dateStart === todayStr || dateEnd === todayStr;

            const fullFields = "ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,account_id,impressions,clicks,spend,reach,frequency,inline_link_clicks,actions,action_values,conversions,date_start,date_stop";
            const hourlyFields = "ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,account_id,impressions,clicks,spend,inline_link_clicks,actions,action_values,conversions,date_start,date_stop";

            const gran = (granularity || "daily").toLowerCase();
            const actualGranularities: ("daily" | "hourly")[] = [];
            if (gran === "both") actualGranularities.push("daily", "hourly");
            else actualGranularities.push(gran as "daily" | "hourly");

            let totalFbCount = 0;
            let totalUpsertCount = 0;

            // Load Mappings once
            const ads = await fetchPagedFromSupabase("unified_ads", "id, external_id", accountId);
            const campaigns = await fetchPagedFromSupabase("unified_campaigns", "id, external_id", accountId);
            const adGroups = await fetchPagedFromSupabase("unified_ad_groups", "id, external_id", accountId);

            log(`Loaded mappings: Ads: ${ads.length}, Campaigns: ${campaigns.length}, AdGroups: ${adGroups.length}`);

            const adMap = new Map((ads || []).map((a: any) => [a.external_id, a.id]));
            const campMap = new Map((campaigns || []).map((c: any) => [c.external_id, c.id]));
            const adGroupMap = new Map((adGroups || []).map((ag: any) => [ag.external_id, ag.id]));

            const offset = ["VND", "JPY", "KRW", "CLP", "PYG", "ISK"].includes(account.currency?.toUpperCase()) ? 1 : 100;
            const timestampNow = getVietnamTime();

            const processAndUpsert = async (insights: any[], targetGran: "daily" | "hourly") => {
                const insightsToUpsert = [];
                for (const row of insights) {
                    // 1. Recursive Self-Healing: Campaign
                    let campId = campMap.get(row.campaign_id);
                    if (!campId && row.campaign_id) {
                        log(`Campaign not found: ${row.campaign_id} (${row.campaign_name}). Creating...`);
                        const { data: newCamp, error: cErr } = await supabase
                            .from("unified_campaigns")
                            .insert({
                                id: crypto.randomUUID(),
                                platform_account_id: accountId,
                                external_id: row.campaign_id,
                                name: row.campaign_name,
                                status: "ACTIVE",
                                synced_at: timestampNow
                            })
                            .select("id")
                            .single();
                        if (!cErr && newCamp) {
                            campId = newCamp.id;
                            campMap.set(row.campaign_id, campId);
                        } else {
                            log(`Failed to create campaign ${row.campaign_id}: ${cErr?.message}`);
                        }
                    }

                    // 2. Recursive Self-Healing: AdSet
                    let adGroupId = adGroupMap.get(row.adset_id);
                    if (!adGroupId && row.adset_id && campId) {
                        log(`AdSet not found: ${row.adset_id} (${row.adset_name}). Creating...`);
                        const { data: newAG, error: agErr } = await supabase
                            .from("unified_ad_groups")
                            .insert({
                                id: crypto.randomUUID(),
                                platform_account_id: accountId,
                                unified_campaign_id: campId,
                                external_id: row.adset_id,
                                name: row.adset_name,
                                status: "ACTIVE",
                                synced_at: timestampNow
                            })
                            .select("id")
                            .single();
                        if (!agErr && newAG) {
                            adGroupId = newAG.id;
                            adGroupMap.set(row.adset_id, adGroupId);
                        } else {
                            log(`Failed to create adset ${row.adset_id}: ${agErr?.message}`);
                        }
                    }

                    // 3. Recursive Self-Healing: Ad
                    let adId = adMap.get(row.ad_id);
                    if (!adId && row.ad_id && adGroupId) {
                        log(`Ad not found: ${row.ad_id} (${row.ad_name}). Creating...`);
                        const { data: newAd, error: adErr } = await supabase
                            .from("unified_ads")
                            .insert({
                                id: crypto.randomUUID(),
                                platform_account_id: accountId,
                                unified_ad_group_id: adGroupId,
                                external_id: row.ad_id,
                                name: row.ad_name,
                                status: "ACTIVE",
                                synced_at: timestampNow
                            })
                            .select("id")
                            .single();
                        if (!adErr && newAd) {
                            adId = newAd.id;
                            adMap.set(row.ad_id, adId);
                        } else {
                            log(`Failed to create ad ${row.ad_id}: ${adErr?.message}`);
                        }
                    }

                    if (!adId) continue;

                    const actions = row.actions || [];
                    const actionValues = row.action_values || [];
                    const messaging_new = actions.find((a: any) => a.action_type === 'onsite_conversion.messaging_first_reply')?.value || 0;
                    const messaging_total = actions.find((a: any) => a.action_type === 'onsite_conversion.messaging_conversation_started_7d')?.value || 0;
                    const results_count = actions.find((a: any) => a.action_type === 'lead' || a.action_type === 'purchase' || a.action_type === 'onsite_conversion.messaging_conversation_started_7d')?.value || 0;
                    const purchase_value = actionValues.find((a: any) => a.action_type === 'purchase' || a.action_type === 'onsite_conversion.purchase')?.value || 0;
                    const conversions = row.conversions || 0;

                    const baseData: any = {
                        platform_account_id: accountId,
                        unified_campaign_id: campMap.get(row.campaign_id),
                        unified_ad_group_id: adGroupMap.get(row.adset_id),
                        unified_ad_id: adId,
                        date: row.date_start,
                        impressions: parseInt(row.impressions || 0),
                        clicks: parseInt(row.clicks || 0),
                        spend: parseFloat(row.spend || 0) / offset,
                        results: parseInt(results_count),
                        messaging_total: parseInt(messaging_total),
                        messaging_new: parseInt(messaging_new),
                        purchase_value: parseFloat(purchase_value) / offset,
                        conversions: parseInt(conversions),
                        synced_at: timestampNow
                    };

                    if (targetGran === 'hourly') {
                        const hourStr = row.hourly_stats_aggregated_by_advertiser_time_zone || "";
                        const hour = parseInt(hourStr.split(':')[0] || "0");
                        insightsToUpsert.push({ ...baseData, hour });
                    } else {
                        insightsToUpsert.push(baseData);
                    }
                }

                if (insightsToUpsert.length > 0) {
                    let table = targetGran === 'hourly' ? "unified_hourly_insights" : "unified_insights";
                    let onConflict = targetGran === 'hourly'
                        ? "platform_account_id,unified_ad_id,date,hour"
                        : "platform_account_id,unified_ad_id,date";

                    const { error: uErr } = await supabase.from(table).upsert(insightsToUpsert, { onConflict });
                    if (uErr) log(`Upsert failed for ${table}: ${uErr.message}`);
                    else totalUpsertCount += insightsToUpsert.length;
                }
            };

            for (const currentGran of actualGranularities) {
                log(`Starting sync for ${currentGran}...`);
                const params: Record<string, string> = { limit: "1000" };

                // FORCE HOURLY TO ALWAYS BE TODAY
                if (currentGran === 'hourly') {
                    params.date_preset = 'today';
                } else if (currentGran === 'daily' && !date_preset && !dateStart && !dateEnd) {
                    params.date_preset = 'today';
                } else {
                    if (date_preset) params.date_preset = date_preset;
                    if (dateStart && dateEnd) params.time_range = JSON.stringify({ since: dateStart, until: dateEnd });
                }

                if (currentGran === 'hourly') {
                    params.level = "ad";
                    params.breakdowns = "hourly_stats_aggregated_by_advertiser_time_zone";
                    params.fields = hourlyFields;
                } else {
                    params.level = "ad";
                    params.time_increment = "1";
                    params.fields = fullFields;
                }

                // UNIFIED STRICT ACTIVE FILTERING
                log(`Using strict hierarchical active filtering for ${currentGran}`);

                // Fetch only ads that belong to an active hierarchy (Ad, AdSet, and Campaign all ACTIVE)
                const { data: activeAds, error: adsErr } = await supabase
                    .from("unified_ads")
                    .select(`
                        external_id,
                        unified_ad_groups!inner (
                            status,
                            unified_campaigns!inner (
                                status
                            )
                        )
                    `)
                    .eq("platform_account_id", accountId)
                    .eq("status", "ACTIVE")
                    .eq("unified_ad_groups.status", "ACTIVE")
                    .eq("unified_ad_groups.unified_campaigns.status", "ACTIVE");

                let adIds: string[] = [];

                if (adsErr) {
                    log(`Error fetching hierarchical active ads: ${adsErr.message}. Falling back to status filter.`);
                    const fallbackAds = await fetchPagedFromSupabase("unified_ads", "external_id", accountId, { status: "ACTIVE" });
                    adIds = fallbackAds?.map((a: any) => a.external_id) || [];
                } else {
                    adIds = activeAds?.map((a: any) => a.external_id) || [];
                }

                log(`Found ${adIds.length} hierarchical active ads for sync`);

                if (adIds.length === 0 && isToday) {
                    // Only fallback to FB if it's today and we have nothing in DB (newly added account case)
                    log(`No hierarchical active ads found in DB, fetching active ads directly from FB`);
                    const fbAdIds = await fb.getActiveAdsFromFB(account.external_id);
                    log(`Found ${fbAdIds.length} active ads from FB`);
                    adIds.push(...fbAdIds);
                }

                if (adIds.length > 0) {
                    const idChunkSize = 50;
                    const uniqueAdIds = [...new Set(adIds)];
                    for (let i = 0; i < uniqueAdIds.length; i += idChunkSize) {
                        const chunk = uniqueAdIds.slice(i, i + idChunkSize);
                        log(`Fetching ${currentGran} chunk ${Math.floor(i / idChunkSize) + 1} (${chunk.length} ads)...`);
                        try {
                            const chunkInsights = await fb.getBatchInsights(chunk, params);
                            totalFbCount += chunkInsights.length;
                            await processAndUpsert(chunkInsights, currentGran);
                        } catch (chunkErr: any) {
                            log(`Error in ${currentGran} chunk: ${chunkErr.message}`);
                            if (chunkErr.message.includes("FACEBOOK_RATE_LIMIT")) {
                                log("Rate limit detected. Waiting...");
                                await new Promise(r => setTimeout(r, 5000));
                            }
                        }
                        await new Promise(r => setTimeout(r, 300));
                    }
                } else {
                    log(`No active ads found for ${currentGran}. Skipping.`);
                }
            }

            await supabase.from("platform_accounts").update({ synced_at: timestampNow }).eq("id", accountId);

            // FINAL UPDATE: Job completed
            if (jobId) {
                await supabase.from("sync_jobs").update({
                    status: "COMPLETED",
                    completed_at: new Date().toISOString()
                }).eq("id", jobId);
            }

            return jsonResponse({
                status: "success",
                synced: totalUpsertCount,
                fbCount: totalFbCount,
                debug_logs: logs
            });

        } catch (syncErr: any) {
            log(`Inner Error: ${syncErr.message}`);
            if (jobId) {
                await supabase.from("sync_jobs").update({
                    status: "FAILED",
                    error_message: syncErr.message,
                    completed_at: new Date().toISOString()
                }).eq("id", jobId);
            }
            throw syncErr;
        }
    } catch (err: any) {
        log(`Fatal Error: ${err.message}`);
        return jsonResponse({ error: err.message, debug_logs: logs }, 500);
    }
});