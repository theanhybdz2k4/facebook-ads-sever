/**
 * Branch Stats - Query
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
  
  // 1. Service Role Key check
  if (authHeader?.includes(supabaseKey)) return { authenticated: true, userId: 1 };
  
  // 2. API Key check
  if (apiKey === API_SECRET && API_SECRET !== "") return { authenticated: true, userId: 1 };
  
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.substring(7).trim();

    // 3. Check custom auth_tokens table (Most reliable for this system)
    try {
      const { data: tokenData } = await supabase
        .from("auth_tokens")
        .select("user_id")
        .eq("token", token)
        .eq("is_active", true)
        .gte("expires_at", new Date().toISOString())
        .maybeSingle();
      
      if (tokenData) return { authenticated: true, userId: tokenData.user_id };
    } catch (e) {
      console.error("[Auth] auth_tokens check failed:", e.message);
    }

    // 4. Manual JWT verification
    try {
      const payload = await verify(token, await getKey());
      return { authenticated: true, userId: parseInt(payload.sub as string, 10) };
    } catch (e) { 
      console.error("[Auth] JWT verification failed:", e.message);
    }
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
    const url = new URL(req.url);
    const branchId = url.searchParams.get("branchId") || (await req.json().catch(() => ({}))).branchId;
    const dateStart = url.searchParams.get("dateStart") || getVietnamYesterday();
    const dateEnd = url.searchParams.get("dateEnd") || getVietnamToday();
    const platformCode = url.searchParams.get("platformCode") || "all";

    if (!branchId) return jsonResponse({ success: false, error: "branchId is required" }, 400);

    // Check ownership if JWT auth
    if (auth.userId) {
      const { data: branch } = await supabase.from("branches").select("id, user_id").eq("id", branchId).eq("user_id", auth.userId).single();
      if (!branch) return jsonResponse({ success: false, error: "Access denied" }, 403);
    }

    const { data: branch, error: branchError } = await supabase.from("branches").select("id, name, code, user_id").eq("id", branchId).single();
    if (branchError || !branch) return jsonResponse({ success: false, error: "Branch not found" }, 404);

    let statsQuery = supabase.from("branch_daily_stats").select("*").eq("branch_id", branchId).gte("date", dateStart).lte("date", dateEnd).order("date", { ascending: true });
    if (platformCode !== "all") statsQuery = statsQuery.eq("platform_code", platformCode);
    const { data: dailyStats } = await statsQuery;

    const totals = { spend: 0, impressions: 0, clicks: 0, results: 0 };
    for (const stat of dailyStats || []) {
      totals.spend += parseFloat(stat.totalSpend || stat.total_spend || "0");
      totals.impressions += parseInt(stat.totalImpressions || stat.total_impressions || "0", 10);
      totals.clicks += parseInt(stat.totalClicks || stat.total_clicks || "0", 10);
      totals.results += parseInt(stat.totalResults || stat.total_results || "0", 10);
    }

    const metrics = { ...totals, ctr: totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0, cpc: totals.clicks > 0 ? totals.spend / totals.clicks : 0, cpm: totals.impressions > 0 ? (totals.spend / totals.impressions) * 1000 : 0, costPerResult: totals.results > 0 ? totals.spend / totals.results : 0 };

    const { data: accounts } = await supabase.from("platform_accounts").select("id, external_id, name, account_status, currency, platforms (code, name)").eq("branch_id", branchId);

    return jsonResponse({ success: true, data: { branch, dateRange: { start: dateStart, end: dateEnd }, platformCode, metrics, dailyStats: dailyStats || [], accounts: accounts || [] } });
  } catch (error: any) {
    console.error("Error:", error);
    return jsonResponse({ success: false, error: error.message }, 500);
  }
});
