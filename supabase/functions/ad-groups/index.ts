/**
 * Ad-Groups Edge Function - FULL FEATURE COMPATIBILITY
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";
import { verify } from "https://deno.land/x/djwt@v3.0.1/mod.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const JWT_SECRET = Deno.env.get("JWT_SECRET") || "your-secret-key";
const supabase = createClient(supabaseUrl, supabaseKey);

const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const jsonResponse = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: corsHeaders });

async function verifyAuth(req: Request) {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return null;
    const token = authHeader.substring(7);
    try {
        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey("raw", encoder.encode(JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
        const payload = await verify(token, key);
        const userId = parseInt(payload.sub as string, 10);
        return isNaN(userId) ? null : { userId };
    } catch { return null; }
}

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

    const auth = await verifyAuth(req);
    if (!auth) return jsonResponse({ success: false, error: "Unauthorized" }, 401);

    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter(Boolean);
    const funcIndex = segments.indexOf("ad-groups");
    const subPathSegments = funcIndex !== -1 ? segments.slice(funcIndex + 1) : segments;
    const path = "/" + subPathSegments.join("/");

    try {
        // GET /ad-groups
        if ((path === "/" || path === "") && req.method === "GET") {
            const campaignId = url.searchParams.get("campaignId");
            const accountId = url.searchParams.get("accountId");
            const status = url.searchParams.get("effectiveStatus");
            const branchId = url.searchParams.get("branchId");

            let query = supabase
                .from("unified_ad_groups")
                .select(`
                    id, external_id, name, status, effective_status, daily_budget, synced_at, unified_campaign_id,
                    unified_campaigns!inner(id, name, platform_account_id, platform_accounts!inner(id, branch_id, platform_identities!inner(user_id))),
                    unified_insights(spend, impressions, clicks, results, date)
                `)
                .eq("unified_campaigns.platform_accounts.platform_identities.user_id", auth.userId);

            if (campaignId) query = query.eq("unified_campaign_id", campaignId);
            if (accountId) query = query.eq("unified_campaigns.platform_account_id", parseInt(accountId));
            if (status) query = query.eq("effective_status", status);
            if (branchId && branchId !== "all") query = query.eq("unified_campaigns.platform_accounts.branch_id", parseInt(branchId));

            const { data, error } = await query.order("name", { ascending: true }).limit(500);
            if (error) throw error;

            const vnNow = new Date(Date.now() + 7 * 3600000);
            const dateTodayVn = vnNow.toISOString().split('T')[0];
            const datePastVn = new Date(vnNow.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

            const dateStart = url.searchParams.get("dateStart") || datePastVn;
            const dateEnd = url.searchParams.get("dateEnd") || dateTodayVn;

            const optimizedData = (data || []).map((s: any) => {
                const insights = Array.isArray(s.unified_insights) ? s.unified_insights : [];
                const filteredInsights = insights.filter((i: any) => i.date >= dateStart && i.date <= dateEnd);

                const stats = filteredInsights.reduce((acc: any, curr: any) => ({
                    spend: acc.spend + (Number(curr.spend) || 0),
                    impressions: acc.impressions + (Number(curr.impressions) || 0),
                    clicks: acc.clicks + (Number(curr.clicks) || 0),
                    results: acc.results + (Number(curr.results) || 0),
                }), { spend: 0, impressions: 0, clicks: 0, results: 0 });

                return {
                    id: s.id,
                    campaignId: s.unified_campaign_id,
                    externalId: s.external_id,
                    name: s.name,
                    status: s.status,
                    effectiveStatus: s.effective_status,
                    dailyBudget: s.daily_budget,
                    syncedAt: s.synced_at,
                    campaign: { id: s.unified_campaigns.id, name: s.unified_campaigns.name },
                    stats: stats
                };
            });

            return jsonResponse(optimizedData);
        }

        // GET /ad-groups/by-campaign/:id
        if (path.includes("/by-campaign/") && req.method === "GET") {
            const campaignId = path.split("/").pop();
            const { data, error } = await supabase
                .from("unified_ad_groups")
                .select(`id, name, status, effective_status, external_id, unified_campaign_id`)
                .eq("unified_campaign_id", campaignId);
            if (error) throw error;
            return jsonResponse(data);
        }

        // GET /ad-groups/:id
        if (subPathSegments.length === 1 && req.method === "GET") {
            const adgroupId = subPathSegments[0];
            const { data, error } = await supabase
                .from("unified_ad_groups")
                .select(`
                    id, external_id, name, status, effective_status, daily_budget, synced_at, unified_campaign_id,
                    unified_campaigns!inner(id, name, platform_accounts!inner(id, platform_identities!inner(user_id)))
                `)
                .eq("id", adgroupId)
                .eq("unified_campaigns.platform_accounts.platform_identities.user_id", auth.userId) // Consider relaxing this like other detail views if needed
                .single();

            if (error || !data) return jsonResponse({ success: false, error: "Ad Group not found" }, 404);

            return jsonResponse({
                id: data.id,
                name: data.name,
                status: data.status,
                effectiveStatus: data.effective_status,
                campaignId: data.unified_campaign_id,
                campaign: data.unified_campaigns
            });
        }

        // POST /ad-groups/sync/account/:id (reuses campaigns sync)
        if (path.includes("/sync/account/") && req.method === "POST") {
            const accountId = path.split("/").pop();
            const syncResponse = await fetch(`${supabaseUrl}/functions/v1/fb-sync-campaigns`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${supabaseKey}` },
                body: JSON.stringify({ accountId: parseInt(accountId!) })
            });
            return jsonResponse(await syncResponse.json());
        }

        return jsonResponse({ success: false, error: `Route Not Found: ${req.method} ${path}` }, 404);
    } catch (error: any) {
        return jsonResponse({ success: false, error: error.message }, 500);
    }
});
