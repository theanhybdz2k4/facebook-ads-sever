/**
 * Branches Edge Function - Harmonized with NestJS
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
    const serviceKeyHeader = req.headers.get("x-service-key");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

    // 1. Try x-service-key (Bypass Postman Auth issues)
    if (serviceKeyHeader) {
        const val = serviceKeyHeader.trim();
        if (serviceKey !== "" && val === serviceKey) {
            const url = new URL(req.url);
            const queryUserId = url.searchParams.get("userId");
            return { userId: queryUserId ? parseInt(queryUserId, 10) : 1 };
        }
    }

    // 2. Try Bearer Token
    if (authHeader?.startsWith("Bearer ")) {
        const token = authHeader.substring(7).trim();
        if (serviceKey !== "" && token === serviceKey) {
            const url = new URL(req.url);
            const queryUserId = url.searchParams.get("userId");
            return { userId: queryUserId ? parseInt(queryUserId, 10) : 1 };
        }

        // JWT verification
        try {
            const encoder = new TextEncoder();
            const key = await crypto.subtle.importKey("raw", encoder.encode(JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
            const payload = await verify(token, key);
            return { userId: parseInt(payload.sub as string, 10) };
        } catch { return null; }
    }

    return null;
}

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

    const auth = await verifyAuth(req);
    if (!auth) {
        return jsonResponse({ success: false, error: "Unauthorized" }, 401);
    }

    const url = new URL(req.url);
    const method = req.method;
    let path = url.pathname;
    const segments = path.split("/").filter(Boolean);
    if (segments[0] === "branches") segments.shift();
    path = "/" + segments.join("/");

    try {
        // --- STATS DASHBOARD ---
        if (path.includes("/stats/dashboard")) {
            const dateStart = url.searchParams.get("dateStart") || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
            const dateEnd = url.searchParams.get("dateEnd") || new Date().toISOString().split("T")[0];
            const platformCode = url.searchParams.get("platformCode") || "all";
            const branchIdParam = url.searchParams.get("branchId") || "all";
            const queryUserId = url.searchParams.get("userId");
            
            // Use queryUserId if provided, otherwise fallback to auth user
            const targetUserId = queryUserId ? parseInt(queryUserId, 10) : auth.userId;

            // 1. Fetch Branches filtered by user and optionally branchId
            let branchQuery = supabase.from("branches").select("id, name, code").eq("user_id", targetUserId);
            if (branchIdParam !== "all" && !isNaN(parseInt(branchIdParam))) {
                branchQuery = branchQuery.eq("id", parseInt(branchIdParam));
            }
            const { data: branches } = await branchQuery;
            const branchIds = branches?.map(b => b.id) || [];

            if (branchIds.length === 0) return jsonResponse({ branches: [], breakdowns: null });

            // 2. Fetch Daily Stats
            let statsQuery = supabase.from("branch_daily_stats").select("*").in("branch_id", branchIds).gte("date", dateStart).lte("date", dateEnd);
            if (platformCode !== "all") statsQuery = statsQuery.eq("platform_code", platformCode);
            const { data: allStats } = await statsQuery;

            // 3. Get Platform Accounts for Breakdowns
            let accountQuery = supabase.from("platform_accounts").select("id").in("branch_id", branchIds);
            if (platformCode !== "all") accountQuery = accountQuery.eq("platform_code", platformCode);
            const { data: accounts } = await accountQuery;
            const accountIds = accounts?.map(a => a.id) || [];

            // 4. Fetch Breakdowns via RPC
            const { data: breakdowns } = await supabase.rpc('get_dashboard_breakdowns', {
                p_account_ids: accountIds,
                p_date_start: dateStart,
                p_date_end: dateEnd
            });

            const mappedBranches = branches?.map(b => {
                const bStats = allStats?.filter(s => s.branch_id === b.id) || [];
                const platformMap = new Map();
                let totalSpend = 0, totalImpressions = 0, totalClicks = 0, totalResults = 0;

                bStats.forEach(s => {
                    const sp = parseFloat(s.totalSpend || "0");
                    const im = parseInt(s.totalImpressions || "0");
                    const cl = parseInt(s.totalClicks || "0");
                    const re = parseInt(s.totalResults || "0");
                    totalSpend += sp; totalImpressions += im; totalClicks += cl; totalResults += re;

                    if (s.platform_code !== "all") {
                        if (!platformMap.has(s.platform_code)) {
                            platformMap.set(s.platform_code, { code: s.platform_code, spend: 0, impressions: 0, clicks: 0, results: 0 });
                        }
                        const p = platformMap.get(s.platform_code);
                        p.spend += sp; p.impressions += im; p.clicks += cl; p.results += re;
                    }
                });

                return {
                    id: b.id, name: b.name, code: b.code,
                    totalSpend, totalImpressions, totalClicks, totalResults,
                    totalMessaging: totalResults,
                    platforms: Array.from(platformMap.values()),
                    stats: bStats.map(s => ({
                        date: s.date,
                        platformCode: s.platform_code,
                        spend: parseFloat(s.totalSpend || "0"),
                        impressions: parseInt(s.totalImpressions || "0"),
                        clicks: parseInt(s.totalClicks || "0"),
                        results: parseInt(s.totalResults || "0")
                    }))
                };
            });

            return jsonResponse({ branches: mappedBranches, breakdowns });
        }

        // --- CRUD / LIST ---
        const idParam = path.split("/").filter(Boolean)[0];
        const id = idParam && !isNaN(parseInt(idParam)) ? parseInt(idParam) : null;

        if ((path === "/" || path === "") && method === "GET") {
            const { data, error } = await supabase.from("branches").select("*, platform_accounts(id, name, account_status)").eq("user_id", auth.userId);
            if (error) throw error;
            return jsonResponse({ success: true, result: data });
        }

        if (method === "POST" && (path === "/" || path === "")) {
            const body = await req.json();
            const { data, error } = await supabase.from("branches").insert({ ...body, user_id: auth.userId }).select().single();
            if (error) throw error;
            return jsonResponse({ success: true, result: data });
        }

        if (id) {
            if (method === "GET") {
                const { data } = await supabase.from("branches").select("*, platform_accounts(*)").eq("id", id).eq("user_id", auth.userId).single();
                return jsonResponse({ success: true, result: data });
            }
            if (method === "PUT") {
                const body = await req.json();
                const { data } = await supabase.from("branches").update(body).eq("id", id).eq("user_id", auth.userId).select().single();
                return jsonResponse({ success: true, result: data });
            }
            if (method === "DELETE") {
                await supabase.from("branches").delete().eq("id", id).eq("user_id", auth.userId);
                return jsonResponse({ success: true });
            }
        }

        return jsonResponse({ success: false, error: "Not Found", path }, 404);
    } catch (error: any) {
        return jsonResponse({ success: false, error: error.message }, 500);
    }
});
