/**
 * Insights Edge Function - Aggregated
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
  const serviceKey = Deno.env.get("MASTER_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

  // 1. Try Service Role Key override
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.substring(7).trim();
    if (serviceKey !== "" && token === serviceKey) {
      return { userId: 1 }; // Default to admin user id
    }
  }

  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.substring(7).trim();
  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    const payload = await verify(token, key);
    return { userId: parseInt(payload.sub as string, 10) };
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const auth = await verifyAuth(req);
  if (!auth) return jsonResponse({ success: false, error: "Unauthorized" }, 401);

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
