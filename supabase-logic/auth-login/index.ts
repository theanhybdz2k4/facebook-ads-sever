/**
 * Auth - Login
 * Returns JWT access token and refresh token
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";
import * as bcrypt from "https://esm.sh/bcryptjs@2.4.3";
import { create, getNumericDate } from "https://deno.land/x/djwt@v3.0.1/mod.ts";

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

// Create crypto key from secret
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
    const { email, password } = await req.json();

    if (!email || !password) {
      return jsonResponse({ success: false, error: "Email and password are required" }, 400);
    }

    // Find user
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("id, email, password, name, is_active")
      .eq("email", email)
      .single();

    if (userError || !user) {
      return jsonResponse({ success: false, error: "Invalid credentials" }, 401);
    }

    if (!user.is_active) {
      return jsonResponse({ success: false, error: "Account is disabled" }, 401);
    }

    // Verify password
    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      return jsonResponse({ success: false, error: "Invalid credentials" }, 401);
    }

    // Generate JWT
    const key = await getKey();
    const now = Math.floor(Date.now() / 1000);
    const accessToken = await create(
      { alg: "HS256", typ: "JWT" },
      {
        sub: user.id.toString(),
        email: user.email,
        iat: now,
        exp: now + 3600, // 1 hour
      },
      key
    );

    // Generate refresh token
    const refreshToken = generateUUID();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    // Save tokens to DB
    await Promise.all([
      supabase.from("auth_tokens").insert({
        user_id: user.id,
        token: accessToken,
        expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
        is_active: true
      }),
      supabase.from("refresh_tokens").insert({
        user_id: user.id,
        token: refreshToken,
        expires_at: expiresAt.toISOString(),
      })
    ]);

    return jsonResponse({
      success: true,
      data: {
        accessToken,
        refreshToken,
        expiresIn: 3600,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
        },
      },
    });
  } catch (error: any) {
    console.error("Error:", error);
    return jsonResponse({ success: false, error: error.message }, 500);
  }
});

