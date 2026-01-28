
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";
import { verify } from "https://deno.land/x/djwt@v3.0.1/mod.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const supabase = createClient(supabaseUrl, supabaseKey);

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-client-info, apikey",
};

const jsonResponse = (data: any, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const JWT_SECRET = Deno.env.get("JWT_SECRET");

// Performance Optimization: Cache the crypto key globally
let memoizedKey: CryptoKey | null = null;
async function getKey(): Promise<CryptoKey> {
    if (memoizedKey) return memoizedKey;
    const encoder = new TextEncoder();
    memoizedKey = await crypto.subtle.importKey("raw", encoder.encode(JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    return memoizedKey;
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
        return { userId: 1 };
    }

    if (authHeader?.startsWith("Bearer ")) {
        const token = authHeader.substring(7).trim();
        if ((serviceKey !== "" && token === serviceKey) || (masterKey !== "" && token === masterKey) || (authSecret !== "" && token === authSecret)) {
            return { userId: 1 };
        }

        // PRIORITY: Check custom auth_tokens table first
        try {
            const { data: tokenData } = await supabase.from("auth_tokens").select("user_id").eq("token", token).single();
            if (tokenData) return { userId: tokenData.user_id };
        } catch (e) {
            // Not found in auth_tokens, fallback to JWT
        }

        // FALLBACK: JWT verification
        try {
            const encoder = new TextEncoder();
            const key = await crypto.subtle.importKey("raw", encoder.encode(JWT_SECRET || ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
            const payload = await verify(token, key);
            const sub = payload.sub as string;
            const userIdNum = parseInt(sub, 10);
            if (!isNaN(userIdNum)) return { userId: userIdNum };
            
            // Legacy/Email lookup fallback
            const { data: userData } = await supabase.from("users").select("id").eq("email", payload.email).single();
            if (userData) return { userId: userData.id };
            
            return { userId: sub as any };
        } catch (e: any) {
            console.log("Auth: JWT verify failed:", e.message);
        }
    }
    return null;
}

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

    try {
        const url = new URL(req.url);
        const path = url.pathname;
        const method = req.method;

        console.log(`[Telegram] ${method} ${path}`);
        console.log(`[Telegram] Headers:`, JSON.stringify(Object.fromEntries(req.headers.entries())));
        // URL format: /telegram/webhook/:bot_token
        if (path.includes("/webhook/")) {
            const botToken = path.split("/").pop();
            if (!botToken) return jsonResponse({ error: "Missing token" }, 400);

            const update = await req.json();
            console.log(`[Webhook] Update for bot ${botToken.substring(0, 10)}...:`, JSON.stringify(update));

            if (update.message?.text) {
                const text = update.message.text.trim();
                const chatId = update.message.chat.id.toString();
                const firstName = update.message.from.first_name || "User";

                // Find bot
                const { data: bot } = await supabase.from("telegram_bots").select("id, bot_name, user_id").eq("bot_token", botToken).single();

                if (bot) {
                    // Check if subscriber exists
                    const { data: subscriber } = await supabase.from("telegram_subscribers")
                        .select("id, is_active")
                        .eq("telegram_bot_id", bot.id)
                        .eq("chat_id", chatId)
                        .single();

                    const isSubscribed = subscriber?.is_active === true;

                    // ==================== COMMAND HANDLERS ====================

                    if (text === "/start") {
                        await supabase.from("telegram_subscribers").upsert({
                            telegram_bot_id: bot.id,
                            chat_id: chatId,
                            name: firstName,
                            is_active: true
                        }, { onConflict: 'telegram_bot_id, chat_id' });

                        await sendTelegramMessage(botToken, chatId,
                            `✨ *Xin chào ${firstName}!* ✨\n\n` +
                            `✅ Bạn đã kết nối với *${bot.bot_name}*\n` +
                            `📩 Sẽ nhận báo cáo Ads tự động tại đây!\n\n` +
                            `━━━━━━━━━━━━━━━━━━\n` +
                            `📊  *CÁC LỆNH CHÍNH*\n` +
                            `━━━━━━━━━━━━━━━━━━\n\n` +
                            `📅  /today  •  Báo cáo hôm nay\n` +
                            `⏰  /hour   •  Giờ vừa qua\n` +
                            `📆  /week  •  7 ngày qua\n` +
                            `💰  /budget •  Ngân sách\n` +
                            `📊  /stats  •  Thống kê nhanh\n\n` +
                            `📖 Gõ /help để xem đầy đủ lệnh`
                        );
                    }
                    else if (text === "/subscribe") {
                        if (isSubscribed) {
                            await sendTelegramMessage(botToken, chatId, "🔔 Bạn đã bật thông báo rồi nhé!");
                        } else {
                            await supabase.from("telegram_subscribers").upsert({
                                telegram_bot_id: bot.id,
                                chat_id: chatId,
                                name: firstName,
                                is_active: true
                            }, { onConflict: 'telegram_bot_id, chat_id' });
                            await sendTelegramMessage(botToken, chatId, "✅ *Đã bật thông báo!*\n\n📩 Bạn sẽ nhận báo cáo tự động.");
                        }
                    }
                    else if (text === "/unsubscribe") {
                        if (!isSubscribed) {
                            await sendTelegramMessage(botToken, chatId, "ℹ️ Thông báo đang tắt.\nGõ /subscribe để bật.");
                        } else {
                            await supabase.from("telegram_subscribers")
                                .update({ is_active: false })
                                .eq("telegram_bot_id", bot.id)
                                .eq("chat_id", chatId);
                            await sendTelegramMessage(botToken, chatId, "🔕 *Đã tắt thông báo*\n\n💡 Gõ /subscribe để bật lại bất cứ lúc nào.");
                        }
                    }
                    else if (text === "/report" || text === "/today") {
                        const report = await generateDailyReport(bot.user_id, "TODAY");
                        await sendTelegramMessage(botToken, chatId, report);
                    }
                    else if (text === "/hour") {
                        const report = await generateHourlyReport(bot.user_id);
                        if (Array.isArray(report)) {
                            for (const msg of report) {
                                await sendTelegramMessage(botToken, chatId, msg);
                            }
                        } else {
                            await sendTelegramMessage(botToken, chatId, report);
                        }
                    }
                    else if (text === "/week") {
                        const report = await generateWeeklyReport(bot.user_id);
                        await sendTelegramMessage(botToken, chatId, report);
                    }
                    else if (text === "/budget") {
                        const report = await generateBudgetReport(bot.user_id);
                        await sendTelegramMessage(botToken, chatId, report);
                    }
                    else if (text === "/stats") {
                        const stats = await generateQuickStats(bot.user_id);
                        await sendTelegramMessage(botToken, chatId, stats);
                    }
                    else if (text === "/help") {
                        await sendTelegramMessage(botToken, chatId,
                            `📖 *HƯỚNG DẪN SỬ DỤNG*\n` +
                            `━━━━━━━━━━━━━━━━━━\n\n` +
                            `📩 *THÔNG BÁO*\n` +
                            `• /subscribe — Bật nhận báo cáo tự động\n` +
                            `• /unsubscribe — Tắt thông báo\n\n` +
                            `📊 *BÁO CÁO*\n` +
                            `• /today — Chi tiết hôm nay (top ads)\n` +
                            `• /hour — Số liệu giờ vừa qua\n` +
                            `• /week — Tổng hợp 7 ngày\n` +
                            `• /stats — Thống kê theo chi nhánh\n\n` +
                            `💰 *NGÂN SÁCH*\n` +
                            `• /budget — Xem ngân sách campaigns`
                        );
                    }
                    else if (text === "/sync") {
                        await sendTelegramMessage(botToken, chatId, "⏳ Đang bắt đầu đồng bộ dữ liệu...");

                        // Call fb-dispatch for this user
                        try {
                            const res = await fetch(`${supabaseUrl}/functions/v1/fb-dispatch`, {
                                method: "POST",
                                headers: { "Content-Type": "application/json", Authorization: `Bearer ${supabaseKey}` },
                                body: JSON.stringify({ userId: bot.user_id, cronType: "full" }),
                            });
                            const result = await res.json();
                            if (result.success) {
                                await sendTelegramMessage(botToken, chatId, "✅ Đã gửi lệnh đồng bộ thành công! Bạn sẽ nhận được báo cáo sau ít phút.");
                            } else {
                                await sendTelegramMessage(botToken, chatId, `❌ Lỗi đồng bộ: ${result.error || "Unknown error"}`);
                            }
                        } catch (e: any) {
                            await sendTelegramMessage(botToken, chatId, `❌ Lỗi hệ thống: ${e.message}`);
                        }
                    }
                    else {
                        // Unknown command - show quick menu
                        await sendTelegramMessage(botToken, chatId,
                            `❓ Lệnh không hợp lệ.\n\n` +
                            `Gõ /help để xem danh sách lệnh.`
                        );
                    }
                }
            }
            return jsonResponse({ ok: true });
        }

        // --- PROTECTED API ENDPOINTS ---
        const auth = await verifyAuth(req);
        if (!auth) return jsonResponse({ success: false, error: "Unauthorized" }, 401);
        const userId = auth.userId;

        const parts = path.split("/").filter(Boolean);
        console.log(`[Telegram] Path Parts:`, JSON.stringify(parts));

        // Find the index of "bots" to determine if this is a bots-related request
        // Sometimes the path inside the function might include "telegram" if called via a proxy
        const botsIndex = parts.indexOf("bots");
        const botIdParam = botsIndex !== -1 && parts[botsIndex + 1] ? parts[botsIndex + 1] : null;
        const botId = botIdParam && !isNaN(parseInt(botIdParam)) ? parseInt(botIdParam, 10) : null;
        
        console.log(`[Telegram] botsIndex: ${botsIndex}, botIdParam: ${botIdParam}, botId: ${botId}`);

        if (method === "GET" && !botId) {
            const { data, error } = await supabase
                .from("telegram_bots")
                .select("*, adAccount:platform_accounts(id, name), notificationSettings:telegram_bot_notification_settings(*)")
                .eq("is_active", true)
                .eq("user_id", userId);

            if (error) throw error;

            // Enrich and map to camelCase to match frontend interface
            const enrichedBots = await Promise.all((data || []).map(async (bot: any) => {
                const [activeRes, totalRes] = await Promise.all([
                    supabase.from("telegram_subscribers").select("*", { count: 'exact', head: true }).eq("telegram_bot_id", bot.id).eq("is_active", true),
                    supabase.from("telegram_subscribers").select("*", { count: 'exact', head: true }).eq("telegram_bot_id", bot.id)
                ]);

                // Map notification settings to camelCase
                const settings = bot.notificationSettings?.[0] || bot.notificationSettings || null;
                const notificationSettings = settings ? {
                    id: settings.id,
                    userId: settings.user_id,
                    botId: settings.telegram_bot_id,
                    allowedHours: settings.allowed_hours || [],
                    enabled: settings.enabled ?? true,
                    createdAt: settings.created_at,
                    updatedAt: settings.updated_at
                } : null;

                return {
                    id: bot.id,
                    userId: bot.user_id,
                    adAccountId: bot.platform_account_id,
                    botToken: bot.bot_token,
                    botName: bot.bot_name,
                    botUsername: bot.bot_username,
                    isActive: bot.is_active,
                    adAccount: bot.adAccount,
                    notificationSettings,
                    activeSubscribers: activeRes.count || 0,
                    subscriberCount: totalRes.count || 0,
                    telegramLink: `https://t.me/${bot.bot_username || 'your_bot'}`
                };
            }));

            return jsonResponse({ success: true, result: { bots: enrichedBots } });
        }

        // --- GET /telegram/bots/:id/settings ---
        if (method === "GET" && botId && path.includes("/settings")) {
            const { data, error } = await supabase
                .from("telegram_bot_notification_settings")
                .select("*")
                .eq("telegram_bot_id", botId)
                .single();

            if (error && error.code !== 'PGRST116') throw error;
            return jsonResponse({ success: true, result: { setting: data || null } });
        }

        // --- POST /telegram/bots (Upsert Bot) ---
        if (method === "POST" && !botId) {
            const body = await req.json();
            console.log(`[Telegram] POST /bots Body:`, JSON.stringify(body));
            const { botToken, botName, adAccountId } = body;

            if (!botToken) {
                console.error("[Telegram] Missing botToken");
                return jsonResponse({ success: false, error: "Bot token is required" }, 400);
            }

            console.log(`[Telegram] Checking bot token with Telegram API...`);
            const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`).then(r => r.json());
            if (!tgRes.ok) {
                console.error("[Telegram] Telegram API check failed:", JSON.stringify(tgRes));
                return jsonResponse({ success: false, error: "Invalid bot token (Telegram check failed)", details: tgRes }, 400);
            }

            console.log(`[Telegram] Upserting bot to database... user_id: ${userId}`);
            const { data, error } = await supabase.from("telegram_bots").upsert({
                user_id: userId,
                bot_token: botToken,
                bot_name: botName || tgRes.result.first_name,
                bot_username: tgRes.result.username,
                platform_account_id: adAccountId ? parseInt(adAccountId.toString(), 10) : null,
                is_active: true,
                updated_at: new Date().toISOString()
            }, { onConflict: 'bot_token' }).select().single();

            if (error) {
                console.error("[Telegram] Bot Upsert Error:", error);
                return jsonResponse({ success: false, error: error.message, details: error }, 400);
            }
            console.log(`[Telegram] Bot upserted successfully:`, data.id);
            return jsonResponse({ success: true, bot: data });
        }

        // --- POST /telegram/bots/:id/settings ---
        if (method === "POST" && botId && path.includes("/settings")) {
            const body = await req.json();
            const { allowedHours, enabled } = body;

            const { data, error } = await supabase.from("telegram_bot_notification_settings").upsert({
                telegram_bot_id: botId,
                allowed_hours: allowedHours,
                enabled: enabled ?? true,
                updated_at: new Date().toISOString()
            }, { onConflict: 'telegram_bot_id' }).select().single();

            if (error) {
                console.error("Setting Upsert Error:", error);
                return jsonResponse({ success: false, error: error.message, details: error }, 400);
            }
            return jsonResponse({ success: true, result: { setting: data } });
        }

        // --- POST /telegram/bots/:id/test ---
        if (method === "POST" && botId && path.includes("/test")) {
            const { data: bot } = await supabase.from("telegram_bots").select("bot_token").eq("id", botId).single();
            if (!bot) return jsonResponse({ success: false, error: "Bot not found" }, 404);

            const { data: subs } = await supabase.from("telegram_subscribers").select("chat_id").eq("telegram_bot_id", botId).eq("is_active", true);

            if (!subs || subs.length === 0) return jsonResponse({ success: true, subscriberCount: 0, message: "No active subscribers found. Please send /start to the bot." });

            let sent = 0;
            for (const sub of subs) {
                try {
                    await fetch(`https://api.telegram.org/bot${bot.bot_token}/sendMessage`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ chat_id: sub.chat_id, text: "🔔 *Sync Test*\nKết nối thành công! Bạn sẽ nhận được báo cáo tại đây.", parse_mode: "Markdown" }),
                    });
                    sent++;
                } catch (e) { console.error(`Failed to send to ${sub.chat_id}`, e); }
            }

            return jsonResponse({ success: true, subscriberCount: sent, message: `Đã gửi tin nhắn thử tới ${sent} người.` });
        }

        // --- POST /telegram/bots/:id/register-webhook ---
        if (method === "POST" && botId && path.includes("/register-webhook")) {
            const { data: bot } = await supabase.from("telegram_bots").select("bot_token").eq("id", botId).single();
            if (!bot) return jsonResponse({ success: false, error: "Bot not found" }, 404);

            const webhookUrl = `${supabaseUrl}/functions/v1/telegram/webhook/${bot.bot_token}`;
            const tgRes = await fetch(`https://api.telegram.org/bot${bot.bot_token}/setWebhook`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url: webhookUrl })
            }).then(r => r.json());

            return jsonResponse({ success: tgRes.ok, message: tgRes.description, url: webhookUrl, details: tgRes });
        }

        // --- GET /telegram/bots/:id/webhook-info ---
        if (method === "GET" && botId && path.includes("/webhook-info")) {
            const { data: bot } = await supabase.from("telegram_bots").select("bot_token").eq("id", botId).single();
            if (!bot) return jsonResponse({ success: false, error: "Bot not found" }, 404);

            const tgRes = await fetch(`https://api.telegram.org/bot${bot.bot_token}/getWebhookInfo`).then(r => r.json());
            
            return jsonResponse({ 
                success: tgRes.ok, 
                result: tgRes.result,
                isRegistered: tgRes.ok && tgRes.result?.url?.includes(supabaseUrl)
            });
        }

        // --- DELETE /telegram/bots/:id ---
        if (method === "DELETE" && botId) {
            const { error } = await supabase
                .from("telegram_bots")
                .update({ is_active: false, updated_at: new Date().toISOString() })
                .eq("id", botId)
                .eq("user_id", userId);

            if (error) throw error;
            return jsonResponse({ success: true });
        }

        return jsonResponse({ success: false, error: `Invalid endpoint or method (${method} ${path})`, path }, 404);

    } catch (error: any) {
        console.error("Global Error:", error);
        return jsonResponse({ success: false, error: error.message, stack: error.stack }, 500);
    }
});

