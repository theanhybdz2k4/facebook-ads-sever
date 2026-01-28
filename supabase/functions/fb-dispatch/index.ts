/**
 * Facebook Ads - Dispatch
 * Main dispatcher triggered by n8n/cron to run sync jobs based on cron_settings
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const supabase = createClient(supabaseUrl, supabaseKey);

function getVietnamToday(): string {
  const now = new Date();
  const vn = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return vn.toISOString().split("T")[0];
}

function getVietnamYesterday(): string {
  const now = new Date();
  const vn = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  vn.setDate(vn.getDate() - 1);
  return vn.toISOString().split("T")[0];
}

function getVietnamHour(): number {
  const now = new Date();
  const vn = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return vn.getUTCHours();
}

const corsHeaders = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" };
const jsonResponse = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: corsHeaders });

async function callEdgeFunction(name: string, body: any): Promise<any> {
  const res = await fetch(`${supabaseUrl}/functions/v1/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${supabaseKey}` },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function sendTelegram(botToken: string, chatId: string, message: string) {
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "Markdown" }),
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const { dateStart = getVietnamYesterday(), dateEnd = getVietnamToday(), cronType, userId } = body;
    const currentHour = getVietnamHour();

    console.log(`[Dispatch] Hour ${currentHour}, range: ${dateStart} - ${dateEnd}`);

    let query = supabase.from("cron_settings").select("id, user_id, cron_type, allowed_hours, enabled").eq("enabled", true).contains("allowed_hours", [currentHour]);
    if (cronType) query = query.eq("cron_type", cronType);
    if (userId) query = query.eq("user_id", userId);

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

        console.log(`[Dispatch] User ${userId}, types: ${Array.from(types).join(", ")}`);
        if (!doCampaigns && !doAds && !doInsightDaily && !doInsightHourly && !hasBreakdowns && !doLeads) {
          console.log(`[Dispatch] User ${userId} nothing to do`);
          continue;
        }

        // Get user's accounts ONCE
        const { data: accounts } = await supabase
          .from("platform_accounts")
          .select("id, name, external_id, branch_id, platform_identities!inner (user_id)")
          .eq("platform_identities.user_id", userId)
          .eq("account_status", "ACTIVE")
          .limit(2000);

        console.log(`[Dispatch] User ${userId} found ${accounts?.length || 0} active accounts`);
        
        // Fetch branches for auto-assignment
        const { data: branches } = await supabase.from("branches").select("id, auto_match_keywords").eq("user_id", userId);
        
        const branchIds = new Set<number>();
        const summary = { accounts: accounts?.length || 0, items: 0, errors: 0 };

        const syncPromises = (accounts || []).map(async (account: any) => {
          try {
            let currentBranchId = account.branch_id;

            // Auto-assign branch if missing
            if (!currentBranchId && branches && branches.length > 0) {
              const accName = account.name?.toLowerCase() || "";
              for (const b of branches) {
                const keywords = b.auto_match_keywords || [];
                if (keywords.some((k: string) => k && accName.includes(k.toLowerCase()))) {
                  currentBranchId = b.id;
                  console.log(`[Dispatch] Auto-assigning account ${account.id} to branch ${b.id}`);
                  await supabase.from("platform_accounts").update({ branch_id: b.id }).eq("id", account.id);
                  break;
                }
              }
            }

            if (currentBranchId) branchIds.add(currentBranchId);

            const tasks = [];

            // 1. Sync Entities (Parallel)
            if (doCampaigns) {
              tasks.push(callEdgeFunction("fb-sync-campaigns", { accountId: account.id }));
            }
            if (doAds) {
              tasks.push(callEdgeFunction("fb-sync-ads", { accountId: account.id }));
            }

            await Promise.allSettled(tasks);
            const secondaryTasks = [];

            // 1.5 Sync Leads (Only once per account or just trigger for any active account)
            if (doLeads) {
              // Note: fb-sync-leads fetches its own token, but we call it with system auth
              secondaryTasks.push((async () => {
                const res = await callEdgeFunction("fb-sync-leads", { accountId: account.id });
                summary.items += (res?.result?.leadsSynced || 0);
              })());
            }

            // 2. Sync Insights (with skipAggregation)
            if (doInsightDaily || doInsightHourly) {
              secondaryTasks.push((async () => {
                const res = await callEdgeFunction("fb-sync-insights", {
                  accountId: account.id,
                  dateStart,
                  dateEnd,
                  granularity,
                  skipBranchAggregation: true
                });
                summary.items += (res?.data?.insights || 0) + (res?.data?.hourly || 0);
              })());
            }

            // 3. Sync Breakdowns
            if (types.has("insight_device")) {
              secondaryTasks.push(callEdgeFunction("fb-sync-insights", { accountId: account.id, dateStart, dateEnd, breakdown: "device", skipBranchAggregation: true }));
            }
            if (types.has("insight_age_gender")) {
              secondaryTasks.push(callEdgeFunction("fb-sync-insights", { accountId: account.id, dateStart, dateEnd, breakdown: "age_gender", skipBranchAggregation: true }));
            }
            if (types.has("insight_region")) {
              secondaryTasks.push(callEdgeFunction("fb-sync-insights", { accountId: account.id, dateStart, dateEnd, breakdown: "region", skipBranchAggregation: true }));
            }

            await Promise.allSettled(secondaryTasks);
          } catch (e: any) {
            console.error(`Error syncing account ${account.id}:`, e.message);
            summary.errors++;
          }
        });

        await Promise.allSettled(syncPromises);

        // 4. Branch Aggregation (Once per branch)
        console.log(`[Dispatch] Aggregating ${branchIds.size} branches`);
        const aggPromises = Array.from(branchIds).map(async (bid) => {
          try {
            const firstAccInBranch = (accounts || []).find(a => a.branch_id === bid);
            if (firstAccInBranch) {
              await callEdgeFunction(`branches/${bid}/stats/recalculate`, {
                dateStart,
                dateEnd
              });
            }
          } catch (e: any) {
            console.error(`Error aggregating branch ${bid}:`, e.message);
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
                    spend, impressions, clicks, results, 
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
                const fmtCur = (n: number) => `${fmt(n)} ${currency}`;

                let msg = `📊 *CHI TIẾT ADS - ${reportDate} ${reportHour}:00*\n\n`;
                msg += `📈 Tài khoản: ${accountName}\n`;
                msg += `📁 Chiến dịch: ${campaignName}\n`;
                msg += `📂 Nhóm QC: ${adsetName}\n`;
                msg += `🎯 Quảng cáo: ${adName}\n\n`;

                msg += `💰 *THÔNG SỐ*\n`;
                msg += `├── 💵 Chi tiêu: ${fmtCur(spend)}\n`;
                msg += `├── 👁 Hiển thị: ${fmt(impressions)}\n`;
                msg += `├── 👆 Lượt click: ${fmt(clicks)}\n`;
                msg += `├── 🎯 Kết quả: ${fmt(results)}\n`;
                msg += `├── 💬 Tin nhắn mới: 0\n`;
                msg += `├── 📊 CTR: ${ctr.toFixed(2)}%\n`;
                msg += `├── 💳 CPC: ${fmtCur(cpc)}\n`;
                msg += `├── 📈 CPM: ${fmtCur(cpm)}\n`;
                msg += `└── 🎯 CPR: ${fmtCur(cpr)}`;

                if (externalId) {
                  msg += `\n\n🔗 [Xem QC](https://facebook.com/ads/manage/prediction?act=${item.account?.id}&ad_id=${externalId})`;
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
              const msg = `📊 *Sync Report (Optimized)*\n📅 ${new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}\n✅ Accounts: ${summary.accounts}\n📈 Items: ${summary.items}\n⚠️ Errors: ${summary.errors}\n🔧 Sync: ${Array.from(types).join(", ")}`;
              for (const bot of bots || []) {
                for (const sub of (bot.telegram_subscribers || []).filter((s: any) => s.is_active)) {
                  await sendTelegram(bot.bot_token, sub.chat_id, msg);
                }
              }
            }
          } else {
            // Standard daily/full sync summary
            const msg = `📊 *Sync Report (Optimized)*\n📅 ${new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}\n✅ Accounts: ${summary.accounts}\n📈 Items: ${summary.items}\n⚠️ Errors: ${summary.errors}\n🔧 Sync: ${Array.from(types).join(", ")}`;
            for (const bot of bots || []) {
              for (const sub of (bot.telegram_subscribers || []).filter((s: any) => s.is_active)) {
                await sendTelegram(bot.bot_token, sub.chat_id, msg);
              }
            }
          }
        }
      } catch (e: any) {
        result.errors.push(`User ${userId}: ${e.message}`);
      }
    }

    return jsonResponse({ success: true, data: result });
  } catch (error: any) {
    console.error("Error:", error);
    return jsonResponse({ success: false, error: error.message }, 500);
  }
});
