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
        // Use smaller batch size to avoid rate limits
        let url: string | null = FB_BASE_URL + "/" + accountId + "/ads?fields=id,adset_id,campaign_id,name,status,effective_status,creative{id,name,thumbnail_url,image_url},created_time,updated_time,configured_status&limit=200&access_token=" + this.accessToken;

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
const jsonResponse = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: corsHeaders });

function mapStatus(fbStatus: string): string {
    return { ACTIVE: "ACTIVE", PAUSED: "PAUSED", DELETED: "DELETED", ARCHIVED: "ARCHIVED" }[fbStatus] || "UNKNOWN";
}

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

    const auth = await verifyAuth(req);
    if (!auth) return jsonResponse({ success: false, error: "Unauthorized" }, 401);

    try {
        const { accountId } = await req.json();
        if (!accountId) return jsonResponse({ success: false, error: "accountId is required" }, 400);

        const { data: account, error: accountError } = await supabase
            .from("platform_accounts")
            .select("id, external_id, platform_identities!inner (id, user_id, platform_credentials (credential_type, credential_value, is_active))")
            .eq("id", accountId)
            .eq("platform_identities.user_id", auth.userId)
            .maybeSingle();

        if (accountError || !account) return jsonResponse({ success: false, error: "Account not found or access denied" }, 404);

        const creds = account.platform_identities?.platform_credentials || [];
        const tokenCred = creds.find((c: any) => c.credential_type === "access_token" && c.is_active);
        if (!tokenCred) return jsonResponse({ success: false, error: "No access token" }, 401);

        const fb = new FacebookApiClient(tokenCred.credential_value);
        const result = { ads: 0, creatives: 0, campaigns: 0, adGroups: 0, errors: [] as string[] };

        // Load existing entities
        const { data: existingCampaigns } = await supabase.from("unified_campaigns").select("id, external_id").eq("platform_account_id", accountId).limit(5000);
        const campaignMap = new Map<string, string>((existingCampaigns || []).map((c: any) => [c.external_id, c.id]));

        const { data: adGroups } = await supabase.from("unified_ad_groups").select("id, external_id, unified_campaign_id, start_time, end_time").eq("platform_account_id", accountId).limit(5000);
        const adGroupMap = new Map<string, any>((adGroups || []).map((ag: any) => [ag.external_id, ag]));

        // BATCH SYNC ADS & CREATIVES
        const fbAds = await fb.getAds(account.external_id);
        if (fbAds.length > 0) {
            console.log("[AdsSync] Fetched " + fbAds.length + " ads from FB. Checking for missing parent entities...");

            // STEP 0: Find and auto-create missing campaigns & ad_groups
            const missingAdSetIds = new Set<string>();
            const missingCampaignIds = new Set<string>();

            for (const ad of fbAds) {
                if (!adGroupMap.has(ad.adset_id)) {
                    missingAdSetIds.add(ad.adset_id);
                }
                if (!campaignMap.has(ad.campaign_id)) {
                    missingCampaignIds.add(ad.campaign_id);
                }
            }

            console.log("[AdsSync] Found " + missingCampaignIds.size + " missing campaigns, " + missingAdSetIds.size + " missing ad_groups");

            // Fetch and create missing campaigns
            if (missingCampaignIds.size > 0) {
                const campaignUpserts = [];
                for (const campId of missingCampaignIds) {
                    try {
                        const fbCamp = await fb.getCampaign(campId);
                        if (fbCamp && fbCamp.id) {
                            const newId = crypto.randomUUID();
                            campaignUpserts.push({
                                id: newId,
                                external_id: fbCamp.id,
                                platform_account_id: accountId,
                                name: fbCamp.name || "Campaign " + fbCamp.id,
                                objective: fbCamp.objective,
                                status: mapStatus(fbCamp.status),
                                effective_status: fbCamp.effective_status,
                                start_time: fbCamp.start_time || null,
                                end_time: fbCamp.stop_time || null,
                                platform_data: fbCamp,
                                synced_at: getVietnamTime(),
                            });
                            campaignMap.set(fbCamp.id, newId);
                        }
                    } catch (e: any) {
                        console.log("[AdsSync] Failed to fetch campaign " + campId + ": " + e.message);
                    }
                }
                if (campaignUpserts.length > 0) {
                    const { error: campErr } = await supabase.from("unified_campaigns").upsert(campaignUpserts, { onConflict: "platform_account_id,external_id" });
                    if (campErr) result.errors.push("Campaign Auto-Create Error: " + campErr.message);
                    else {
                        result.campaigns = campaignUpserts.length;
                        console.log("[AdsSync] Auto-created " + campaignUpserts.length + " missing campaigns");
                    }
                }
            }

            // Fetch and create missing ad_groups
            if (missingAdSetIds.size > 0) {
                const adGroupUpserts = [];
                for (const adsetId of missingAdSetIds) {
                    try {
                        const fbAdSet = await fb.getAdSet(adsetId);
                        if (fbAdSet && fbAdSet.id) {
                            // Ensure campaign exists
                            let campaignId = campaignMap.get(fbAdSet.campaign_id);
                            if (!campaignId) {
                                // Fetch campaign too if needed
                                try {
                                    const fbCamp = await fb.getCampaign(fbAdSet.campaign_id);
                                    if (fbCamp && fbCamp.id) {
                                        const newCampId = crypto.randomUUID();
                                        await supabase.from("unified_campaigns").upsert({
                                            id: newCampId,
                                            external_id: fbCamp.id,
                                            platform_account_id: accountId,
                                            name: fbCamp.name || "Campaign " + fbCamp.id,
                                            objective: fbCamp.objective,
                                            status: mapStatus(fbCamp.status),
                                            effective_status: fbCamp.effective_status,
                                            platform_data: fbCamp,
                                            synced_at: getVietnamTime(),
                                        }, { onConflict: "platform_account_id,external_id" });
                                        campaignMap.set(fbCamp.id, newCampId);
                                        campaignId = newCampId;
                                        result.campaigns++;
                                    }
                                } catch (ce: any) {
                                    console.log("[AdsSync] Failed to fetch parent campaign for adset " + adsetId + ": " + ce.message);
                                }
                            }

                            if (campaignId) {
                                const newId = crypto.randomUUID();
                                adGroupUpserts.push({
                                    id: newId,
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
                                    synced_at: getVietnamTime(),
                                });
                                adGroupMap.set(fbAdSet.id, { id: newId, start_time: fbAdSet.start_time, end_time: fbAdSet.end_time });
                            }
                        }
                    } catch (e: any) {
                        console.log("[AdsSync] Failed to fetch adset " + adsetId + ": " + e.message);
                    }
                }
                if (adGroupUpserts.length > 0) {
                    const { error: agErr } = await supabase.from("unified_ad_groups").upsert(adGroupUpserts, { onConflict: "platform_account_id,external_id" });
                    if (agErr) result.errors.push("AdGroup Auto-Create Error: " + agErr.message);
                    else {
                        result.adGroups = adGroupUpserts.length;
                        console.log("[AdsSync] Auto-created " + adGroupUpserts.length + " missing ad_groups");
                    }
                }
            }

            // 1. EXTRACT & SYNC UNIQUE CREATIVES FIRST
            const creativeMap = new Map<string, any>();
            fbAds.forEach(ad => {
                if (ad.creative && ad.creative.id) {
                    creativeMap.set(ad.creative.id, ad.creative);
                }
            });

            const uniqueCreatives = Array.from(creativeMap.values());
            const creativeIdMapping = new Map<string, string>(); // External ID -> Internal UUID

            console.log("[AdsSync] Found " + uniqueCreatives.length + " unique creatives from " + fbAds.length + " ads");

            // First fetch existing creatives to preserve IDs for upsert
            const externalIds = uniqueCreatives.map(c => c.id);
            const { data: existingCreatives } = await supabase
                .from("unified_ad_creatives")
                .select("id, external_id")
                .eq("platform_account_id", accountId)
                .in("external_id", externalIds);

            const existingCreativeMap = new Map((existingCreatives || []).map((c: any) => [c.external_id, c.id]));

            if (uniqueCreatives.length > 0) {
                const creativeUpserts = uniqueCreatives.map(c => ({
                    id: existingCreativeMap.get(c.id) || crypto.randomUUID(),
                    external_id: c.id,
                    platform_account_id: accountId,
                    name: c.name || "Creative " + c.id,
                    thumbnail_url: c.thumbnail_url || c.image_url || null,
                    image_url: c.image_url || null,
                    platform_data: c,
                    synced_at: getVietnamTime(),
                }));

                console.log("[AdsSync] Upserting " + creativeUpserts.length + " creatives to DB...");
                const { data: upsertedCreatives, error: creErr } = await supabase
                    .from("unified_ad_creatives")
                    .upsert(creativeUpserts, { onConflict: "platform_account_id,external_id" })
                    .select("id, external_id");

                if (creErr) {
                    console.error("AdsSync Creative Batch Error: " + creErr.message);
                    result.errors.push("Creative Batch Error: " + creErr.message);
                } else if (upsertedCreatives) {
                    console.log("[AdsSync] Successfully upserted " + upsertedCreatives.length + " creatives");
                    upsertedCreatives.forEach((c: any) => creativeIdMapping.set(c.external_id, c.id));
                    result.creatives = upsertedCreatives.length;
                }
            }

            // 2. SYNC ADS (now with linked creative IDs)
            const { data: existingAds } = await supabase.from("unified_ads").select("id, external_id").eq("platform_account_id", accountId).limit(10000);
            const adIdMap = new Map((existingAds || []).map((a: any) => [a.external_id, a.id]));

            const adUpserts = [];
            let skippedAds = 0;
            for (const ad of fbAds) {
                const adGroup = adGroupMap.get(ad.adset_id);
                if (!adGroup) {
                    skippedAds++;
                    continue;
                }

                const internalCreativeId = ad.creative?.id ? creativeIdMapping.get(ad.creative.id) : null;

                adUpserts.push({
                    id: adIdMap.get(ad.id) || crypto.randomUUID(),
                    external_id: ad.id,
                    platform_account_id: accountId,
                    unified_ad_group_id: adGroup.id,
                    unified_ad_creative_id: internalCreativeId,
                    name: ad.name,
                    status: mapStatus(ad.status),
                    effective_status: ad.effective_status,
                    start_time: adGroup.start_time,
                    end_time: adGroup.end_time,
                    platform_data: ad,
                    synced_at: getVietnamTime(),
                });
            }

            if (skippedAds > 0) {
                console.log("[AdsSync] Skipped " + skippedAds + " ads due to missing ad_groups (after auto-create attempt)");
            }

            if (adUpserts.length > 0) {
                console.log("[AdsSync] Upserting " + adUpserts.length + " ads to DB...");
                const { error: adErr } = await supabase.from("unified_ads").upsert(adUpserts as any[], { onConflict: "platform_account_id,external_id" });
                if (adErr) {
                    console.error("AdsSync Ad Batch Error: " + adErr.message);
                    result.errors.push("Ad Batch Error: " + adErr.message);
                } else {
                    console.log("[AdsSync] Successfully upserted " + adUpserts.length + " ads");
                    result.ads = adUpserts.length;
                }
            }
        }

        // Update account sync timestamp
        await supabase.from("platform_accounts").update({ synced_at: getVietnamTime() }).eq("id", accountId);

        return jsonResponse({ success: true, data: result });
    } catch (error: any) {
        return jsonResponse({ success: false, error: error.message }, 500);
    }
});