// --- HELPER FUNCTIONS ---

async function sendTelegramMessage(token: string, chatId: string, text: string) {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    });
}

function formatNumber(num: number) {
    return new Intl.NumberFormat('vi-VN').format(Math.round(num));
}

function getVietnamDate(offsetDays = 0): string {
    const now = new Date();
    const vn = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    vn.setDate(vn.getDate() + offsetDays);
    return vn.toISOString().split("T")[0];
}

function getVietnamHour(): number {
    const now = new Date();
    const vn = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    return vn.getUTCHours();
}

// ==================== REPORT GENERATORS ====================

async function generateDailyReport(userId: number, type: "TODAY" | "YESTERDAY" = "TODAY") {
    const dateStr = type === "TODAY" ? getVietnamDate(0) : getVietnamDate(-1);

    const { data: insights } = await supabase
        .from("unified_insights")
        .select(`
            spend, impressions, results, clicks, messaging_total, messaging_new,
            ad:unified_ads(name, external_id),
            account:platform_accounts(name)
        `)
        .eq("date", dateStr)
        .gt("spend", 0)
        .order("spend", { ascending: false });

    if (!insights || insights.length === 0) {
        return `📭 *Không có dữ liệu*\n\n📅 ${dateStr}\nChưa có chi tiêu nào được ghi nhận.`;
    }

    const totalSpend = insights.reduce((sum: number, i: any) => sum + Number(i.spend || 0), 0);
    const totalImpressions = insights.reduce((sum: number, i: any) => sum + Number(i.impressions || 0), 0);
    const totalClicks = insights.reduce((sum: number, i: any) => sum + Number(i.clicks || 0), 0);
    const totalResults = insights.reduce((sum: number, i: any) => sum + Number(i.results || 0), 0);
    const totalMsgNew = insights.reduce((sum: number, i: any) => sum + Number(i.messaging_new || 0), 0);
    const totalMsgTotal = insights.reduce((sum: number, i: any) => sum + Number(i.messaging_total || 0), 0);

    const ctr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
    const cpr = totalMsgNew > 0 ? totalSpend / totalMsgNew : (totalResults > 0 ? totalSpend / totalResults : 0);

    let msg = `📊 *BÁO CÁO ${type === "TODAY" ? "HÔM NAY" : "HÔM QUA"}*\n`;
    msg += `📅 ${dateStr}\n`;
    msg += `━━━━━━━━━━━━━━━━━━\n\n`;

    msg += `💰 Chi tiêu: *${formatNumber(totalSpend)}*\n`;
    msg += `🎯 Tin nhắn mới: *${formatNumber(totalMsgNew)}* / ${formatNumber(totalMsgTotal)} tổng\n`;
    msg += `💬 CPR: *${formatNumber(cpr)}*\n`;
    msg += `📈 CTR: *${ctr.toFixed(2)}%*\n`;
    msg += `👁 Hiển thị: ${formatNumber(totalImpressions)}\n`;
    msg += `👆 Clicks: ${formatNumber(totalClicks)}\n\n`;

    msg += `━━━━━━━━━━━━━━━━━━\n`;
    msg += `🏆 *TOP ${Math.min(10, insights.length)} ADS*\n`;
    msg += `━━━━━━━━━━━━━━━━━━\n\n`;

    const top10 = insights.slice(0, 10);
    for (let i = 0; i < top10.length; i++) {
        const insight = top10[i];
        const adName = insight.ad?.name || "Unknown Ad";
        const adSpend = Number(insight.spend || 0);
        const adResults = Number(insight.results || 0);
        const adCpr = adResults > 0 ? adSpend / adResults : 0;

        const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
        msg += `${medal} *${adName.substring(0, 22)}${adName.length > 22 ? "..." : ""}*\n`;
        msg += `    💸 ${formatNumber(adSpend)}  ·  🎯 ${adResults}  ·  CPR ${formatNumber(adCpr)}\n\n`;
    }

    if (insights.length > 10) {
        msg += `📋 _...và ${insights.length - 10} ads khác_`;
    }

    return msg;
}

