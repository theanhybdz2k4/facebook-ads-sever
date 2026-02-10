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
        // Use smaller batch size (100) because we are expanding fields (campaign, adset)
        let url: string | null = FB_BASE_URL + "/" + accountId + "/ads?fields=id,adset_id,campaign_id,name,status,effective_status,creative{id,name,thumbnail_url,image_url,image_hash,object_story_spec},adset{id,campaign_id,name,status,effective_status,daily_budget,optimization_goal,start_time,end_time},campaign{id,account_id,name,objective,status,effective_status,daily_budget,lifetime_budget,start_time,stop_time},created_time,updated_time,configured_status&limit=100&access_token=" + this.accessToken;

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
        const timestampNow = getVietnamTime();
        const result = { 
            ads: { added: 0, updated: 0, noChange: 0, total: 0 }, 
            creatives: { added: 0, updated: 0, noChange: 0, total: 0, cleanedUp: 0 }, 
            campaigns: 0, 
            adGroups: 0, 
            errors: [] as string[] 
        };

        // Load existing entities
        const { data: existingCampaigns } = await supabase.from("unified_campaigns").select("id, external_id").eq("platform_account_id", accountId).limit(5000);
        const campaignMap = new Map<string, string>((existingCampaigns || []).map((c: any) => [c.external_id, c.id]));

        const { data: adGroups } = await supabase.from("unified_ad_groups").select("id, external_id, unified_campaign_id, start_time, end_time").eq("platform_account_id", accountId).limit(5000);
        const adGroupMap = new Map<string, any>((adGroups || []).map((ag: any) => [ag.external_id, ag]));

        // BATCH SYNC ADS & CREATIVES
        let fetchedAds = await fb.getAds(account.external_id);
        
        // Keep all ads to update their status (ACTIVE -> PAUSED/ARCHIVED)
        // We only skip detailed creative fetching for non-active ones to save resources
        const fbAds = fetchedAds;
        console.log(`[AdsSync] Processing ${fbAds.length} ads total (including ARCHIVED/DELETED for status updates)`);

        if (fbAds.length > 0) {
            console.log("[AdsSync] Extracting parent entities and creatives...");

            // STEP 0: Extract campaigns & ad_groups from expanded ad objects
            const campaignDataMap = new Map<string, any>();
            const adSetDataMap = new Map<string, any>();

            for (const ad of fbAds) {
                if (ad.campaign && ad.campaign.id && !campaignMap.has(ad.campaign.id)) {
                    campaignDataMap.set(ad.campaign.id, ad.campaign);
                }
                if (ad.adset && ad.adset.id && !adGroupMap.has(ad.adset.id)) {
                    adSetDataMap.set(ad.adset.id, ad.adset);
                }
            }

            // Sync missing campaigns
            if (campaignDataMap.size > 0) {
                const campaignUpserts = Array.from(campaignDataMap.values()).map(fbCamp => {
                    const newId = crypto.randomUUID();
                    campaignMap.set(fbCamp.id, newId);
                    return {
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
                        synced_at: timestampNow,
                    };
                });
                const { error: campErr } = await supabase.from("unified_campaigns").upsert(campaignUpserts, { onConflict: "platform_account_id,external_id" });
                if (campErr) result.errors.push("Campaign Auto-Create Error: " + campErr.message);
                else result.campaigns = campaignUpserts.length;
            }

            // Sync missing ad_groups
            if (adSetDataMap.size > 0) {
                const adGroupUpserts = [];
                for (const fbAdSet of adSetDataMap.values()) {
                    let campaignId = campaignMap.get(fbAdSet.campaign_id);
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
                            synced_at: timestampNow,
                        });
                        adGroupMap.set(fbAdSet.id, { id: newId, start_time: fbAdSet.start_time, end_time: fbAdSet.end_time });
                    }
                }
                if (adGroupUpserts.length > 0) {
                    const { error: agErr } = await supabase.from("unified_ad_groups").upsert(adGroupUpserts, { onConflict: "platform_account_id,external_id" });
                    if (agErr) result.errors.push("AdGroup Auto-Create Error: " + agErr.message);
                    else result.adGroups = adGroupUpserts.length;
                }
            }

            // 1. EXTRACT & SYNC UNIQUE CREATIVES
            // Optimization: Only sync the creative object if the ad is ACTIVE, or if we don't have it yet.
            const creativeIdMapping = new Map<string, string>(); // External ID -> Internal UUID
            
            // Get existing creatives for comparison
            const { data: currentCreatives } = await supabase
                .from("unified_ad_creatives")
                .select("id, external_id, name, image_url, thumbnail_url") // FETCH ONLY NEEDED FIELDS
                .eq("platform_account_id", accountId);
            
            const existingCreativeDataMap = new Map<string, any>((currentCreatives || []).map((c: any) => [c.external_id, c]));
            (currentCreatives || []).forEach((c: any) => creativeIdMapping.set(c.external_id, c.id));

            const creativeMap = new Map<string, any>();
            fbAds.forEach((ad: any) => {
                if (ad.creative && ad.creative.id) {
                    const hasExisting = creativeIdMapping.has(ad.creative.id);
                    const isActive = ad.effective_status === 'ACTIVE';
                    
                    // Only put in map to refresh/create if it's ACTIVE or MISSING
                    if (isActive || !hasExisting) {
                        creativeMap.set(ad.creative.id, ad.creative);
                    }
                }
            });

            const uniqueCreativesToUpsert = Array.from(creativeMap.values());
            if (uniqueCreativesToUpsert.length > 0) {
                const creativeUpserts = [];
                for (const c of uniqueCreativesToUpsert) {
                    const existing = existingCreativeDataMap.get(c.id);
                    
                    // Fix missing image: Use multiple sources
                    let imageUrl = c.image_url || c.thumbnail_url || null;
                    if (!imageUrl && c.image_hash) {
                         imageUrl = `https://graph.facebook.com/v24.0/${c.image_hash}/picture`;
                    }
                    if (!imageUrl && c.object_story_spec?.link_data?.image_hash) {
                         imageUrl = `https://graph.facebook.com/v24.0/${c.object_story_spec.link_data.image_hash}/picture`;
                    }

                    // CRITICAL OPTIMIZATION: Trim platform_data to save space
                    // Only keep what's needed for display and lead-sync mapping
                    const trimmedPlatformData = {
                        id: c.id,
                        name: c.name,
                        thumbnail_url: c.thumbnail_url,
                        image_url: c.image_url,
                        page_id: c.object_story_spec?.page_id || c.page_id,
                        object_story_spec: c.object_story_spec ? { page_id: c.object_story_spec.page_id } : undefined
                    };

                    const newData = {
                        id: existing?.id || crypto.randomUUID(),
                        external_id: c.id,
                        platform_account_id: accountId,
                        name: c.name || "Creative " + c.id,
                        thumbnail_url: c.thumbnail_url || imageUrl || null,
                        image_url: imageUrl,
                        platform_data: trimmedPlatformData, // USE TRIMMED DATA
                        synced_at: timestampNow,
                    };

                    if (!existing) {
                        creativeUpserts.push(newData);
                        result.creatives.added++;
                    } else if (!isEquivalent(existing, newData, ['name', 'image_url', 'thumbnail_url'])) {
                        creativeUpserts.push(newData);
                        result.creatives.updated++;
                    } else {
                        result.creatives.noChange++;
                    }
                }

                if (creativeUpserts.length > 0) {
                    // Split into chunks if too many
                    const chunks = [];
                    for (let i = 0; i < creativeUpserts.length; i += 100) chunks.push(creativeUpserts.slice(i, i + 100));
                    
                    for (const chunk of chunks) {
                        const { data: upsertedCreatives, error: creErr } = await supabase
                            .from("unified_ad_creatives")
                            .upsert(chunk, { onConflict: "platform_account_id,external_id" })
                            .select("id, external_id");

                        if (!creErr && upsertedCreatives) {
                            upsertedCreatives.forEach((c: any) => creativeIdMapping.set(c.external_id, c.id));
                        } else if (creErr) {
                            result.errors.push("Creative Batch Error: " + creErr.message);
                        }
                    }
                }
            }
            result.creatives.total = creativeIdMapping.size;

            // 2. SYNC ADS
            const { data: currentAds } = await supabase.from("unified_ads").select("id, external_id, name, status, effective_status, unified_ad_creative_id").eq("platform_account_id", accountId).limit(10000);
            const existingAdDataMap = new Map<string, any>((currentAds || []).map((a: any) => [a.external_id, a]));

            const adUpserts = [];

            for (const ad of fbAds) {
                const adGroup = adGroupMap.get(ad.adset_id);
                if (!adGroup) continue;

                const internalCreativeId = ad.creative?.id ? creativeIdMapping.get(ad.creative.id) : null;
                const existing = existingAdDataMap.get(ad.id);

                // Optimization: Skip upserting platform_data for ARCHIVED ads if not changed
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

                // Only store platform_data for non-archived or new ads to save space
                if (!isArchived || !existing) {
                    // Tràng platform_data: Remove expanded objects before saving to ad
                    const trimmedAd = { ...ad };
                    delete trimmedAd.adset;
                    delete trimmedAd.campaign;
                    newData.platform_data = trimmedAd;
                }

                if (!existing) {
                    adUpserts.push(newData);
                    result.ads.added++;
                } else if (!isEquivalent(existing, newData, ['name', 'status', 'effective_status', 'unified_ad_creative_id'])) {
                    adUpserts.push(newData);
                    result.ads.updated++;
                } else {
                    // Update ONLY synced_at to keep DB lightweight
                    // Must include conflict keys for the upsert to match correctly
                    adUpserts.push({ 
                        id: existing.id, 
                        platform_account_id: accountId,
                        external_id: ad.id,
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

            // 3. AUTO-CLEANUP: 
            // Phase A: Mark ads that were NOT returned by FB as ARCHIVED
            // We know they weren't returned because we fetched ALL ads for the account, and these weren't in the fbAds list (so they weren't matched and updated above)
            try {
                const { data: updatedAds, error: adStatusErr } = await supabase
                    .from("unified_ads")
                    .update({ effective_status: 'ARCHIVED', synced_at: timestampNow })
                    .eq("platform_account_id", accountId)
                    .neq("effective_status", "ARCHIVED")
                    .neq("effective_status", "DELETED")
                    .lt("synced_at", timestampNow)
                    .select("id");
                
                if (adStatusErr) {
                    console.error("[AdsSync] Ad status cleanup error:", adStatusErr.message);
                } else if (updatedAds && updatedAds.length > 0) {
                    console.log(`[AdsSync] Marked ${updatedAds.length} stale ads as ARCHIVED for account ${accountId}`);
                }

                // Phase B: Mark ad groups that were not synced as ARCHIVED
                const { error: agStatusErr } = await supabase
                    .from("unified_ad_groups")
                    .update({ effective_status: 'ARCHIVED', synced_at: timestampNow })
                    .eq("platform_account_id", accountId)
                    .neq("effective_status", "ARCHIVED")
                    .neq("effective_status", "DELETED")
                    .lt("synced_at", timestampNow);
                
                if (agStatusErr) console.error("[AdsSync] AdGroup status cleanup error:", agStatusErr.message);

                // Phase C: Mark campaigns that were not synced as ARCHIVED
                const { error: campStatusErr } = await supabase
                    .from("unified_campaigns")
                    .update({ effective_status: 'ARCHIVED', synced_at: timestampNow })
                    .eq("platform_account_id", accountId)
                    .neq("effective_status", "ARCHIVED")
                    .neq("effective_status", "DELETED")
                    .lt("synced_at", timestampNow);
                
                if (campStatusErr) console.error("[AdsSync] Campaign status cleanup error:", campStatusErr.message);

                // Phase D: Delete archived/deleted ads that haven't been synced in over 30 days
                const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
                const { error: adCleanupErr } = await supabase
                    .from("unified_ads")
                    .delete()
                    .eq("platform_account_id", accountId)
                    .in("effective_status", ["ARCHIVED", "DELETED", "UNKNOWN"])
                    .lt("synced_at", thirtyDaysAgo);
                
                if (adCleanupErr) console.error("[AdsSync] Stale ad deletion error:", adCleanupErr.message);

                // Phase E: Call the RPC to delete creatives that are no longer referenced by ANY ad
                const { data: cleanedCount, error: cleanupErr } = await supabase.rpc('delete_unused_creatives', { p_account_id: accountId });
                if (!cleanupErr) {
                    result.creatives.cleanedUp = cleanedCount || 0;
                    if (cleanedCount > 0) console.log(`[AdsSync] Cleaned up ${cleanedCount} unused creatives for account ${accountId}`);
                } else {
                    console.error("[AdsSync] Creative cleanup RPC error:", cleanupErr.message);
                }
            } catch (e: any) {
                console.error("[AdsSync] Cleanup exception:", e.message);
            }

        }

        await supabase.from("platform_accounts").update({ synced_at: timestampNow }).eq("id", accountId);
        return jsonResponse({ success: true, data: result });
    } catch (error: any) {
        return jsonResponse({ success: false, error: error.message }, 500);
    }
});
