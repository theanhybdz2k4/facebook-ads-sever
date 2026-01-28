/**
 * Ads Edge Function - FULL FEATURE COMPATIBILITY
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";
import { verify } from "https://deno.land/x/djwt@v3.0.1/mod.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const JWT_SECRET = Deno.env.get("JWT_SECRET");
const supabase = createClient(supabaseUrl, supabaseKey);

function getVietnamNowISO(): string {
    const vn = new Date(new Date().getTime() + 7 * 60 * 60 * 1000);
    return vn.toISOString().replace('T', ' ').slice(0, 19);
}

const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const jsonResponse = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: corsHeaders });

async function verifyAuth(req: Request) {
    const authHeader = req.headers.get("Authorization");
    const serviceKey = req.headers.get("x-service-key");

    if (serviceKey === supabaseKey) return { userId: 1 };
    if (!authHeader?.startsWith("Bearer ")) return null;

    const token = authHeader.substring(7);
    if (token === Deno.env.get("AUTH_SECRET")) return { userId: 1 };

    const { data: tokenData } = await supabase.from("auth_tokens").select("user_id").eq("token", token).single();
    if (tokenData) return { userId: tokenData.user_id };

    try {
        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey("raw", encoder.encode(JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
        const payload = await verify(token, key);
        const userId = typeof payload.sub === 'string' ? parseInt(payload.sub, 10) : payload.sub;
        return isNaN(userId as any) ? null : { userId: userId as number };
    } catch { return null; }
}

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

    const auth = await verifyAuth(req);
    if (!auth) return jsonResponse({ success: false, error: "Unauthorized" }, 401);

    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter(Boolean);
    const funcIndex = segments.indexOf("ads");
    const subPathSegments = funcIndex !== -1 ? segments.slice(funcIndex + 1) : segments;
    const path = "/" + subPathSegments.join("/");

    try {
        // GET /ads
        if ((path === "/" || path === "") && req.method === "GET") {
            const adId = url.searchParams.get("adId");

            // Single Ad Retrieval via query param (to bypass adblockers)
            if (adId) {
                const { data: ad, error } = await supabase
                    .from("unified_ads")
                    .select(`
                        *,
                        platform_accounts(id, name, currency, platform_identity_id, branch_id),
                        unified_ad_groups(id, name, unified_campaigns(id, name)),
                        unified_ad_creatives(id, thumbnail_url, image_url)
                    `)
                    .eq("id", adId)
                    .single();

                if (error || !ad) return jsonResponse({ success: false, error: "Ad not found" }, 404);

                const creative = Array.isArray(ad.unified_ad_creatives) ? ad.unified_ad_creatives[0] : ad.unified_ad_creatives;
                return jsonResponse({
                    id: ad.id,
                    name: ad.name,
                    status: ad.status,
                    effectiveStatus: ad.effective_status,
                    accountId: ad.platform_account_id,
                    adsetId: ad.unified_ad_group_id,
                    campaignId: ad.unified_ad_groups?.unified_campaigns?.id,
                    syncedAt: ad.synced_at,
                    thumbnailUrl: creative?.thumbnail_url || creative?.image_url || null,
                    account: ad.platform_accounts,
                    adset: ad.unified_ad_groups,
                    campaign: ad.unified_ad_groups?.unified_campaigns
                });
            }

            const adsetId = url.searchParams.get("adsetId") || url.searchParams.get("adGroupId");
            const branchId = url.searchParams.get("branchId");
            const status = url.searchParams.get("effectiveStatus") || url.searchParams.get("status");

            // 1. Get user's authorized platform_identity_ids
            const { data: identities, error: idError } = await supabase
                .from("platform_identities")
                .select("id")
                .eq("user_id", auth.userId);

            if (idError) throw idError;
            const idList = (identities || []).map(i => i.id);
            if (!idList.length) return jsonResponse([]);

            // 2. Fetch ads
            let query = supabase
                .from("unified_ads")
                .select(`
                    id, name, status, effective_status, external_id, start_time, end_time, synced_at, unified_ad_group_id, platform_account_id,
                    platform_accounts!inner(id, branch_id, platform_identity_id),
                    unified_ad_creatives(thumbnail_url, image_url),
                    unified_insights(spend, impressions, clicks, results, date)
                `)
                .in("platform_accounts.platform_identity_id", idList);

            if (adsetId) query = query.eq("unified_ad_group_id", adsetId);
            if (status) query = query.eq("effective_status", status);
            if (branchId && branchId !== "all") {
                query = query.eq("platform_accounts.branch_id", parseInt(branchId));
            }

            // Filter out expired ads (end_time in the past)
            const nowVN = getVietnamNowISO();
            query = query.or(`end_time.is.null,end_time.gte.${nowVN}`);

            const { data, error } = await query.order("name", { ascending: true }).limit(500);
            if (error) throw error;

            const vnNow = new Date(Date.now() + 7 * 3600000);
            const vnTodayStr = vnNow.toISOString().split('T')[0];
            const vnPastStr = new Date(vnNow.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

            const dateStart = url.searchParams.get("dateStart") || vnPastStr;
            const dateEnd = url.searchParams.get("dateEnd") || vnTodayStr;

            const enrichedData = (data || []).map(a => {
                const creative = Array.isArray(a.unified_ad_creatives) ? a.unified_ad_creatives[0] : a.unified_ad_creatives;
                const insightsArr = Array.isArray(a.unified_insights) ? a.unified_insights : [];
                const filteredInsights = insightsArr.filter((i: any) => i.date >= dateStart && i.date <= dateEnd);

                const baseMetrics = filteredInsights.reduce((acc: any, curr: any) => ({
                    spend: acc.spend + (Number(curr.spend) || 0),
                    impressions: acc.impressions + (Number(curr.impressions) || 0),
                    clicks: acc.clicks + (Number(curr.clicks) || 0),
                    results: acc.results + (Number(curr.results) || 0),
                }), { spend: 0, impressions: 0, clicks: 0, results: 0 });

                const metrics = {
                    ...baseMetrics,
                    costPerResult: baseMetrics.results > 0 ? baseMetrics.spend / baseMetrics.results : 0,
                    messagingStarted: baseMetrics.results, // Logic placeholder
                    costPerMessaging: baseMetrics.results > 0 ? baseMetrics.spend / baseMetrics.results : 0
                };

                return {
                    id: a.id,
                    adsetId: a.unified_ad_group_id,
                    externalId: a.external_id,
                    name: a.name,
                    status: a.status,
                    effectiveStatus: a.effective_status,
                    thumbnailUrl: creative?.thumbnail_url || creative?.image_url || null,
                    startTime: a.start_time,
                    endTime: a.end_time,
                    syncedAt: a.synced_at,
                    metrics: metrics,
                    stats: metrics
                };
            });

            return jsonResponse(enrichedData);
        }

        // GET /ads/by-ad-group/:id
        if (path.includes("/by-ad-group/") && req.method === "GET") {
            const adgroupId = path.split("/").pop();
            const { data, error } = await supabase
                .from("unified_ads")
                .select(`id, name, status, effective_status, external_id, start_time, end_time, synced_at, unified_ad_group_id, platform_accounts!inner(platform_identity_id)`)
                .eq("unified_ad_group_id", adgroupId)
                .eq("platform_accounts.platform_identity_id", (await supabase.from("platform_identities").select("id").eq("user_id", auth.userId)).data?.[0]?.id);
            if (error) throw error;
            return jsonResponse(data);
        }

        // POST /ads/sync/account/:id
        if (path.includes("/sync/account/") && req.method === "POST") {
            const accountId = path.split("/").pop();
            const syncResponse = await fetch(`${supabaseUrl}/functions/v1/fb-sync-ads`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${supabaseKey}` },
                body: JSON.stringify({ accountId: parseInt(accountId!) })
            });
            return jsonResponse(await syncResponse.json());
        }

        // GET /ads/:id
        if (subPathSegments.length === 1 && req.method === "GET") {
            const adId = subPathSegments[0];
            const { data: ad, error } = await supabase
                .from("unified_ads")
                .select(`
                    *,
                    platform_accounts(id, name, currency, platform_identity_id, branch_id),
                    unified_ad_groups(id, name, unified_campaigns(id, name)),
                    unified_ad_creatives(id, thumbnail_url, image_url)
                `)
                .eq("id", adId)
                .single();

            if (error || !ad) return jsonResponse({ success: false, error: "Ad not found" }, 404);

            const creative = Array.isArray(ad.unified_ad_creatives) ? ad.unified_ad_creatives[0] : ad.unified_ad_creatives;
            return jsonResponse({
                id: ad.id,
                name: ad.name,
                status: ad.status,
                effectiveStatus: ad.effective_status,
                accountId: ad.platform_account_id,
                adsetId: ad.unified_ad_group_id,
                campaignId: ad.unified_ad_groups?.unified_campaigns?.id,
                startTime: ad.start_time,
                endTime: ad.end_time,
                syncedAt: ad.synced_at,
                thumbnailUrl: creative?.thumbnail_url || creative?.image_url || null,
                account: ad.platform_accounts,
                adset: ad.unified_ad_groups,
                campaign: ad.unified_ad_groups?.unified_campaigns
            });
        }

        return jsonResponse({ success: false, error: "Not Found", path }, 404);
    } catch (error: any) {
        return jsonResponse({ success: false, error: error.message }, 500);
    }
});