async function generateHourlyReport(userId: number) {
    const currentHour = getVietnamHour();
    let reportDate = getVietnamDate(0);
    let reportHour = currentHour - 1;

    // Handle beginning of day: if current hour is 0 (midnight), previous hour is 23 of yesterday
    if (reportHour < 0) {
        reportHour = 23;
        reportDate = getVietnamDate(-1);
    }

    // Get user's accounts to filter insights
    const { data: accounts } = await supabase
        .from("platform_accounts")
        .select("id")
        .eq("account_status", "ACTIVE")
        .eq("platform_identities.user_id", userId);
        
    const accountIds = accounts?.map(a => a.id) || [];
    if (accountIds.length === 0) return `⚠️ Không tìm thấy tài khoản quảng cáo nào hoạt động.`;

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
        .in("platform_account_id", accountIds)
        .order("spend", { ascending: false });

    if (!hourlyData || hourlyData.length === 0) {
        return `⏰ *${reportHour}:00 - ${reportHour + 1}:00*\n\n📅 ${reportDate}\n_Không có chi tiêu trong khung giờ này._`;
    }
    
    // 3. AGGREGATE by Ad ID to handle split records
    const aggregated = (hourlyData || []).reduce((acc: Map<string, any>, curr: any) => {
        const adId = curr.unified_ad_id || "null";
        const key = `${curr.platform_account_id}|${adId}`;
        
        if (!acc.has(key)) {
            acc.set(key, { ...curr, spend: 0, impressions: 0, clicks: 0, results: 0 });
        }
        
        const existing = acc.get(key);
        existing.spend += Number(curr.spend || 0);
        existing.impressions += Number(curr.impressions || 0);
        existing.clicks += Number(curr.clicks || 0);
        existing.results += Number(curr.results || 0);
        existing.messaging_total += Number(curr.messaging_total || 0);
        existing.messaging_new += Number(curr.messaging_new || 0);
        
        // Prefer keeping non-null names if possible
        if (!existing.ad?.name && curr.ad?.name) existing.ad = curr.ad;
        if (!existing.campaign?.name && curr.campaign?.name) existing.campaign = curr.campaign;
        if (!existing.adGroup?.name && curr.adGroup?.name) existing.adGroup = curr.adGroup;
        
        return acc;
    }, new Map<string, any>());

    const messages: string[] = [];
    const insights = Array.from(aggregated.values());
    
    const totalSpend = insights.reduce((s: number, i: any) => s + Number(i.spend || 0), 0);
    const totalResults = insights.reduce((s: number, i: any) => s + Number(i.results || 0), 0);
    const totalMsgNew = insights.reduce((s: number, i: any) => s + Number(i.messaging_new || 0), 0);
    const totalMsgTotal = insights.reduce((s: number, i: any) => s + Number(i.messaging_total || 0), 0);
    const totalImpressions = insights.reduce((s: number, i: any) => s + Number(i.impressions || 0), 0);
    const totalClicks = insights.reduce((s: number, i: any) => s + Number(i.clicks || 0), 0);
    
    const cpr = totalMsgNew > 0 ? totalSpend / totalMsgNew : (totalResults > 0 ? totalSpend / totalResults : 0);
    const ctr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;

    let msg = `⏰ *BÁO CÁO GIỜ: ${reportHour}:00 - ${reportHour + 1}:00*\n`;
    msg += `📅 Ngày: ${reportDate}\n`;
    msg += `━━━━━━━━━━━━━━━━━━\n\n`;
    
    msg += `💰 Tổng chi tiêu: *${formatNumber(totalSpend)} VND*\n`;
    msg += `🎯 Tin nhắn mới: *${formatNumber(totalMsgNew)}* / ${formatNumber(totalMsgTotal)} tổng\n`;
    msg += `💬 CPR: *${formatNumber(cpr)} VND*\n`;
    msg += `📈 CTR: *${ctr.toFixed(2)}%*\n`;
    msg += `👁 Hiển thị: ${formatNumber(totalImpressions)}\n\n`;

    msg += `━━━━━━━━━━━━━━━━━━\n`;
    msg += `🏆 *TOP ADS TRONG GIỜ*\n`;
    msg += `━━━━━━━━━━━━━━━━━━\n\n`;

    const topAds = insights.sort((a: any, b: any) => Number(b.spend || 0) - Number(a.spend || 0)).slice(0, 8);
    for (let i = 0; i < topAds.length; i++) {
        const item = topAds[i] as any;
        const adName = item.ad?.name || "Unknown Ad";
        const spend = Number(item.spend || 0);
        const results = Number(item.results || 0);
        const itemCpr = results > 0 ? spend / results : 0;

        const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "•";
        msg += `${medal} *${adName.substring(0, 25)}${adName.length > 25 ? "..." : ""}*\n`;
        msg += `   💸 ${formatNumber(spend)}  ·  🎯 ${results}  ·  CPR ${formatNumber(itemCpr)}\n\n`;
    }

    if (insights.length > 8) {
        msg += `📋 _...và ${insights.length - 8} ads khác_`;
    }

    return msg;
}

