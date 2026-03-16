/**
 * Cron Settings Edge Function
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
    if (!authHeader?.startsWith("Bearer ")) return null;
    const token = authHeader.substring(7);
    try {
        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey("raw", encoder.encode(JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
        const payload = await verify(token, key);
        return { userId: parseInt(payload.sub as string, 10) };
    } catch { return null; }
}

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

    const auth = await verifyAuth(req);
    if (!auth) return jsonResponse({ success: false, error: "Unauthorized" }, 401);

    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    try {
        if (path.includes("/settings")) {
            const parts = path.split("/");
            const cronType = parts.length > 2 ? parts[2] : null;

            if (method === "GET") {
                if (path.includes("/estimated-calls")) {
                    return jsonResponse({ success: true, result: { totalEstimatedCalls: 0 } });
                }
                const { data } = await supabase.from("cron_settings").select("*").eq("user_id", auth.userId);
                return jsonResponse({ success: true, result: data });
            }

            if (method === "POST" || (method === "PUT" && cronType)) {
                const body = await req.json();
                const payload = { ...body, user_id: auth.userId };
                if (cronType) payload.cron_type = cronType;
                const { data } = await supabase.from("cron_settings").upsert(payload, { onConflict: "user_id,cron_type" }).select().single();
                return jsonResponse({ success: true, result: data });
            }

            if (method === "DELETE" && cronType) {
                await supabase.from("cron_settings").delete().eq("user_id", auth.userId).eq("cron_type", cronType);
                return jsonResponse({ success: true });
            }
        }

        return jsonResponse({ success: false, error: "Not Found", path }, 404);
    } catch (error: any) {
        return jsonResponse({ success: false, error: error.message }, 500);
    }
});
