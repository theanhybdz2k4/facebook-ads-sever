
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";
import { verify } from "https://deno.land/x/djwt@v3.0.1/mod.ts";
import { resolveAvatarWithCrawler } from "../_shared/fb_crawler.ts";


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
        const { userId: forcedUserId, force_historic: forceHistoric } = body;
        const targetUserId = auth.isSystem ? forcedUserId : auth.userId;
        if (!targetUserId) return jsonResponse({ success: false, error: "Missing Target User ID" }, 400);

        log(`Crawling data for user: ${targetUserId} (Historic: ${!!forceHistoric})`);

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

        const { data: activeAccounts } = await supabase.from("unified_ads").select("platform_account_id").limit(1000);
        const activeAccIdsSet = new Set(activeAccounts?.map((a: any) => a.platform_account_id) || []);

        const pageToAccount: Record<string, number> = {};
        creativesData?.forEach((c: any) => {
            const pId = c.platform_data?.object_story_spec?.page_id || c.platform_data?.page_id;
            if (pId && activeAccIdsSet.has(c.platform_account_id) && c.platform_account_id !== 45 && c.platform_account_id !== 46) {
                pageToAccount[String(pId)] = c.platform_account_id;
            }
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

        // Map page tokens for easy access
        const pageTokens: Record<string, string> = {};
        pages.forEach((p: any) => pageTokens[p.id] = p.access_token);

        let stats = { leads: 0, messages: 0, errors: 0 };
        const maxPages = 15;

        // --- MODE A: HISTORIC DEEP CRAWL (Targeting Existing Leads) ---
        if (forceHistoric) {
            log("Creating Deep Crawl for existing leads in DB...");

            // Fetch all leads that have page_id information
            const { data: dbLeads } = await supabase
                .from("leads")
                .select("id, fb_page_id, external_id, platform_data, customer_name")
                .not("fb_page_id", "is", null)
                .order("last_message_at", { ascending: false })
                .limit(500); // Process top 500 active leads for safety

            if (!dbLeads || dbLeads.length === 0) {
                return jsonResponse({ success: true, message: "No leads found to sync", stats });
            }

            log(`Found ${dbLeads.length} leads to backfill.`);

            for (const lead of dbLeads) {
                const pToken = pageTokens[lead.fb_page_id];
                const convId = lead.platform_data?.fb_conv_id;

                if (!pToken) {
                    log(`Skipping lead ${lead.customer_name}: No token for page ${lead.fb_page_id}`);
                    continue;
                }
                if (!convId) {
                    log(`Skipping lead ${lead.customer_name}: No conv ID`);
                    continue;
                }

                log(`Backfilling lead: ${lead.customer_name} (${convId})`);

                // Pagination Loop
                let nextUrl = `${FB_BASE_URL}/${convId}/messages?fields=id,message,from,created_time,referral,attachments,shares,sticker&limit=100&access_token=${pToken}`;
                let pageCount = 0;
                let latestMsgTime: any = null;

                while (nextUrl && pageCount < 10) { // Safety limit: 1000 messages per lead
                    try {
                        const res: any = await fetchWithRetry(nextUrl);
                        const msgs = res.data || [];

                        if (msgs.length > 0) {
                            // Track latest message time for sorting
                            const batchLatest = msgs[0].created_time; // FB returns newest first
                            if (!latestMsgTime || new Date(batchLatest) > new Date(latestMsgTime)) {
                                latestMsgTime = batchLatest;
                            }

                            const dbMessages = msgs.map((m: any) => {
                                const msgSenderId = String(m.from?.id || "");
                                const isMsgFromPage = msgSenderId === String(lead.fb_page_id);

                                let content = m.message || "";
                                if (!content && m.attachments?.data) {
                                    const types = m.attachments.data.map((a: any) => `[${a.type || 'attachment'}]`).join(" ");
                                    content = types;
                                }
                                if (!content && m.sticker) content = "[Sticker]";
                                if (!content) content = "[Media]";

                                return {
                                    id: crypto.randomUUID(),
                                    lead_id: lead.id,
                                    fb_message_id: m.id,
                                    sender_id: msgSenderId,
                                    sender_name: isMsgFromPage ? (pages.find((p: any) => p.id === lead.fb_page_id)?.name || "Page") : (lead.customer_name || "Khách hàng"),
                                    message_content: content,
                                    attachments: m.attachments?.data || null,
                                    sticker: m.sticker || null,
                                    shares: m.shares?.data || null,
                                    sent_at: toVietnamTimestamp(m.created_time),
                                    is_from_customer: !isMsgFromPage
                                };
                            });

                            const { error: msgErr } = await supabase
                                .from("lead_messages")
                                .upsert(dbMessages, { onConflict: "fb_message_id" });

                            if (msgErr) log(`Msg upsert err: ${msgErr.message}`);
                            else stats.messages += dbMessages.length;
                        }

                        nextUrl = res.paging?.next || null;
                        pageCount++;

                    } catch (e: any) {
                        log(`Error fetching msgs for lead ${lead.id}: ${e.message}`);
                        break;
                    }
                }

                // Update lead's last_message_at if we found a message (to fix sorting)
                if (latestMsgTime) {
                    await supabase
                        .from("leads")
                        .update({ last_message_at: toVietnamTimestamp(latestMsgTime) })
                        .eq("id", lead.id);
                }

                stats.leads++;
            }

            return jsonResponse({ success: true, result: stats, logs });
        }


        // --- MODE B: STANDARD RECENT SYNC (Default) ---
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

            let conversations: any[] = [];
            let convNextUrl: string | null = `${FB_BASE_URL}/${pageId}/conversations?fields=id,participants,updated_time,snippet&limit=50&since=${since}&access_token=${pageToken}`;
            let convPageCount = 0;

            while (convNextUrl && convPageCount < 10) { // Limit to 10 pages of 50 = 500 conversations max per sync
                try {
                    const res: any = await fetchWithRetry(convNextUrl);
                    const batch = res.data || [];
                    if (batch.length === 0) break;

                    conversations = [...conversations, ...batch];
                    convNextUrl = res.paging?.next || null;
                    convPageCount++;
                } catch (e: any) {
                    log(`Error fetching conv page ${convPageCount}: ${e.message}`);
                    break;
                }
            }
            log(`- ${pageName}: Found ${conversations.length} conversations.`);

            for (const conv of conversations) {
                try {
                    const customer = conv.participants?.data?.find((p: any) => String(p.id) !== pageId);
                    if (!customer) continue;

                    const customerId = String(customer.id);

                    // 1. Fetch messages to get referral info (ad_id) AND sync content
                    const msgData = await fetchWithRetry(`${FB_BASE_URL}/${conv.id}/messages?fields=id,message,from,created_time,referral,attachments,shares,sticker&limit=100&access_token=${pageToken}`);
                    const fbMsgs = msgData.data || [];

                    // 2. Determine the correctly linked account ID (Smarter extraction)
                    let adId: string | null = null;
                    for (const m of fbMsgs) {
                        const foundId = m.referral?.ad_id || m.referral?.campaign_id || m.referral?.ad_id_key || m.referral?.ads_context_data?.ad_id;
                        if (foundId) {
                            adId = String(foundId);
                            break;
                        }
                    }

                    let accId = (adId && adToAccountMap[adId]) ? adToAccountMap[adId] : (pageToAccount[pageId] || 40);

                    // RE-VERIFY Account ID if we have an adId (Lookup in DB if map failed)
                    if (adId && (!accId || accId === 40 || accId === 46)) {
                        const { data: adLookup } = await supabase.from("unified_ads").select("platform_account_id").eq("external_id", adId).maybeSingle();
                        if (adLookup?.platform_account_id) accId = adLookup.platform_account_id;
                    }

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
                            const profileRes = await fetch(`${FB_BASE_URL}/${customerId}?fields=name,first_name,last_name,profile_pic,picture&access_token=${pageToken}`);
                            const profileData = await profileRes.json();

                            if (!profileData.error) {
                                let resolvedName = profileData.name;
                                if (!resolvedName && (profileData.first_name || profileData.last_name)) {
                                    resolvedName = [profileData.first_name, profileData.last_name].filter(Boolean).join(" ");
                                }

                                if (!hasName && resolvedName) customerName = resolvedName;
                                if (!customerAvatar) {
                                    customerAvatar = profileData.profile_pic || profileData.picture?.data?.url;
                                }

                                // Fallback for avatar if still missing
                                if (!customerAvatar) {
                                    try {
                                        const picRes = await fetch(`${FB_BASE_URL}/${customerId}/picture?type=large&redirect=false&access_token=${pageToken}`);
                                        const picData = await picRes.json();
                                        if (picData.data?.url) {
                                            customerAvatar = picData.data.url;
                                        }
                                    } catch (e) { }
                                }
                            } else if (!customerName) {
                                customerName = customer.name || "Khách hàng";
                            }
                        } catch (e) {
                            if (!customerName) customerName = customer.name || "Khách hàng";
                        }

                        // METHOD 1.5: Crawler Fallback (Pancake Strategy)
                        if (!customerAvatar) {
                            try {
                                customerAvatar = await resolveAvatarWithCrawler(supabase, customerId);
                                if (customerAvatar) {
                                    log(`Avatar resolved via Crawler! ${customerAvatar}`);
                                }
                            } catch (crawlErr: any) {
                                log(`Crawler fallback error: ${crawlErr.message}`);
                            }
                        }
                    }


                    // 5. Upsert Lead
                    // Try to get earliest message time for first_contact_at
                    let earliestMsgTime = null;
                    if (fbMsgs.length > 0) {
                        // Messages are returned newest first, so last item is oldest
                        const oldestMsg = fbMsgs[fbMsgs.length - 1];
                        earliestMsgTime = oldestMsg?.created_time;
                    }
                    
                    const leadUpsertData: any = {
                        platform_account_id: accId,
                        external_id: customerId,
                        fb_page_id: pageId,
                        customer_name: customerName,
                        customer_avatar: customerAvatar,
                        last_message_at: toVietnamTimestamp(conv.updated_time),
                        is_read: true,
                        is_qualified: !!adId,
                        source_campaign_id: adId || null,
                        metadata: {
                            ...(existingLead?.metadata || {}),
                            qualified_at: existingLead?.metadata?.qualified_at || (adId ? toVietnamTimestamp(conv.updated_time) : null)
                        },
                        platform_data: {
                            fb_conv_id: conv.id,
                            fb_page_id: pageId,
                            fb_page_name: pageName,
                            snippet: conv.snippet
                        }
                    };
                    
                    // Set first_contact_at only for NEW leads (or if not set yet)
                    if (!existingLead) {
                        leadUpsertData.first_contact_at = earliestMsgTime ? toVietnamTimestamp(earliestMsgTime) : toVietnamTimestamp(conv.updated_time);
                        log(`New lead ${customerName}: first_contact_at = ${leadUpsertData.first_contact_at}`);
                    }

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

                    // 6. SYNC MESSAGES
                    if (fbMsgs.length > 0) {
                        const dbMessages = fbMsgs.map((m: any) => {
                            const msgSenderId = String(m.from?.id || "");
                            const isMsgFromPage = msgSenderId === pageId;

                            // Parse attachments for text summary if needed
                            let content = m.message || "";
                            if (!content && m.attachments?.data) {
                                const types = m.attachments.data.map((a: any) => `[${a.type || 'attachment'}]`).join(" ");
                                content = types;
                            }
                            if (!content && m.sticker) content = "[Sticker]";
                            if (!content) content = "[Media]";

                            return {
                                id: crypto.randomUUID(),
                                lead_id: leadId,
                                fb_message_id: m.id,
                                sender_id: msgSenderId,
                                sender_name: isMsgFromPage ? pageName : (customerName || "Khách hàng"),
                                message_content: content,
                                attachments: m.attachments?.data || null,
                                sticker: m.sticker || null,
                                shares: m.shares?.data || null,
                                sent_at: toVietnamTimestamp(m.created_time),
                                is_from_customer: !isMsgFromPage
                            };
                        });

                        const { error: msgErr } = await supabase
                            .from("lead_messages")
                            .upsert(dbMessages, { onConflict: "fb_message_id" });

                        if (msgErr) log(`Msg sync error: ${msgErr.message}`);
                        else stats.messages += dbMessages.length;
                    }


                } catch (e: any) {
                    log(`Conv error: ${e.message}`);
                    stats.errors++;
                }
            }
        }
        log(`Done: ${stats.leads} profiles synced, ${stats.errors} errors`);

        return jsonResponse({ success: true, result: stats, logs });

    } catch (err: any) {
        log(`FATAL: ${err.message}`);
        return jsonResponse({ success: false, error: err.message, logs }, 500);
    }
});