async function generateWeeklyReport(userId: number) {
    const today = getVietnamDate(0);
    const weekAgo = getVietnamDate(-6);

    const { data: insights } = await supabase
        .from("unified_insights")
        .select("date, spend, impressions, clicks, results")
        .gte("date", weekAgo)
        .lte("date", today)
        .order("date", { ascending: false });

    if (!insights || insights.length === 0) {
        return `📆 *Báo cáo 7 ngày*\n\n_Không có dữ liệu._`;
    }

    const byDate = new Map<string, { spend: number; results: number; impressions: number; clicks: number }>();
    for (const i of insights) {
        const existing = byDate.get(i.date) || { spend: 0, results: 0, impressions: 0, clicks: 0 };
        existing.spend += Number(i.spend || 0);
        existing.results += Number(i.results || 0);
        existing.impressions += Number(i.impressions || 0);
        existing.clicks += Number(i.clicks || 0);
        byDate.set(i.date, existing);
    }

    const totalSpend = [...byDate.values()].reduce((s, d) => s + d.spend, 0);
    const totalResults = [...byDate.values()].reduce((s, d) => s + d.results, 0);
    const avgCpr = totalResults > 0 ? totalSpend / totalResults : 0;
    const avgDaily = totalSpend / byDate.size;

    let msg = `📆 *BÁO CÁO 7 NGÀY*\n`;
    msg += `📅 ${weekAgo} → ${today}\n`;
    msg += `━━━━━━━━━━━━━━━━━━\n\n`;

    msg += `💰 Tổng chi tiêu: *${formatNumber(totalSpend)}*\n`;
    msg += `📊 Trung bình/ngày: *${formatNumber(avgDaily)}*\n`;
    msg += `🎯 Tổng kết quả: *${formatNumber(totalResults)}*\n`;
    msg += `💬 CPR trung bình: *${formatNumber(avgCpr)}*\n\n`;

    msg += `━━━━━━━━━━━━━━━━━━\n`;
    msg += `📊 *CHI TIẾT THEO NGÀY*\n\n`;

    const sortedDates = [...byDate.entries()].sort((a, b) => b[0].localeCompare(a[0]));
    for (const [date, data] of sortedDates) {
        const dayName = new Date(date).toLocaleDateString("vi-VN", { weekday: "short" });
        const dayCpr = data.results > 0 ? data.spend / data.results : 0;
        msg += `• *${dayName} ${date.slice(5)}*\n`;
        msg += `  💸 ${formatNumber(data.spend)}  ·  🎯 ${data.results}  ·  CPR ${formatNumber(dayCpr)}\n\n`;
    }

    return msg;
}

