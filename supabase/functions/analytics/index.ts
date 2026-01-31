/**
 * Insights Edge Function - Aggregated
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
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-client-info, apikey, x-service-key",
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

  console.log(`[Auth] Path: ${new URL(req.url).pathname}, Method: ${req.method}`);

  // 1. Check Service/Master Key in specialized headers
  if (serviceKeyHeader === serviceKey || (masterKey && serviceKeyHeader === masterKey)) {
    console.log("[Auth] Verified via service-key header");
    return { userId: 1 };
  }

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.substring(7).trim();
    console.log(`[Auth] Token received (len: ${token.length})`);

    // 2. Check Service/Master/Auth secrets as Bearer token
    if ((serviceKey && token === serviceKey) ||
      (masterKey && token === masterKey) ||
      (authSecret && token === authSecret)) {
      console.log("[Auth] Verified via secret-as-token");
      return { userId: 1 };
    }

    // 3. PRIORITY: Check custom auth_tokens table
    try {
      const { data: tokenData, error: tokenError } = await supabase.from("auth_tokens").select("user_id").eq("token", token).maybeSingle();
      if (tokenData) {
        console.log(`[Auth] Verified via auth_tokens table, userId: ${tokenData.user_id}`);
        return { userId: tokenData.user_id };
      }
    } catch (e: any) {
      console.error("[Auth] auth_tokens exception:", e.message);
    }

    // 4. FALLBACK 1: Manual JWT verification
    try {
      const secret = Deno.env.get("JWT_SECRET");
      if (secret) {
        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
        const payload = await verify(token, key);

        if (payload.role === "service_role") {
          console.log("[Auth] Verified via JWT (service_role)");
          return { userId: 1 };
        }

        const sub = payload.sub as string;
        if (sub) {
          const userIdNum = parseInt(sub, 10);
          console.log(`[Auth] Verified via JWT (sub: ${sub})`);
          return { userId: isNaN(userIdNum) ? sub : userIdNum };
        }
      }
    } catch (e: any) {
      console.log(`[Auth] Manual JWT verify failed: ${e.message}`);
    }

    // 5. FALLBACK 2: Supabase Auth
    try {
      const { data: { user }, error: userError } = await supabase.auth.getUser(token);
      if (user) {
        console.log(`[Auth] Verified via Supabase getUser, userId: ${user.id}`);
        return { userId: user.id };
      }
    } catch (e: any) {
      console.error("[Auth] getUser exception:", e.message);
    }
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const auth = await verifyAuth(req);
  if (!auth) {
    console.log("[Auth] Authentication failed, returning 401");
    return jsonResponse({ 
      success: false, 
      error: "Unauthorized",
      debug: {
        hasAuthHeader: !!req.headers.get("Authorization"),
        tokenPrefix: req.headers.get("Authorization")?.substring(0, 15),
        hasJwtSecret: !!Deno.env.get("JWT_SECRET"),
      }
    }, 401);
  }

  const url = new URL(req.url);
  // ROBUST ROUTING
  const segments = url.pathname.split("/").filter(Boolean);
  const funcIndex = segments.indexOf("analytics");
  const subPathSegments = funcIndex !== -1 ? segments.slice(funcIndex + 1) : segments;
  const path = "/" + subPathSegments.join("/");

  const method = req.method;

  try {
    // Ad Hourly Insights - Aggregated
    if (path.includes("/ad-hourly/") || (subPathSegments[0] === 'ad-hourly' && subPathSegments[1])) {
      const adId = path.split("/").pop();
      const date = url.searchParams.get("date");
      if (!date) return jsonResponse({ success: false, error: "date required" }, 400);

      const { data, error } = await supabase
        .from("unified_hourly_insights")
        .select("*")
        .eq("unified_ad_id", adId)
        .eq("date", date)
        .order("hour", { ascending: true });

      if (error) throw error;

      // Aggregate by Hour
      const aggregated = (data || []).reduce((acc: any, curr: any) => {
        const hour = curr.hour;
        if (!acc[hour]) {
          acc[hour] = {
            hour,
            dateStart: curr.date,
            spend: 0,
            impressions: 0,
            clicks: 0,
            results: 0
          };
        }
        acc[hour].spend += Number(curr.spend || 0);
        acc[hour].impressions += Number(curr.impressions || 0);
        acc[hour].clicks += Number(curr.clicks || 0);
        acc[hour].results += Number(curr.results || 0);
        return acc;
      }, {});

      const mappedHourly = Object.values(aggregated).map((h: any) => {
        const { spend, impressions, clicks, results } = h;
        const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
        const costPerResult = results > 0 ? spend / results : 0;

        return {
          ...h,
          ctr,
          costPerResult,
        };
      }).sort((a: any, b: any) => a.hour - b.hour);

      return jsonResponse(mappedHourly);
    }

    // Branch Hourly Insights - Aggregated across all accounts
    if (path.includes("/branch-hourly/") || (subPathSegments[0] === 'branch-hourly' && subPathSegments[1])) {
      const branchId = parseInt(path.split("/").pop() || "0", 10);
      const date = url.searchParams.get("date");
      if (!date) return jsonResponse({ success: false, error: "date required" }, 400);

      // 1. Get all account IDs for this branch
      const { data: accounts } = await supabase.from("platform_accounts").select("id").eq("branch_id", branchId);
      const accountIds = accounts?.map(a => a.id) || [];
      if (accountIds.length === 0) return jsonResponse([]);

      // 2. Fetch hourly insights for these accounts
      const { data, error } = await supabase
        .from("unified_hourly_insights")
        .select("*")
        .in("platform_account_id", accountIds)
        .eq("date", date)
        .order("hour", { ascending: true });

      if (error) throw error;

      // 3. Aggregate by Hour
      const aggregated = (data || []).reduce((acc: any, curr: any) => {
        const hour = curr.hour;
        if (!acc[hour]) {
          acc[hour] = {
            hour,
            date,
            spend: 0,
            impressions: 0,
            clicks: 0,
            results: 0
          };
        }
        acc[hour].spend += Number(curr.spend || 0);
        acc[hour].impressions += Number(curr.impressions || 0);
        acc[hour].clicks += Number(curr.clicks || 0);
        acc[hour].results += Number(curr.results || 0);
        return acc;
      }, {});

      const result = Object.values(aggregated).sort((a: any, b: any) => a.hour - b.hour);
      return jsonResponse(result);
    }

    // Ad Daily Insights - Aggregated
    if (path.includes("/ad/") || (subPathSegments[0] === 'ad' && subPathSegments[1])) {
      const adId = path.split("/").pop();
      const dateNowVn = new Date(Date.now() + 7 * 3600000);
      const dateTodayVn = dateNowVn.toISOString().split("T")[0];
      const datePastVn = new Date(dateNowVn.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

      const dateStart = url.searchParams.get("dateStart") || datePastVn;
      const dateEnd = url.searchParams.get("dateEnd") || dateTodayVn;

      let query = supabase.from("unified_insights").select("*").eq("unified_ad_id", adId);
      if (dateStart) query = query.gte("date", dateStart);
      if (dateEnd) query = query.lte("date", dateEnd);

      const { data: insights, error } = await query.order("date", { ascending: true });
      if (error) throw error;

      // Aggregate by Date
      const aggregated = (insights || []).reduce((acc: any, curr: any) => {
        const date = curr.date;
        if (!acc[date]) {
          acc[date] = {
            date,
            spend: 0,
            impressions: 0,
            clicks: 0,
            results: 0,
            reach: 0,
            conversions: 0
          };
        }
        acc[date].spend += Number(curr.spend || 0);
        acc[date].impressions += Number(curr.impressions || 0);
        acc[date].clicks += Number(curr.clicks || 0);
        acc[date].results += Number(curr.results || 0);
        acc[date].reach += Number(curr.reach || 0);
        acc[date].conversions += Number(curr.conversions || 0);
        return acc;
      }, {});

      const mappedInsights = Object.values(aggregated).map((i: any) => {
        const { spend, impressions, clicks, results } = i;
        const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
        const cpc = clicks > 0 ? spend / clicks : 0;
        const cpm = impressions > 0 ? (spend / impressions) * 1000 : 0;
        const costPerResult = results > 0 ? spend / results : 0;

        return {
          ...i,
          ctr,
          cpc,
          cpm,
          costPerResult,
        };
      }).sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());

      // Summary Calculation
      const summary = mappedInsights.reduce((acc: any, i: any) => ({
        totalSpend: acc.totalSpend + i.spend,
        totalImpressions: acc.totalImpressions + i.impressions,
        totalClicks: acc.totalClicks + i.clicks,
        totalResults: acc.totalResults + i.results,
        totalReach: acc.totalReach + i.reach,
        totalMessages: acc.totalMessages + i.results, // Approximation
      }), { totalSpend: 0, totalImpressions: 0, totalClicks: 0, totalResults: 0, totalReach: 0, totalMessages: 0 });

      const s = summary;
      const avgCtr = s.totalImpressions > 0 ? (s.totalClicks / s.totalImpressions) * 100 : 0;
      const avgCpc = s.totalClicks > 0 ? s.totalSpend / s.totalClicks : 0;
      const avgCpm = s.totalImpressions > 0 ? (s.totalSpend / s.totalImpressions) * 1000 : 0;
      const avgCpr = s.totalResults > 0 ? s.totalSpend / s.totalResults : 0;
      const avgCostPerMessage = s.totalMessages > 0 ? s.totalSpend / s.totalMessages : 0;

      return jsonResponse({
        summary: { ...summary, avgCtr, avgCpc, avgCpm, avgCpr, avgCostPerMessage },
        dailyInsights: mappedInsights,
        deviceBreakdown: [], // Implement breakdowns aggregation if needed
        placementBreakdown: [],
        ageGenderBreakdown: [],
      });
    }


    // Global Breakdown - Age/Gender
    if (path.includes("/global-breakdown/age-gender")) {
      const dateStart = url.searchParams.get("dateStart");
      const dateEnd = url.searchParams.get("dateEnd");
      const accountIdParam = url.searchParams.get("accountId");
      const branchIdParam = url.searchParams.get("branchId");

      console.log(`[Breakdown] Params: start=${dateStart}, end=${dateEnd}, account=${accountIdParam}, branch=${branchIdParam}`);

      // 1. Get account IDs using correct join syntax
      let accountQuery = supabase
        .from("platform_accounts")
        .select("id, platform_identities!inner(user_id)")
        .eq("platform_identities.user_id", auth.userId);

      if (accountIdParam) accountQuery = accountQuery.eq("id", accountIdParam);
      if (branchIdParam && branchIdParam !== "all") accountQuery = accountQuery.eq("branch_id", branchIdParam);

      const { data: accounts, error: accountError } = await accountQuery;
      
      let accountIds = accounts?.map(a => a.id) || [];
      console.log(`[Breakdown] User ${auth.userId} query returned ${accountIds.length} accounts`);

      // SINGLE-USER FALLBACK: If no accounts found for specific userId but identities exist for '1'
      if (accountIds.length === 0) {
        console.log("[Breakdown] Falling back to userId 1 for data retrieval (Single tenant compatibility)");
        const { data: accountsRaw } = await supabase
          .from("platform_accounts")
          .select("id, platform_identities!inner(user_id)")
          .eq("platform_identities.user_id", 1);
          
        if (accountIdParam) accountQuery = accountQuery.eq("id", accountIdParam);
        if (branchIdParam && branchIdParam !== "all") accountQuery = accountQuery.eq("branch_id", branchIdParam);

        accountIds = accountsRaw?.map(a => a.id) || [];
        console.log(`[Breakdown] Fallback returned ${accountIds.length} accounts`);
      }
      
      if (accountIds.length === 0) return jsonResponse([]);

      // 2. Query breakdown table
      let query = supabase
        .from("unified_insight_age_gender")
        .select(`
          age, 
          gender, 
          spend, 
          results, 
          unified_insights!inner(platform_account_id, date)
        `)
        .in("unified_insights.platform_account_id", accountIds);

      if (dateStart) query = query.gte("unified_insights.date", dateStart);
      if (dateEnd) query = query.lte("unified_insights.date", dateEnd);

      const { data, error } = await query;
      if (error) {
        console.error("[Breakdown] Query error:", error.message);
        throw error;
      }

      console.log(`[Breakdown] Raw data rows: ${data?.length || 0}`);

      // 3. Aggregate
      const aggregated = (data || []).reduce((acc: any, curr: any) => {
        const key = `${curr.age}-${curr.gender}`;
        if (!acc[key]) {
          acc[key] = { age: curr.age, gender: curr.gender, spend: 0, results: 0 };
        }
        acc[key].spend += Number(curr.spend || 0);
        acc[key].results += Number(curr.results || 0);
        return acc;
      }, {});

      // Sort by results (desc), then spend (desc)
      const result = Object.values(aggregated).sort((a: any, b: any) => {
        if (b.results !== a.results) return b.results - a.results;
        return b.spend - a.spend;
      });

      console.log(`[Breakdown] Returning ${result.length} aggregated segments`);
      return jsonResponse(result);
    }

    // Cleanup
    if (path === "/cleanup" && method === "POST") {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const dateStr = yesterday.toISOString().split("T")[0];

      const { count, error } = await supabase.from("unified_hourly_insights").delete({ count: "exact" }).lt("date", dateStr);
      if (error) throw error;
      return jsonResponse({ success: true, deletedCount: count });
    }

    return jsonResponse({ success: false, error: "Not Found", path }, 404);
  } catch (error: any) {
    return jsonResponse({ success: false, error: error.message }, 500);
  }
});
