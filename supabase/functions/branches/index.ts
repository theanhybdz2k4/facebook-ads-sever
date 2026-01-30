/**
 * Branches Edge Function - Harmonized with NestJS
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";
import { verify } from "https://deno.land/x/djwt@v3.0.1/mod.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const JWT_SECRET = Deno.env.get("JWT_SECRET") || "";
const AUTH_SECRET = Deno.env.get("AUTH_SECRET") || Deno.env.get("MASTER_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const supabase = createClient(supabaseUrl, supabaseKey);

const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-client-info, apikey",
};

const jsonResponse = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: corsHeaders });

function getVietnamToday(): string {
    const vn = new Date(new Date().getTime() + 7 * 60 * 60 * 1000);
    return vn.toISOString().split("T")[0];
}

function getVietnamYesterday(): string {
    const vn = new Date(new Date().getTime() + 7 * 60 * 60 * 1000);
    vn.setDate(vn.getDate() - 1);
    return vn.toISOString().split("T")[0];
}

// CRITICAL: DO NOT REMOVE THIS AUTH LOGIC. 
// IT PRIORITIZES auth_tokens TABLE FOR CUSTOM AUTHENTICATION.
async function verifyAuth(req: Request) {
    const authHeader = req.headers.get("Authorization");
    const serviceKeyHeader = req.headers.get("x-service-key") || req.headers.get("x-master-key");
    const masterKey = Deno.env.get("MASTER_KEY") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const authSecret = Deno.env.get("AUTH_SECRET") || "";
    const legacyToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxuY2dtYXh0cWpmYmN5cG5jZm9lIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NzM0NzQxMywiZXhwIjoyMDgyOTIzNDEzfQ.zalV6mnyd1Iit0KbHnqLxemnBKFPbKz2159tkHtodJY";

    if (serviceKeyHeader === serviceKey || serviceKeyHeader === masterKey || serviceKeyHeader === legacyToken) {
        return { userId: 1 };
    }

    if (authHeader?.startsWith("Bearer ")) {
        const token = authHeader.substring(7).trim();
        if ((serviceKey !== "" && token === serviceKey) || (masterKey !== "" && token === masterKey) || (authSecret !== "" && token === authSecret) || token === legacyToken) {
            return { userId: 1 };
        }

        // PRIORITY: Check custom auth_tokens table first
        try {
            const { data: tokenData } = await supabase.from("auth_tokens").select("user_id").eq("token", token).single();
            if (tokenData) return { userId: tokenData.user_id };
        } catch (e) {
            // Fallback to JWT
        }

        // FALLBACK 1: Manual JWT verification
        try {
            const encoder = new TextEncoder();
            const key = await crypto.subtle.importKey("raw", encoder.encode(JWT_SECRET || ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
            const payload = await verify(token, key);

            // service_role tokens don't have a 'sub' but have 'role'
            if (payload.role === "service_role") {
                console.log("Auth: Verified via manual JWT (service_role)");
                return { userId: 1 };
            }

            const sub = payload.sub as string;
            if (sub) {
                const userIdNum = parseInt(sub, 10);
                if (!isNaN(userIdNum)) return { userId: userIdNum };
                return { userId: sub as any };
            }
        } catch (e: any) {
            console.log("Auth: Manual JWT verify failed:", e.message);
        }

        // FALLBACK 2: Supabase Auth verification (Works for Service Role Keys)
        try {
            const { data: { user }, error } = await supabase.auth.getUser(token);
            if (user) {
                console.log("Auth: Verified via Supabase Auth. ID:", user.id);
                return { userId: user.id };
            } else if (error) {
                console.log("Auth: Supabase Auth verify returned error:", error.message);
            }
        } catch (e: any) {
            console.log("Auth: Supabase Auth verify thrown error:", e.message);
        }
    }
    return null;
}

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

    const url = new URL(req.url);
    const method = req.method;

    // Robust path handling for Supabase Edge Functions
    const segments = url.pathname.split("/").filter(Boolean);
    const branchesIndex = segments.indexOf("branches");
    const relevantSegments = branchesIndex !== -1 ? segments.slice(branchesIndex + 1) : segments;
    const path = "/" + relevantSegments.join("/");

    console.log(`[Branches] Request: ${method} ${url.pathname} -> Path: ${path}`);

    try {
        const auth = await verifyAuth(req);
        if (!auth) {
            const authHeader = req.headers.get("Authorization");
            const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
            const token = authHeader?.startsWith("Bearer ") ? authHeader.substring(7).trim() : "";

            return jsonResponse({ 
                success: false, 
                error: "Unauthorized",
                debug: {
                    hasJwtSecret: !!Deno.env.get("JWT_SECRET"),
                    hasServiceKey: !!serviceKey,
                    hasMasterKey: !!Deno.env.get("MASTER_KEY"),
                    hasAuthSecret: !!Deno.env.get("AUTH_SECRET"),
                    lengths: {
                        token: token.length,
                        serviceKeyEnv: serviceKey.length
                    },
                    matches: {
                        serviceKey: token !== "" && token === serviceKey
                    },
                    headers: {
                        auth: !!authHeader,
                        authPrefix: authHeader?.substring(0, 15),
                        serviceKeyPrefix: serviceKey.substring(0, 15), // Safe to show prefix
                        serviceKeyHeader: !!(req.headers.get("x-service-key") || req.headers.get("x-master-key")),
                    }
                }
            }, 401);
        }
        const targetUserId = auth.userId;

        // --- STATS DASHBOARD ---
        if (path.includes("/stats/dashboard")) {
            const dateStart = url.searchParams.get("dateStart") || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
            const dateEnd = url.searchParams.get("dateEnd") || new Date().toISOString().split("T")[0];
            const platformCode = url.searchParams.get("platformCode") || "all";
            const branchIdParam = url.searchParams.get("branchId") || "all";

            let branchQuery = supabase.from("branches").select("id, name, code, auto_match_keywords").eq("user_id", targetUserId);
            if (branchIdParam !== "all" && !isNaN(parseInt(branchIdParam))) {
                branchQuery = branchQuery.eq("id", parseInt(branchIdParam));
            }
            const { data: branches } = await branchQuery;
            const branchIds = branches?.map(b => b.id) || [];

            if (branchIds.length === 0) return jsonResponse({ branches: [], breakdowns: { device: [], ageGender: [], region: [] } });

            let statsQuery = supabase.from("branch_daily_stats").select("*").in("branch_id", branchIds).gte("date", dateStart).lte("date", dateEnd);
            if (platformCode !== "all") statsQuery = statsQuery.eq("platform_code", platformCode);
            const { data: allStats } = await statsQuery;

            // Get platform_id from platforms table if filtering by specific platform
            let platformId: number | null = null;
            if (platformCode !== "all") {
                const { data: platform } = await supabase.from("platforms").select("id").eq("code", platformCode).single();
                platformId = platform?.id || null;
            }

            let accountQuery = supabase.from("platform_accounts").select("id").in("branch_id", branchIds);
            if (platformId) accountQuery = accountQuery.eq("platform_id", platformId);
            const { data: accounts } = await accountQuery;
            const accountIds = accounts?.map(a => a.id) || [];

            const { data: breakdowns, error: rpcError } = await supabase.rpc('get_dashboard_breakdowns', {
                p_account_ids: accountIds,
                p_date_start: dateStart,
                p_date_end: dateEnd
            });
            if (rpcError) console.error("[Dashboard] Breakdown RPC error:", rpcError);

            const mappedBranches = branches?.map(b => {
                const bStats = allStats?.filter(s => s.branch_id === b.id) || [];
                const platformMap = new Map();
                let totalSpend = 0, totalImpressions = 0, totalClicks = 0, totalResults = 0;
                let totalMessagingTotal = 0, totalMessagingNew = 0;

                bStats.forEach(s => {
                    const sp = parseFloat(s.totalSpend || "0");
                    const im = parseInt(s.totalImpressions || "0");
                    const cl = parseInt(s.totalClicks || "0");
                    const re = parseInt(s.totalResults || "0");
                    const msgTotal = parseInt(s.totalMessagingTotal || "0");
                    const msgNew = parseInt(s.totalMessagingNew || "0");

                    // Only count totals from the appropriate source:
                    // - If filtering by specific platform (facebook/google/etc), only count that platform's rows
                    // - If filtering "all", only count the "all" summary row to avoid double counting
                    const shouldCountForTotal = (platformCode === "all" && s.platform_code === "all") ||
                        (platformCode !== "all" && s.platform_code === platformCode);

                    if (shouldCountForTotal) {
                        totalSpend += sp; totalImpressions += im; totalClicks += cl; totalResults += re;
                        totalMessagingTotal += msgTotal; totalMessagingNew += msgNew;
                    }

                    // Build platform breakdown for display (exclude 'all' summary row)
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
                    totalMessaging: totalMessagingTotal,
                    totalMessagingTotal, totalMessagingNew,
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

            return jsonResponse({ branches: mappedBranches, breakdowns: breakdowns || { device: [], ageGender: [], region: [] } });
        }

        if (path === "/stats/rebuild" && method === "POST") {
            const dateStart = url.searchParams.get("dateStart") || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
            const dateEnd = url.searchParams.get("dateEnd") || new Date().toISOString().split("T")[0];

            const { data: branches } = await supabase.from("branches").select("id").eq("user_id", targetUserId);
            if (!branches || branches.length === 0) return jsonResponse({ success: true, message: "No branches to rebuild" });

            const results = [];
            for (const b of branches) {
                await aggregateBranchStats(b.id, dateStart, dateEnd);
                results.push(b.id);
            }

            return jsonResponse({ success: true, message: `Rebuilt stats for ${branches.length} branches`, branches: results, dates: 30 });
        }

        if (path.includes("/stats/recalculate") && method === "POST") {
            const dateStart = url.searchParams.get("dateStart") || getVietnamYesterday();
            const dateEnd = url.searchParams.get("dateEnd") || getVietnamToday();

            // Extract id from path: /123/stats/recalculate
            const idMatch = path.match(/^\/(\d+)\//);
            const bId = idMatch ? parseInt(idMatch[1]) : null;

            if (!bId) return jsonResponse({ success: false, error: "Missing branchId" }, 400);

            await aggregateBranchStats(bId, dateStart, dateEnd);
            return jsonResponse({ success: true, message: `Recalculated stats for branch ${bId}` });
        }

        // --- CRUD / LIST ---
        if ((path === "/" || path === "") && method === "GET") {
            const { data, error } = await supabase.from("branches").select("*, platform_accounts(id, name, account_status)").eq("user_id", targetUserId);
            if (error) throw error;
            return jsonResponse({ success: true, result: data });
        }

        if (method === "POST" && (path === "/" || path === "")) {
            const body = await req.json();
            let keywords = body.autoMatchKeywords || body.auto_match_keywords;
            if (keywords && typeof keywords === 'string') keywords = keywords.split(',').map((k: string) => k.trim()).filter((k: string) => k);

            const insertData = { name: body.name, code: body.code, auto_match_keywords: keywords || [], user_id: targetUserId };
            const { data, error } = await supabase.from("branches").insert(insertData).select().single();
            if (error) throw error;
            return jsonResponse({ success: true, result: data });
        }

        const idParam = path.split("/").filter(Boolean)[0];
        const id = idParam && !isNaN(parseInt(idParam)) ? parseInt(idParam) : null;

        if (id) {
            if (method === "GET") {
                const { data } = await supabase.from("branches").select("*, platform_accounts(*)").eq("id", id).eq("user_id", targetUserId).single();
                return jsonResponse({ success: true, result: data });
            }
            if (method === "PUT") {
                const body = await req.json();
                let keywords = body.autoMatchKeywords || body.auto_match_keywords;
                if (keywords && typeof keywords === 'string') keywords = keywords.split(',').map((k: string) => k.trim()).filter((k: string) => k);

                const updateData: any = {};
                if (body.name !== undefined) updateData.name = body.name;
                if (body.code !== undefined) updateData.code = body.code;
                if (keywords !== undefined) updateData.auto_match_keywords = keywords;

                const { data } = await supabase.from("branches").update(updateData).eq("id", id).eq("user_id", targetUserId).select().single();
                return jsonResponse({ success: true, result: data });
            }
            if (method === "DELETE") {
                await supabase.from("branches").delete().eq("id", id).eq("user_id", targetUserId);
                return jsonResponse({ success: true });
            }
        }

        return jsonResponse({ success: false, error: "Not Found", path }, 404);
    } catch (error: any) {
        console.error(`[Branches] Final Catch Error:`, error);
        return jsonResponse({ success: false, error: error.message }, 500);
    }
});

async function aggregateBranchStats(branch_id: number, dateStart: string, dateEnd: string) {
    console.log(`[Branches] RPC recalculate_branch_daily_stats for branch ${branch_id} (${dateStart} to ${dateEnd})`);
    const { error } = await supabase.rpc('recalculate_branch_daily_stats', { p_branch_id: branch_id, p_date_start: dateStart, p_date_end: dateEnd });
    if (error) {
        console.error(`[Branches] RPC Error:`, error);
        throw error;
    }
}
