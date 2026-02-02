/**
 * Facebook Ads - Dispatch
 * Main dispatcher triggered by n8n/cron to run sync jobs based on cron_settings
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";
import { verify } from "https://deno.land/x/djwt@v3.0.1/mod.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const JWT_SECRET = Deno.env.get("JWT_SECRET");
const supabase = createClient(supabaseUrl, supabaseKey);

// CRITICAL: DO NOT REMOVE THIS AUTH LOGIC. 
// IT PRIORITIZES auth_tokens TABLE FOR CUSTOM AUTHENTICATION.
async function verifyAuth(req: Request) {
  const authHeader = req.headers.get("Authorization");
  const serviceKeyHeader = req.headers.get("x-service-key") || req.headers.get("x-master-key");
  const masterKey = Deno.env.get("MASTER_KEY") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const authSecret = Deno.env.get("AUTH_SECRET") || "";
  const legacyToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxuY2dtYXh0cWpmYmN5cG5jZm9lIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NzM0NzQxMywiZXhwIjoyMDgyOTIzNDEzfQ.zalV6mnyd1Iit0KbHnqLxemnBKFPbKz2159tkHtodJY";

  if (serviceKeyHeader === serviceKey || serviceKeyHeader === masterKey || serviceKeyHeader === legacyToken) {
    return { userId: 1 };
  }

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.substring(7).trim();
    if ((serviceKey !== "" && token === serviceKey) || (masterKey !== "" && token === masterKey) || (authSecret !== "" && token === authSecret) || token === legacyToken) {
      return { userId: 1 };
    }

    // PRIORITY: Check custom auth_tokens table first
    try {
      const { data: tokenData } = await supabase.from("auth_tokens").select("user_id").eq("token", token).single();
      if (tokenData) return { userId: tokenData.user_id };
    } catch (e) {
      // Fallback to JWT
    }

    // FALLBACK 1: Manual JWT verification
    try {
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey("raw", encoder.encode(JWT_SECRET || ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
      const payload = await verify(token, key);

      // service_role tokens don't have a 'sub' but have 'role'
      if (payload.role === "service_role") {
        console.log("Auth: Verified via manual JWT (service_role)");
        return { userId: 1 };
      }

      const sub = payload.sub as string;
      if (sub) {
        const userIdNum = parseInt(sub, 10);
        if (!isNaN(userIdNum)) return { userId: userIdNum };
        return { userId: sub as any };
      }
    } catch (e: any) {
      console.log("Auth: Manual JWT verify failed:", e.message);
    }

    // FALLBACK 2: Supabase Auth verification (Works for Service Role Keys)
    try {
      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (user) {
        console.log("Auth: Verified via Supabase Auth. ID:", user.id);
        return { userId: user.id };
      }
    } catch (e: any) {
      console.log("Auth: Supabase Auth verify failed:", e.message);
    }
  }
  return null;
}

function getVietnamToday(): string {
  // ... existing getVietnamToday ...
  const now = new Date();
  const vn = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return vn.toISOString().split("T")[0];
}

function getVietnamYesterday(): string {
  // ... existing getVietnamYesterday ...
  const now = new Date();
  const vn = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  vn.setDate(vn.getDate() - 1);
  return vn.toISOString().split("T")[0];
}

function getVietnamHour(): number {
  // ... existing getVietnamHour ...
  const now = new Date();
  const vn = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return vn.getUTCHours();
}

const corsHeaders = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" };
const jsonResponse = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: corsHeaders });

async function callEdgeFunction(name: string, body: any): Promise<any> {
  const res = await fetch(`${supabaseUrl}/functions/v1/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + supabaseKey },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function sendTelegram(botToken: string, chatId: string, message: string) {
  await fetch("https://api.telegram.org/bot" + botToken + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "Markdown" }),
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  const auth = await verifyAuth(req);
  if (!auth) {
    const authHeader = req.headers.get("Authorization");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const token = authHeader?.startsWith("Bearer ") ? authHeader.substring(7).trim() : "";

    return jsonResponse({
      success: false,
      error: "Unauthorized",
      debug: {
        hasJwtSecret: !!Deno.env.get("JWT_SECRET"),
        hasServiceKey: !!serviceKey,
        lengths: {
          token: token.length,
          serviceKeyEnv: serviceKey.length
        },
        matches: {
          serviceKey: token !== "" && token === serviceKey
        },
        headers: {
          auth: !!authHeader,
          authPrefix: authHeader?.substring(0, 15),
          serviceKeyHeader: !!(req.headers.get("x-service-key") || req.headers.get("x-master-key")),
        }
      }
    }, 401);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { dateStart = getVietnamYesterday(), dateEnd = getVietnamToday(), cronType, userId: forcedUserId, force = false } = body;

    // Use either the forced user ID (system call) or the authenticated user's ID
    const targetUserId = forcedUserId || auth.userId;
    const currentHour = getVietnamHour();

    console.log("[Dispatch] Hour " + currentHour + ", range: " + dateStart + " - " + dateEnd + ", force: " + force);

    // Build query - skip hour check if force=true (manual trigger)
    let query = supabase.from("cron_settings").select("id, user_id, cron_type, allowed_hours, enabled").eq("enabled", true);
    if (!force) {
      query = query.contains("allowed_hours", [currentHour]);
    }
    if (cronType) query = query.eq("cron_type", cronType);
    if (targetUserId) query = query.eq("user_id", targetUserId);

    const { data: cronSettings, error: cronError } = await query;
    if (cronError) return jsonResponse({ success: false, error: cronError.message }, 500);

    // Group types by user to de-duplicate
    const userMap = new Map<number, Set<string>>();
    for (const s of cronSettings || []) {
      if (!userMap.has(s.user_id)) userMap.set(s.user_id, new Set());
      userMap.get(s.user_id)!.add(s.cron_type);
    }

    const result = { dispatchedUsers: userMap.size, results: [] as any[], errors: [] as string[] };

    for (const [userId, types] of userMap.entries()) {
      try {
        // Flags for what needs to be synced
        const syncAll = types.has("full");
        const syncQuick = types.has("insight"); // "Quick Insights"

        const doCampaigns = syncAll || types.has("campaign") || types.has("adset") || types.has("ad_account");
        const doAds = syncAll || types.has("ads") || types.has("creative");
        const doInsightDaily = syncAll || syncQuick || types.has("insight_daily");
        const doInsightHourly = syncQuick || types.has("insight_hourly") || types.has("insight_hour");
        const doLeads = syncAll || types.has("leads");

        // Granularity logic
        let granularity: "DAILY" | "HOURLY" | "BOTH" = "DAILY";
        if (doInsightDaily && doInsightHourly) granularity = "BOTH";
        else if (doInsightHourly) granularity = "HOURLY";

        // Breakdown flags (placeholders for future breakdown support in fb-sync-insights)
        const hasBreakdowns = types.has("insight_device") || types.has("insight_placement") || types.has("insight_age_gender") || types.has("insight_region");

        // Should we send a Telegram report?
        const shouldReport = syncAll || syncQuick || types.has("insight_daily") || types.has("insight_hourly") || types.has("insight_hour");

        console.log("[Dispatch] User " + userId + ", types: " + Array.from(types).join(", "));
        if (!doCampaigns && !doAds && !doInsightDaily && !doInsightHourly && !hasBreakdowns && !doLeads) {
          console.log(`[Dispatch] User ${userId} nothing to do`);
          continue;
        }

        // Get user's accounts - sorted by synced_at ASC (oldest first)
        // CRITICAL: Limit to 2 accounts per cron run to avoid Edge Function timeout (~150s)
        const { data: allAccounts } = await supabase
          .from("platform_accounts")
          .select("id, name, external_id, branch_id, synced_at, platform_identities!inner (user_id)")
          .eq("platform_identities.user_id", userId)
          .eq("account_status", "1")  // 1 = ACTIVE in Facebook API
          .order("synced_at", { ascending: true, nullsFirst: true })
          .limit(2000);

        // Only process 2 accounts with oldest synced_at to avoid timeout
        const MAX_ACCOUNTS_PER_RUN = 2;
        const accounts = (allAccounts || []).slice(0, MAX_ACCOUNTS_PER_RUN);

        console.log("[Dispatch] User " + userId + " found " + (allAccounts?.length || 0) + " active accounts, processing " + accounts.length + " (oldest synced_at first)");

        // Fetch branches for auto-assignment
        const { data: branches } = await supabase.from("branches").select("id, auto_match_keywords").eq("user_id", userId);

        const branchIds = new Set<number>();
        const summary = { totalAccounts: allAccounts?.length || 0, accountsProcessed: accounts.length, items: 0, errors: 0 };

        // Process accounts SEQUENTIALLY to avoid rate limits and race conditions
        for (const account of (accounts || [])) {
          console.log(`[Dispatch] Processing account ${account.name} (${account.id})`);
          try {
            let currentBranchId = account.branch_id;

            if (currentBranchId) branchIds.add(currentBranchId);

            // CRITICAL: Sync ORDER matters. Campaigns must be synced BEFORE Ads.
            // 1. Sync Entities (SEQUENTIAL)
            if (doCampaigns) {
              console.log(`[Dispatch] Syncing campaigns for ${account.id}`);
              await callEdgeFunction("fb-sync-campaigns", { accountId: account.id });
            }
            if (doAds) {
              console.log(`[Dispatch] Syncing ads for ${account.id}`);
              await callEdgeFunction("fb-sync-ads", { accountId: account.id });
            }

            // 1.5 Sync Leads
            if (doLeads) {
              console.log(`[Dispatch] Syncing leads for ${account.id}`);
              const res = await callEdgeFunction("fb-sync-leads", { accountId: account.id });
              summary.items += (res?.result?.leadsSynced || 0);
            }

            // 2. Sync Insights (with skipAggregation)
            if (doInsightDaily || doInsightHourly) {
              console.log(`[Dispatch] Syncing insights for ${account.id} (${granularity})`);
              const res = await callEdgeFunction("fb-sync-insights", {
                accountId: account.id,
                dateStart,
                dateEnd,
                granularity,
                skipBranchAggregation: true
              });
              summary.items += (res?.data?.insights || 0) + (res?.data?.hourly || 0);
            }

            // 3. Sync Breakdowns
            if (types.has("insight_device")) {
              await callEdgeFunction("fb-sync-insights", { accountId: account.id, dateStart, dateEnd, breakdown: "device", skipBranchAggregation: true });
            }
            if (types.has("insight_age_gender")) {
              await callEdgeFunction("fb-sync-insights", { accountId: account.id, dateStart, dateEnd, breakdown: "age_gender", skipBranchAggregation: true });
            }
            if (types.has("insight_region")) {
              await callEdgeFunction("fb-sync-insights", { accountId: account.id, dateStart, dateEnd, breakdown: "region", skipBranchAggregation: true });
            }

          } catch (e: any) {
            console.error("Error syncing account " + account.id + ":", e.message);
            summary.errors++;
          }
        }

        // 4. Branch Aggregation (Once per branch)
        console.log("[Dispatch] Aggregating " + branchIds.size + " branches");
        const aggPromises = Array.from(branchIds).map(async (bid) => {
          try {
            const firstAccInBranch = (accounts || []).find(a => a.branch_id === bid);
            if (firstAccInBranch) {
              await callEdgeFunction("branches/" + bid + "/stats/recalculate", {
                dateStart,
                dateEnd
              });
            }
          } catch (e: any) {
            console.error("Error aggregating branch " + bid + ":", e.message);
          }
        });
        await Promise.allSettled(aggPromises);

        result.results.push({ userId, types: Array.from(types), ...summary });

        // Send Telegram report
        if (shouldReport) {
          const { data: bots } = await supabase.from("telegram_bots").select("bot_token, telegram_subscribers (chat_id, is_active)").eq("user_id", userId).eq("is_active", true);

          if (doInsightHourly) {
            // Generate Detailed Hourly Report
            let reportDate = getVietnamToday();
            let reportHour = currentHour - 1;
            if (reportHour < 0) {
              reportHour = 23;
              reportDate = getVietnamYesterday();
            }

            const { data: hourlyData } = await supabase
              .from("unified_hourly_insights")
              .select(`
                    spend, impressions, clicks, results, messaging_total, messaging_new,
                    date, hour,
                    ad:unified_ads(name, external_id),
                    adGroup:unified_ad_groups(name),
                    campaign:unified_campaigns(name),
                    account:platform_accounts(name, currency, id)
                `)
              .eq("date", reportDate)
              .eq("hour", reportHour)
              .gt("spend", 0)
              .in("platform_account_id", accounts?.map(a => a.id) || [])
              .order("spend", { ascending: false });

            if (hourlyData && hourlyData.length > 0) {
              for (const item of hourlyData) {
                const adName = item.ad?.name || "Unknown Ad";
                const campaignName = item.campaign?.name || "Unknown Campaign";
                const adsetName = item.adGroup?.name || "Unknown AdSet";
                const accountName = item.account?.name || "Unknown Account";
                const currency = item.account?.currency || "VND";
                const externalId = item.ad?.external_id;

                const spend = Number(item.spend || 0);
                const impressions = Number(item.impressions || 0);
                const clicks = Number(item.clicks || 0);
                const results = Number(item.results || 0);

                const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
                const cpc = clicks > 0 ? spend / clicks : 0;
                const cpm = impressions > 0 ? (spend / impressions) * 1000 : 0;
                const cpr = results > 0 ? spend / results : 0;

                const fmt = (n: number) => new Intl.NumberFormat('vi-VN').format(Math.round(n));
                const fmtCur = (n: number) => fmt(n) + " " + currency;

                // Aggregate by Ad ID to consolidate split records and fix "Chi tiêu" accuracy
                // Initialize aggregation (or skip if already unique after db fix, but this is safer)
                if (!result.aggregatedHourly) result.aggregatedHourly = new Map();
                const adKey = accountName + "|" + externalId;
                const existing = result.aggregatedHourly.get(adKey);

                if (existing) {
                  existing.spend += spend;
                  existing.impressions += impressions;
                  existing.clicks += clicks;
                  existing.results += results;
                  existing.messaging_new += Number(item.messaging_new || 0);
                } else {
                  result.aggregatedHourly.set(adKey, {
                    accountName, campaignName, adsetName, adName, spend, impressions, clicks, results,
                    messaging_new: Number(item.messaging_new || 0),
                    currency, externalId, accountId: item.account?.id
                  });
                }
              }

              for (const item of result.aggregatedHourly.values()) {
                const { accountName, campaignName, adsetName, adName, spend, impressions, clicks, results, messaging_new, currency, externalId, accountId } = item;

                const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
                const cpc = clicks > 0 ? spend / clicks : 0;
                const cpm = impressions > 0 ? (spend / impressions) * 1000 : 0;
                const cpr = results > 0 ? spend / results : (messaging_new > 0 ? spend / messaging_new : 0);

                const fmt = (n: number) => new Intl.NumberFormat('vi-VN').format(Math.round(n));
                const fmtCur = (n: number) => `${fmt(n)} ${currency}`;

                let msg = "📊 *CHI TIẾT ADS - " + reportDate + " " + reportHour + ":00*\n\n";
                msg += "📈 Tài khoản: " + accountName + "\n";
                msg += "📁 Chiến dịch: " + campaignName + "\n";
                msg += "📂 Nhóm QC: " + adsetName + "\n";
                msg += "🎯 Quảng cáo: " + adName + "\n\n";

                msg += "💰 *THÔNG SỐ*\n";
                msg += "├── 💵 Chi tiêu: " + fmtCur(spend) + "\n";
                msg += "├── 👁 Hiển thị: " + fmt(impressions) + "\n";
                msg += "├── 👆 Lượt click: " + fmt(clicks) + "\n";
                msg += "├── 🎯 Kết quả: " + fmt(results) + "\n";
                msg += "├── 💬 Tin nhắn mới: " + fmt(messaging_new) + "\n";
                msg += "├── 📊 CTR: " + ctr.toFixed(2) + "%\n";
                msg += "├── 💳 CPC: " + fmtCur(cpc) + "\n";
                msg += "├── 📈 CPM: " + fmtCur(cpm) + "\n";
                msg += "└── 🎯 CPR: " + fmtCur(cpr);

                if (externalId) {
                  msg += "\n\n🔗 [Xem QC](https://facebook.com/ads/manage/prediction?act=" + accountId + "&adid=" + externalId + ")";
                }

                for (const bot of bots || []) {
                  for (const sub of (bot.telegram_subscribers || []).filter((s: any) => s.is_active)) {
                    await sendTelegram(bot.bot_token, sub.chat_id, msg);
                  }
                }
              }
              // Optional: Also send a summary or omit generic report
            } else {
              // Fallback to generic if no ad spend found specifically in that hour but sync happened
              const msg = "📊 *Sync Report (Optimized)*\n📅 " + new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }) + "\n✅ Synced: " + summary.accountsProcessed + "/" + summary.totalAccounts + " accounts\n📈 Items: " + summary.items + "\n⚠️ Errors: " + summary.errors + "\n🔧 Sync: " + Array.from(types).join(", ");
              for (const bot of bots || []) {
                for (const sub of (bot.telegram_subscribers || []).filter((s: any) => s.is_active)) {
                  await sendTelegram(bot.bot_token, sub.chat_id, msg);
                }
              }
            }
          } else {
            // Standard daily/full sync summary
            const msg = "📊 *Sync Report (Optimized)*\n📅 " + new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }) + "\n✅ Synced: " + summary.accountsProcessed + "/" + summary.totalAccounts + " accounts\n📈 Items: " + summary.items + "\n⚠️ Errors: " + summary.errors + "\n🔧 Sync: " + Array.from(types).join(", ");
            for (const bot of bots || []) {
              for (const sub of (bot.telegram_subscribers || []).filter((s: any) => s.is_active)) {
                await sendTelegram(bot.bot_token, sub.chat_id, msg);
              }
            }
          }
        }
      } catch (e: any) {
        result.errors.push("User " + userId + ": " + e.message);
      }
    }

    return jsonResponse({ success: true, data: result });
  } catch (error: any) {
    console.error("Error:", error);
    return jsonResponse({ success: false, error: error.message }, 500);
  }
});
