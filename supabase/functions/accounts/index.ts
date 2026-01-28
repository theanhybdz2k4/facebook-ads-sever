/**
 * Accounts (Identities) Edge Function - v20
 * Cập nhật: Thông báo lỗi tiếng Việt, Fix Routing, Forced Connection
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";
import { verify } from "https://deno.land/x/djwt@v3.0.1/mod.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const JWT_SECRET = Deno.env.get("JWT_SECRET");
const supabase = createClient(supabaseUrl, supabaseKey);

const FB_BASE_URL = "https://graph.facebook.com/v23.0";

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
        id: i.id, userId: i.user_id, platformId: i.platform_id, externalId: i.external_id,
        name: i.name, isValid: i.is_valid, createdAt: i.created_at, updatedAt: i.updated_at,
        platform: i.platforms ? { id: i.platforms.id, code: i.platforms.code, name: i.platforms.name } : null,
        _count: { accounts: i.platform_accounts?.length || 0 }
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
    const segments = url.pathname.split("/").filter(Boolean);
    const funcIndex = segments.indexOf("accounts");
    const subPathSegments = funcIndex !== -1 ? segments.slice(funcIndex + 1) : segments;
    const path = "/" + subPathSegments.join("/");
    const method = req.method;

    try {
        // List Identities
        if ((path === "/identities" || path === "/identities/") && method === "GET") {
            const { data, error } = await supabase.from("platform_identities").select("*, platforms(*), platform_accounts(id)").eq("user_id", auth.userId);
            if (error) throw error;
            return jsonResponse({ success: true, result: data.map(mapIdentity) });
        }

        // Connect
        if ((path === "/connect" || path === "/connect/") && method === "POST") {
            const body = await req.json();
            const { platformCode, token, name } = body;
            const { data: platform } = await supabase.from("platforms").select("*").eq("code", platformCode).single();
            if (!platform) return jsonResponse({ success: false, error: "Platform not found" }, 404);
            if (!token) return jsonResponse({ success: false, error: "Missing token" }, 400);

            let fbUserId = null;
            let fbUserName = name || "Facebook User";
            const fbMe = await fbRequest("/me", token, { fields: "id,name" });

            if (fbMe.error) {
                console.warn(`[Connect] FB Error (Forcing):`, JSON.stringify(fbMe.error));
                const { data: existing } = await supabase.from("platform_identities").select("id, external_id").eq("user_id", auth.userId).eq("name", fbUserName).eq("platform_id", platform.id).maybeSingle();
                fbUserId = existing?.external_id || `forced_${auth.userId}_${Date.now()}`;
            } else {
                fbUserId = fbMe.id;
                fbUserName = name || fbMe.name;
            }

            const { data: identity, error: idError } = await supabase.from("platform_identities").upsert({
                user_id: auth.userId, platform_id: platform.id, external_id: fbUserId, name: fbUserName,
                is_valid: !fbMe.error, created_at: new Date().toISOString(), updated_at: new Date().toISOString()
            }, { onConflict: "platform_id,external_id" }).select().single();
            if (idError) throw idError;

            await supabase.from("platform_credentials").upsert({
                platform_identity_id: identity.id, credential_type: "access_token", credential_value: token, is_active: true
            }, { onConflict: "platform_identity_id,credential_type" });

            return jsonResponse({ success: true, result: mapIdentity(identity) });
        }

        // Sync Sub-Accounts
        if (path.includes("/sync-accounts")) {
            const identIndex = subPathSegments.indexOf("identities");
            const identityId = identIndex !== -1 ? subPathSegments[identIndex + 1] : null;
            if (!identityId) return jsonResponse({ success: false, error: "Identity ID missing" }, 400);

            const logs: string[] = [];
            const log = (msg: string) => { console.log(msg); logs.push(msg); };
            const errorLog = (msg: string, err: any) => { console.error(msg, err); logs.push(`ERROR: ${msg} ${JSON.stringify(err)}`); };

            log(`[Sync] Request: identityId=${identityId}, userId=${auth.userId}`);

            const { data: identity } = await supabase.from("platform_identities").select("*").eq("id", identityId).eq("user_id", auth.userId).single();
            if (!identity) {
                log(`[Sync] Identity not found`);
                return jsonResponse({ success: false, error: "Identity not found", logs }, 404);
            }

            const { data: creds } = await supabase.from("platform_credentials").select("credential_value").eq("platform_identity_id", identity.id).eq("credential_type", "access_token").eq("is_active", true).maybeSingle();
            const token = creds?.credential_value;

            log(`[Sync] Token found: ${!!token}`);

            if (!token) return jsonResponse({ success: false, error: "Không tìm thấy Access Token hợp lệ trong DB.", logs }, 400);

            const fbAccs = await fbRequest("/me/adaccounts", token, { fields: "id,name,account_status,currency,timezone_name,business_id,business_name", limit: "500" });

            if (fbAccs.error) {
                errorLog(`[Sync] FB Error Response`, fbAccs);
                let userFriendlyError = fbAccs.error.message;
                if (fbAccs.error.code === 190) userFriendlyError = "Token Facebook đã hết hạn hoặc bạn đã đăng xuất. Vui lòng lấy token mới và kết nối lại.";
                return jsonResponse({ success: false, error: userFriendlyError, fbError: fbAccs.error, diagnostic: "Facebook từ chối Token này.", logs }, 400);
            }

            log(`[Sync] FB Data Count: ${(fbAccs.data || []).length}`);

            const { data: branches } = await supabase.from("branches").select("id, name, auto_match_keywords").eq("user_id", auth.userId);

            // Get existing accounts to PRESERVE branch_id
            const { data: existingAccounts } = await supabase
                .from("platform_accounts")
                .select("external_id, branch_id")
                .eq("platform_identity_id", identity.id);
            const existingBranchMap = new Map(existingAccounts?.map(a => [a.external_id, a.branch_id]));

            const results = [];
            for (const acc of (fbAccs.data || [])) {
                // Priority: 1. Existing branch_id, 2. Keyword matching
                const existingBranchId = existingBranchMap.get(acc.id);
                let branchIdToAssign = existingBranchId || null;

                if (!branchIdToAssign && branches) {
                    const accName = acc.name?.toLowerCase() || "";
                    for (const b of branches) {
                        const keywords = Array.isArray(b.auto_match_keywords) ? b.auto_match_keywords : [];
                        if (keywords.some((k: string) => accName.includes(k.toLowerCase()))) {
                            branchIdToAssign = b.id; break;
                        }
                    }
                }

                const upsertData = {
                    platform_identity_id: identity.id, platform_id: identity.platform_id, external_id: acc.id, name: acc.name,
                    currency: acc.currency, timezone: acc.timezone_name, account_status: acc.account_status.toString(),
                    platform_data: acc, branch_id: branchIdToAssign, synced_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                };

                log(`[Sync] Upserting: ${acc.id}`);

                const { data, error: upsertError } = await supabase.from("platform_accounts").upsert(upsertData, { onConflict: "platform_id,external_id" }).select().single();

                if (upsertError) {
                    errorLog(`[Sync] Upsert Error for ${acc.id}`, upsertError);
                } else {
                    results.push(data);
                }
            }
            log(`[Sync] Saved ${results.length} accounts.`);
            return jsonResponse({ success: true, result: { count: results.length, accounts: results }, logs, fbDebug: fbAccs });
        }

        // Update Token (Change Token mechanism)
        if (path.includes("/update-token") && method === "POST") {
            const identIndex = subPathSegments.indexOf("identities");
            const identityId = identIndex !== -1 ? subPathSegments[identIndex + 1] : null;
            if (!identityId) return jsonResponse({ success: false, error: "Identity ID missing" }, 400);

            const body = await req.json();
            const { token } = body;
            if (!token) return jsonResponse({ success: false, error: "Token is required" }, 400);

            // Verify identity ownership
            const { data: identity } = await supabase.from("platform_identities").select("id").eq("id", identityId).eq("user_id", auth.userId).single();
            if (!identity) return jsonResponse({ success: false, error: "Identity not found or unauthorized" }, 404);

            // Update credential
            const { error: credError } = await supabase.from("platform_credentials").upsert({
                platform_identity_id: identity.id,
                credential_type: "access_token",
                credential_value: token,
                is_active: true
            }, { onConflict: "platform_identity_id,credential_type" });

            if (credError) throw credError;

            // Optional: Mark identity as valid again since we have a new token
            await supabase.from("platform_identities").update({ is_valid: true, updated_at: new Date().toISOString() }).eq("id", identity.id);

            return jsonResponse({ success: true, message: "Token updated successfully" });
        }

        // Delete
        if (subPathSegments[0] === 'identities' && subPathSegments[1] && method === "DELETE") {
            const id = subPathSegments[1];
            await supabase.from("platform_identities").delete().eq("id", id).eq("user_id", auth.userId);
            return jsonResponse({ success: true });
        }

        return jsonResponse({ error: "Endpoint không tồn tại", path, segments: subPathSegments }, 404);
    } catch (error: any) { return jsonResponse({ success: false, error: error.message }, 500); }
});
