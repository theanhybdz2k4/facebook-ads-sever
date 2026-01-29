
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
        if (mode === "subscribe" && token === VERIFY_TOKEN) {
            console.log("[FB-Webhook] Verification successful!");
            return new Response(challenge, { status: 200 });
        }
        console.error("[FB-Webhook] Verification failed!");
        return new Response("Forbidden", { status: 403 });
    }

    // POST - Receive Webhook Events
    if (req.method === "POST") {
        try {
            const body = await req.json();
            console.log("[FB-Webhook] Received event:", JSON.stringify(body));

            if (body.object !== "page") {
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
                    console.warn(`[FB-Webhook] REJECTED: Page ${pageId} is not authorized in our system`);
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
                    if (!customerId) continue;

                    console.log(`[FB-Webhook] Processing message for customer ${customerId}`);

                    // Get customer info
                    let customerName = "Khách hàng";
                    let customerAvatar = null;
                    let pageName = pageId;

                    if (pageToken) {
                        try {
                            if (!isFromPage) {
                                const profileRes = await fetch(`${FB_BASE_URL}/${customerId}?fields=name,profile_pic&access_token=${pageToken}`);
                                const profileData = await profileRes.json();
                                if (profileData.name) customerName = profileData.name;
                                if (profileData.profile_pic) customerAvatar = profileData.profile_pic;
                            }
                            const pageInfoRes = await fetch(`${FB_BASE_URL}/${pageId}?fields=name&access_token=${pageToken}`);
                            const pageInfoData = await pageInfoRes.json();
                            if (pageInfoData.name) pageName = pageInfoData.name;
                        } catch (e) { }
                    }

                    // Check if lead exists
                    const { data: existingLead } = await supabase
                        .from("leads")
                        .select("id")
                        .eq("platform_account_id", accountId)
                        .eq("external_id", customerId)
                        .single();

                    let lead, leadError;

                    if (existingLead) {
                        const result = await supabase
                            .from("leads")
                            .update({
                                customer_name: customerName,
                                customer_avatar: customerAvatar,
                                last_message_at: new Date(timestamp).toISOString(),
                                is_read: isFromPage, // If from page, keep as read. If from customer, mark as unread.
                                platform_data: { 
                                    fb_page_id: pageId, 
                                    fb_page_name: pageName, 
                                    snippet: message?.text?.substring(0, 100) || "Tin nhắn mới" 
                                }
                            })
                            .eq("id", existingLead.id)
                            .select()
                            .single();
                        lead = result.data;
                        leadError = result.error;
                    } else {
                        const result = await supabase
                            .from("leads")
                            .insert({
                                id: crypto.randomUUID(),
                                platform_account_id: accountId,
                                external_id: customerId,
                                customer_name: customerName,
                                customer_avatar: customerAvatar,
                                last_message_at: new Date(timestamp).toISOString(),
                                source_campaign_id: referral?.ad_id || null,
                                is_read: isFromPage,
                                platform_data: { 
                                    fb_page_id: pageId, 
                                    fb_page_name: pageName, 
                                    snippet: message?.text?.substring(0, 100) || "Tin nhắn mới" 
                                }
                            })
                            .select()
                            .single();
                        lead = result.data;
                        leadError = result.error;
                    }

                    if (leadError) {
                        console.error("[FB-Webhook] Lead error:", leadError);
                        continue;
                    }
                    leadsUpdated++;

                    // Insert Message
                    if (message && lead) {
                        const { error: msgError } = await supabase
                            .from("lead_messages")
                            .upsert({
                                id: crypto.randomUUID(),
                                lead_id: lead.id,
                                fb_message_id: message.mid,
                                sender_id: senderId,
                                sender_name: isFromPage ? pageName : customerName,
                                message_content: message.text || "",
                                sent_at: new Date(timestamp).toISOString(),
                                is_from_customer: !isFromPage
                            }, { onConflict: "fb_message_id" });

                        if (!msgError) messagesInserted++;
                        else console.error("[FB-Webhook] Message error:", msgError);
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
