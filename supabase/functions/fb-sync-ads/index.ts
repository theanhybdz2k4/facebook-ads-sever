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

    async getAds(accountId: string): Promise<any[]> {
        let allAds: any[] = [];
        // Removed status filtering to ensure all ads (including paused/deleted) are synced for insights matching
        let url = `${FB_BASE_URL}/${accountId}/ads?fields=id,adset_id,campaign_id,name,status,effective_status,creative,created_time,updated_time,configured_status&limit=1000&access_token=${this.accessToken}`;

        while (url) {
            const res = await fetch(url);
            const data = await res.json();
            if (data.error) throw new Error(`Facebook API Error: ${data.error.message}`);
            if (data.data) allAds = allAds.concat(data.data);
            url = data.paging?.next || null;
        }
        return allAds;
    }

    async getAdCreatives(adIds: string[]): Promise<any[]> {
        const url = new URL(`${FB_BASE_URL}/`);
        url.searchParams.set("access_token", this.accessToken);
        url.searchParams.set("ids", adIds.join(","));
        url.searchParams.set("fields", "id,creative{id,object_story_spec,thumbnail_url,name}");
        const response = await fetch(url.toString());
        const data = await response.json();
        if (data.error) throw new Error(`Facebook API Error: ${data.error.message}`);
        return Object.values(data);
    }
}

const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-client-info, apikey, x-service-key",
};

