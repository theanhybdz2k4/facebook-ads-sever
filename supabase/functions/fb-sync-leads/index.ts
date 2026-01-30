
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";
import { verify } from "https://deno.land/x/djwt@v3.0.1/mod.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const JWT_SECRET = Deno.env.get("JWT_SECRET") || "";
const supabase = createClient(supabaseUrl, supabaseKey);

const FB_BASE_URL = "https://graph.facebook.com/v24.0";

const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const jsonResponse = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: corsHeaders });

// Logging
const logs: string[] = [];
function log(msg: string) {
    console.log(`[FB-Sync-Leads] ${msg}`);
    logs.push(msg);
}

// Helper to convert timestamp to Vietnam timezone (UTC+7) for storage
// Database stores Vietnam time directly for correct display
function toVietnamTimestamp(timestamp: number | string | Date): string {
    const date = new Date(timestamp);
    // Add 7 hours to convert UTC to Vietnam time
    const vnTime = new Date(date.getTime() + 7 * 60 * 60 * 1000);
    return vnTime.toISOString().slice(0, 19).replace('T', ' '); // Format: YYYY-MM-DD HH:mm:ss
}

// Unified Auth Logic
async function verifyAuth(req: Request) {
    const authHeader = req.headers.get("Authorization");
    const serviceKeyHeader = req.headers.get("x-service-key") || req.headers.get("x-master-key");
    const masterKey = Deno.env.get("MASTER_KEY") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const authSecret = Deno.env.get("AUTH_SECRET") || "";
    const legacyToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxuY2dtYXh0cWpmYmN5cG5jZm9lIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NzM0NzQxMywiZXhwIjoyMDgyOTIzNDEzfQ.zalV6mnyd1Iit0KbHnqLxemnBKFPbKz2159tkHtodJY";

    if (serviceKeyHeader === serviceKey || serviceKeyHeader === masterKey || serviceKeyHeader === legacyToken) {
        return { userId: 1, isSystem: true };
    }

    if (authHeader?.startsWith("Bearer ")) {
        const token = authHeader.substring(7).trim();
        if ((serviceKey !== "" && token === serviceKey) || (masterKey !== "" && token === masterKey) || (authSecret !== "" && token === authSecret) || token === legacyToken) {
            return { userId: 1, isSystem: true };
        }

        // Check custom auth_tokens table
        try {
            const { data: tokenData } = await supabase.from("auth_tokens").select("user_id").eq("token", token).single();
            if (tokenData) return { userId: tokenData.user_id, isSystem: false };
        } catch (e) { }

        // Fallback to JWT
        try {
            const encoder = new TextEncoder();
            const key = await crypto.subtle.importKey("raw", encoder.encode(JWT_SECRET || ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
            const payload = await verify(token, key);
            const sub = payload.sub as string;
            const userIdNum = parseInt(sub, 10);
            if (!isNaN(userIdNum)) return { userId: userIdNum, isSystem: false };
            return { userId: sub as any, isSystem: false };
        } catch (e: any) {
            console.log("Auth error:", e.message);
        }
    }
    return null;
}

// Fetch with retry
async function fetchWithRetry(url: string, retries = 3): Promise<any> {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url);
            const data = await res.json();
            if (data.error) {
                log(`FB API Error: ${data.error.message}`);
                if (i < retries - 1) {
                    await new Promise(r => setTimeout(r, 1000 * (i + 1)));
                    continue;
                }
            }
            return data;
        } catch (e: any) {
            log(`Fetch error: ${e.message}`);
            if (i < retries - 1) {
                await new Promise(r => setTimeout(r, 1000 * (i + 1)));
            }
        }
    }
    return { data: [] };
}

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

    const auth = await verifyAuth(req);
    if (!auth) return jsonResponse({ success: false, error: "Unauthorized" }, 401);

    try {
        const body = await req.json().catch(() => ({}));
        const { userId: forcedUserId } = body;
        const targetUserId = auth.isSystem ? forcedUserId : auth.userId;
        if (!targetUserId) return jsonResponse({ success: false, error: "Missing Target User ID" }, 400);

        log(`Crawling data for user: ${targetUserId}`);

        // 1. Get Ad Account Map
        log(`Fetching ad account mapping...`);
        const { data: adsData } = await supabase.from("unified_ads").select("external_id, platform_account_id");
        const adToAccountMap: Record<string, number> = {};
        adsData?.forEach((a: any) => adToAccountMap[a.external_id] = a.platform_account_id);

        const { data: creativesData } = await supabase
            .from("unified_ad_creatives")
            .select("platform_account_id, platform_data")
            .not("platform_data", "is", null)
            .limit(1000);

        const pageToAccount: Record<string, number> = {};
        creativesData?.forEach((c: any) => {
            const pId = c.platform_data?.object_story_spec?.page_id || c.platform_data?.page_id;
            if (pId) pageToAccount[String(pId)] = c.platform_account_id;
        });

        // 2. Get active User Token
        const { data: creds } = await supabase.from("platform_credentials").select("credential_value").eq("is_active", true).limit(1);
        if (!creds?.length) throw new Error("No active FB token found");
        const userToken = creds[0].credential_value;

        // 3. Fetch Managed Pages
        log("Fetching managed pages list...");
        const pagesData = await fetchWithRetry(`${FB_BASE_URL}/me/accounts?fields=id,name,access_token&limit=50&access_token=${userToken}`);
        const pages = pagesData.data || [];
        log(`Found ${pages.length} managed pages.`);

        let stats = { leads: 0, messages: 0, errors: 0 };
        const maxPages = 15;

        for (const page of pages.slice(0, maxPages)) {
            const pageId = String(page.id);
            const pageName = page.name;
            const pageToken = page.access_token;
            log(`Syncing Page: ${pageName}`);

            // Update centralized page info
            await supabase.from("platform_pages").upsert({
                id: pageId,
                name: pageName,
                access_token: pageToken,
                last_synced_at: new Date().toISOString()
            });

            const startOfMonth = new Date();
            startOfMonth.setDate(1);
            const since = Math.floor(startOfMonth.getTime() / 1000);

            try {
                const convData = await fetchWithRetry(`${FB_BASE_URL}/${pageId}/conversations?fields=id,participants,updated_time,snippet&limit=15&since=${since}&access_token=${pageToken}`);
                const conversations = convData.data || [];
                log(`- ${pageName}: Found ${conversations.length} conversations.`);

                for (const conv of conversations) {
                    try {
                        const customer = conv.participants?.data?.find((p: any) => String(p.id) !== pageId);
                        if (!customer) continue;

                        const customerId = String(customer.id);

                        // 1. Fetch messages to get referral info (ad_id)
                        const msgData = await fetchWithRetry(`${FB_BASE_URL}/${conv.id}/messages?fields=id,message,from,created_time,referral&limit=50&access_token=${pageToken}`);
                        const fbMsgs = msgData.data || [];

                        // 2. Determine the correctly linked account ID
                        let adId = fbMsgs.find((m: any) => m.referral?.ad_id)?.referral?.ad_id;
                        let accId = (adId && adToAccountMap[adId]) ? adToAccountMap[adId] : (pageToAccount[pageId] || 40);

                        // 3. Find existing data for this specific lead (User + Page)
                        const { data: existingLead } = await supabase
                            .from("leads")
                            .select("id, customer_name, customer_avatar")
                            .eq("platform_account_id", accId)
                            .eq("external_id", customerId)
                            .eq("fb_page_id", pageId)
                            .maybeSingle();

                        let customerName = existingLead?.customer_name || null;
                        let customerAvatar = existingLead?.customer_avatar || null;
                        const hasName = customerName && customerName !== "Khách hàng" && customerName !== customerId;

                        // 4. Fetch/Refresh profile if needed
                        if (!hasName || !customerAvatar) {
                            try {
                                const profileRes = await fetch(`${FB_BASE_URL}/${customerId}?fields=name,profile_pic&access_token=${pageToken}`);
                                const profileData = await profileRes.json();
                                if (!profileData.error) {
                                    if (!hasName && profileData.name) customerName = profileData.name;
                                    if (!customerAvatar && profileData.profile_pic) customerAvatar = profileData.profile_pic;
                                } else if (!customerName) {
                                    customerName = customer.name || "Khách hàng";
                                }
                            } catch (e) {
                                if (!customerName) customerName = customer.name || "Khách hàng";
                            }
                        }

                        // 5. Upsert Lead
                        const leadUpsertData: any = {
                            platform_account_id: accId,
                            external_id: customerId,
                            fb_page_id: pageId,
                            customer_name: customerName,
                            customer_avatar: customerAvatar,
                            last_message_at: toVietnamTimestamp(conv.updated_time),
                            is_read: true,
                            platform_data: {
                                fb_conv_id: conv.id,
                                fb_page_id: pageId,
                                fb_page_name: pageName,
                                snippet: conv.snippet
                            }
                        };

                        const { data: leadRows, error: lErr } = await supabase
                            .from("leads")
                            .upsert(leadUpsertData, { onConflict: "platform_account_id,external_id,fb_page_id" })
                            .select("id");

                        if (lErr || !leadRows?.length) {
                            log(`Lead upsert error: ${lErr?.message}`);
                            continue;
                        }
                        const leadId = leadRows[0].id;
                        stats.leads++;

                        // 6. Upsert Messages
                        if (fbMsgs.length > 0) {
                            const dbMsgs = fbMsgs.map((m: any) => {
                                const senderId = String(m.from?.id || "");
                                const isFromPage = senderId === pageId;
                                return {
                                    lead_id: leadId,
                                    fb_message_id: m.id,
                                    sender_id: senderId,
                                    sender_name: isFromPage ? pageName : (m.from?.name || customerName),
                                    message_content: m.message || "",
                                    sent_at: toVietnamTimestamp(m.created_time),
                                    is_from_customer: !isFromPage
                                };
                            });
                            await supabase.from("lead_messages").upsert(dbMsgs, { onConflict: "fb_message_id" });
                            stats.messages += dbMsgs.length;
                        }
                    } catch (e: any) {
                        log(`Conv error: ${e.message}`);
                        stats.errors++;
                    }
                }
            } catch (e: any) {
                log(`- Error page ${pageName}: ${e.message}`);
            }
        }

        log(`Done: ${stats.leads} leads, ${stats.messages} messages, ${stats.errors} errors`);
        return jsonResponse({ success: true, result: stats, logs });

    } catch (err: any) {
        log(`FATAL: ${err.message}`);
        return jsonResponse({ success: false, error: err.message, logs }, 500);
    }
});
