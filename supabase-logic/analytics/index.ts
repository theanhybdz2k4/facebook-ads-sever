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
// Gemini AI helper function to analyze campaign performance
async function analyzeCampaignWithGemini(apiKey: string, metrics: any): Promise<string | null> {
  if (!apiKey) return null;

  try {
    const { name, ctr, cvr, spend, results, creativesText } = metrics;

    const creativesSection = creativesText ? `\nDữ liệu nội dung các mẫu quảng cáo đang chạy:\n${creativesText}\n` : '';

    const prompt = `Bạn là chuyên gia copywriter và tối ưu hóa quảng cáo Facebook cho ngành Giáo dục (bán khóa học). 
Hãy phân tích chiến dịch sau và đặc biệt chú trọng vào nội dung quảng cáo (ads copy) đang sử dụng để đưa ra cách viết tốt hơn:

Chiến dịch: ${name}
- CTR: ${ctr.toFixed(2)}% (Mục tiêu ngành: > 2.3%)
- CVR: ${cvr.toFixed(1)}% (Mục tiêu ngành: > 10%)
- Đã chi: ${spend.toLocaleString()} VND
- Kết quả: ${results} leads${creativesSection}
Yêu cầu trả lời:
1. Đánh giá ngắn gọn (1-2 câu) hiệu quả hiện tại dựa trên số liệu.
2. Đánh giá trực tiếp vào các nội dung/tiêu đề quảng cáo đang dùng (nếu có dữ liệu ở trên). Chỉ ra điểm chưa tốt hoặc điểm cần cải thiện trong cách viết.
3. Viết lại 2-3 tiêu đề hoặc đoạn mở bài mới hấp dẫn hơn (angle mới) để tăng CTR. (Ví dụ: nhắm vào nỗi đau cụ thể, hoặc bằng chứng thành công).
4. Đội ngũ cần làm thêm hành động gì cho Landing Page báo giá, hoặc cấu hình kỹ thuật để cải thiện CVR?

Trả lời bằng tiếng Việt, chuyên nghiệp, định dạng Markdown (sử dụng bullet points, in đậm từ khóa quan trọng). QUAN TRỌNG: Không trả lời chung chung, đặc biệt chú ý cải tiến câu chữ quảng cáo.`;

    console.log(`[AI] Analyzing campaign ${name} with Gemini...`);

    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" + apiKey, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });

    const data = await response.json();
    if (data.error) {
      console.error("[AI] Gemini API error:", data.error.message);
      return null;
    }

    return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch (e: any) {
    console.error("[AI] Gemini API call failed:", e.message);
    return null;
  }
}

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
        console.log(`[Auth] JWT Verified. sub: ${sub}`);

        // Handle sub logic correctly: only parse as int if it's strictly a numeric string
        if (typeof sub === 'string') {
          if (/^\d+$/.test(sub)) {
            const userIdNum = parseInt(sub, 10);
            console.log(`[Auth] Using numeric userId: ${userIdNum}`);
            return { userId: userIdNum };
          }
          console.log(`[Auth] Using string userId (UUID): ${sub}`);
          return { userId: sub };
        }

        return { userId: sub };
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

    // Critical Fallback: If token present but not found, allow as default user
    console.log("[Auth] Permissive Auth: Allowing request with invalid/unknown token.");
    return { userId: 1 };
  }

  // Default Fallback: Allow unauthenticated
  console.log("[Auth] Permissive Auth: Allowing unauthenticated request.");
  return { userId: 1 };
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

      // 1. SECURITY: Verify ownership of this ad
      const { data: adCheck } = await supabase
        .from("unified_ads")
        .select("id, platform_accounts!inner(platform_identities!inner(user_id))")
        .eq("id", adId)
        .eq("platform_accounts.platform_identities.user_id", auth.userId)
        .limit(1)
        .maybeSingle();

      if (!adCheck) return jsonResponse({ success: false, error: "Ad not found or unauthorized" }, 404);

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

      // 1. Get all account IDs for this branch - AND VERIFY OWNERSHIP
      const { data: accounts } = await supabase
        .from("platform_accounts")
        .select("id, platform_identities!inner(user_id)")
        .eq("branch_id", branchId)
        .eq("platform_identities.user_id", auth.userId);
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

      // 1. SECURITY: Verify ownership of this ad
      const { data: adCheck } = await supabase
        .from("unified_ads")
        .select("id, platform_accounts!inner(platform_identities!inner(user_id))")
        .eq("id", adId)
        .eq("platform_accounts.platform_identities.user_id", auth.userId)
        .limit(1)
        .maybeSingle();

      if (!adCheck) return jsonResponse({ success: false, error: "Ad not found or unauthorized" }, 404);

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


    // Global Breakdown - Age/Gender (ON-DEMAND FROM FB)
    if (path.includes("/global-breakdown/age-gender")) {
      const dateStart = url.searchParams.get("dateStart");
      const dateEnd = url.searchParams.get("dateEnd");
      const accountIdParam = url.searchParams.get("accountId");
      const branchIdParam = url.searchParams.get("branchId");

      console.log(`[Breakdown] On-Demand Params: start=${dateStart}, end=${dateEnd}, account=${accountIdParam}, branch=${branchIdParam}`);

      // 1. Get account IDs and their credentials
      let accountQuery = supabase
        .from("platform_accounts")
        .select(`
          id, 
          external_id,
          platform_identity_id,
          platform_identities!inner(user_id)
        `)
        .eq("platform_identities.user_id", auth.userId);

      if (accountIdParam) accountQuery = accountQuery.eq("id", accountIdParam);
      if (branchIdParam && branchIdParam !== "all") accountQuery = accountQuery.eq("branch_id", branchIdParam);

      const { data: accounts, error: accountError } = await accountQuery;
      if (accountError) throw accountError;

      if (!accounts || accounts.length === 0) return jsonResponse([]);

      // 2. Fetch breakdowns from Facebook per account
      const allAgeGenderData: any[] = [];
      const startTime = performance.now();

      for (const account of accounts) {
        try {
          // Get token for THIS identity
          const { data: tokenCred } = await supabase
            .from("platform_credentials")
            .select("credential_value")
            .eq("platform_identity_id", account.platform_identity_id)
            .eq("credential_type", "access_token")
            .maybeSingle();

          if (!tokenCred?.credential_value) {
            console.warn(`[Breakdown] No token for account ${account.id}`);
            continue;
          }

          const fbUrl = new URL(`https://graph.facebook.com/v24.0/${account.external_id}/insights`);
          fbUrl.searchParams.set("access_token", tokenCred.credential_value);
          fbUrl.searchParams.set("level", "account");
          fbUrl.searchParams.set("breakdowns", "age,gender");
          fbUrl.searchParams.set("fields", "age,gender,spend,actions");
          
          if (dateStart && dateEnd) {
             fbUrl.searchParams.set("time_range", JSON.stringify({ since: dateStart, until: dateEnd }));
          } else {
             fbUrl.searchParams.set("date_preset", "last_30d");
          }

          const response = await fetch(fbUrl.toString());
          const fbData = await response.json();

          if (fbData.data) {
            allAgeGenderData.push(...fbData.data);
          } else if (fbData.error) {
            console.error(`[Breakdown] FB Error for ${account.id}:`, fbData.error.message);
          }
        } catch (e: any) {
          console.error(`[Breakdown] Failed for account ${account.id}:`, e.message);
        }
      }

      // 3. Aggregate results
      const aggregated = allAgeGenderData.reduce((acc: any, curr: any) => {
        const age = curr.age || "unknown";
        const gender = curr.gender || "unknown";
        const key = `${age}-${gender}`;
        
        const messaging_total = curr.actions?.find((a: any) => a.action_type === 'onsite_conversion.messaging_conversation_started_7d')?.value || 0;
        const results = Number(messaging_total); // Matching current UI expectation for results

        if (!acc[key]) {
          acc[key] = { age, gender, spend: 0, results: 0 };
        }
        acc[key].spend += Number(curr.spend || 0);
        acc[key].results += results;
        return acc;
      }, {});

      // Sort by results (desc), then spend (desc)
      const result = Object.values(aggregated).sort((a: any, b: any) => {
        if (b.results !== a.results) return b.results - a.results;
        return b.spend - a.spend;
      });

      const endTime = performance.now();
      console.log(`[Breakdown] On-demand processed ${accounts.length} accounts in ${(endTime - startTime).toFixed(2)}ms`);

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

    // AI Campaign Optimization
    if (path === "/optimize" && method === "POST") {
      const body = await req.json();
      const { campaignId, name, ctr, cvr, spend, results } = body;

      if (!campaignId) return jsonResponse({ success: false, error: "campaignId required" }, 400);

      // 0. SECURITY: Verify ownership of this campaign
      const { data: campaignCheck } = await supabase
        .from("unified_campaigns")
        .select("id, platform_accounts!inner(platform_identities!inner(user_id))")
        .eq("id", campaignId)
        .eq("platform_accounts.platform_identities.user_id", auth.userId)
        .limit(1)
        .maybeSingle();

      if (!campaignCheck) return jsonResponse({ success: false, error: "Campaign not found or unauthorized" }, 404);

      // 1. Get Gemini API key for THIS user
      const { data: userData } = await supabase
        .from("users")
        .select("gemini_api_key")
        .eq("id", auth.userId)
        .maybeSingle();

      const geminiApiKey = userData?.gemini_api_key;
      if (!geminiApiKey) {
        return jsonResponse({ success: false, error: "Gemini API key not configured for this project" }, 400);
      }

      // 2. Perform AI analysis
      // Extract ad creatives text from database
      let creativesText = '';
      try {
        const { data: adGroups } = await supabase.from('unified_ad_groups').select('id').eq('unified_campaign_id', campaignId);
        const adGroupIds = adGroups?.map((ag: any) => ag.id) || [];
        if (adGroupIds.length > 0) {
          const { data: ads } = await supabase.from('unified_ads').select('id, unified_ad_creative_id').in('unified_ad_group_id', adGroupIds).not('unified_ad_creative_id', 'is', null);
          const creativeIds = [...new Set(ads?.map((a: any) => a.unified_ad_creative_id).filter(Boolean) || [])];

          if (creativeIds.length > 0) {
            const { data: creatives } = await supabase.from('unified_ad_creatives').select('platform_data, name').in('id', creativeIds).limit(10);
            creativesText = creatives?.map((c: any) => {
              const aiContent = c.platform_data?.ai_content;
              const msg = aiContent?.message ? `Nội dung: ${aiContent.message}` : '';
              const hl = aiContent?.headline ? `Tiêu đề: ${aiContent.headline}` : '';
              if (!msg && !hl) return '';
              return `--- Quảng cáo: ${c.name} ---\n${hl}\n${msg}`;
            }).filter(Boolean).join("\n\n") || '';
          }
        }
      } catch (e) {
        console.error("[Optimize] Error fetching creatives:", e);
      }

      const analysisText = await analyzeCampaignWithGemini(geminiApiKey, { name, ctr, cvr, spend, results, creativesText });
      if (!analysisText) {
        return jsonResponse({ success: false, error: "Failed to generate AI analysis" }, 500);
      }

      // 3. Save to database
      const { data: savedData, error: saveError } = await supabase
        .from("campaign_ai_analysis")
        .upsert({
          campaign_id: campaignId,
          analysis_text: analysisText,
          metrics_snapshot: { ctr, cvr, spend, results },
          updated_at: new Date().toISOString()
        }, { onConflict: 'campaign_id' })
        .select()
        .single();

      if (saveError) throw saveError;

      return jsonResponse({ success: true, data: savedData });
    }

    // Get specific campaign analysis
    if (path.startsWith("/analysis/") && method === "GET") {
      const campaignId = path.split("/").pop();
      const { data, error } = await supabase
        .from("campaign_ai_analysis")
        .select("*, unified_campaigns!inner(platform_accounts!inner(platform_identities!inner(user_id)))")
        .eq("campaign_id", campaignId)
        .eq("unified_campaigns.platform_accounts.platform_identities.user_id", auth.userId)
        .maybeSingle();

      if (error) throw error;
      return jsonResponse(data || null);
    }

    return jsonResponse({ success: false, error: "Not Found", path }, 404);
  } catch (error: any) {
    return jsonResponse({ success: false, error: error.message }, 500);
  }
});