async function verifyAuth(req: Request) {
    const authHeader = req.headers.get("Authorization");
    const serviceKeyHeader = req.headers.get("x-service-key");
    const masterKey = Deno.env.get("MASTER_KEY") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const authSecret = Deno.env.get("AUTH_SECRET") || "";

    // 1. Try Service Role Key / x-service-key override
    if (serviceKeyHeader === serviceKey || serviceKeyHeader === masterKey) {
        console.log("Auth: Authenticated via service key header");
        return { userId: 1 };
    }

    if (authHeader?.startsWith("Bearer ")) {
        const token = authHeader.substring(7).trim();
        if ((serviceKey !== "" && token === serviceKey) || (masterKey !== "" && token === masterKey) || (authSecret !== "" && token === authSecret)) {
            console.log("Auth: Authenticated via bearer secret token");
            return { userId: 1 };
        }

        // 2. Try JWT Verify first (standard path)
        try {
            const encoder = new TextEncoder();
            const key = await crypto.subtle.importKey("raw", encoder.encode(JWT_SECRET || ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
            const payload = await verify(token, key);

            // Handle both integer (legacy) and UUID (supabase) sub
            const sub = payload.sub as string;
            const userIdNum = parseInt(sub, 10);

            if (!isNaN(userIdNum)) {
                console.log(`Auth: Authenticated via custom JWT (id: ${userIdNum})`);
                return { userId: userIdNum };
            } else {
                console.log(`Auth: Authenticated via Supabase JWT (uuid: ${sub})`);
                return { userId: sub as any };
            }
        } catch (e: any) {
            console.log("Auth: JWT verify failed, checking database:", e.message);
        }

        // 3. Try auth_tokens table (if it exists)
        try {
            const { data: tokenData, error } = await supabase.from("auth_tokens").select("user_id").eq("token", token).single();
            if (tokenData && !error) {
                console.log(`Auth: Authenticated via auth_tokens (id: ${tokenData.user_id})`);
                return { userId: tokenData.user_id };
            }
        } catch (e: any) {
            console.log("Auth: auth_tokens check failed (table might be missing)");
        }
    }

    console.log("Auth: Authentication failed");
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
            .select(`id, external_id, platform_identities!inner (id, platform_credentials (credential_type, credential_value, is_active))`)
            .eq("id", accountId).single();

        if (accountError || !account) return jsonResponse({ success: false, error: "Account not found" }, 404);

        const creds = account.platform_identities?.platform_credentials || [];
        const tokenCred = creds.find((c: any) => c.credential_type === "access_token" && c.is_active);
        if (!tokenCred) return jsonResponse({ success: false, error: "No access token" }, 401);

        const fb = new FacebookApiClient(tokenCred.credential_value);
        const result = { ads: 0, creatives: 0, errors: [] as string[] };

        const { data: adGroups } = await supabase.from("unified_ad_groups").select("id, external_id, start_time, end_time").eq("platform_account_id", accountId).limit(5000);
        const adGroupMap = new Map<string, any>((adGroups || []).map((ag: any) => [ag.external_id, ag]));

        // BATCH SYNC ADS
        const fbAds = await fb.getAds(account.external_id);
        if (fbAds.length > 0) {
            const { data: existingAds } = await supabase.from("unified_ads").select("id, external_id").eq("platform_account_id", accountId).limit(10000);
            const adIdMap = new Map((existingAds || []).map(a => [a.external_id, a.id]));

            const adUpserts = fbAds.map(ad => {
                const adGroup = adGroupMap.get(ad.adset_id);
                if (!adGroup) return null;
                return {
                    id: adIdMap.get(ad.id) || crypto.randomUUID(),
                    external_id: ad.id,
                    platform_account_id: accountId,
                    unified_ad_group_id: adGroup.id,
                    name: ad.name,
                    status: mapStatus(ad.status),
                    effective_status: ad.effective_status,
                    start_time: adGroup.start_time,
                    end_time: adGroup.end_time,
                    platform_data: ad,  // Contains campaign_id for reference
                    synced_at: getVietnamTime(),
                };
            }).filter(Boolean);

            if (adUpserts.length > 0) {
                const { error: adErr } = await supabase.from("unified_ads").upsert(adUpserts as any[], { onConflict: "platform_account_id,external_id" });
                if (adErr) result.errors.push(`Ad Batch Error: ${adErr.message}`);
                else result.ads = adUpserts.length;
            }
        }

        // BATCH SYNC CREATIVES & LINK TO ADS
        const adExternalIds = fbAds.map(a => a.id);
        if (adExternalIds.length > 0) {
            const chunks = [];
            for (let i = 0; i < adExternalIds.length; i += 50) chunks.push(adExternalIds.slice(i, i + 50));

            const creativeToAdMap = new Map<string, string>(); // external_creative_id -> external_ad_id

            for (const chunk of chunks) {
                try {
                    const creativeData = await fb.getAdCreatives(chunk);
                    const creativeUpserts = creativeData.map(item => {
                        const c = item.creative;
                        if (!c) return null;

                        // Link this creative back to the ad for indexing
                        creativeToAdMap.set(c.id, item.id); // item.id is the adExternalId

                        return {
                            external_id: c.id,
                            platform_account_id: accountId,
                            name: c.name || `Creative ${c.id}`,
                            thumbnail_url: c.thumbnail_url || null,
                            platform_data: c,
                            synced_at: getVietnamTime(),
                        };
                    }).filter(Boolean);

                    if (creativeUpserts.length > 0) {
                        const { data: upsertedCreatives, error: creErr } = await supabase
                            .from("unified_ad_creatives")
                            .upsert(creativeUpserts as any[], { onConflict: "platform_account_id,external_id" })
                            .select("id, external_id");

                        if (!creErr && upsertedCreatives) {
                            result.creatives += creativeUpserts.length;

                            // Update ads with their creative IDs
                            const adLinkUpserts = upsertedCreatives.map(c => {
                                const adExtId = creativeToAdMap.get(c.external_id);
                                if (!adExtId) return null;
                                return {
                                    platform_account_id: accountId,
                                    external_id: adExtId,
                                    unified_ad_creative_id: c.id
                                };
                            }).filter(Boolean);

                            if (adLinkUpserts.length > 0) {
                                await supabase.from("unified_ads").upsert(adLinkUpserts as any[], { onConflict: "platform_account_id,external_id" });
                            }
                        }
                    }
                } catch (e: any) { console.error("Creative error", e); }
            }
        }

        // Update account sync timestamp
        await supabase.from("platform_accounts").update({ synced_at: getVietnamTime() }).eq("id", accountId);

        return jsonResponse({ success: true, data: result });
    } catch (error: any) {
        return jsonResponse({ success: false, error: error.message }, 500);
    }
});
