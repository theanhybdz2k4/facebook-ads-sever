/**
 * Unified Auth Function - PERFORMANCE OPTIMIZED & FIXED
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";
import * as bcrypt from "https://esm.sh/bcryptjs@2.4.3";
import { create, verify } from "https://deno.land/x/djwt@v3.0.1/mod.ts";

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

async function getKey(): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  return await crypto.subtle.importKey("raw", encoder.encode(JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function verifyToken(authHeader: string | null): Promise<any | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.substring(7);
  try {
    const key = await getKey();
    return await verify(token, key);
  } catch { return null; }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  const url = new URL(req.url);
  // THE FIX: More robust path detection
  const path = url.pathname;
  
  try {
    if (path.endsWith("/login") && req.method === "POST") {
      const { email, password } = await req.json();
      const { data: user } = await supabase.from("users").select("id, email, password, name, is_active").eq("email", email).single();
      
      if (!user || !user.is_active) {
        return jsonResponse({ success: false, error: "Invalid credentials or account inactive" }, 401);
      }

      // ESM.sh imports can sometimes have different structures for default exports
      const compare = (bcrypt as any).compare || (bcrypt as any).default?.compare;
      if (!compare) {
        throw new Error("bcrypt.compare is not available in the current import");
      }

      const isMatch = await compare(password, user.password);
      if (!isMatch) {
        return jsonResponse({ success: false, error: "Invalid credentials" }, 401);
      }
      return await generateTokenResponse(user);
    }

    if (path.endsWith("/me") && req.method === "GET") {
      const payload = await verifyToken(req.headers.get("Authorization"));
      if (!payload) return jsonResponse({ success: false, error: "Unauthorized" }, 401);
      
      const { data: user } = await supabase.from("users")
        .select("id, email, name, is_active")
        .eq("id", payload.sub)
        .single();
        
      if (!user) return jsonResponse({ success: false, error: "User not found" }, 404);
      return jsonResponse({ success: true, data: user });
    }

    if (path.endsWith("/refresh") && req.method === "POST") {
      const { refreshToken } = await req.json();
      const { data: record } = await supabase.from("refresh_tokens").select("id, user_id, expires_at").eq("token", refreshToken).single();
      if (!record || new Date() > new Date(record.expires_at)) return jsonResponse({ success: false, error: "Invalid token" }, 401);
      
      const { data: user } = await supabase.from("users").select("id, email, name, is_active").eq("id", record.user_id).single();
      await supabase.from("refresh_tokens").delete().eq("id", record.id);
      return await generateTokenResponse(user);
    }

    return jsonResponse({ success: false, error: `Auth Function: Not Found (${path})` }, 404);
  } catch (error: any) {
    console.error(`[Auth Error] ${path}:`, error);
    return jsonResponse({ 
      success: false, 
      error: error.message,
      stack: error.stack,
      path: path
    }, 500);
  }
});

async function generateTokenResponse(user: any) {
  const key = await getKey();
  const now = Math.floor(Date.now() / 1000);
  const accessToken = await create({ alg: "HS256", typ: "JWT" }, { sub: user.id.toString(), email: user.email, iat: now, exp: now + 3600 }, key);
  const refreshToken = crypto.randomUUID();
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);
  await supabase.from("refresh_tokens").insert({ user_id: user.id, token: refreshToken, expires_at: expiresAt.toISOString() });
  return jsonResponse({ success: true, data: { accessToken, refreshToken, expiresIn: 3600, user: { id: user.id, email: user.email, name: user.name } } });
}
