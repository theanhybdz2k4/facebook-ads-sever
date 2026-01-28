/**
 * Worker Edge Function - Harmonized with NestJS
 * Handles: background sync triggers
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
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
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

async function triggerBackground(func: string, payload: any) {
  const url = `${supabaseUrl}/functions/v1/${func}`;
  try {
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${supabaseKey}`
      },
      body: JSON.stringify(payload)
    }).catch(e => console.error(`Async trigger failed for ${func}:`, e));
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const auth = await verifyAuth(req);
  if (!auth) return jsonResponse({ success: false, error: "Unauthorized" }, 401);

  const url = new URL(req.url);
  let path = url.pathname;
  // Handle Supabase function name in path
  const segments = path.split("/").filter(Boolean);
  if (segments[0] === "worker") segments.shift();
  path = "/" + segments.join("/");

  const method = req.method;

  try {
    // Sync Account (One)
    if (path.includes("/sync/account/")) {
      const accountId = path.split("/").pop();
      const force = url.searchParams.get("force") === "true";

      triggerBackground("fb-sync-campaigns", { accountId, force });
      triggerBackground("fb-sync-ads", { accountId, force });
      triggerBackground("fb-sync-insights", { accountId, force, granularity: "BOTH" });
      triggerBackground("fb-sync-creatives", { accountId });

      return jsonResponse({ success: true, message: "Sync triggered" });
    }

    // Sync Branch
    if (path.includes("/sync/branch/")) {
      const branchId = path.split("/").pop();
      const { data: accounts } = await supabase.from("platform_accounts").select("id").eq("branch_id", branchId);

      if (accounts) {
        for (const acc of accounts) {
          triggerBackground("fb-sync-campaigns", { accountId: acc.id });
          triggerBackground("fb-sync-ads", { accountId: acc.id });
          triggerBackground("fb-sync-insights", { accountId: acc.id, granularity: "BOTH" });
        }
      }
      return jsonResponse({ success: true, message: "Sync triggered" });
    }

    return jsonResponse({ success: false, error: "Not Found", path }, 404);
  } catch (error: any) {
    return jsonResponse({ success: false, error: error.message }, 500);
  }
});
