/**
 * Facebook Sync - Ads (BATCH OPTIMIZED)
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";
import { verify } from "https://deno.land/x/djwt@v3.0.1/mod.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const JWT_SECRET = Deno.env.get("JWT_SECRET");
const supabase = createClient(supabaseUrl, supabaseKey);

const FB_BASE_URL = "https://graph.facebook.com/v24.0";

async function fetchPagedFromSupabase(table: string, select: string, accountId: number) {
    let all: any[] = [];
    let page = 0;
    const pageSize = 1000;

    while (true) {
        const { data, error } = await supabase
            .from(table)
            .select(select)
            .eq("platform_account_id", accountId)
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

    async request<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
        const url = new URL(FB_BASE_URL + endpoint);
        url.searchParams.set("access_token", this.accessToken);
        for (const [key, value] of Object.entries(params)) {
            if (value !== undefined && value !== null) url.searchParams.set(key, value);
        }
        const response = await fetch(url.toString());
        const data = await response.json();
        if (data.error) throw new Error("Facebook API Error: " + data.error.message);
        return data;
    }

    async getCampaign(campaignId: string): Promise<any> {
        return this.request<any>("/" + campaignId, {
            fields: "id,account_id,name,objective,status,effective_status,daily_budget,lifetime_budget,start_time,stop_time"
        });
    }

    async getAdSet(adsetId: string): Promise<any> {
        return this.request<any>("/" + adsetId, {
            fields: "id,campaign_id,name,status,effective_status,daily_budget,optimization_goal,start_time,end_time"
        });
    }

    async getAds(accountId: string): Promise<any[]> {
        let allAds: any[] = [];
        // OPTIMIZATION: Only fetch non-archived/deleted ads to prevent timeout on large accounts
        // Account 42 has 3715 ads but only ~100 are non-archived - this reduces fetch time from 49s to <5s
        const filtering = encodeURIComponent(JSON.stringify([{ "field": "effective_status", "operator": "NOT_IN", "value": ["ARCHIVED", "DELETED"] }]));
        let url: string | null = FB_BASE_URL + "/" + accountId + "/ads?fields=id,adset_id,campaign_id,name,status,effective_status,creative{id,name,thumbnail_url,image_url,image_hash,object_story_spec},adset{id,campaign_id,name,status,effective_status,daily_budget,optimization_goal,start_time,end_time},campaign{id,account_id,name,objective,status,effective_status,daily_budget,lifetime_budget,start_time,stop_time},created_time,updated_time,configured_status&filtering=" + filtering + "&limit=100&access_token=" + this.accessToken;

        let retryCount = 0;
        const maxRetries = 3;

        while (url) {
            try {
                const res = await fetch(url);
                const data = await res.json();

                if (data.error) {
                    // Rate limit error - wait and retry
                    if (data.error.code === 17 || data.error.code === 4 || data.error.message?.includes("reduce the amount of data")) {
                        if (retryCount < maxRetries) {
                            retryCount++;
                            const waitMs = Math.pow(2, retryCount) * 1000; // Exponential backoff: 2s, 4s, 8s
                            console.log("[AdsSync] Rate limited, waiting " + waitMs + "ms before retry " + retryCount + "/" + maxRetries);
                            await new Promise(r => setTimeout(r, waitMs));
                            continue; // Retry same URL
                        }
                    }
                    throw new Error("Facebook API Error: " + data.error.message);
                }

                retryCount = 0; // Reset retry count on success
                if (data.data) allAds = allAds.concat(data.data);
                url = data.paging?.next || null;

                // Add small delay between pages to avoid rate limits
                if (url) await new Promise(r => setTimeout(r, 100));

            } catch (e: any) {
                if (retryCount < maxRetries) {
                    retryCount++;
                    const waitMs = Math.pow(2, retryCount) * 1000;
                    console.log("[AdsSync] Error, waiting " + waitMs + "ms before retry: " + e.message);
                    await new Promise(r => setTimeout(r, waitMs));
                    continue;
                }
                throw e;
            }
        }

        console.log("[AdsSync] Fetched " + allAds.length + " ads total");
        return allAds;
    }
}

const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-client-info, apikey, x-service-key",
};

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
const jsonResponse = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: corsHeaders });

function mapStatus(fbStatus: string): string {
    return { ACTIVE: "ACTIVE", PAUSED: "PAUSED", DELETED: "DELETED", ARCHIVED: "ARCHIVED" }[fbStatus] || "UNKNOWN";
}

// Helper to check if two objects are equivalent for our purposes
function isEquivalent(obj1: any, obj2: any, fields: string[]): boolean {
    for (const field of fields) {
        const val1 = obj1[field];
        const val2 = obj2[field];
        if (typeof val1 === 'object' && val1 !== null) {
            if (JSON.stringify(val1) !== JSON.stringify(val2)) return false;
        } else if (val1 !== val2) {
            return false;
        }
    }
    return true;
}

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

    const auth = await verifyAuth(req);
    if (!auth) return jsonResponse({ success: false, error: "Unauthorized" }, 401);

    try {
        const bodyValue = await req.json();
        const accountIdRaw = bodyValue.accountId;
        if (!accountIdRaw) return jsonResponse({ success: false, error: "accountId is required" }, 400);

        const accountId = parseInt(String(accountIdRaw));

        // Build query - service_role can access any account
        let query = supabase
            .from("platform_accounts")
            .select("id, external_id, platform_identities!inner (id, user_id, platform_credentials (credential_type, credential_value, is_active))")
            .eq("id", accountId);

        // Only apply user_id filter if NOT service_role
        if (auth.userId !== 1) {
            query = query.eq("platform_identities.user_id", auth.userId);
        }

        const { data: account, error: accountError } = await query.maybeSingle();

        if (accountError) {
            console.error(`[AdsSync] DB Error looking up account ${accountId}:`, accountError);
            return jsonResponse({ success: false, error: "Database error looking up account" }, 500);
        }

        if (!account) {
            console.warn(`[AdsSync] Account ${accountId} not found or access denied for user ${auth.userId}`);
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
                job_type: "ads",
                status: "RUNNING",
                started_at: new Date().toISOString()
            })
            .select("id")
            .single();

        const jobId = job?.id;
        const timestampNow = getVietnamTime();
        const result = {
            ads: { added: 0, updated: 0, noChange: 0, total: 0 },
            creatives: { added: 0, updated: 0, noChange: 0, total: 0, cleanedUp: 0 },
            campaigns: 0,
            adGroups: 0,
            errors: [] as string[]
        };

        try {
            // Load existing entities (PAGINATED to handle >1000 records)
            console.log(`[AdsSync] Fetching existing entities for account ${accountId}...`);
            const existingCampaigns = await fetchPagedFromSupabase("unified_campaigns", "id, external_id", accountId);
            const adGroups = await fetchPagedFromSupabase("unified_ad_groups", "id, external_id, unified_campaign_id, start_time, end_time", accountId);

            console.log(`[AdsSync] Loaded ${existingCampaigns.length} campaigns and ${adGroups.length} adSets.`);
            const campaignMap = new Map<string, string>((existingCampaigns || []).map((c: any) => [c.external_id, c.id]));
            const adGroupMap = new Map<string, any>((adGroups || []).map((ag: any) => [ag.external_id, ag]));

            // BATCH SYNC ADS & CREATIVES
            let fetchedAds = await fb.getAds(account.external_id);

            // We only fetch non-archived/deleted ads from FB API to prevent timeout
            // Phase A cleanup handles marking stale ads as ARCHIVED
            const fbAds = fetchedAds;
            console.log(`[AdsSync] Processing ${fbAds.length} non-archived ads from FB`);

            if (fbAds.length > 0) {
                console.log("[AdsSync] Extracting parent entities and creatives...");

                // STEP 0: Extract ALL campaigns & ad_groups from expanded ad objects
                const campaignDataMap = new Map<string, any>();
                const adSetDataMap = new Map<string, any>();

                for (const ad of fbAds) {
                    if (ad.campaign && ad.campaign.id) {
                        campaignDataMap.set(ad.campaign.id, ad.campaign);
                    }
                    if (ad.adset && ad.adset.id) {
                        adSetDataMap.set(ad.adset.id, ad.adset);
                    }
                }

                // Sync ALL campaigns
                if (campaignDataMap.size > 0) {
                    const campaignUpserts = Array.from(campaignDataMap.values()).map(fbCamp => {
                        const existingId = campaignMap.get(fbCamp.id);
                        const id = existingId || crypto.randomUUID();
                        if (!existingId) campaignMap.set(fbCamp.id, id);
                        return {
                            id: id,
                            external_id: fbCamp.id,
                            platform_account_id: accountId,
                            name: fbCamp.name || "Campaign " + fbCamp.id,
                            objective: fbCamp.objective,
                            status: mapStatus(fbCamp.status),
                            effective_status: fbCamp.effective_status,
                            start_time: fbCamp.start_time || null,
                            end_time: fbCamp.stop_time || null,
                            platform_data: fbCamp,
                            synced_at: timestampNow,
                        };
                    });
                    const chunks = [];
                    for (let i = 0; i < campaignUpserts.length; i += 200) chunks.push(campaignUpserts.slice(i, i + 200));
                    for (const chunk of chunks) {
                        const { error: campErr } = await supabase.from("unified_campaigns").upsert(chunk, { onConflict: "platform_account_id,external_id" });
                        if (campErr) result.errors.push("Campaign Sync Error: " + campErr.message);
                    }
                    result.campaigns = campaignUpserts.length;
                }

                // Sync ALL ad_groups
                if (adSetDataMap.size > 0) {
                    const adGroupUpserts = [];
                    for (const fbAdSet of adSetDataMap.values()) {
                        let campaignId = campaignMap.get(fbAdSet.campaign_id);
                        if (campaignId) {
                            const existingAdGroup = adGroupMap.get(fbAdSet.id);
                            const id = existingAdGroup?.id || crypto.randomUUID();
                            adGroupUpserts.push({
                                id: id,
                                external_id: fbAdSet.id,
                                platform_account_id: accountId,
                                unified_campaign_id: campaignId,
                                name: fbAdSet.name || "AdSet " + fbAdSet.id,
                                status: mapStatus(fbAdSet.status),
                                effective_status: fbAdSet.effective_status,
                                daily_budget: fbAdSet.daily_budget ? parseFloat(fbAdSet.daily_budget) : null,
                                optimization_goal: fbAdSet.optimization_goal,
                                start_time: fbAdSet.start_time || null,
                                end_time: fbAdSet.end_time || null,
                                platform_data: fbAdSet,
                                synced_at: timestampNow,
                            });
                            if (!existingAdGroup) {
                                adGroupMap.set(fbAdSet.id, { id: id, start_time: fbAdSet.start_time, end_time: fbAdSet.end_time });
                            }
                        }
                    }
                    if (adGroupUpserts.length > 0) {
                        const chunks = [];
                        for (let i = 0; i < adGroupUpserts.length; i += 200) chunks.push(adGroupUpserts.slice(i, i + 200));
                        for (const chunk of chunks) {
                            const { error: agErr } = await supabase.from("unified_ad_groups").upsert(chunk, { onConflict: "platform_account_id,external_id" });
                            if (agErr) result.errors.push("AdGroup Sync Error: " + agErr.message);
                        }
                        result.adGroups = adGroupUpserts.length;
                    }
                }

                // 1. EXTRACT & SYNC UNIQUE CREATIVES
                const creativeIdMapping = new Map<string, string>();
                const currentCreatives = await fetchPagedFromSupabase("unified_ad_creatives", "id, external_id, name, image_url, thumbnail_url", accountId);
                const existingCreativeDataMap = new Map<string, any>((currentCreatives || []).map((c: any) => [c.external_id, c]));
                (currentCreatives || []).forEach((c: any) => creativeIdMapping.set(c.external_id, c.id));

                const creativeMap = new Map<string, any>();
                fbAds.forEach((ad: any) => {
                    if (ad.creative && ad.creative.id) {
                        const hasExisting = creativeIdMapping.has(ad.creative.id);
                        const isActive = ad.effective_status === 'ACTIVE';
                        if (isActive || !hasExisting) creativeMap.set(ad.creative.id, ad.creative);
                    }
                });

                const uniqueCreativesToUpsert = Array.from(creativeMap.values());
                if (uniqueCreativesToUpsert.length > 0) {
                    const creativeUpserts = [];
                    for (const c of uniqueCreativesToUpsert) {
                        const existing = existingCreativeDataMap.get(c.id);
                        let imageUrl = c.image_url || c.thumbnail_url || null;
                        if (!imageUrl && c.image_hash) imageUrl = `https://graph.facebook.com/v24.0/${c.image_hash}/picture`;
                        if (!imageUrl && c.object_story_spec?.link_data?.image_hash) imageUrl = `https://graph.facebook.com/v24.0/${c.object_story_spec.link_data.image_hash}/picture`;

                        let aiMessage = "";
                        let aiHeadline = "";
                        if (c.object_story_spec) {
                            const spec = c.object_story_spec;
                            const data = spec.link_data || spec.video_data || spec.text_data || spec.template_data || {};
                            aiMessage = data.message || "";
                            aiHeadline = data.name || data.title || data.headline || "";
                        }

                        const trimmedPlatformData = {
                            id: c.id,
                            name: c.name,
                            thumbnail_url: c.thumbnail_url,
                            image_url: c.image_url,
                            page_id: c.object_story_spec?.page_id || c.page_id,
                            object_story_spec: c.object_story_spec ? { page_id: c.object_story_spec.page_id } : undefined,
                            ai_content: { message: aiMessage, headline: aiHeadline }
                        };

                        const newData = {
                            id: existing?.id || crypto.randomUUID(),
                            external_id: c.id,
                            platform_account_id: accountId,
                            name: c.name || "Creative " + c.id,
                            thumbnail_url: c.thumbnail_url || imageUrl || null,
                            image_url: imageUrl,
                            platform_data: trimmedPlatformData,
                            synced_at: timestampNow,
                        };

                        if (!existing || !isEquivalent(existing, newData, ['name', 'image_url', 'thumbnail_url'])) {
                            creativeUpserts.push(newData);
                            existing ? result.creatives.updated++ : result.creatives.added++;
                        } else {
                            result.creatives.noChange++;
                        }
                    }

                    if (creativeUpserts.length > 0) {
                        const chunks = [];
                        for (let i = 0; i < creativeUpserts.length; i += 100) chunks.push(creativeUpserts.slice(i, i + 100));
                        for (const chunk of chunks) {
                            const { data: upsertedCreatives, error: creErr } = await supabase.from("unified_ad_creatives").upsert(chunk, { onConflict: "platform_account_id,external_id" }).select("id, external_id");
                            if (!creErr && upsertedCreatives) {
                                upsertedCreatives.forEach((c: any) => creativeIdMapping.set(c.external_id, c.id));
                            } else if (creErr) {
                                result.errors.push("Creative Batch Error: " + creErr.message);
                            }
                        }
                    }
                }
                result.creatives.total = creativeIdMapping.size;

                // 2. SYNC ADS (PAGINATED)
                const currentAds = await fetchPagedFromSupabase("unified_ads", "id, external_id, name, status, effective_status, unified_ad_creative_id", accountId);
                const existingAdDataMap = new Map<string, any>((currentAds || []).map((a: any) => [a.external_id, a]));
                const adUpserts = [];

                for (const ad of fbAds) {
                    const adGroup = adGroupMap.get(ad.adset_id);
                    if (!adGroup) continue;

                    const internalCreativeId = ad.creative?.id ? creativeIdMapping.get(ad.creative.id) : null;
                    const existing = existingAdDataMap.get(ad.id);
                    const isArchived = ad.effective_status === 'ARCHIVED' || ad.effective_status === 'DELETED';
                    const newData: any = {
                        id: existing?.id || crypto.randomUUID(),
                        external_id: ad.id,
                        platform_account_id: accountId,
                        unified_ad_group_id: adGroup.id,
                        unified_ad_creative_id: internalCreativeId,
                        name: ad.name,
                        status: mapStatus(ad.status),
                        effective_status: ad.effective_status,
                        start_time: adGroup.start_time,
                        end_time: adGroup.end_time,
                        synced_at: timestampNow,
                    };

                    if (!isArchived || !existing) {
                        const trimmedAd = { ...ad };
                        delete trimmedAd.adset;
                        delete trimmedAd.campaign;
                        newData.platform_data = trimmedAd;
                    }

                    if (!existing || !isEquivalent(existing, newData, ['name', 'status', 'effective_status', 'unified_ad_creative_id'])) {
                        adUpserts.push(newData);
                        existing ? result.ads.updated++ : result.ads.added++;
                    } else {
                        adUpserts.push({
                            id: existing.id,
                            platform_account_id: accountId,
                            external_id: ad.id,
                            unified_ad_group_id: adGroup.id,
                            status: mapStatus(ad.status),
                            synced_at: timestampNow
                        });
                        result.ads.noChange++;
                    }
                }

                if (adUpserts.length > 0) {
                    const chunks = [];
                    for (let i = 0; i < adUpserts.length; i += 200) chunks.push(adUpserts.slice(i, i + 200));
                    for (const chunk of chunks) {
                        const { error: adErr } = await supabase.from("unified_ads").upsert(chunk as any[], { onConflict: "platform_account_id,external_id" });
                        if (adErr) result.errors.push("Ad Batch Error: " + adErr.message);
                    }
                }
                result.ads.total = fbAds.length;

                // 3. AUTO-CLEANUP
                try {
                    await supabase.from("unified_ads").update({ effective_status: 'ARCHIVED', synced_at: timestampNow }).eq("platform_account_id", accountId).neq("effective_status", "ARCHIVED").neq("effective_status", "DELETED").lt("synced_at", timestampNow);
                    await supabase.from("unified_ad_groups").update({ effective_status: 'ARCHIVED', synced_at: timestampNow }).eq("platform_account_id", accountId).neq("effective_status", "ARCHIVED").neq("effective_status", "DELETED").lt("synced_at", timestampNow);
                    await supabase.from("unified_campaigns").update({ effective_status: 'ARCHIVED', synced_at: timestampNow }).eq("platform_account_id", accountId).neq("effective_status", "ARCHIVED").neq("effective_status", "DELETED").lt("synced_at", timestampNow);
                    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
                    await supabase.from("unified_ads").delete().eq("platform_account_id", accountId).in("effective_status", ["ARCHIVED", "DELETED", "UNKNOWN"]).lt("synced_at", thirtyDaysAgo);
                    await supabase.rpc('delete_unused_creatives', { p_account_id: accountId });
                } catch (e: any) {
                    console.error("[AdsSync] Cleanup exception:", e.message);
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

            return jsonResponse({ success: true, data: result });
        } catch (syncErr: any) {
            console.error(`[AdsSync] Inner Error:`, syncErr);
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
        console.error(`[AdsSync] Fatal Error:`, error);
        const status = error.message?.includes("Facebook API Error") || error.message?.includes("FACEBOOK_RATE_LIMIT") ? 200 : 500;
        return jsonResponse({ success: false, error: error.message }, status);
    }
});
