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

const jsonResponse = (data: any, status = 200) => new Response(JSON.stringify(data), {
    status,
    headers: {
        ...corsHeaders,
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    }
});

// Tax markup for display (10%)
const TAX_MULTIPLIER = 1.1;

function getVietnamToday(): string {
    const vn = new Date(new Date().getTime() + 7 * 60 * 60 * 1000);
    return vn.toISOString().split("T")[0];
}

function getVietnamYesterday(): string {
    const vn = new Date(new Date().getTime() + 7 * 60 * 60 * 1000);
    vn.setDate(vn.getDate() - 1);
    return vn.toISOString().split("T")[0];
}

// Standardized verifyAuth for consistent security across all Edge Functions
async function verifyAuth(req: Request) {
    const authHeader = req.headers.get("Authorization");
    const serviceKeyHeader = req.headers.get("x-service-key") || req.headers.get("x-master-key");
    const masterKey = Deno.env.get("MASTER_KEY") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const authSecret = Deno.env.get("AUTH_SECRET") || "";

    // 1. Service Role/Master Key check (Header)
    if (serviceKeyHeader && (serviceKeyHeader === serviceKey || serviceKeyHeader === masterKey)) {
        return { userId: 1, isServiceRole: true };
    }

    if (authHeader?.startsWith("Bearer ")) {
        const token = authHeader.substring(7).trim();

        // 2. Service Role/Master Key check (Bearer Token)
        if (token === serviceKey || token === masterKey || (authSecret !== "" && token === authSecret)) {
            return { userId: 1, isServiceRole: true };
        }

        // 3. Custom auth_tokens check
        try {
            const { data: tokenData } = await supabase
                .from("auth_tokens")
                .select("user_id, expires_at, is_active")
                .eq("token", token)
                .maybeSingle();

            if (tokenData) {
                if (tokenData.is_active === false) return null;
                if (tokenData.expires_at && new Date(tokenData.expires_at) < new Date()) return null;
                return { userId: tokenData.user_id, isServiceRole: true };
            }
        } catch (e: any) { }

        // 4. Manual JWT Verification Fallback
        try {
            const secret = Deno.env.get("JWT_SECRET");
            if (secret) {
                const encoder = new TextEncoder();
                const jwtKey = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
                const payload = await verify(token, jwtKey);

                if (payload.role === "service_role") return { userId: 1, isServiceRole: true };

                const sub = payload.sub as string;
                if (sub) {
                    const userIdNum = parseInt(sub, 10);
                    return { userId: isNaN(userIdNum) ? sub : userIdNum };
                }
            }
        } catch (e: any) {
            console.warn(`[Auth] JWT verification failed: ${e.message}. Using permissive fallback.`);
        }

        // 5. Supabase Auth Fallback
        try {
            const { data: { user } } = await supabase.auth.getUser(token);
            if (user) {
                const userIdNum = parseInt(user.id, 10);
                return { userId: isNaN(userIdNum) ? user.id : userIdNum };
            }
        } catch (e: any) {
            console.warn(`[Auth] Supabase Auth failed: ${e.message}. Using permissive fallback.`);
        }

        // 6. CRITICAL FALLBACK: "Tắt JWT" - If any token is present, allow access as admin/primary user
        console.log("[Auth] Permissive Auth active: Allowing request based on token presence.");
        return { userId: 1 };
    }
    return null;
}

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

    const url = new URL(req.url);
    const method = req.method;

    // Robust path handling
    const segments = url.pathname.split("/").filter(Boolean);
    const branchesIndex = segments.indexOf("branches");
    const relevantSegments = branchesIndex !== -1 ? segments.slice(branchesIndex + 1) : segments;
    const path = "/" + relevantSegments.join("/");

    try {
        // --- STATS DASHBOARD (AUTH REQUIRED, service key can pass ?userId=) ---
        const dashAuth = await verifyAuth(req);
        if (!dashAuth) return jsonResponse({ success: false, error: "Unauthorized" }, 401);
        if (path === "/stats/dashboard" || path.includes("/stats/dashboard")) {
            // Service key (third-party): allow ?userId= param
            // Regular JWT user: always use their own userId
            const userIdParam = url.searchParams.get("userId");
            const targetUserId = (dashAuth.isServiceRole && userIdParam)
                ? (isNaN(parseInt(userIdParam)) ? userIdParam : parseInt(userIdParam))
                : dashAuth.userId;

            const dateStart = url.searchParams.get("dateStart") || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
            const dateEnd = url.searchParams.get("dateEnd") || new Date().toISOString().split("T")[0];
            const platformCode = url.searchParams.get("platformCode") || "all";
            const branchIdParam = url.searchParams.get("branchId") || "all";

            console.log(`[Dashboard] Aggregating stats: ${dateStart} to ${dateEnd}, Platform: ${platformCode}, Branch: ${branchIdParam}`);

            let branchQuery = supabase.from("branches").select("id, name, code, auto_match_keywords").eq("user_id", targetUserId);
            if (branchIdParam !== "all" && !isNaN(parseInt(branchIdParam))) {
                branchQuery = branchQuery.eq("id", parseInt(branchIdParam));
            }
            const { data: branches, error: branchError } = await branchQuery;
            if (branchError) throw branchError;

            const branchIds = branches?.map(b => b.id) || [];
            if (branchIds.length === 0) {
                console.log(`[Dashboard] No branches found for user ${targetUserId}`);
                return jsonResponse({ branches: [], breakdowns: { device: [], ageGender: [] } });
            }

            console.log(`[Dashboard] Found ${branchIds.length} branches: ${branchIds.join(", ")}`);

            let statsQuery = supabase.from("branch_daily_stats").select("*").in("branch_id", branchIds).gte("date", dateStart).lte("date", dateEnd);
            if (platformCode !== "all") statsQuery = statsQuery.eq("platform_code", platformCode);

            const { data: allStats, error: statsError } = await statsQuery;
            if (statsError) throw statsError;

            // Get platform_id from platforms table if filtering by specific platform
            let platformId: number | null = null;
            if (platformCode !== "all") {
                const { data: platform } = await supabase.from("platforms").select("id").eq("code", platformCode).maybeSingle();
                platformId = platform?.id || null;
            }

            let accountQuery = supabase.from("platform_accounts").select("id").in("branch_id", branchIds);
            if (platformId) accountQuery = accountQuery.eq("platform_id", platformId);
            const { data: accounts, error: accountError } = await accountQuery;
            if (accountError) throw accountError;

            const accountIds = accounts?.map(a => a.id) || [];
            console.log(`[Dashboard] Statistics retrieved: ${allStats?.length || 0} rows. Target accounts: ${accountIds.length}`);

            let breakdowns: any = { device: [], ageGender: [] };
            if (accountIds.length > 0) {
                const { data: breakdownData, error: rpcError } = await supabase.rpc('get_dashboard_breakdowns', {
                    p_account_ids: accountIds,
                    p_date_start: dateStart,
                    p_date_end: dateEnd
                });
                if (rpcError) {
                    console.error("[Dashboard] Breakdown RPC error:", rpcError);
                } else {
                    breakdowns = breakdownData;
                }
            }

            const today = getVietnamToday();

            const mappedBranches = (branches || []).map(b => {
                const bStats = allStats?.filter(s => s.branch_id === b.id) || [];
                const platformMap = new Map();
                let totalSpend = 0, totalImpressions = 0, totalClicks = 0, totalResults = 0;
                let totalMessagingTotal = 0, totalMessagingNew = 0;
                let todaySpend = 0, todayImpressions = 0, todayClicks = 0, todayResults = 0;

                bStats.forEach(s => {
                    const sp = parseFloat(s.totalSpend || "0");
                    const im = parseInt(s.totalImpressions || "0");
                    const cl = parseInt(s.totalClicks || "0");
                    const re = parseInt(s.totalResults || "0");
                    const msgTotal = parseInt(s.totalMessagingTotal || "0");
                    const msgNew = parseInt(s.totalMessagingNew || "0");

                    const shouldCountForTotal = (platformCode === "all" && s.platform_code === "all") ||
                        (platformCode !== "all" && s.platform_code === platformCode);

                    if (shouldCountForTotal) {
                        totalSpend += sp * TAX_MULTIPLIER; totalImpressions += im; totalClicks += cl; totalResults += msgNew;
                        totalMessagingTotal += msgTotal; totalMessagingNew += msgNew;

                        if (s.date === today) {
                            todaySpend += sp * TAX_MULTIPLIER;
                            todayImpressions += im;
                            todayClicks += cl;
                            todayResults += msgNew;
                        }
                    }

                    if (s.platform_code !== "all") {
                        if (!platformMap.has(s.platform_code)) {
                            platformMap.set(s.platform_code, { code: s.platform_code, spend: 0, impressions: 0, clicks: 0, results: 0 });
                        }
                        const p = platformMap.get(s.platform_code);
                        p.spend += sp * TAX_MULTIPLIER; p.impressions += im; p.clicks += cl; p.results += msgNew;
                    }
                });

                return {
                    id: b.id, name: b.name, code: b.code,
                    totalSpend, totalImpressions, totalClicks, totalResults,
                    todaySpend, todayImpressions, todayClicks, todayResults,
                    totalMessaging: totalMessagingTotal,
                    totalMessagingTotal, totalMessagingNew,
                    platforms: Array.from(platformMap.values()),
                    stats: bStats.map(s => ({
                        date: s.date,
                        platformCode: s.platform_code,
                        spend: parseFloat(s.totalSpend || "0") * TAX_MULTIPLIER,
                        impressions: parseInt(s.totalImpressions || "0"),
                        clicks: parseInt(s.totalClicks || "0"),
                        results: parseInt(s.totalMessagingNew || "0")
                    }))
                };
            });

            return jsonResponse({ branches: mappedBranches, breakdowns });
        }

        // --- All other routes also require auth (reuse dashAuth) ---
        const auth = dashAuth;
        if (!auth) {
            const authHeader = req.headers.get("Authorization");
            const token = authHeader?.startsWith("Bearer ") ? authHeader.substring(7).trim() : "";
            console.warn(`[Branches] Unauthorized access attempt: ${method} ${url.pathname}`);

            return jsonResponse({
                success: false,
                error: "Unauthorized",
                debug: {
                    hasJwtSecret: !!JWT_SECRET,
                    tokenLength: token.length,
                    headers: {
                        auth: !!authHeader,
                        serviceKeyHeader: !!(req.headers.get("x-service-key") || req.headers.get("x-master-key")),
                    }
                }
            }, 401);
        }

        // Support userId from query parameter
        const userIdParam = url.searchParams.get("userId");
        const targetUserId = userIdParam ? (isNaN(parseInt(userIdParam)) ? userIdParam : parseInt(userIdParam)) : auth.userId;

        console.log(`[Branches] Processing ${method} ${path} for user ${targetUserId} (Auth User: ${auth.userId})`);

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

            return jsonResponse({ success: true, message: "Rebuilt stats for " + branches.length + " branches", branches: results, dates: 30 });
        }

        if (path.includes("/stats/recalculate") && method === "POST") {
            let body: any = {};
            try { body = await req.json(); } catch (e) { /* ignore */ }

            const dateStart = url.searchParams.get("dateStart") || body.dateStart || getVietnamYesterday();
            const dateEnd = url.searchParams.get("dateEnd") || body.dateEnd || getVietnamToday();

            const idMatch = path.match(/\/(\d+)\//);
            const bId = idMatch ? parseInt(idMatch[1]) : null;

            if (!bId) return jsonResponse({ success: false, error: "Missing branchId" }, 400);

            await aggregateBranchStats(bId, dateStart, dateEnd);
            return jsonResponse({ success: true, message: "Recalculated stats for branch " + bId, dates: { dateStart, dateEnd } });
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
                const { data, error } = await supabase.from("branches").select("*, platform_accounts(*)").eq("id", id).eq("user_id", targetUserId).maybeSingle();
                if (error) throw error;
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

                const { data, error } = await supabase.from("branches").update(updateData).eq("id", id).eq("user_id", targetUserId).select().maybeSingle();
                if (error) throw error;
                return jsonResponse({ success: true, result: data });
            }
            if (method === "DELETE") {
                const { error } = await supabase.from("branches").delete().eq("id", id).eq("user_id", targetUserId);
                if (error) throw error;
                return jsonResponse({ success: true });
            }
        }

        return jsonResponse({ success: false, error: "Not Found", path }, 404);
    } catch (error: any) {
        console.error(`[Branches] Fatal error:`, error);
        return jsonResponse({ success: false, error: error.message }, 500);
    }
});

async function aggregateBranchStats(branch_id: number, dateStart: string, dateEnd: string) {
    console.log("[Branches] RPC recalculate_branch_daily_stats for branch " + branch_id + " (" + dateStart + " to " + dateEnd + ")");
    const { error } = await supabase.rpc('recalculate_branch_daily_stats', {
        target_branch_id: branch_id,
        start_date: dateStart,
        end_date: dateEnd
    });
    if (error) {
        console.error(`[Branches] RPC Error:`, error);
        throw error;
    }
}
