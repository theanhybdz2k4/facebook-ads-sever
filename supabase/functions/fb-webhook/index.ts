
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const supabase = createClient(supabaseUrl, supabaseKey);

const VERIFY_TOKEN = Deno.env.get("FB_WEBHOOK_VERIFY_TOKEN") || "colorme_webhook_secret";
const FB_BASE_URL = "https://graph.facebook.com/v24.0";

const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const jsonResponse = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: corsHeaders });

// Helper to convert timestamp to Vietnam timezone (UTC+7) for storage
// Database stores Vietnam time directly for correct display
function toVietnamTimestamp(timestamp: number | string | Date): string {
    const date = new Date(timestamp);
    // Add 7 hours to convert UTC to Vietnam time
    const vnTime = new Date(date.getTime() + 7 * 60 * 60 * 1000);
    return vnTime.toISOString().slice(0, 19).replace('T', ' '); // Format: YYYY-MM-DD HH:mm:ss
}

// Cache for authorized pages - maps pageId to { token, accountId, identityId }
interface PageAuth {
    token: string;
    accountId: number;
    identityId: number;
}

Deno.serve(async (req) => {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }

    // GET - Facebook Webhook Verification
    if (req.method === "GET") {
        const mode = url.searchParams.get("hub.mode");
        const token = url.searchParams.get("hub.verify_token");
        const challenge = url.searchParams.get("hub.challenge");

        console.log(`[FB-Webhook] Verification attempt: mode=${mode}, token=${token}, expected=${VERIFY_TOKEN}`);

        if (mode === "subscribe" && token === VERIFY_TOKEN) {
            console.log("[FB-Webhook] Verification successful!");
            return new Response(challenge, { status: 200 });
        }

        console.error(`[FB-Webhook] Verification failed! Got token "${token}", expected "${VERIFY_TOKEN}"`);
        return new Response("Forbidden", { status: 403 });
    }

    // POST - Receive Webhook Events
    if (req.method === "POST") {
        try {
            const body = await req.json();
            console.log("[FB-Webhook] Received webhook event body:", JSON.stringify(body, null, 2));

            if (body.object !== "page") {
                console.log(`[FB-Webhook] Ignored non-page object: ${body.object}`);
                return jsonResponse({ status: "ignored", reason: "not a page event" });
            }

            // Get ALL active tokens from database
            const { data: credentials } = await supabase
                .from("platform_credentials")
                .select(`
                    credential_value,
                    platform_identity_id,
                    platform_identities!inner(id, user_id)
                `)
                .eq("is_active", true)
                .eq("credential_type", "access_token");

            if (!credentials || credentials.length === 0) {
                console.log("[FB-Webhook] No active tokens found");
                return jsonResponse({ status: "ok", message: "No tokens configured" });
            }

            // Build a map of authorized pages
            // For each token, get the pages it has access to
            const authorizedPages: Record<string, PageAuth> = {};

            for (const cred of credentials) {
                const token = cred.credential_value;
                const identityId = cred.platform_identity_id;

                try {
                    // Get pages this token has access to
                    const pagesRes = await fetch(`${FB_BASE_URL}/me/accounts?fields=id,name,access_token&access_token=${token}`);
                    const pagesData = await pagesRes.json();

                    if (pagesData.data) {
                        for (const page of pagesData.data) {
                            authorizedPages[page.id] = {
                                token: page.access_token || token,
                                accountId: 40, // Will be resolved later
                                identityId: identityId
                            };
                        }
                    }
                } catch (e) {
                    console.warn(`[FB-Webhook] Failed to get pages for identity ${identityId}`);
                }
            }

            console.log(`[FB-Webhook] Authorized pages: ${Object.keys(authorizedPages).join(", ")}`);

            // Get platform_account mapping (page -> ad account)
            const { data: accountsData } = await supabase
                .from("platform_accounts")
                .select("id, platform_identity_id")
                .eq("platform_id", 1); // Facebook

            const identityToAccountMap: Record<number, number> = {};
            accountsData?.forEach((acc: any) => {
                if (!identityToAccountMap[acc.platform_identity_id]) {
                    identityToAccountMap[acc.platform_identity_id] = acc.id;
                }
            });

            let leadsUpdated = 0;
            let messagesInserted = 0;
            let pagesSkipped = 0;

            // Process each entry
            for (const entry of body.entry || []) {
                const pageId = entry.id;

                // *** SECURITY CHECK: Only process if page is authorized ***
                const pageAuth = authorizedPages[pageId];
                if (!pageAuth) {
                    console.warn(`[FB-Webhook] REJECTED: Page ${pageId} is not authorized in our system. Authorized pages are: ${Object.keys(authorizedPages).join(", ")}`);
                    pagesSkipped++;
                    continue;
                }

                console.log(`[FB-Webhook] ACCEPTED: Page ${pageId} belongs to identity ${pageAuth.identityId}`);

                const pageToken = pageAuth.token;
                const accountId = identityToAccountMap[pageAuth.identityId] || 40;

                // Process messaging events
                for (const messaging of entry.messaging || []) {
                    const senderId = messaging.sender?.id;
                    const recipientId = messaging.recipient?.id;
                    const timestamp = messaging.timestamp;
                    const message = messaging.message;
                    const referral = messaging.referral;

                    const isFromPage = senderId === pageId;
                    const customerId = isFromPage ? recipientId : senderId;
                    if (!customerId) {
                        console.warn("[FB-Webhook] Missing customerId in messaging event");
                        continue;
                    }

                    console.log(`[FB-Webhook] Processing message from ${isFromPage ? 'PAGE' : 'CUSTOMER'} ${customerId} on Page ${pageId}`);

                    // Check if lead already exists with valid customer info
                    const { data: existingLead } = await supabase
                        .from("leads")
                        .select("id, customer_name, customer_avatar")
                        .eq("platform_account_id", accountId)
                        .eq("external_id", customerId)
                        .single();

                    let customerName = existingLead?.customer_name || null;
                    let customerAvatar = existingLead?.customer_avatar || null;
                    let pageName = pageId;

                    // Check if we have valid existing data
                    const hasValidName = customerName && customerName !== "Khách hàng" && customerName !== customerId;

                    if (pageToken) {
                        // Fetch customer profile (only if we don't have valid info and message is from customer)
                        if (!isFromPage && (!hasValidName || !customerAvatar)) {
                            try {
                                console.log(`[FB-Webhook] Fetching profile for customer ${customerId}...`);
                                const profileRes = await fetch(`${FB_BASE_URL}/${customerId}?fields=name,profile_pic&access_token=${pageToken}`);
                                const profileData = await profileRes.json();
                                
                                if (profileData.error) {
                                    console.error(`[FB-Webhook] FB API Error fetching profile: ${profileData.error.message} (code: ${profileData.error.code})`);
                                    // Try to get name from conversation participants as fallback
                                    if (!hasValidName) {
                                        try {
                                            const convsRes = await fetch(`${FB_BASE_URL}/${pageId}/conversations?user_id=${customerId}&fields=participants&access_token=${pageToken}`);
                                            const convsData = await convsRes.json();
                                            const participant = convsData.data?.[0]?.participants?.data?.find((p: any) => p.id === customerId);
                                            if (participant?.name) {
                                                customerName = participant.name;
                                                console.log(`[FB-Webhook] Got customer name from conversation: ${customerName}`);
                                            }
                                        } catch (fallbackErr) {
                                            console.error(`[FB-Webhook] Fallback conversation fetch also failed`);
                                        }
                                    }
                                } else {
                                    if (!hasValidName && profileData.name) {
                                        customerName = profileData.name;
                                        console.log(`[FB-Webhook] Fetched customer name: ${customerName}`);
                                    }
                                    if (!customerAvatar && profileData.profile_pic) {
                                        customerAvatar = profileData.profile_pic;
                                    }
                                }
                            } catch (e: any) {
                                console.error(`[FB-Webhook] Network error fetching profile: ${e.message}`);
                            }
                        }
                        
                        // Fetch page name
                        try {
                            const pageInfoRes = await fetch(`${FB_BASE_URL}/${pageId}?fields=name&access_token=${pageToken}`);
                            const pageInfoData = await pageInfoRes.json();
                            if (pageInfoData.name) pageName = pageInfoData.name;
                        } catch (e) {
                            console.error(`[FB-Webhook] Failed to fetch page info`);
                        }
                    }

                    let lead, leadError;

                    // Build lead data - only include fields that should always be updated
                    const leadBaseData: any = {
                        last_message_at: toVietnamTimestamp(timestamp),
                        is_read: isFromPage,
                        platform_data: {
                            fb_page_id: pageId,
                            fb_page_name: pageName,
                            snippet: message?.text?.substring(0, 100) || "Tin nhắn mới"
                        }
                    };
                    
                    // Only update customer_name if we have a valid new one
                    if (customerName && customerName !== "Khách hàng") {
                        leadBaseData.customer_name = customerName;
                    }
                    
                    // Only update avatar if we have one
                    if (customerAvatar) {
                        leadBaseData.customer_avatar = customerAvatar;
                    }

                    if (existingLead) {
                        const result = await supabase
                            .from("leads")
                            .update(leadBaseData)
                            .eq("id", existingLead.id)
                            .select()
                            .single();
                        lead = result.data;
                        leadError = result.error;
                        console.log(`[FB-Webhook] Updated existing lead: ${lead?.id}`);
                    } else {
                        // New lead - set defaults for required fields
                        const insertData = {
                            id: crypto.randomUUID(),
                            platform_account_id: accountId,
                            external_id: customerId,
                            source_campaign_id: referral?.ad_id || null,
                            customer_name: customerName || "Khách hàng",
                            customer_avatar: customerAvatar,
                            ...leadBaseData
                        };
                        
                        const result = await supabase
                            .from("leads")
                            .insert(insertData)
                            .select()
                            .single();
                        lead = result.data;
                        leadError = result.error;
                        console.log(`[FB-Webhook] Created new lead: ${lead?.id}`);
                    }

                    if (leadError) {
                        console.error("[FB-Webhook] Lead error:", leadError);
                        continue;
                    }
                    leadsUpdated++;

                    // Use lead.customer_name as final source of truth for all messages
                    const finalCustomerName = lead?.customer_name || customerName || "Khách hàng";

                    // 1. Insert current message
                    if (message && lead) {
                        const { error: msgError } = await supabase
                            .from("lead_messages")
                            .upsert({
                                id: crypto.randomUUID(),
                                lead_id: lead.id,
                                fb_message_id: message.mid,
                                sender_id: senderId,
                                sender_name: isFromPage ? pageName : finalCustomerName,
                                message_content: message.text || "",
                                sent_at: toVietnamTimestamp(timestamp),
                                is_from_customer: !isFromPage
                            }, { onConflict: "fb_message_id" });

                        if (!msgError) {
                            messagesInserted++;
                            console.log(`[FB-Webhook] Inserted current message: ${message.mid}`);
                        } else {
                            console.error("[FB-Webhook] Message error:", msgError);
                        }
                    }

                    // 2. CRAWL ENTIRE CONVERSATION (like pancake.vn)
                    if (lead && pageToken) {
                        try {
                            console.log(`[FB-Webhook] Triggering full conversation crawl for customer ${customerId}...`);
                            // Fetch conversations to find the ID
                            const convsRes = await fetch(`${FB_BASE_URL}/${pageId}/conversations?user_id=${customerId}&fields=id,updated_time,snippet&access_token=${pageToken}`);
                            const convsData = await convsRes.json();

                            const conv = convsData.data?.[0];
                            if (conv) {
                                console.log(`[FB-Webhook] Found conversation ID: ${conv.id}. Fetching historical messages...`);
                                // Fetch messages for this conversation
                                const msgsRes = await fetch(`${FB_BASE_URL}/${conv.id}/messages?fields=id,message,from,created_time&limit=50&access_token=${pageToken}`);
                                const msgsData = await msgsRes.json();

                                if (msgsData.data && msgsData.data.length > 0) {
                                    const dbMessages = msgsData.data.map((m: any) => {
                                        const msgSenderId = String(m.from?.id || "");
                                        const isMsgFromPage = msgSenderId === pageId;
                                        // Use from.name if available, otherwise use our resolved names
                                        let senderName = m.from?.name;
                                        if (!senderName) {
                                            senderName = isMsgFromPage ? pageName : finalCustomerName;
                                        }
                                        return {
                                            id: crypto.randomUUID(),
                                            lead_id: lead.id,
                                            fb_message_id: m.id,
                                            sender_id: msgSenderId,
                                            sender_name: senderName,
                                            message_content: m.message || "",
                                            sent_at: m.created_time,
                                            is_from_customer: !isMsgFromPage
                                        };
                                    });

                                    const { error: crawlError } = await supabase
                                        .from("lead_messages")
                                        .upsert(dbMessages, { onConflict: "fb_message_id" });

                                    if (!crawlError) {
                                        console.log(`[FB-Webhook] Successfully crawled ${dbMessages.length} historical messages`);
                                    } else {
                                        console.error(`[FB-Webhook] Crawl upsert error:`, crawlError);
                                    }
                                }
                            } else {
                                console.warn(`[FB-Webhook] Could not find conversation ID for customer ${customerId}`);
                            }
                        } catch (crawlErr) {
                            console.error(`[FB-Webhook] Fatal error during crawl:`, crawlErr);
                        }
                    }
                }
            }

            console.log(`[FB-Webhook] Done: ${leadsUpdated} leads, ${messagesInserted} messages, ${pagesSkipped} pages skipped`);
            return jsonResponse({ status: "ok", leadsUpdated, messagesInserted, pagesSkipped });

        } catch (err: any) {
            console.error("[FB-Webhook] Error:", err);
            return jsonResponse({ status: "error", error: err.message });
        }
    }

    return jsonResponse({ error: "Method not allowed" }, 405);
});
