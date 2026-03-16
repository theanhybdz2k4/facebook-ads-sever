import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";
import { verify } from "https://deno.land/x/djwt@v3.0.1/mod.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const supabase = createClient(supabaseUrl, supabaseKey);

const FB_BASE_URL = "https://graph.facebook.com/v19.0";

const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-client-info, apikey, x-service-key",
};

// CRITICAL:// Robust Auth Logic (DB-Only: auth_tokens & refresh_tokens)
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

async function fbRequest(endpoint: string, token: string, params: Record<string, string> = {}) {
    const url = new URL(`${FB_BASE_URL}${endpoint}`);
    url.searchParams.set("access_token", token);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url.toString());
    return res.json();
}

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

    const auth = await verifyAuth(req);
    if (!auth) return jsonResponse({ success: false, error: "Unauthorized" }, 401);

    try {
        const { accountId, adIds } = await req.json();
        if (!accountId && (!adIds || adIds.length === 0)) return jsonResponse({ error: "No account or ads provided" }, 400);

        // 1. Get account and credentials WITH OWNERSHIP CHECK
        let query = supabase
            .from("platform_accounts")
            .select("*, platforms(code), platform_identities(user_id, platform_credentials(*))")
            .eq("id", accountId || 0);

        if (auth.userId !== 1) {
            query = query.eq("platform_identities.user_id", auth.userId);
        }

        const { data: account, error: accountError } = await query.maybeSingle();
        if (accountError || !account) return jsonResponse({ error: "Account not found or access denied" }, 404);

        // Extract token safely (handling join structure)
        const identity = Array.isArray(account.platform_identities) ? account.platform_identities[0] : account.platform_identities;
        const creds = identity?.platform_credentials || [];
        const token = (Array.isArray(creds) ? creds : [creds]).find((c: any) => c.credential_type === "access_token" && c.is_active)?.credential_value;

        if (!token) throw new Error("Token not found or inactive");

        // 2. Identify ads to sync
        let adsToSync = [];
        if (adIds?.length) {
            const { data } = await supabase.from("unified_ads").select("id, external_id").in("id", adIds).eq("platform_account_id", account.id);
            adsToSync = data || [];
        } else {
            const { data } = await supabase.from("unified_ads").select("id, external_id").eq("platform_account_id", account.id).eq("effective_status", "ACTIVE");
            adsToSync = data || [];
        }

        if (adsToSync.length === 0) return jsonResponse({ success: true, count: 0 });

        // 3. Fetch from FB (Chunked)
        const chunkSize = 50;
        const results = [];
        for (let i = 0; i < adsToSync.length; i += chunkSize) {
            const chunk = adsToSync.slice(i, i + chunkSize);
            const ids = chunk.map(a => a.external_id).join(",");
            const fbRes = await fbRequest("", token, { ids, fields: "id,creative{id,name,object_story_spec,asset_feed_spec,image_url,thumbnail_url,image_hash}" });
            results.push(fbRes);
        }

        const rawCreatives = [];
        const adToCreative = [];

        for (const resBatch of results) {
            for (const adExtId in resBatch) {
                const creative = resBatch[adExtId].creative;
                if (!creative) continue;

                const spec = creative.object_story_spec || {};
                const assetFeed = creative.asset_feed_spec || {};
                const thumbnailUrl = creative.thumbnail_url ||
                    spec.link_data?.picture ||
                    spec.video_data?.image_url ||
                    (assetFeed.images && assetFeed.images[0]?.url) ||
                    (creative.image_hash ? `https://graph.facebook.com/v19.0/${creative.image_hash}/thumbnails` : null);

                rawCreatives.push({
                    platform_account_id: account.id,
                    external_id: creative.id,
                    name: creative.name,
                    image_url: creative.image_url || thumbnailUrl,
                    thumbnail_url: thumbnailUrl,
                    platform_data: creative,
                    synced_at: new Date().toISOString()
                });

                const internalAdId = adsToSync.find(a => a.external_id === adExtId)?.id;
                if (internalAdId) adToCreative.push({ ad_id: internalAdId, creative_ext_id: creative.id });
            }
        }

        // 4. Batch Upsert Creatives
        if (rawCreatives.length > 0) {
            const { data: upsertedCreatives } = await supabase.from("unified_ad_creatives").upsert(rawCreatives, { onConflict: "platform_account_id,external_id" }).select();

            // 5. Link Ads to Creatives
            const adsUpdates = adToCreative.map(item => {
                const creative = upsertedCreatives?.find(c => c.external_id === item.creative_ext_id);
                return {
                    id: item.ad_id,
                    unified_ad_creative_id: creative?.id,
                    synced_at: new Date().toISOString()
                };
            }).filter(u => u.unified_ad_creative_id);

            if (adsUpdates.length > 0) {
                await supabase.from("unified_ads").upsert(adsUpdates);
            }
        }

        return jsonResponse({ success: true, creativesFetched: rawCreatives.length, adsLinked: adToCreative.length });
    } catch (error: any) {
        return jsonResponse({ error: error.message }, 500);
    }
});
