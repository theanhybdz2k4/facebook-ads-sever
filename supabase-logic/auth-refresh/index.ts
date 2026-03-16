/**
 * Auth - Refresh Token
 * Exchange refresh token for new access token
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";
import { create } from "https://deno.land/x/djwt@v3.0.1/mod.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const JWT_SECRET = Deno.env.get("JWT_SECRET") || "your-secret-key";
const supabase = createClient(supabaseUrl, supabaseKey);

const corsHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const jsonResponse = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: corsHeaders });

async function getKey(): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  return await crypto.subtle.importKey(
    "raw",
    encoder.encode(JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

function generateUUID(): string {
  return crypto.randomUUID();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  try {
    const { refreshToken } = await req.json();

    if (!refreshToken) {
      return jsonResponse({ success: false, error: "Refresh token is required" }, 400);
    }

    // Find refresh token
    const { data: tokenRecord, error: tokenError } = await supabase
      .from("refresh_tokens")
      .select("id, user_id, expires_at, users (id, email, name)")
      .eq("token", refreshToken)
      .single();

    if (tokenError || !tokenRecord) {
      return jsonResponse({ success: false, error: "Invalid refresh token" }, 401);
    }

    // Check expiration
    if (new Date() > new Date(tokenRecord.expires_at)) {
      await supabase.from("refresh_tokens").delete().eq("id", tokenRecord.id);
      return jsonResponse({ success: false, error: "Refresh token expired" }, 401);
    }

    // Delete old refresh token
    await supabase.from("refresh_tokens").delete().eq("id", tokenRecord.id);

    const user = tokenRecord.users;

    // Generate new JWT
    const key = await getKey();
    const now = Math.floor(Date.now() / 1000);
    const accessToken = await create(
      { alg: "HS256", typ: "JWT" },
      {
        sub: user.id.toString(),
        email: user.email,
        iat: now,
        exp: now + 3600,
      },
      key
    );

    // Generate new refresh token
    const newRefreshToken = generateUUID();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    // Save tokens to DB
    const [authRes, refreshRes] = await Promise.all([
      supabase.from("auth_tokens").insert({
        user_id: user.id,
        token: accessToken,
        expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
        is_active: true
      }),
      supabase.from("refresh_tokens").insert({
        user_id: user.id,
        token: newRefreshToken,
        expires_at: expiresAt.toISOString(),
      })
    ]);

    if (authRes.error) {
      console.error("[AuthRefresh] auth_tokens insert error:", authRes.error);
      return jsonResponse({ success: false, error: `Failed to save auth token: ${authRes.error.message}` }, 500);
    }
    if (refreshRes.error) {
      console.error("[AuthRefresh] refresh_tokens insert error:", refreshRes.error);
      return jsonResponse({ success: false, error: `Failed to save refresh token: ${refreshRes.error.message}` }, 500);
    }

    return jsonResponse({
      success: true,
      data: {
        accessToken,
        refreshToken: newRefreshToken,
        expiresIn: 3600,
      },
    });
  } catch (error: any) {
    console.error("Error:", error);
    return jsonResponse({ success: false, error: error.message }, 500);
  }
});

