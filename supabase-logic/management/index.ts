/**
 * Management Edge Function - Harmonized with NestJS
 * Handles: cron-settings, telegram, api-tokens
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
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, PATCH",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const jsonResponse = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: corsHeaders });

// Unified Auth Function
async function verifyAuth(req: Request) {
    const authHeader = req.headers.get("Authorization");
    const serviceKeyHeader = req.headers.get("x-service-key") || req.headers.get("x-master-key");
    const masterKey = Deno.env.get("MASTER_KEY") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const authSecret = Deno.env.get("AUTH_SECRET") || "";

    if (serviceKeyHeader === serviceKey || (masterKey && serviceKeyHeader === masterKey)) {
        return { userId: 1, isServiceRole: true };
    }

    if (authHeader?.startsWith("Bearer ")) {
        const token = authHeader.substring(7).trim();
        if ((serviceKey !== "" && token === serviceKey) || (masterKey !== "" && token === masterKey) || (authSecret !== "" && token === authSecret)) {
            return { userId: 1, isServiceRole: true };
        }

        // PRIORITY: Check custom auth_tokens table first
        try {
            const { data: tokenData } = await supabase
                .from("auth_tokens")
                .select("user_id, expires_at, is_active")
                .eq("token", token)
                .single();

            if (tokenData) {
                if (tokenData.is_active === false) return null;
                if (tokenData.expires_at && new Date(tokenData.expires_at) < new Date()) {
                    console.log("Auth: Token expired");
                    return null;
                }
                return { userId: tokenData.user_id, isServiceRole: true };
            }
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

function mapCron(c: any) {
    return {
        id: c.id,
        userId: c.user_id,
        cronType: c.cron_type,
        allowedHours: c.allowed_hours,
        enabled: c.enabled,
        createdAt: c.created_at,
        updatedAt: c.updated_at
    };
}

function mapBot(b: any) {
    return {
        id: b.id,
        userId: b.user_id,
        adAccountId: b.ad_account_id,
        botToken: b.bot_token,
        botName: b.bot_name,
        botUsername: b.bot_username,
        isActive: b.is_active,
        telegramLink: b.bot_username ? `https://t.me/${b.bot_username}` : null,
        adAccount: b.platform_accounts ? { id: b.platform_accounts.id, name: b.platform_accounts.name } : null,
        subscriberCount: b.telegram_subscribers?.length || 0
    };
}

function mapToken(t: any) {
    return {
        token: t.token,
        userId: t.user_id,
        name: t.name,
        expiresAt: t.expires_at,
        isActive: t.is_active,
        createdAt: t.created_at
    };
}

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

    const auth = await verifyAuth(req);
    if (!auth) return jsonResponse({ success: false, error: "Unauthorized" }, 401);

    const url = new URL(req.url);
    let path = url.pathname;
    const segments = path.split("/").filter(Boolean);
    if (segments[0] === "management") segments.shift();
    path = "/" + segments.join("/");

    const method = req.method;

    try {
        // --- CRON SETTINGS ---
        if (path.includes("/cron/settings")) {
            if (method === "GET") {
                const { data } = await supabase.from("cron_settings").select("*").eq("user_id", auth.userId);
                return jsonResponse({ success: true, result: data?.map(mapCron) || [] });
            }
            if (method === "POST" || method === "PUT" || method === "PATCH") {
                const body = await req.json();
                const { cronType, allowedHours, enabled } = body;
                const { data, error } = await supabase.from("cron_settings").upsert({
                    user_id: auth.userId,
                    cron_type: cronType || path.split("/").pop(),
                    allowed_hours: allowedHours,
                    enabled: enabled ?? true
                }, { onConflict: "user_id,cron_type" }).select().single();
                if (error) throw error;
                return jsonResponse({ success: true, result: mapCron(data) });
            }
            if (method === "DELETE") {
                const cronType = path.split("/").pop();
                await supabase.from("cron_settings").delete().eq("user_id", auth.userId).eq("cron_type", cronType);
                return jsonResponse({ success: true });
            }
        }

        // --- TELEGRAM ---
        if (path.includes("/telegram/bots")) {
            const parts = path.split("/");
            const botId = parseInt(parts[parts.indexOf("bots") + 1]);

            if (method === "GET") {
                if (botId) {
                    const { data } = await supabase.from("telegram_bots").select("*, platform_accounts(*), telegram_subscribers(*)").eq("id", botId).eq("user_id", auth.userId).single();
                    return jsonResponse({ success: true, result: mapBot(data) });
                }
                const { data } = await supabase.from("telegram_bots").select("*, platform_accounts(*), telegram_subscribers(*)").eq("user_id", auth.userId);
                return jsonResponse({ success: true, result: { bots: data?.map(mapBot) || [] } });
            }
            if (method === "POST") {
                const { botToken, botName, adAccountId } = await req.json();
                const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`).then(r => r.json());
                if (!tgRes.ok) return jsonResponse({ success: false, error: "Invalid bot token" }, 400);

                const { data, error } = await supabase.from("telegram_bots").insert({
                    user_id: auth.userId,
                    bot_token: botToken,
                    bot_name: botName,
                    bot_username: tgRes.result.username,
                    ad_account_id: adAccountId
                }).select().single();
                if (error) throw error;
                return jsonResponse({ success: true, bot: mapBot(data) });
            }
            if (method === "DELETE") {
                await supabase.from("telegram_bots").delete().eq("id", botId).eq("user_id", auth.userId);
                return jsonResponse({ success: true });
            }
        }

        // --- API TOKENS ---
        if (path === "/api-tokens" || path.startsWith("/api-tokens/")) {
            if (method === "GET") {
                const { data } = await supabase.from("auth_tokens").select("*").eq("user_id", auth.userId).order("created_at", { ascending: false });
                return jsonResponse({ success: true, result: data?.map(mapToken) || [] });
            }
            if (method === "POST") {
                const { name, expiresAt } = await req.json();
                if (!name) return jsonResponse({ success: false, error: "Name is required" }, 400);

                // Generate a random token
                const randomBytes = crypto.getRandomValues(new Uint8Array(32));
                const token = btoa(String.fromCharCode(...randomBytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
                const pref = "cm_"; // colorme prefix
                const finalToken = pref + token;

                const { data, error } = await supabase.from("auth_tokens").insert({
                    token: finalToken,
                    user_id: auth.userId,
                    name: name,
                    expires_at: expiresAt || null,
                    is_active: true
                }).select().single();

                if (error) throw error;
                return jsonResponse({ success: true, result: mapToken(data) });
            }
            if (method === "DELETE") {
                const segments = path.split("/").filter(Boolean);
                const tokenToDelete = segments[segments.length - 1];
                if (!tokenToDelete || tokenToDelete === "api-tokens") {
                    return jsonResponse({ success: false, error: "Token required" }, 400);
                }
                const { error } = await supabase.from("auth_tokens").delete().eq("user_id", auth.userId).eq("token", tokenToDelete);
                if (error) throw error;
                return jsonResponse({ success: true });
            }
        }

        return jsonResponse({ success: false, error: "Not Found", path }, 404);
    } catch (error: any) {
        return jsonResponse({ success: false, error: error.message }, 500);
    }
});
