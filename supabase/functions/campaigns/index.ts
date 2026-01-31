/**
 * Campaigns Edge Function - FULL FEATURE COMPATIBILITY
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";
import { verify } from "https://deno.land/x/djwt@v3.0.1/mod.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const JWT_SECRET = Deno.env.get("JWT_SECRET");
const supabase = createClient(supabaseUrl, supabaseKey);

function getVietnamNowISO(): string {
  const vn = new Date(new Date().getTime() + 7 * 60 * 60 * 1000);
  return vn.toISOString().replace('T', ' ').slice(0, 19);
}

const corsHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
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

  // 1. Check Service/Master Key in specialized headers
  if (serviceKeyHeader === serviceKey || (masterKey && serviceKeyHeader === masterKey)) {
    return { userId: 1 };
  }

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.substring(7).trim();

    // 2. Check Service/Master/Auth secrets as Bearer token
    if ((serviceKey && token === serviceKey) ||
      (masterKey && token === masterKey) ||
      (authSecret && token === authSecret)) {
      return { userId: 1 };
    }

    // 3. PRIORITY: Check custom auth_tokens table
    try {
      const { data: tokenData } = await supabase.from("auth_tokens").select("user_id").eq("token", token).maybeSingle();
      if (tokenData) return { userId: tokenData.user_id };
    } catch (e) {
      // Fallback
    }

    // 4. FALLBACK 1: Manual JWT verification
    try {
      const secret = Deno.env.get("JWT_SECRET");
      if (secret) {
        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
        const payload = await verify(token, key);

        if (payload.role === "service_role") return { userId: 1 };

        const sub = payload.sub as string;
        if (sub) {
          const userIdNum = parseInt(sub, 10);
          return { userId: isNaN(userIdNum) ? sub : userIdNum };
        }
      }
    } catch (e) {
      // Fallback
    }

    // 5. FALLBACK 2: Supabase Auth (for valid Supabase JWTs)
    try {
      const { data: { user } } = await supabase.auth.getUser(token);
      if (user) return { userId: user.id };
    } catch (e) {
      // Final fail
    }
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const auth = await verifyAuth(req);
  if (!auth) return jsonResponse({ success: false, error: "Unauthorized" }, 401);

  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const funcIndex = segments.indexOf("campaigns");
  const subPathSegments = funcIndex !== -1 ? segments.slice(funcIndex + 1) : segments;
  const path = "/" + subPathSegments.join("/");

  try {
    // GET /campaigns
    if ((path === "/" || path === "") && req.method === "GET") {
      const accountId = url.searchParams.get("accountId");
      const status = url.searchParams.get("effectiveStatus");
      const search = url.searchParams.get("search");
      const branchId = url.searchParams.get("branchId");

      let query = supabase
        .from("unified_campaigns")
        .select(`
          id, external_id, name, status, effective_status, daily_budget, start_time, end_time, synced_at, platform_account_id,
          platform_accounts!inner(id, name, synced_at, branch_id, platforms(code), platform_identities!inner(user_id))
        `)
        .eq("platform_accounts.platform_identities.user_id", auth.userId);

      if (accountId && accountId !== "all") query = query.eq("platform_account_id", parseInt(accountId));
      if (status) query = query.eq("effective_status", status);
      if (search) query = query.or(`name.ilike.%${search}%,external_id.ilike.%${search}%`);
      if (branchId && branchId !== "all") query = query.eq("platform_accounts.branch_id", parseInt(branchId));

      // Filter out expired campaigns (end_time in the past)
      const nowVN = getVietnamNowISO();
      query = query.or(`end_time.is.null,end_time.gte.${nowVN}`);

      const { data, error } = await query
        .order("effective_status", { ascending: true })
        .order("name", { ascending: true })
        .limit(200);

      if (error) throw error;

      const campaignIds = data.map((c: any) => c.id);

      // Fetch stats
      const vnNow = new Date(Date.now() + 7 * 3600000);
      const dateTodayVn = vnNow.toISOString().split("T")[0];
      const datePastVn = new Date(vnNow.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

      const dateStart = url.searchParams.get("dateStart") || datePastVn;
      const dateEnd = url.searchParams.get("dateEnd") || dateTodayVn;

      const { data: stats } = await supabase
        .from("unified_insights")
        .select("unified_campaign_id, spend, impressions, clicks, results")
        .in("unified_campaign_id", campaignIds)
        .gte("date", dateStart)
        .lte("date", dateEnd);

      const statsMap: Record<string, any> = {};
      (stats || []).forEach((s: any) => {
        const cid = s.unified_campaign_id;
        if (!cid) return;
        if (!statsMap[cid]) statsMap[cid] = { spend: 0, impressions: 0, clicks: 0, results: 0 };
        statsMap[cid].spend += parseFloat(s.spend || "0");
        statsMap[cid].impressions += parseInt(s.impressions || "0", 10);
        statsMap[cid].clicks += parseInt(s.clicks || "0", 10);
        statsMap[cid].results += parseInt(s.results || "0", 10);
      });

      const enrichedData = (data || []).map((c: any) => ({
        id: c.id,
        accountId: c.platform_account_id,
        externalId: c.external_id,
        name: c.name,
        status: c.status,
        effectiveStatus: c.effective_status,
        dailyBudget: c.daily_budget,
        startTime: c.start_time,
        endTime: c.end_time,
        syncedAt: c.synced_at,
        account: {
          id: c.platform_accounts.id,
          name: c.platform_accounts.name,
          syncedAt: c.platform_accounts.synced_at,
          platform: c.platform_accounts.platforms ? { code: c.platform_accounts.platforms.code } : null
        },
        stats: statsMap[c.id] || { spend: 0, impressions: 0, clicks: 0, results: 0 }
      }));

      return jsonResponse(enrichedData);
    }

    // GET /campaigns/by-account/:id
    if (path.includes("/by-account/") && req.method === "GET") {
      const accountId = path.split("/").pop();
      const { data, error } = await supabase
        .from("unified_campaigns")
        .select(`id, name, status, effective_status, external_id, platform_account_id`)
        .eq("platform_account_id", parseInt(accountId!));
      if (error) throw error;
      return jsonResponse(data);
    }

    // POST /campaigns/sync/account/:id
    if (path.includes("/sync/account/") && req.method === "POST") {
      const accountId = path.split("/").pop();
      const syncResponse = await fetch(`${supabaseUrl}/functions/v1/fb-sync-campaigns`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${supabaseKey}` },
        body: JSON.stringify({ accountId: parseInt(accountId!) })
      });
      return jsonResponse(await syncResponse.json());
    }

    // GET /campaigns/:id
    if (subPathSegments.length === 1 && req.method === "GET") {
      const campaignId = subPathSegments[0];
      const { data, error } = await supabase
        .from("unified_campaigns")
        .select(`
          id, external_id, name, status, effective_status, daily_budget, start_time, end_time, synced_at, platform_account_id,
          platform_accounts(id, name, platforms(code))
        `)
        .eq("id", campaignId)
        .single();

      if (error || !data) return jsonResponse({ success: false, error: "Campaign not found" }, 404);

      return jsonResponse({
        id: data.id,
        accountId: data.platform_account_id,
        externalId: data.external_id,
        name: data.name,
        status: data.status,
        effectiveStatus: data.effective_status,
        startTime: data.start_time,
        endTime: data.end_time,
        syncedAt: data.synced_at,
        account: {
          id: data.platform_accounts.id,
          name: data.platform_accounts.name,
          platform: data.platform_accounts.platforms ? { code: data.platform_accounts.platforms.code } : null
        }
      });
    }

    return jsonResponse({ success: false, error: `Route Not Found: ${req.method} ${path}` }, 404);
  } catch (error: any) {
    return jsonResponse({ success: false, error: error.message }, 500);
  }
});
