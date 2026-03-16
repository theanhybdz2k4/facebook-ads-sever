/**
 * Insights Query
 * Auth: API Key OR JWT Bearer token
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";
import { verify } from "https://deno.land/x/djwt@v3.0.1/mod.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const API_SECRET = Deno.env.get("API_SECRET_KEY") || "";
const JWT_SECRET = Deno.env.get("JWT_SECRET") || "your-secret-key";
const supabase = createClient(supabaseUrl, supabaseKey);

async function getKey(): Promise<CryptoKey> {
  return await crypto.subtle.importKey("raw", new TextEncoder().encode(JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function checkAuth(req: Request): Promise<{ authenticated: boolean; userId?: number }> {
  const authHeader = req.headers.get("Authorization");
  const apiKey = req.headers.get("X-API-Key");
  if (authHeader?.includes(supabaseKey)) return { authenticated: true };
  if (apiKey === API_SECRET && API_SECRET !== "") return { authenticated: true };
  if (authHeader?.startsWith("Bearer ")) {
    try {
      const payload = await verify(authHeader.substring(7), await getKey());
      return { authenticated: true, userId: parseInt(payload.sub as string, 10) };
    } catch { return { authenticated: false }; }
  }
  return { authenticated: false };
}

function getVietnamToday(): string { const d = new Date(Date.now() + 7 * 3600000); return d.toISOString().split("T")[0]; }
function getVietnamYesterday(): string { const d = new Date(Date.now() + 7 * 3600000); d.setDate(d.getDate() - 1); return d.toISOString().split("T")[0]; }

const corsHeaders = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key" };
const jsonResponse = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: corsHeaders });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  const auth = await checkAuth(req);
  if (!auth.authenticated) return jsonResponse({ success: false, error: "Unauthorized" }, 401);

  try {
    const body = await req.json().catch(() => ({}));
    const { accountId, campaignId, adGroupId, adId, dateStart = getVietnamYesterday(), dateEnd = getVietnamToday(), granularity = "daily", limit = 100 } = body;

    // Check ownership if JWT auth and accountId provided
    if (auth.userId && accountId) {
      const { data: acc } = await supabase.from("platform_accounts").select("id, platform_identities!inner (user_id)").eq("id", accountId).eq("platform_identities.user_id", auth.userId).single();
      if (!acc) return jsonResponse({ success: false, error: "Access denied" }, 403);
    }

    const tableName = granularity === "hourly" ? "unified_hourly_insights" : "unified_insights";
    let query = supabase.from(tableName).select(`*, unified_campaigns (id, name, external_id), unified_ad_groups (id, name, external_id), unified_ads (id, name, external_id)`).gte("date", dateStart).lte("date", dateEnd).order("date", { ascending: false }).limit(limit);

    if (accountId) query = query.eq("platform_account_id", accountId);
    if (campaignId) query = query.eq("unified_campaign_id", campaignId);
    if (adGroupId) query = query.eq("unified_ad_group_id", adGroupId);
    if (adId) query = query.eq("unified_ad_id", adId);

    const { data: insights, error } = await query;
    if (error) return jsonResponse({ success: false, error: error.message }, 500);

    const totals = { spend: 0, impressions: 0, clicks: 0, results: 0, reach: 0 };
    for (const i of insights || []) {
      totals.spend += parseFloat(i.spend || "0");
      totals.impressions += parseInt(i.impressions || "0", 10);
      totals.clicks += parseInt(i.clicks || "0", 10);
      totals.results += parseInt(i.results || "0", 10);
      totals.reach += parseInt(i.reach || "0", 10);
    }

    const metrics = { ...totals, ctr: totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0, cpc: totals.clicks > 0 ? totals.spend / totals.clicks : 0, cpm: totals.impressions > 0 ? (totals.spend / totals.impressions) * 1000 : 0, costPerResult: totals.results > 0 ? totals.spend / totals.results : 0 };

    return jsonResponse({ success: true, data: { dateRange: { start: dateStart, end: dateEnd }, granularity, count: insights?.length || 0, metrics, insights: insights || [] } });
  } catch (error: any) {
    console.error("Error:", error);
    return jsonResponse({ success: false, error: error.message }, 500);
  }
});
