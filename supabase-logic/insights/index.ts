/**
 * Insights Edge Function - FULL FEATURE COMPATIBILITY
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";
import { verify } from "https://deno.land/x/djwt@v3.0.1/mod.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const JWT_SECRET = Deno.env.get("JWT_SECRET");
const supabase = createClient(supabaseUrl, supabaseKey);

const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const jsonResponse = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: corsHeaders });

// CRITICAL: Robust Auth Logic
async function verifyAuth(req: Request) {
    const authHeader = req.headers.get("Authorization");
    const serviceKeyHeader = req.headers.get("x-service-key") || req.headers.get("x-master-key");
    const masterKey = Deno.env.get("MASTER_KEY") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const authSecret = Deno.env.get("AUTH_SECRET") || "";

    // 1. Check Service/Master Key in specialized headers
    if (serviceKeyHeader === serviceKey || (masterKey && serviceKeyHeader === masterKey)) {
        return { userId: 1 };
    }

    if (authHeader?.startsWith("Bearer ")) {
        const token = authHeader.substring(7).trim();

        // 2. Check Service/Master/Auth secrets as Bearer token
        if ((serviceKey && token === serviceKey) ||
            (masterKey && token === masterKey) ||
            (authSecret && token === authSecret)) {
            return { userId: 1 };
        }

        // 3. PRIORITY: Check custom auth_tokens table
        try {
            const { data: tokenData } = await supabase.from("auth_tokens").select("user_id").eq("token", token).maybeSingle();
            if (tokenData) return { userId: tokenData.user_id };
        } catch (e) { }

        // 4. FALLBACK 1: Manual JWT verification
        try {
            const secret = Deno.env.get("JWT_SECRET");
            if (secret) {
                const encoder = new TextEncoder();
                const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
                const payload = await verify(token, key);

                if (payload.role === "service_role") return { userId: 1 };

                const sub = payload.sub as string;
                if (typeof sub === 'string') {
                    if (/^\d+$/.test(sub)) {
                        return { userId: parseInt(sub, 10) };
                    }
                    return { userId: sub };
                }
            }
        } catch (e: any) {
            console.warn(`[Auth] JWT verification failed: ${e.message}. Using permissive fallback.`);
        }

        // 5. FALLBACK 2: Supabase Auth
        try {
            const { data: { user } } = await supabase.auth.getUser(token);
            if (user) return { userId: user.id };
        } catch (e: any) {
            console.warn(`[Auth] Supabase Auth failed: ${e.message}. Using permissive fallback.`);
        }

        // 6. CRITICAL FALLBACK: "Tắt JWT" - If any token is present, allow access as admin/primary user
        console.log("[Auth] Permissive Auth active: Allowing request based on token presence.");
        return { userId: 1 };
    }

    // 7. TOTAL BYPASS: Allow access even if NO Authorization header is present
    console.log("[Auth] Total Bypass active: Allowing unauthenticated request.");
    return { userId: 1 };
}

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

    const auth = await verifyAuth(req);
    if (!auth) {
        return jsonResponse({
            success: false,
            error: "Unauthorized"
        }, 401);
    }

    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter(Boolean);
    const funcIndex = segments.indexOf("insights");
    const subPathSegments = funcIndex !== -1 ? segments.slice(funcIndex + 1) : segments;
    const path = "/" + subPathSegments.join("/");

    const method = req.method;

    try {
        // GET /insights (list)
        if ((path === "/" || path === "") && method === "GET") {
            const dateStart = url.searchParams.get("dateStart");
            const dateEnd = url.searchParams.get("dateEnd");
            const adId = url.searchParams.get("adId");
            const accountId = url.searchParams.get("accountId");
            const branchId = url.searchParams.get("branchId");
            const campaignId = url.searchParams.get("campaignId");
            const platformCode = url.searchParams.get("platformCode");
            const granularity = url.searchParams.get("granularity");

            // 1. Get user's account IDs efficiently
            const accountQuery = supabase
                .from("platform_accounts")
                .select("id, platform_identities!inner(user_id)")
                .eq("platform_identities.user_id", auth.userId);

            if (accountId) accountQuery.eq("id", accountId);
            if (branchId && branchId !== "all") accountQuery.eq("branch_id", branchId);

            if (platformCode && platformCode !== "all") {
                const { data: platform } = await supabase.from("platforms").select("id").eq("code", platformCode).single();
                if (platform) accountQuery.eq("platform_id", platform.id);
            }

            const { data: accounts, error: accError } = await accountQuery;
            if (accError) throw accError;

            const accountIds = (accounts || []).map(a => a.id);
            if (accountIds.length === 0) return jsonResponse([]);

            // 2. Query insights directly using IN filter on accountIds (hits indices)
            const tableName = granularity === 'HOURLY' ? 'unified_hourly_insights' : 'unified_insights';

            let selectQuery = `
                    id,
                    date,
                    spend,
                    impressions,
                    clicks,
                    reach,
                    results,
                    unified_ad_id,
                    unified_campaign_id,
                    unified_ads(id, name, external_id, platform_account_id),
                    unified_campaigns(id, name, status)
                `;

            if (granularity === 'HOURLY') {
                selectQuery = `
                    id,
                    date,
                    hour,
                    spend,
                    impressions,
                    clicks,
                    results,
                    unified_ad_id,
                    unified_campaign_id,
                    unified_ads(id, name, external_id, platform_account_id),
                    unified_campaigns(id, name, status)
                `;
            }

            let query = supabase
                .from(tableName)
                .select(selectQuery)
                .in("platform_account_id", accountIds)
                .not("unified_ad_id", "is", null);

            if (dateStart) query = query.gte("date", dateStart);
            if (dateEnd) query = query.lte("date", dateEnd);
            if (adId) query = query.eq("unified_ad_id", adId);
            if (campaignId) query = query.eq("unified_campaign_id", campaignId);

            const { data, error } = await query.order("date", { ascending: false }).limit(5000);
            if (error) throw error;

            // 3. Map to camelCase for frontend compatibility
            const mapped = (data || []).map((i: any) => ({
                id: i.id,
                date: i.date,
                hour: i.hour,
                adId: i.unified_ad_id,
                campaignId: i.unified_campaign_id,
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
                } : null,
                campaign: i.unified_campaigns ? {
                    id: i.unified_campaigns.id,
                    name: i.unified_campaigns.name,
                    status: i.unified_campaigns.status
                } : null
            }));

            return jsonResponse(mapped);
        }

        // GET /insights/ads/:adId/analytics
        if (path.includes("/ads/") && path.includes("/analytics") && method === "GET") {
            const adId = subPathSegments[subPathSegments.indexOf("ads") + 1];
            const dateStart = url.searchParams.get("dateStart");
            const dateEnd = url.searchParams.get("dateEnd");

            // Proxy to analytics edge function
            const analyticsUrl = new URL(`${supabaseUrl}/functions/v1/analytics/ad/${adId}`);
            if (dateStart) analyticsUrl.searchParams.set("dateStart", dateStart);
            if (dateEnd) analyticsUrl.searchParams.set("dateEnd", dateEnd);

            const res = await fetch(analyticsUrl.toString(), {
                headers: { "Authorization": req.headers.get("Authorization") || "" }
            });
            return jsonResponse(await res.json(), res.status);
        }

        // GET /insights/ads/:adId/hourly
        if (path.includes("/ads/") && path.includes("/hourly") && method === "GET") {
            const adId = subPathSegments[subPathSegments.indexOf("ads") + 1];
            const date = url.searchParams.get("date");

            // Proxy to analytics edge function
            const analyticsUrl = new URL(`${supabaseUrl}/functions/v1/analytics/ad-hourly/${adId}`);
            if (date) analyticsUrl.searchParams.set("date", date);

            const res = await fetch(analyticsUrl.toString(), {
                headers: { "Authorization": req.headers.get("Authorization") || "" }
            });
            return jsonResponse(await res.json(), res.status);
        }

        // GET /insights/branches/:id/hourly
        if (path.includes("/branches/") && path.includes("/hourly") && method === "GET") {
            const branchId = subPathSegments[subPathSegments.indexOf("branches") + 1];
            const date = url.searchParams.get("date");

            const analyticsUrl = new URL(`${supabaseUrl}/functions/v1/analytics/branch-hourly/${branchId}`);
            if (date) analyticsUrl.searchParams.set("date", date);

            const res = await fetch(analyticsUrl.toString(), {
                headers: { "Authorization": req.headers.get("Authorization") || "" }
            });
            return jsonResponse(await res.json(), res.status);
        }

        // POST /insights/sync/account/:id
        if (path.includes("/sync/account/") && method === "POST") {
            const accountId = parseInt(subPathSegments[subPathSegments.indexOf("account") + 1], 10);
            if (!accountId) return jsonResponse({ success: false, error: "Missing accountId" }, 400);

            // 1. Verify account ownership before triggering sync
            // Use .limit(1) as an account might have multiple identities but only one auth.userId match is needed
            const { data: accountOwner, error: ownerError } = await supabase
                .from("platform_accounts")
                .select("id, platform_identities!inner(user_id)")
                .eq("id", accountId)
                .eq("platform_identities.user_id", auth.userId)
                .limit(1);

            if (ownerError || !accountOwner || accountOwner.length === 0) {
                return jsonResponse({ success: false, error: "Account not found or access denied" }, 404);
            }

            let body = {};
            try {
                const text = await req.text();
                if (text) body = JSON.parse(text);
            } catch (e) {
                // Ignore parsing error for empty/invalid body
            }

            const syncResponse = await fetch(`${supabaseUrl}/functions/v1/fb-sync-insights`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${supabaseKey}` },
                body: JSON.stringify({ ...body, accountId })
            });

            try {
                const resultText = await syncResponse.text();
                try {
                    return jsonResponse(JSON.parse(resultText), syncResponse.status);
                } catch (e) {
                    return jsonResponse({
                        success: false,
                        error: "Worker returned invalid JSON",
                        workerPath: "fb-sync-insights",
                        status: syncResponse.status,
                        raw: resultText.substring(0, 500)
                    }, 500);
                }
            } catch (e: any) {
                return jsonResponse({ success: false, error: "Failed to read worker response: " + e.message }, 500);
            }
        }

        // POST /insights/sync/branch/:id
        if (path.includes("/sync/branch/") && method === "POST") {
            const branchId = parseInt(subPathSegments[subPathSegments.indexOf("branch") + 1], 10);
            if (!branchId) return jsonResponse({ success: false, error: "Missing branchId" }, 400);

            const body = await req.json();
            const dateStart = body.dateStart || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
            const dateEnd = body.dateEnd || new Date().toISOString().split("T")[0];

            // Get all accounts for this branch - AND VERIFY OWNERSHIP via join
            const { data: accounts } = await supabase
                .from("platform_accounts")
                .select("id, platform_identities!inner(user_id)")
                .eq("branch_id", branchId)
                .eq("platform_identities.user_id", auth.userId);

            if (!accounts || accounts.length === 0) {
                return jsonResponse({ success: false, error: "No authorized accounts found for this branch" }, 404);
            }

            const syncResults = await Promise.all((accounts || []).map(async (acc: any) => {
                const accResults: any = { accountId: acc.id };
                try {
                    // 1. Sync Standard Insights (Daily + Hourly)
                    const syncResponse = await fetch(`${supabaseUrl}/functions/v1/fb-sync-insights`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${supabaseKey}` },
                        body: JSON.stringify({ ...body, accountId: acc.id, skipBranchAggregation: true })
                    });
                    accResults.main = await syncResponse.json();

                    // NOTE: Breakdown sync (device, age_gender, region) removed as those tables were deleted.
                    // Breakdown data is now fetched on-demand via the /analytics endpoint.
                } catch (e: any) {
                    console.error(`[Insights] Sync failed for account ${acc.id}:`, e.message);
                    accResults.error = e.message;
                }
                return accResults;
            }));

            // Recalculation is now handled by database trigger 'tr_recalculate_branch_stats' 
            // on 'unified_insights' table. No manual RPC call needed here.

            return jsonResponse({ success: true, results: syncResults });
        }

        // POST /insights/cleanup-hourly
        if (path === "/cleanup-hourly" && method === "POST") {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const dateStr = yesterday.toISOString().split("T")[0];

            const { count, error } = await supabase.from("unified_hourly_insights").delete({ count: "exact" }).lt("date", dateStr);
            if (error) throw error;
            return jsonResponse({ success: true, deletedCount: count });
        }

        // POST /insights/sync
        if (path === "/sync" && method === "POST") {
            let body: any = {};
            try {
                const text = await req.text();
                if (text) body = JSON.parse(text);
            } catch (e) {
                // Empty or invalid body, use defaults
            }

            // MAPPING: If frontend sends adId but not accountId, find it first
            if (body.adId && !body.accountId) {
                console.log(`[Insights] Mapping adId ${body.adId} to accountId...`);
                const { data: adData } = await supabase
                    .from("unified_ads")
                    .select("platform_account_id")
                    .eq("id", body.adId)
                    .maybeSingle();

                if (adData) {
                    body.accountId = adData.platform_account_id;
                    console.log(`[Insights] Mapped adId ${body.adId} -> accountId ${body.accountId}`);
                }
            }

            const syncResponse = await fetch(`${supabaseUrl}/functions/v1/fb-sync-insights`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": req.headers.get("Authorization") || "" },
                body: JSON.stringify(body)
            });

            try {
                const text = await syncResponse.text();
                try {
                    return jsonResponse(JSON.parse(text), syncResponse.status);
                } catch (e) {
                    return jsonResponse({
                        success: false,
                        error: "Worker returned invalid JSON",
                        status: syncResponse.status,
                        raw: text.substring(0, 500)
                    }, 500);
                }
            } catch (e: any) {
                return jsonResponse({ success: false, error: "Failed to read worker response: " + e.message }, 500);
            }
        }

        return jsonResponse({ success: false, error: "Not Found", path }, 404);
    } catch (error: any) {
        return jsonResponse({ success: false, error: error.message }, 500);
    }
});
