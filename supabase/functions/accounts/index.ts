/**
 * Accounts (Identities) Edge Function - Harmonized with NestJS
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";
import { verify } from "https://deno.land/x/djwt@v3.0.1/mod.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const JWT_SECRET = Deno.env.get("JWT_SECRET") || "your-secret-key";
const supabase = createClient(supabaseUrl, supabaseKey);

const FB_BASE_URL = "https://graph.facebook.com/v19.0";

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
        return { userId: parseInt(payload.sub as string, 10) };
    } catch { return null; }
}

function mapIdentity(i: any) {
    return {
        id: i.id,
        userId: i.user_id,
        platformId: i.platform_id,
        externalId: i.external_id,
        name: i.name,
        isValid: i.is_valid,
        createdAt: i.created_at,
        updatedAt: i.updated_at,
        platform: i.platforms ? { id: i.platforms.id, code: i.platforms.code, name: i.platforms.name } : null,
        _count: {
            accounts: i.platform_accounts?.length || 0
        }
    };
}

async function fbRequest(endpoint: string, token: string, params: any = {}) {
    const url = new URL(`${FB_BASE_URL}${endpoint}`);
    Object.keys(params).forEach(key => url.searchParams.append(key, params[key]));
    url.searchParams.append("access_token", token);
    const resp = await fetch(url.toString());
    return await resp.json();
}

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

    const auth = await verifyAuth(req);
    if (!auth) return jsonResponse({ success: false, error: "Unauthorized" }, 401);

    const url = new URL(req.url);
    // ROBUST ROUTING
    const segments = url.pathname.split("/").filter(Boolean);
    const funcIndex = segments.indexOf("accounts");
    const subPathSegments = funcIndex !== -1 ? segments.slice(funcIndex + 1) : segments;
    const path = "/" + subPathSegments.join("/");

    const method = req.method;

    try {
        // List Identities
        if (path === "/identities" || path === "/identities/") {
            if (method === "GET") {
                const { data, error } = await supabase
                    .from("platform_identities")
                    .select("*, platforms(*), platform_accounts(id)")
                    .eq("user_id", auth.userId);
                if (error) throw error;
                return jsonResponse({ success: true, result: data.map(mapIdentity) });
            }
        }

        // Connect / Add Identity
        if (path === "/connect" || path === "/connect/") {
            const body = await req.json();
            const { platformCode, token, name } = body;

            const { data: platform } = await supabase.from("platforms").select("*").eq("code", platformCode).single();
            if (!platform) return jsonResponse({ success: false, error: "Platform not found" }, 404);

            // Validate token with FB
            const fbMe = await fbRequest("/me", token, { fields: "id,name" });
            if (fbMe.error) return jsonResponse({ success: false, error: fbMe.error.message }, 400);

            const { data: identity, error: idError } = await supabase.from("platform_identities").upsert({
                user_id: auth.userId,
                platform_id: platform.id,
                external_id: fbMe.id,
                name: name || fbMe.name,
                is_valid: true
            }, { onConflict: "platform_id,external_id" }).select().single();

            if (idError) throw idError;

            // Upsert Credential
            await supabase.from("platform_credentials").upsert({
                platform_identity_id: identity.id,
                credential_type: "access_token",
                credential_value: token,
                is_active: true
            }, { onConflict: "platform_identity_id,credential_type" });

            return jsonResponse({ success: true, result: mapIdentity(identity) });
        }

        // Sync Sub-accounts
        if (path.includes("/sync-accounts")) {
            // Robustly find identityId from subPathSegments
            const identIndex = subPathSegments.indexOf("identities");
            const identityId = identIndex !== -1 ? subPathSegments[identIndex + 1] : null;

            if (!identityId) return jsonResponse({ success: false, error: "Identity ID missing from path" }, 400);

            const { data: identity } = await supabase
                .from("platform_identities")
                .select("*, platform_credentials(*)")
                .eq("id", identityId)
                .eq("user_id", auth.userId)
                .single();

            if (!identity) return jsonResponse({ success: false, error: "Identity not found" }, 404);

            const token = identity.platform_credentials?.find((c: any) => c.credential_type === "access_token" && c.is_active)?.credential_value;
            if (!token) return jsonResponse({ success: false, error: "No active token" }, 400);

            const fbAccs = await fbRequest("/me/adaccounts", token, {
                fields: "id,name,account_status,currency,timezone_name,business_id,business_name",
                limit: "500"
            });
            if (fbAccs.error) return jsonResponse({ success: false, error: fbAccs.error.message }, 400);
            
            // Fetch branches for auto-matching
            const { data: branches } = await supabase.from("branches").select("id, name, auto_match_keywords").eq("user_id", auth.userId);
            
            const results = [];
            for (const acc of (fbAccs.data || [])) {
                // Auto Match Logic
                let branchIdToAssign = null;
                if (branches && branches.length > 0) {
                    const accName = acc.name?.toLowerCase() || "";
                    for (const b of branches) {
                        const keywords = b.auto_match_keywords || [];
                        if (keywords.some((k: string) => k && accName.includes(k.toLowerCase()))) {
                            branchIdToAssign = b.id;
                            break;
                        }
                    }
                }

                const { data } = await supabase.from("platform_accounts").upsert({
                    platform_identity_id: identity.id,
                    platform_id: identity.platform_id,
                    external_id: acc.id,
                    name: acc.name,
                    currency: acc.currency,
                    timezone: acc.timezone_name,
                    account_status: acc.account_status.toString(),
                    platform_data: acc,
                    branch_id: branchIdToAssign,
                    synced_at: new Date().toISOString()
                }, { onConflict: "platform_id,external_id" }).select().single();
                results.push(data);
            }
            return jsonResponse({ success: true, result: { count: results.length, accounts: results } });
        }

        // Delete Identity
        if (subPathSegments[0] === 'identities' && subPathSegments[1] && method === "DELETE") {
            const id = subPathSegments[1];
            await supabase.from("platform_identities").delete().eq("id", id).eq("user_id", auth.userId);
            return jsonResponse({ success: true });
        }

        return jsonResponse({ success: false, error: "Not Found", path }, 404);
    } catch (error: any) {
        return jsonResponse({ success: false, error: error.message }, 500);
    }
});
