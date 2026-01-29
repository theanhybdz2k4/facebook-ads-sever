/**
 * Ad-Accounts Edge Function - Harmonized with NestJS
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
            // Not found in auth_tokens, fallback to JWT
        }

        // FALLBACK: JWT verification
        try {
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

// Normalize raw FB status codes to standard names
function normalizeStatus(rawStatus: string): string {
    switch (rawStatus) {
        case '1': return 'ACTIVE';
        case '2': return 'DISABLED';
        case '100': return 'PENDING';
        case '101': return 'CLOSED';
        case '201': return 'PENDING';
        case '202': return 'DISABLED';
        default: return rawStatus;
    }
}

function mapAccount(a: any) {
    return {
        id: a.id,
        identityId: a.platform_identity_id,
        platformId: a.platform_id,
        externalId: a.external_id,
        name: a.name,
        currency: a.currency,
        timezone: a.timezone,
        accountStatus: normalizeStatus(a.account_status || ''),
        amountSpent: a.amount_spent,
        syncedAt: a.synced_at,
        branchId: a.branch_id,
        branch: a.branches ? { id: a.branches.id, name: a.branches.name } : null,
        platform: a.platforms ? { id: a.platforms.id, code: a.platforms.code } : null
    };
}

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

    const auth = await verifyAuth(req);
    if (!auth) return jsonResponse({ success: false, error: "Unauthorized" }, 401);

    const url = new URL(req.url);
    // ROBUST ROUTING
    const segments = url.pathname.split("/").filter(Boolean);
    const funcIndex = segments.indexOf("ad-accounts");
    const subPathSegments = funcIndex !== -1 ? segments.slice(funcIndex + 1) : segments;
    const path = "/" + subPathSegments.join("/");

    const method = req.method;

    try {
        const idParam = subPathSegments.length > 0 ? subPathSegments[0] : null;
        const id = idParam && !isNaN(parseInt(idParam)) ? parseInt(idParam) : null;

        // List Accounts
        if ((path === "/" || path === "") && method === "GET") {
            const branchId = url.searchParams.get("branchId");
            const status = url.searchParams.get("accountStatus");
            const search = url.searchParams.get("search");

            let query = supabase
                .from("platform_accounts")
                .select("*, branches(*), platforms(*), platform_identities!inner(*)")
                .eq("platform_identities.user_id", auth.userId);

            if (branchId && branchId !== "all") query = query.eq("branch_id", parseInt(branchId));

            if (status) {
                if (status.toUpperCase() === "ACTIVE") {
                    query = query.eq("account_status", "1");
                } else if (status.toUpperCase() === "DISABLED" || status.toUpperCase() === "CLOSED") {
                    query = query.in("account_status", ["2", "101", "100"]);
                } else {
                    query = query.eq("account_status", status);
                }
            }

            if (search) query = query.or(`name.ilike.%${search}%,external_id.ilike.%${search}%`);

            const { data, error } = await query.order("name", { ascending: true });
            if (error) throw error;
            return jsonResponse(data.map(mapAccount));
        }

        // Get Single Account
        if (id && subPathSegments.length === 1 && method === "GET") {
            const { data, error } = await supabase
                .from("platform_accounts")
                .select("*, branches(*), platforms(*), platform_identities!inner(*)")
                .eq("id", id)
                .eq("platform_identities.user_id", auth.userId)
                .single();
            if (error) return jsonResponse({ success: false, error: "Account not found" }, 404);
            return jsonResponse(mapAccount(data));
        }

        // Assign Branch
        if (id && subPathSegments.includes("branch") && method === "PUT") {
            const body = await req.json();
            const { branchId } = body;

            // Verify account ownership
            const { data: account } = await supabase
                .from("platform_accounts")
                .select("id, platform_identities!inner(user_id)")
                .eq("id", id)
                .eq("platform_identities.user_id", auth.userId)
                .single();

            if (!account) return jsonResponse({ success: false, error: "Account not found" }, 404);

            const { data, error } = await supabase
                .from("platform_accounts")
                .update({ branch_id: branchId })
                .eq("id", id)
                .select()
                .single();

            if (error) throw error;
            return jsonResponse(mapAccount(data));
        }

        return jsonResponse({ success: false, error: "Not Found", path }, 404);
    } catch (error: any) {
        return jsonResponse({ success: false, error: error.message }, 500);
    }
});
