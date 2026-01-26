/**
 * Insights Edge Function - FULL FEATURE COMPATIBILITY
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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
        if (isNaN(userId)) return null;
        return { userId };
    } catch (e: any) {
        console.error("Auth error:", e.message);
        return null;
    }
}

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

    const auth = await verifyAuth(req);
    if (!auth) return jsonResponse({ success: false, error: "Unauthorized" }, 401);

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

            // Get all accounts for this branch
            const { data: accounts } = await supabase
                .from("platform_accounts")
                .select("id")
                .eq("branch_id", branchId);

            const results = [];
            for (const acc of (accounts || [])) {
                const syncResponse = await fetch(`${supabaseUrl}/functions/v1/fb-sync-insights`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "Authorization": req.headers.get("Authorization") || "" },
                    body: JSON.stringify({ ...body, accountId: acc.id })
                });
                results.push(await syncResponse.json());
            }

            return jsonResponse({ success: true, results });
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
