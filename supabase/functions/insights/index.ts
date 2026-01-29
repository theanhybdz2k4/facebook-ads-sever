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

// CRITICAL: DO NOT REMOVE THIS AUTH LOGIC. 
// IT PRIORITIZES auth_tokens TABLE FOR CUSTOM AUTHENTICATION.
async function verifyAuth(req: Request) {
    const authHeader = req.headers.get("Authorization");
    const serviceKeyHeader = req.headers.get("x-service-key") || req.headers.get("x-master-key");
    const masterKey = Deno.env.get("MASTER_KEY") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const authSecret = Deno.env.get("AUTH_SECRET") || "";

    if (serviceKeyHeader === serviceKey || serviceKeyHeader === masterKey) {
        return { userId: 1 };
    }

    if (authHeader?.startsWith("Bearer ")) {
        const token = authHeader.substring(7).trim();
        if ((serviceKey !== "" && token === serviceKey) || (masterKey !== "" && token === masterKey) || (authSecret !== "" && token === authSecret)) {
            return { userId: 1 };
        }

        // PRIORITY: Check custom auth_tokens table first
        try {
            const { data: tokenData } = await supabase.from("auth_tokens").select("user_id").eq("token", token).single();
            if (tokenData) return { userId: tokenData.user_id };
        } catch (e) {
            // Fallback to JWT
        }

        // FALLBACK: JWT verification
        try {
            console.log("DEBUG: JWT_SECRET length:", JWT_SECRET?.length || 0);
            const encoder = new TextEncoder();
            const key = await crypto.subtle.importKey("raw", encoder.encode(JWT_SECRET || ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
            const payload = await verify(token, key);
            const sub = payload.sub as string;
            const userIdNum = parseInt(sub, 10);
            if (!isNaN(userIdNum)) return { userId: userIdNum };
            return { userId: sub as any };
        } catch (e: any) {
            console.log("Auth: JWT verify failed:", e.message);
        }
    }
    return null;
}

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

    const auth = await verifyAuth(req);
    if (!auth) {
        return jsonResponse({ 
            success: false, 
            error: "Unauthorized",
            debug: {
                hasSecret: !!Deno.env.get("JWT_SECRET"),
                secretLen: Deno.env.get("JWT_SECRET")?.length || 0,
                tokenPrefix: req.headers.get("Authorization")?.substring(0, 15)
            }
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
            const proxyUrl = new URL(`${supabaseUrl}/functions/v1/fb-sync-insights`);
            url.searchParams.forEach((v, k) => proxyUrl.searchParams.set(k, v));

            const res = await fetch(proxyUrl.toString(), {
                headers: { "Authorization": req.headers.get("Authorization") || "" }
            });
            const data = await res.json();
            return jsonResponse(data, res.status);
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
            const body = await req.json();

            const syncResponse = await fetch(`${supabaseUrl}/functions/v1/fb-sync-insights`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": req.headers.get("Authorization") || "" },
                body: JSON.stringify({ ...body, accountId })
            });
            return jsonResponse(await syncResponse.json(), syncResponse.status);
        }

        // POST /insights/sync/branch/:id
        if (path.includes("/sync/branch/") && method === "POST") {
            const branchId = parseInt(subPathSegments[subPathSegments.indexOf("branch") + 1], 10);
            const body = await req.json();
            const dateStart = body.dateStart || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
            const dateEnd = body.dateEnd || new Date().toISOString().split("T")[0];

            // Get all accounts for this branch
            const { data: accounts } = await supabase
                .from("platform_accounts")
                .select("id")
                .eq("branch_id", branchId);

            const token = req.headers.get("Authorization") || "";

            const syncResults = await Promise.all((accounts || []).map(async (acc: any) => {
                const accResults: any = { accountId: acc.id };
                try {
                    // 1. Sync Standard Insights (Daily + Hourly)
                    const syncResponse = await fetch(`${supabaseUrl}/functions/v1/fb-sync-insights`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json", "Authorization": token },
                        body: JSON.stringify({ ...body, accountId: acc.id, skipBranchAggregation: true })
                    });
                    accResults.main = await syncResponse.json();

                    // 2. Sync Breakdowns (Device, Age/Gender, Region) - Use granularity: 'NONE' to skip redundant main syncs
                    const breakdownTypes = ["device", "age_gender", "region"];
                    accResults.breakdowns = {};

                    await Promise.all(breakdownTypes.map(async (bType) => {
                        try {
                            console.log(`[Insights] Syncing ${bType} for account ${acc.id} (${dateStart} to ${dateEnd})`);
                            const bRes = await fetch(`${supabaseUrl}/functions/v1/fb-sync-insights`, {
                                method: "POST",
                                headers: { "Content-Type": "application/json", "Authorization": token },
                                body: JSON.stringify({
                                    accountId: acc.id,
                                    dateStart,
                                    dateEnd,
                                    breakdown: bType,
                                    granularity: 'NONE' // Optimized: skip DAILY/HOURLY in this call
                                })
                            });
                            accResults.breakdowns[bType] = await bRes.json();
                        } catch (e: any) {
                            console.error(`[Insights] Breakdown sync (${bType}) failed for account ${acc.id}:`, e.message);
                            accResults.breakdowns[bType] = { success: false, error: e.message };
                        }
                    }));
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
            const body = await req.json();
            const syncResponse = await fetch(`${supabaseUrl}/functions/v1/fb-sync-insights`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": req.headers.get("Authorization") || "" },
                body: JSON.stringify(body)
            });
            return jsonResponse(await syncResponse.json(), syncResponse.status);
        }

        return jsonResponse({ success: false, error: "Not Found", path }, 404);
    } catch (error: any) {
        return jsonResponse({ success: false, error: error.message }, 500);
    }
});
