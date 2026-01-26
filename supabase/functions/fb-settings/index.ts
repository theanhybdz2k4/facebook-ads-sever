
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";
import { verify } from "https://deno.land/x/djwt@v3.0.1/mod.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const supabase = createClient(supabaseUrl, supabaseKey);

const corsHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-client-info, apikey",
};

const jsonResponse = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: corsHeaders });

const JWT_SECRET = Deno.env.get("JWT_SECRET") || "heSq8+qsjA5sN/4UM6HJ/fg5t8Pjt/9r/tOAy5iVHyQ=";

// Performance Optimization: Cache the crypto key globally
let memoizedKey: CryptoKey | null = null;
async function getKey(): Promise<CryptoKey> {
  if (memoizedKey) return memoizedKey;
  const encoder = new TextEncoder();
  memoizedKey = await crypto.subtle.importKey("raw", encoder.encode(JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return memoizedKey;
}

// Helper to get user from token
async function getUser(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.substring(7);

  try {
    const key = await getKey();
    const payload = await verify(token, key);
    if (!payload || !payload.sub) return null;

    return { id: Number(payload.sub) };
  } catch (err) {
    console.error("JWT Verify Error:", err);
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  try {
    const url = new URL(req.url);

    // Auth check
    const user = await getUser(req);
    if (!user) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }
    const userId = user.id;

    // --- GET / ---
    if (req.method === "GET" && !url.searchParams.has('estimate')) {
      // PERFORMANCE: Parallelize settings and identity fetching
      const [settingsRes, identitiesRes] = await Promise.all([
        supabase.from("cron_settings").select("*").eq("user_id", userId),
        supabase.from("platform_identities").select("id").eq("user_id", userId)
      ]);

      if (settingsRes.error) throw settingsRes.error;

      const identityIds = (identitiesRes.data || []).map((i: any) => i.id);
      let accountCount = 0;

      if (identityIds.length > 0) {
        // Fetch account count
        const { count } = await supabase
          .from("platform_accounts")
          .select("*", { count: 'exact', head: true })
          .in("platform_identity_id", identityIds);
        accountCount = count || 0;
      }

      const mappedSettings = (settingsRes.data || []).map((s: any) => ({
        id: s.id,
        userId: s.user_id,
        cronType: s.cron_type,
        allowedHours: s.allowed_hours,
        enabled: s.enabled,
        createdAt: s.created_at,
        updatedAt: s.updated_at
      }));

      return jsonResponse({
        result: {
          settings: mappedSettings,
          adAccountCount: accountCount
        }
      });
    }

    // --- GET /estimated-calls (mapped to ?estimate=true) ---
    if (req.method === "GET" && url.searchParams.has('estimate')) {
      // PERFORMANCE: Parallelize identities and settings fetching
      const [identitiesRes, settingsRes] = await Promise.all([
        supabase.from("platform_identities").select("id").eq("user_id", userId),
        supabase.from("cron_settings").select("*").eq("user_id", userId).eq("enabled", true)
      ]);

      const identityIds = (identitiesRes.data || []).map((i: any) => i.id);
      let adAccountCount = 0;

      if (identityIds.length > 0) {
        const { count } = await supabase
          .from("platform_accounts")
          .select("*", { count: 'exact', head: true })
          .in("platform_identity_id", identityIds)
          .eq('account_status', 'ACTIVE');
        adAccountCount = count || 0;
      }

      const settings = settingsRes.data || [];
      let totalCalls = 0;
      const perHour: Record<number, number> = {};
      for (let i = 0; i < 24; i++) perHour[i] = 0;

      for (const setting of settings) {
        let callsPerExecution = 0;
        const type = setting.cron_type;

        if (type.includes('insight') || type === 'full') {
          callsPerExecution = adAccountCount;
          if (type === 'full') callsPerExecution *= 4;
        } else {
          callsPerExecution = adAccountCount;
        }

        const hours = setting.allowed_hours || [];
        totalCalls += callsPerExecution * hours.length;

        for (const hour of hours) {
          perHour[hour] = (perHour[hour] || 0) + callsPerExecution;
        }
      }

      return jsonResponse({
        result: {
          totalCalls,
          perHour,
          warning: totalCalls > 5000 ? 'Quota warning' : undefined,
          adAccountCount
        }
      });
    }

    // --- POST / (Upsert) ---
    if (req.method === "POST") {
      const body = await req.json();
      const { cronType, allowedHours, enabled } = body;

      const { data, error } = await supabase.from("cron_settings").upsert({
        user_id: userId,
        cron_type: cronType,
        allowed_hours: allowedHours,
        enabled: enabled,
        updated_at: new Date().toISOString(),
        created_at: new Date().toISOString()
      }, { onConflict: 'user_id, cron_type' }).select().single();

      if (error) {
        console.error("Supabase Upsert Error:", error);
        return jsonResponse({ error: error.message, details: error }, 500);
      }

      return jsonResponse({
        result: {
          id: data.id,
          userId: data.user_id,
          cronType: data.cron_type,
          allowedHours: data.allowed_hours,
          enabled: data.enabled
        }
      });
    }

    // --- DELETE / ---
    if (req.method === "DELETE") {
      const cronType = url.searchParams.get("type");
      if (!cronType) return jsonResponse({ error: "Missing type param" }, 400);

      const { error } = await supabase.from("cron_settings").delete().eq("user_id", userId).eq("cron_type", cronType);

      if (error) {
        console.error("Supabase Delete Error:", error);
        return jsonResponse({ error: error.message }, 500);
      }
      return jsonResponse({ result: { success: true } });
    }

    return jsonResponse({ error: "Not Found" }, 404);

  } catch (error: any) {
    console.error("Global Error:", error);
    return jsonResponse({ error: error.message, stack: error.stack }, 500);
  }
});