async function generateBudgetReport(userId: number) {
    const { data: campaigns } = await supabase
        .from("unified_campaigns")
        .select(`name, daily_budget, lifetime_budget, status, effective_status, account:platform_accounts(name)`)
        .in("status", ["ACTIVE", "PAUSED"])
        .order("daily_budget", { ascending: false, nullsFirst: false });

    if (!campaigns || campaigns.length === 0) {
        return `💰 *Ngân sách*\n\n_Không có campaign nào._`;
    }

    const activeCamps = campaigns.filter((c: any) => c.effective_status === "ACTIVE");
    const pausedCamps = campaigns.filter((c: any) => c.effective_status !== "ACTIVE");
    const totalDaily = activeCamps.reduce((s: number, c: any) => s + Number(c.daily_budget || 0), 0);

    let msg = `💰 *NGÂN SÁCH CAMPAIGNS*\n`;
    msg += `━━━━━━━━━━━━━━━━━━\n\n`;

    msg += `💵 Tổng ngân sách/ngày: *${formatNumber(totalDaily)}*\n`;
    msg += `🟢 Đang chạy: *${activeCamps.length}*  ·  ⏸ Tạm dừng: *${pausedCamps.length}*\n\n`;

    if (activeCamps.length > 0) {
        msg += `━━━━━━━━━━━━━━━━━━\n`;
        msg += `🟢 *CAMPAIGNS ĐANG CHẠY*\n\n`;
        for (const c of activeCamps.slice(0, 8)) {
            const budget = c.daily_budget ? `${formatNumber(c.daily_budget)}/ngày` :
                c.lifetime_budget ? `${formatNumber(c.lifetime_budget)} lifetime` : "N/A";
            msg += `• ${c.name.substring(0, 22)}${c.name.length > 22 ? "..." : ""}\n`;
            msg += `  💸 ${budget}\n\n`;
        }
        if (activeCamps.length > 8) msg += `_...và ${activeCamps.length - 8} campaign khác_\n`;
    }

    return msg;
}

