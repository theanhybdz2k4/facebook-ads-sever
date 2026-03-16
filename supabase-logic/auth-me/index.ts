/**
 * Auth - Get Me
 * Returns current user info from JWT token
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
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const jsonResponse = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: corsHeaders });

// Robust Auth Logic (DB-Only: auth_tokens & refresh_tokens)
async function verifyAuth(req: Request) {
  const authHeader = req.headers.get("Authorization");
  const masterKey = Deno.env.get("MASTER_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  // 1. SYSTEM FALLBACK (Service/Master Key)
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.substring(7).trim();
    if ((masterKey && token === masterKey) || (serviceKey && token === serviceKey)) {
      return { userId: 1, isSystem: true, isServiceRole: true };
    }
  }

  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.substring(7).trim();

  // 2. USER AUTH (Database lookup)
  // Check auth_tokens
  try {
    const { data: authToken } = await supabase
      .from("auth_tokens")
      .select("user_id, expires_at, is_active")
      .eq("token", token)
      .maybeSingle();

    if (authToken && authToken.is_active !== false) {
      if (!authToken.expires_at || new Date(authToken.expires_at) > new Date()) {
        return { userId: authToken.user_id, isSystem: false };
      }
    }
  } catch (e: any) {
    console.error("[Auth] auth_tokens check error:", e.message);
  }

  // Check refresh_tokens
  try {
    const { data: refreshToken } = await supabase
      .from("refresh_tokens")
      .select("user_id, expires_at, deleted_at")
      .eq("token", token)
      .maybeSingle();

    if (refreshToken && !refreshToken.deleted_at) {
      if (!refreshToken.expires_at || new Date(refreshToken.expires_at) > new Date()) {
        return { userId: refreshToken.user_id, isSystem: false };
      }
    }
  } catch (e: any) {
    console.error("[Auth] refresh_tokens check error:", e.message);
  }

  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  try {
    const auth = await verifyAuth(req);
    if (!auth) {
      return jsonResponse({ success: false, error: "Unauthorized" }, 401);
    }

    const { data: user, error: userError } = await supabase
      .from("users")
      .select(`
        id, email, name, is_active, created_at,
        platform_identities (
          id, name, external_id, is_valid,
          platforms (name, code)
        )
      `)
      .eq("id", auth.userId)
      .single();

    if (userError || !user) {
      return jsonResponse({ success: false, error: "User not found" }, 404);
    }

    return jsonResponse({
      success: true,
      data: user,
    });
  } catch (error: any) {
    console.error("Error:", error);
    return jsonResponse({ success: false, error: error.message }, 500);
  }
});

