/**
 * Unified Auth Function - PERFORMANCE OPTIMIZED & FIXED
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";
import * as bcrypt from "https://esm.sh/bcryptjs@2.4.3";
import { create, verify } from "https://deno.land/x/djwt@v3.0.1/mod.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const JWT_SECRET = Deno.env.get("JWT_SECRET");
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

// CRITICAL: DO NOT REMOVE THIS AUTH LOGIC. 
// IT PRIORITIZES auth_tokens TABLE FOR CUSTOM AUTHENTICATION.
async function verifyAuth(req: Request) {
  const authHeader = req.headers.get("Authorization");
  const serviceKeyHeader = req.headers.get("x-service-key") || req.headers.get("x-master-key");
  const masterKey = Deno.env.get("MASTER_KEY") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const authSecret = Deno.env.get("AUTH_SECRET") || "";

  if (serviceKeyHeader === serviceKey || serviceKeyHeader === masterKey) {
    return { userId: 1, email: "system@internal" };
  }

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.substring(7).trim();
    if ((serviceKey !== "" && token === serviceKey) || (masterKey !== "" && token === masterKey) || (authSecret !== "" && token === authSecret)) {
      return { userId: 1, email: "system@internal" };
    }

    // PRIORITY: Check custom auth_tokens table first
    try {
      const { data: tokenData } = await supabase.from("auth_tokens").select("user_id").eq("token", token).single();
      if (tokenData) {
        const { data: userData } = await supabase.from("users").select("email").eq("id", tokenData.user_id).single();
        return { userId: tokenData.user_id, email: userData?.email || "" };
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
      const email = (payload as any).email || "";
      const userIdNum = parseInt(sub, 10);
      if (!isNaN(userIdNum)) return { userId: userIdNum, email };
      return { userId: sub as any, email };
    } catch (e: any) {
      console.log("Auth: JWT verify failed:", e.message);
    }
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  const url = new URL(req.url);
  const path = url.pathname;

  console.log(`[Auth Request] ${req.method} ${path}`);

  try {
    if (path.endsWith("/login") && req.method === "POST") {
      const body = await req.json();
      const { email, password } = body;
      console.log(`[Login] Attempting login for email: ${email}`);

      const { data: user, error: fetchError } = await supabase.from("users").select("id, email, password, name, is_active, avatar_url, gemini_api_key").eq("email", email).single();

      if (fetchError) {
        console.error(`[Login] Database fetch error for ${email}:`, fetchError);
        return jsonResponse({ success: false, error: "Invalid credentials" }, 401);
      }

      if (!user) {
        console.warn(`[Login] User not found in DB: ${email}`);
        return jsonResponse({ success: false, error: "Invalid credentials" }, 401);
      }

      console.log(`[Login] Found user ${user.id}, is_active: ${user.is_active}`);

      if (!user.is_active) {
        console.warn(`[Login] User inactive: ${email}`);
        return jsonResponse({ success: false, error: "Account inactive" }, 401);
      }

      const compare = (bcrypt as any).compare || (bcrypt as any).default?.compare;
      if (!compare) {
        console.error("[Login] FATAL: bcrypt.compare not found in imports");
        throw new Error("bcrypt.compare is not available");
      }

      console.log(`[Login] Comparing password for ${email}. Hash from DB length: ${user.password.length}`);


      console.log(`[Login] Proceeding with bcrypt.compare...`);
      const isMatch = await compare(password, user.password);
      console.log(`[Login] Bcrypt match result for ${email}: ${isMatch ? 'SUCCESS' : 'PASSWORD_FAIL'}`);

      if (!isMatch) {
        return jsonResponse({ success: false, error: "Invalid credentials" }, 401);
      }

      return await generateTokenResponse(user);
    }

    if (path.endsWith("/me") && req.method === "GET") {
      const auth = await verifyAuth(req);
      if (!auth) return jsonResponse({ success: false, error: "Unauthorized" }, 401);

      const { data: user } = await supabase.from("users")
        .select("id, email, name, is_active, avatar_url, gemini_api_key")
        .eq("id", auth.userId)
        .single();

      if (!user) return jsonResponse({ success: false, error: "User not found" }, 404);
      return jsonResponse({ success: true, data: user });
    }

    if (path.endsWith("/profile") && req.method === "POST") {
      const auth = await verifyAuth(req);
      if (!auth) return jsonResponse({ success: false, error: "Unauthorized" }, 401);

      const { name, email, avatar_url, gemini_api_key } = await req.json();

      // If email is changing, check for duplicates
      if (email) {
        const { data: existing } = await supabase.from("users").select("id").eq("email", email).single();
        if (existing && existing.id.toString() !== auth.userId.toString()) {
          return jsonResponse({ success: false, error: "Email already in use" }, 409);
        }
      }

      const { data: updated, error } = await supabase.from("users")
        .update({ name, email, avatar_url, gemini_api_key, updated_at: new Date().toISOString() })
        .eq("id", auth.userId)
        .select("id, email, name, avatar_url, gemini_api_key")
        .single();

      if (error) return jsonResponse({ success: false, error: error.message }, 400);
      return jsonResponse({ success: true, data: updated });
    }

    if (path.endsWith("/password") && req.method === "POST") {
      const auth = await verifyAuth(req);
      if (!auth) return jsonResponse({ success: false, error: "Unauthorized" }, 401);

      const { currentPassword, newPassword } = await req.json();
      const { data: user } = await supabase.from("users").select("id, password").eq("id", auth.userId).single();

      if (!user) return jsonResponse({ success: false, error: "User not found" }, 404);

      const compare = (bcrypt as any).compare || (bcrypt as any).default?.compare;
      if (!compare) throw new Error("bcrypt.compare is not available");

      const isMatch = await compare(currentPassword, user.password);
      if (!isMatch) return jsonResponse({ success: false, error: "Current password incorrect" }, 401);

      const hash = (bcrypt as any).hash || (bcrypt as any).default?.hash;
      if (!hash) throw new Error("bcrypt.hash is not available");

      const hashedPassword = await hash(newPassword, 10);

      const { error } = await supabase.from("users")
        .update({ password: hashedPassword, updated_at: new Date().toISOString() })
        .eq("id", auth.userId);

      if (error) return jsonResponse({ success: false, error: error.message }, 400);
      return jsonResponse({ success: true, message: "Password updated successfully" });
    }

    if (path.endsWith("/upload-avatar") && req.method === "POST") {
      const auth = await verifyAuth(req);
      if (!auth) return jsonResponse({ success: false, error: "Unauthorized" }, 401);

      const ct = req.headers.get("content-type") || "";
      console.log(`[Upload Debug] User: ${auth.userId}, Content-Type: ${ct}`);
      
      let formData;
      try {
        formData = await req.formData();
      } catch (err: any) {
        console.error(`[Upload Error] Failed to parse formData. CT: ${ct}`, err);
        return jsonResponse({
          success: false,
          error: `Failed to parse form data: ${err.message}.`,
          debug: { contentType: ct, method: req.method, path }
        }, 400);
      }

      const file = formData.get("file") as File;
      if (!file) {
        console.error("[Upload Error] No file found in formData keys:", Array.from(formData.keys()));
        return jsonResponse({ success: false, error: "No file provided in form data" }, 400);
      }

      // Ensure bucket exists (using service role key which has permissions)
      try {
        const { data: buckets } = await supabase.storage.listBuckets();
        if (!buckets?.find(b => b.name === "avatars")) {
          console.log("[Storage] Creating 'avatars' bucket...");
          await supabase.storage.createBucket("avatars", { public: true });
        }
      } catch (e) {
        console.error("[Storage Error] Failed to check/create bucket:", e);
      }

      const fileExt = file.name ? file.name.split(".").pop() : "png";
      const fileName = `${auth.userId}_${Date.now()}.${fileExt}`;

      const { data, error: uploadError } = await supabase.storage
        .from("avatars")
        .upload(fileName, file, {
          contentType: file.type || "image/png",
          upsert: true
        });

      if (uploadError) {
        console.error("[Upload Error] Supabase Storage error:", uploadError);
        return jsonResponse({ success: false, error: `Storage error: ${uploadError.message}` }, 500);
      }

      const { data: { publicUrl } } = supabase.storage
        .from("avatars")
        .getPublicUrl(fileName);

      return jsonResponse({ success: true, url: publicUrl });
    }

    if (path.endsWith("/users") && req.method === "GET") {
      const auth = await verifyAuth(req);
      if (!auth) return jsonResponse({ success: false, error: "Unauthorized" }, 401);

      const { data: users, error } = await supabase.from("users")
        .select("id, email, name, avatar_url")
        .eq("is_active", true)
        .order("name", { ascending: true });

      if (error) return jsonResponse({ success: false, error: error.message }, 400);
      return jsonResponse({ success: true, result: users });
    }

    if (path.endsWith("/refresh") && req.method === "POST") {
      const { refreshToken } = await req.json();
      const { data: record } = await supabase.from("refresh_tokens").select("id, user_id, expires_at").eq("token", refreshToken).single();
      if (!record || new Date() > new Date(record.expires_at)) return jsonResponse({ success: false, error: "Invalid token" }, 401);

      const { data: user } = await supabase.from("users").select("id, email, password, name, is_active, avatar_url, gemini_api_key").eq("id", record.user_id).single();
      await supabase.from("refresh_tokens").delete().eq("id", record.id);
      return await generateTokenResponse(user);
    }

    return jsonResponse({ success: false, error: `Auth Function: Not Found`, path, method: req.method }, 404);
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
  return jsonResponse({ success: true, data: { accessToken, refreshToken, expiresIn: 3600, user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatar_url, geminiApiKey: user.gemini_api_key } } });
}