async function generateQuickStats(userId: number) {
    const today = getVietnamDate(0);
    const { data: stats } = await supabase.from("branch_daily_stats")
        .select("totalSpend, totalResults, totalClicks, totalImpressions, totalMessagingTotal, totalMessagingNew, branch:branches(name)")
        .eq("date", today);

    if (!stats || stats.length === 0) {
        const { data: insights } = await supabase.from("unified_insights")
            .select("spend, results, clicks, impressions")
            .eq("date", today);

        if (!insights || insights.length === 0) {
            return `📊 *Thống kê nhanh*\n\n📅 ${today}\n_Chưa có dữ liệu cho hôm nay._`;
        }

        const total = insights.reduce((s: any, i: any) => ({
            spend: s.spend + Number(i.spend || 0),
            results: s.results + Number(i.results || 0),
            clicks: s.clicks + Number(i.clicks || 0),
            impressions: s.impressions + Number(i.impressions || 0)
        }), { spend: 0, results: 0, clicks: 0, impressions: 0 });

        const cpr = total.messaging_new > 0 ? total.spend / total.messaging_new : (total.results > 0 ? total.spend / total.results : 0);
        const ctr = total.impressions > 0 ? (total.clicks / total.impressions) * 100 : 0;

        return `📊 *THỐNG KÊ NHANH*\n` +
            `📅 ${today}\n` +
            `━━━━━━━━━━━━━━━━━━\n\n` +
            `💰 Chi tiêu: *${formatNumber(total.spend)}*\n` +
            `🎯 Tin nhắn mới: *${formatNumber(total.results)}*\n` +
            `💬 CPR: *${formatNumber(cpr)}*\n` +
            `📈 CTR: *${ctr.toFixed(2)}%*`;
    }

    let msg = `📊 *THỐNG KÊ NHANH*\n`;
    msg += `📅 ${today}\n`;
    msg += `━━━━━━━━━━━━━━━━━━\n\n`;

    for (const s of stats) {
        const branchName = (s.branch as any)?.name || "Chi nhánh";
        const msgNew = Number(s.totalMessagingNew || 0);
        const results = Number(s.totalResults || 0);
        const spend = Number(s.totalSpend || 0);
        const cpr = msgNew > 0 ? spend / msgNew : (results > 0 ? spend / results : 0);
        
        msg += `🏢 *${branchName}*\n`;
        msg += `  💰 ${formatNumber(spend)}  ·  🎯 ${formatNumber(msgNew)}  ·  CPR ${formatNumber(cpr)}\n\n`;
    }

    return msg;
}
