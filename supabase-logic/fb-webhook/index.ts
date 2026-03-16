
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

// Helper to convert any timestamp to standard UTC ISO 8601 string with 'Z'
function toUtcIso(timestamp: number | string | Date): string {
    if (!timestamp) return new Date().toISOString();
    const date = new Date(timestamp);
    return date.toISOString(); // Always returns YYYY-MM-DDTHH:mm:ss.sssZ
}


// Logic analyzeWithGemini đã được tách sang Edge Function fb-ai-analysis

// Cache for authorized pages - maps pageId to { name, token }


/**
 * Resolves a Facebook PSID to a Real UID/Avatar using a session cookie or user token.
 */
async function resolveAvatarWithCrawler(supabase: SupabaseClient, psid: string): Promise<string | null> {
    console.log("[FB-Crawler] Attempting to resolve avatar for PSID: " + psid + "...");

    try {
        // 1. Get the crawler credential from platform_credentials
        const { data: credential } = await supabase
            .from("platform_credentials")
            .select("credential_value, credential_type")
            .in("credential_type", ["fb_crawler_cookie", "fb_crawler_user_token"])
            .eq("is_active", true)
            .order("credential_type", { ascending: false }) // Prioritize cookie for now
            .limit(1)
            .maybeSingle();

        if (!credential) {
            console.log("[FB-Crawler] No active crawler cookies/tokens found in platform_credentials.");
            return null;
        }

        if (credential.credential_type === "fb_crawler_cookie") {
            const cookie = credential.credential_value;
            console.log("[FB-Crawler] Using session cookie strategy...");

            // Strategy: Visit m.facebook.com/{psid} with cookie to find the real ID
            const url = "https://m.facebook.com/" + psid;
            const res = await fetch(url, {
                headers: {
                    "Cookie": cookie,
                    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Mobile/15E148 Safari/604.1",
                    "Accept": "text/html"
                },
                redirect: "follow"
            });

            const finalUrl = res.url;
            console.log("[FB-Crawler] Final URL after redirects: " + finalUrl);

            // Try to extract UID from URL (e.g., id=1000... or /username)
            let uidMatch = finalUrl.match(/id=(\d+)/);
            let uid = uidMatch ? uidMatch[1] : null;

            if (!uid) {
                try {
                    const parsedUrl = new URL(finalUrl);
                    const pathParts = parsedUrl.pathname.split("/");
                    const profileId = pathParts[1];
                    if (profileId && !["login.php", "profile.php", "login"].includes(profileId)) {
                        uid = profileId;
                    }
                } catch (e) { }
            }

            // If URL didn't yield ID or as a primary strategy, scrape the HTML for the direct CDN link
            const html = await res.text();

            // Look for actual Facebook CDN links (scontent) which are the "real" images
            // We look for common patterns in m.facebook.com HTML for profile pictures
            const cdnPatterns = [
                new RegExp('https://scontent\\.[^"&?]+/v/[^"&?]+\\.(?:jpg|png|webp)[^"&?]*', 'gi'),
                new RegExp('https:\\\\[/][/]scontent\\.[^"&?]+/v/[^"&?]+\\.(?:jpg|png|webp)[^"&?]*', 'gi')
            ];


            for (const pattern of cdnPatterns) {
                const matches = html.match(pattern);
                if (matches) {
                    // Find the most likely profile picture (usually has 'p100x100', 'p200x200' or similar in the URL)
                    // Or just pick the first one that looks like a profile pic
                    for (let match of matches) {
                        match = match.replace(/\\/g, ''); // Clean up escaped slashes
                        if (match.includes('/v/') && (match.includes('stp=') || match.includes('_n.'))) {
                            console.log("[FB-Crawler] Found direct CDN avatar: " + match.substring(0, 50) + "...");
                            return match.replace(/&amp;/g, "&");
                        }
                    }
                }
            }

            // Fallback: try to find the UID and return a standard placeholder ONLY if absolutely necessary,
            // but we'll try to find any scontent link first.
            const bodyMatch = html.match(/"entity_id":"(\d+)"/);
            uid = bodyMatch ? bodyMatch[1] : (html.match(/"userID":"(\d+)"/)?.[1] || null);

            if (uid) {
                console.log("[FB-Crawler] Successfully resolved UID as fallback: " + uid);
                // Even with UID, we prefer the scraped link. 
                // Using a public URL that might work without API if scraping fails 
                return `https://www.facebook.com/search/top/?q=${uid}`; // Not an image, just a fallback marker
            }
        } else if (credential.credential_type === "fb_crawler_user_token") {
            // Fallback strategy using a high-privilege user token if available
            console.log("[FB-Crawler] Using public user token strategy...");
            const token = credential.credential_value;
            const res = await fetch("https://graph.facebook.com/" + psid + "/picture?type=large&redirect=false&access_token=" + token);
            const data = await res.json();
            if (data.data?.url) return data.data.url;
        }

    } catch (e: any) {
        console.error("[FB-Crawler] Error during resolution: " + e.message);
    }

    return null;
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

        console.log("[FB-Webhook] Verification attempt: mode=" + mode + ", token=" + token + ", expected=" + VERIFY_TOKEN);

        if (mode === "subscribe" && token === VERIFY_TOKEN) {
            console.log("[FB-Webhook] Verification successful!");
            return new Response(challenge, { status: 200 });
        }

        console.error("[FB-Webhook] Verification failed! Got token \"" + token + "\", expected \"" + VERIFY_TOKEN + "\"");
        return new Response("Forbidden", { status: 403 });
    }

    // POST - Receive Webhook Events
    if (req.method === "POST") {
        try {
            const body = await req.json();
            console.log("[FB-Webhook] Received webhook event body:", JSON.stringify(body, null, 2));

            if (body.object !== "page") {
                console.log("[FB-Webhook] Ignored non-page object: " + body.object);
                await supabase.from("debug_sync_logs").insert({
                    function_name: "fb-webhook",
                    event: "IGNORED_NON_PAGE_OBJECT",
                    payload: { object: body.object }
                });
                return jsonResponse({ status: "ignored", reason: "not a page event" });
            }

            await supabase.from("debug_sync_logs").insert({
                function_name: "fb-webhook",
                event: "WEBHOOK_EVENT_RECEIVED",
                payload: { entryCount: body.entry?.length, object: body.object }
            });

            // Get cached page tokens from platform_pages table (NO Facebook API call!)
            const { data: pages } = await supabase
                .from("platform_pages")
                .select("id, name, access_token")
                .not("access_token", "is", null);

            if (!pages || pages.length === 0) {
                console.log("[FB-Webhook] No pages with tokens configured in platform_pages");
                return jsonResponse({ status: "ok", message: "No page tokens configured" });
            }

            // Build authorized pages map from cached data
            const authorizedPages: Record<string, { name: string; token: string }> = {};
            for (const page of pages) {
                authorizedPages[page.id] = {
                    name: page.name,
                    token: page.access_token
                };
            }

            console.log("[FB-Webhook] Authorized pages (from cache): " + Object.keys(authorizedPages).join(", "));

            // Get default account IDs to map pages to accounts
            const { data: accountsData } = await supabase
                .from("platform_accounts")
                .select("id, name")
                .eq("platform_id", 1) // Facebook
                .order("id", { ascending: true });

            // Get ACTIVE account IDs (those that actually have ads)
            const { data: activeAccounts } = await supabase
                .from("unified_ads")
                .select("platform_account_id")
                .limit(1000);
            const activeAccIdsSet = new Set(activeAccounts?.map((a: any) => a.platform_account_id) || []);

            const availableAccountIds = accountsData?.map((a: any) => a.id) || [40];
            // Prefer accounts that have ads, exclude 45, 46 explicitly
            const preferredAccountIds = availableAccountIds.filter((id: number) => activeAccIdsSet.has(id) && id !== 45 && id !== 46);
            const defaultAccountId = preferredAccountIds[0] || availableAccountIds[0];

            let leadsUpdated = 0;
            let messagesInserted = 0;
            let pagesSkipped = 0;

            // Process each entry
            for (const entry of body.entry || []) {
                const pageId = entry.id;

                // *** SECURITY CHECK: Only process if page is authorized ***
                const pageAuth = authorizedPages[pageId];
                if (!pageAuth) {
                    console.warn("[FB-Webhook] REJECTED: Page " + pageId + " is not authorized in our system. Authorized pages are: " + Object.keys(authorizedPages).join(", "));
                    pagesSkipped++;
                    continue;
                }

                console.log("[FB-Webhook] ACCEPTED: Page " + pageId + " (" + pageAuth.name + ") with cached token");
                
                await supabase.from("debug_sync_logs").insert({
                    function_name: "fb-webhook",
                    event: "PAGE_ACCEPTED",
                    payload: { 
                        pageId, 
                        pageName: pageAuth.name,
                        entryKeys: Object.keys(entry),
                        hasMessaging: !!entry.messaging,
                        messagingCount: entry.messaging?.length
                    }
                });

                const pageToken = pageAuth.token;

                // GET OWNER GEMINI API KEY: Resolve user owning this page to get their key
                let geminiApiKey = null;
                try {
                    // Try chatbot_config first (direct mapping)
                    const { data: ownerConfig } = await supabase
                        .from("chatbot_config")
                        .select("user_id")
                        .eq("page_id", pageId)
                        .maybeSingle();

                    let effectiveUserId = ownerConfig?.user_id;

                    // Fallback: check leads for this page to find account owner
                    if (!effectiveUserId) {
                        const { data: leadOwner } = await supabase
                            .from("leads")
                            .select("platform_accounts!inner(platform_identities!inner(user_id))")
                            .eq("fb_page_id", pageId)
                            .limit(1)
                            .maybeSingle();
                        effectiveUserId = (leadOwner?.platform_accounts as any)?.platform_identities?.user_id;
                    }

                    if (effectiveUserId) {
                        const { data: ownerData } = await supabase
                            .from("users")
                            .select("gemini_api_key")
                            .eq("id", effectiveUserId)
                            .maybeSingle();
                        geminiApiKey = ownerData?.gemini_api_key || null;
                    }
                } catch (e) {
                    console.error("[FB-Webhook] Failed to resolve owner/Gemini key:", e);
                }

                if (geminiApiKey) {
                    console.log("[FB-Webhook] Gemini API key resolved for owner of Page " + pageId);
                } else {
                    console.log("[FB-Webhook] No Gemini API key found for Page " + pageId + " owner");
                }

                // STABLE ACCOUNT MAPPING: Try to find which account this page belongs to
                let accountId = defaultAccountId;

                // 1. Try mapping via unified_ad_creatives (Strongest link: which account actually created ads for this page)
                const { data: creativeSample } = await supabase
                    .rpc('get_account_id_from_page_id', { p_page_id: pageId });

                if (creativeSample) {
                    accountId = creativeSample;
                    console.log("[FB-Webhook] Using accountId " + accountId + " (found via creatives rpc) for Page " + pageId);
                } else {
                    // 2. Try mapping via RECENT leads for this page that belong to an ACTIVE account
                    // We avoid account 45, 46 which the user says have no ads
                    const { data: pageLeadSample } = await supabase
                        .from("leads")
                        .select("platform_account_id")
                        .eq("fb_page_id", pageId)
                        .not("platform_account_id", "in", "(45,46)")
                        .order("last_message_at", { ascending: false })
                        .limit(1)
                        .maybeSingle();

                    if (pageLeadSample?.platform_account_id) {
                        accountId = pageLeadSample.platform_account_id;
                        console.log("[FB-Webhook] Using stable accountId " + accountId + " (found via recent leads) for Page " + pageId);
                    } else {
                        console.log("[FB-Webhook] No mapping found for Page " + pageId + ", using default accountId " + accountId);
                    }
                }

                // Process messaging events
                for (const messaging of entry.messaging || []) {
                    const senderId = messaging.sender?.id;
                    const recipientId = messaging.recipient?.id;
                    const timestamp = messaging.timestamp;
                    const message = messaging.message;
                    const referral = messaging.referral || messaging.postback?.referral || messaging.message?.referral;

                    const isEcho = message?.is_echo === true; // Message sent by page itself
                    const isFromPage = senderId === pageId || isEcho;
                    const customerId = isEcho ? recipientId : senderId; // CRITICAL: For echoes, the customer is the recipient.

                    if (!customerId) {
                        console.warn("[FB-Webhook] Missing customerId in messaging event");
                        continue;
                    }

                    // SKIP non-message events like read receipts, delivery reports, or reactions to prevent empty messages
                    if (!message && !messaging.postback && !referral) {
                        console.log(`[FB-Webhook] Skipping non-message event from ${customerId}`);
                        continue;
                    }

                    console.log("[FB-Webhook] Processing message from " + (isFromPage ? 'PAGE' : 'CUSTOMER') + " " + customerId + " on Page " + pageId);
                    console.log("[FB-Webhook] Event details: message=" + (!!message) + ", mid=" + message?.mid + ", text=" + message?.text?.substring(0, 50) + ", attachments=" + (message?.attachments?.length || 0) + ", reaction=" + (!!messaging.reaction) + ", read=" + (!!messaging.read) + ", postback=" + (!!messaging.postback) + ", isEcho=" + isEcho);

                    // 2. Identify existing lead (User + Page + External Customer ID)
                    const { data: existingLead, error: existingLeadError } = await supabase
                        .from("leads")
                        .select("id, customer_name, customer_avatar, is_potential, ai_analysis, is_manual_potential, metadata, first_contact_at, platform_account_id, source_campaign_id, is_qualified")
                        .eq("external_id", customerId)
                        .eq("fb_page_id", pageId)
                        .maybeSingle();

                    if (existingLeadError && existingLeadError.code !== 'PGRST116') { // PGRST116 is "No rows found"
                        console.error("[FB-Webhook] Error fetching existing lead:", existingLeadError);
                        await supabase.from("debug_sync_logs").insert({
                            function_name: "fb-webhook",
                            event: "E_FETCH_EXISTING_LEAD",
                            payload: { error: existingLeadError, customerId, pageId }
                        });
                        continue;
                    }

                    let dbLead = existingLead; // Use this variable to track the lead object, whether existing or newly created
                    let customerName = dbLead?.customer_name || null;
                    let customerAvatar = dbLead?.customer_avatar || null;
                    let pageName = pageAuth.name || pageId;

                    // Check if we have valid existing data
                    const hasValidName = customerName && customerName !== "Khách hàng" && customerName !== customerId;
                    const needsAIAnalysis = dbLead && dbLead.is_potential === null && (!dbLead.ai_analysis || dbLead.ai_analysis === "NULL");

                    // 4. Build lead data and create/update lead
                    let fbConvId: string | null = null;
                    const leadBaseData: any = {
                        fb_page_id: pageId,
                        platform_data: {
                            ...(dbLead?.platform_data || {}),
                            fb_page_id: pageId,
                            fb_page_name: pageName,
                            fb_profile_url: `https://www.facebook.com/${customerId}`,
                            snippet: message?.text?.substring(0, 100) ||
                                (referral ? "Khách hàng đến từ quảng cáo" :
                                    (messaging.postback ? `Nhấn nút: ${messaging.postback.title || 'menu'}` : "Tin nhắn mới"))
                        }
                    };

                    // 3. Resolve customer name and avatar (if missing or needed)
                    if (pageToken) {
                        // Fetch customer profile (only if we don't have valid info OR we need AI analysis)
                        if (!hasValidName || needsAIAnalysis || !customerAvatar) {
                            console.log("[FB-Webhook] Need to resolve name/info. hasName=" + hasValidName + ", needsAI=" + needsAIAnalysis + ", hasAvatar=" + (!!customerAvatar));

                            let resolvedName: string | null = null;
                            let resolvedAvatar: string | null = null;

                            // Just resolve name if missing
                            try {
                                console.log("[FB-Webhook] Resolving name only for " + customerId + "...");
                                const profileRes = await fetch(FB_BASE_URL + "/" + customerId + "?fields=name,first_name,last_name&access_token=" + pageToken);
                                const profileData = await profileRes.json();
                                if (!profileData.error) {
                                    resolvedName = profileData.name || [profileData.first_name, profileData.last_name].filter(Boolean).join(" ");
                                }
                            } catch (e) {
                                console.error("[FB-Webhook] Profile API network error (name only): " + (e as Error).message);
                            }

                            // METHOD 2: Fallback to conversation participants API if name still missing
                            if (!resolvedName || !dbLead?.platform_data?.fb_conv_id) {
                                try {
                                    console.log("[FB-Webhook] Trying fallback conversation participants API for " + customerId + "...");
                                    const convsRes = await fetch(FB_BASE_URL + "/" + pageId + "/conversations?user_id=" + customerId + "&fields=participants&access_token=" + pageToken);
                                    const convsData = await convsRes.json();

                                    if (!convsData.error && convsData.data?.[0]) {
                                        const conversation = convsData.data[0];
                                        console.log("[FB-Webhook] Found conversation for info: " + conversation.id);
                                        const participant = conversation.participants?.data?.find((p: any) => p.id === customerId);
                                        if (participant?.name && !resolvedName) {
                                            resolvedName = participant.name;
                                            console.log("[FB-Webhook] Resolved name from conversation: " + resolvedName);
                                        }
                                        // CRITICAL: Always store the fb_conv_id for future syncs!
                                        if (conversation.id) {
                                            console.log("[FB-Webhook] Resolved fb_conv_id: " + conversation.id);
                                            fbConvId = conversation.id;
                                            leadBaseData.platform_data.fb_conv_id = conversation.id;
                                        }
                                    }
                                } catch (convErr: any) {
                                    console.error("[FB-Webhook] Fallback API error: " + convErr.message);
                                }
                            }

                            // METHOD 3: Cross-page lookup - check if we have another lead with the same external_id that HAS a name
                            if (!resolvedName) {
                                try {
                                    console.log("[FB-Webhook] Trying cross-page lookup for external_id " + customerId + "...");
                                    const { data: otherLeads } = await supabase
                                        .from("leads")
                                        .select("customer_name, customer_avatar")
                                        .eq("external_id", customerId)
                                        .neq("customer_name", "Khách hàng")
                                        .not("customer_name", "is", null)
                                        .limit(1);

                                    if (otherLeads && otherLeads.length > 0) {
                                        resolvedName = otherLeads[0].customer_name;
                                        resolvedAvatar = otherLeads[0].customer_avatar;
                                        console.log("[FB-Webhook] Cross-page lookup success: Found name \"" + resolvedName + "\"");
                                    }
                                } catch (e: any) {
                                    console.error("[FB-Webhook] Cross-page lookup error: " + e.message);
                                }
                            }

                            // Update local variables if we resolved anything
                            if (resolvedName) customerName = resolvedName;
                            if (resolvedAvatar) customerAvatar = resolvedAvatar;

                            // PROACTIVE SYNC: If we just found a name, update ALL leads for this customer that are still named "Khách hàng"
                            if (resolvedName && resolvedName !== "Khách hàng") {
                                console.log("[FB-Webhook] Proactively updating all leads for external_id " + customerId + " with name \"" + resolvedName + "\"...");
                                const { error: proSyncError } = await supabase
                                    .from("leads")
                                    .update({
                                        customer_name: resolvedName,
                                        customer_avatar: resolvedAvatar || customerAvatar
                                    })
                                    .eq("external_id", customerId)
                                    .or("customer_name.eq.Khách hàng,customer_name.is.null");

                                if (proSyncError) console.error("[FB-Webhook] Proactive sync error:", proSyncError);
                            }

                            console.log("[FB-Webhook] Final resolution: name=\"" + customerName + "\", hasAvatar=" + (!!customerAvatar));
                        }

                        // Fetch page name/avatar and update centralized info
                        try {
                            const pageInfoRes = await fetch(FB_BASE_URL + "/" + pageId + "?fields=name&access_token=" + pageToken);
                            const pageInfoData = await pageInfoRes.json();
                            if (pageInfoData.name) {
                                pageName = pageInfoData.name;

                                // RESOLVE PAGE AVATAR VIA CRAWLER (Direct CDN link)
                                let pageAvatar = null;
                                try {
                                    pageAvatar = await resolveAvatarWithCrawler(supabase, pageId);
                                } catch (crawlErr) {
                                    console.error("[FB-Webhook] Page crawler error:", crawlErr);
                                }

                                // Update centralized page info
                                await supabase.from("platform_pages").upsert({
                                    id: pageId,
                                    name: pageName,
                                    avatar_url: pageAvatar,
                                    last_synced_at: new Date().toISOString()
                                });
                            }
                        } catch (e) {
                            console.error(`[FB-Webhook] Failed to fetch page info`);
                        }
                    }

                    // (Declaration moved to step 4)
                    // ALWAYS set last_message_at from timestamp to ensure sorting
                    leadBaseData.last_message_at = toUtcIso(timestamp);

                    // Set first_contact_at if it doesn't exist yet
                    if (!dbLead?.first_contact_at) {
                        leadBaseData.first_contact_at = toUtcIso(timestamp);
                        console.log("[FB-Webhook] Setting first_contact_at: " + leadBaseData.first_contact_at);
                    }

                    // EXTRACT AD ID SMARTER
                    // Log referral data for debugging
                    if (referral) {
                        console.log("[FB-Webhook] REFERRAL DATA FOUND:", JSON.stringify(referral));
                    }

                    const adIdFromReferral = referral?.ad_id || referral?.campaign_id || referral?.ad_id_key || referral?.ads_context_data?.ad_id || referral?.author_id;
                    const adIdFromPostback = messaging.postback?.referral?.ad_id || messaging.postback?.referral?.campaign_id;
                    const adIdFromMessage = message?.referral?.ad_id || message?.ad_id;

                    // Also check payload for common patterns like ad_id:123 or campaign_id:123
                    let adIdFromPayload = null;
                    if (messaging.postback?.payload && typeof messaging.postback.payload === 'string') {
                        const adMatch = messaging.postback.payload.match(/(?:ad_id|fb_ad_id)[:=]([0-9]+)/i);
                        if (adMatch) adIdFromPayload = adMatch[1];

                        if (!adIdFromPayload) {
                            const campMatch = messaging.postback.payload.match(/(?:campaign_id)[:=]([0-9]+)/i);
                            if (campMatch) adIdFromPayload = campMatch[1];
                        }
                    }

                    const adId = adIdFromReferral || adIdFromPostback || adIdFromMessage || adIdFromPayload;

                    console.log("[FB-Webhook] AD ID EXTRACTION: adIdFromReferral=" + adIdFromReferral + ", adIdFromPostback=" + adIdFromPostback + ", adIdFromMessage=" + adIdFromMessage + ", adIdFromPayload=" + adIdFromPayload + " => FINAL=" + adId);

                    if (adId && !dbLead?.source_campaign_id) { // Only set if not already attributed
                        leadBaseData.source_campaign_id = adId;
                        leadBaseData.is_qualified = true;

                        // Set qualified_at in metadata for accurate daily filtering
                        // Set qualified_at in metadata for accurate daily filtering
                        const nowUtcStr = toUtcIso(new Date());
                        leadBaseData.metadata = {
                            ...(dbLead?.metadata || {}),
                            qualified_at: dbLead?.metadata?.qualified_at || nowUtcStr
                        };
                    }

                    // If we have an ad_id, try to find the correct platform_account_id for it
                    if (adId && !dbLead?.platform_account_id) { // Only set if not already attributed
                        try {
                            const { data: adData } = await supabase
                                .from("unified_ads")
                                .select("platform_account_id")
                                .eq("external_id", adId)
                                .limit(1)
                                .maybeSingle();

                            if (adData?.platform_account_id) {
                                // If the ad is found in a specific account, update BOTH accountId and leadBaseData
                                accountId = adData.platform_account_id;
                                leadBaseData.platform_account_id = adData.platform_account_id;
                                console.log(`[FB-Webhook] Resolved platform_account_id=${adData.platform_account_id} for adId=${adId}`);

                                // PROACTIVE SYNC: Update all existing leads for this customer that are missing attribution
                                console.log("[FB-Webhook] Proactively updating attribution for customerId " + customerId + "...");
                                const nowUtcStr = toUtcIso(new Date());
                                await supabase
                                    .from("leads")
                                    .update({
                                        source_campaign_id: adId,
                                        platform_account_id: adData.platform_account_id,
                                        is_qualified: true,
                                        metadata: {
                                            ...((dbLead?.metadata as any) || {}),
                                            qualified_at: (dbLead?.metadata as any)?.qualified_at || nowUtcStr,
                                            attribution_source: "webhook_proactive_sync"
                                        }
                                    })
                                    .eq("external_id", customerId)
                                    .is("source_campaign_id", null);
                            } else {
                                console.log(`[FB-Webhook] Ad ID ${adId} not found in our system yet, will use default/mapped account ${accountId}`);
                                leadBaseData.platform_account_id = accountId;
                            }
                        } catch (e) {
                            console.error("[FB-Webhook] Failed to lookup ad account info:", e);
                            leadBaseData.platform_account_id = accountId;
                        }
                    } else if (!dbLead?.platform_account_id) {
                        // Ensure accountId is set even if no adId
                        leadBaseData.platform_account_id = accountId;
                    }

                    // Always try to set name/avatar if available
                    if (customerName) leadBaseData.customer_name = customerName;
                    if (customerAvatar) leadBaseData.customer_avatar = customerAvatar;

                    // Enhance metadata with referral info
                    if (referral) {
                        const nowUtcStr = toUtcIso(new Date());
                        leadBaseData.metadata = {
                            ...(leadBaseData.metadata || dbLead?.metadata || {}),
                            qualified_at: (leadBaseData.metadata?.qualified_at || dbLead?.metadata?.qualified_at) || nowUtcStr,
                            referral: {
                                source: referral.source || "ADS",
                                ad_id: referral.ad_id,
                                ref: referral.ref,
                                adgroup_id: referral.adgroup_id,
                                campaign_id: referral.campaign_id
                            }
                        };
                    }

                    if (dbLead) {
                        const result = await supabase
                            .from("leads")
                            .update(leadBaseData)
                            .eq("id", dbLead.id)
                            .select()
                            .single();
                        dbLead = result.data;
                        const leadError = result.error;
                        if (leadError) {
                            console.error("[FB-Webhook] Lead update error:", leadError);
                            continue;
                        }
                        console.log("[FB-Webhook] Updated existing lead: " + dbLead?.id);
                    } else {
                        // New lead - set defaults for required fields
                        const insertData = {
                            id: crypto.randomUUID(),
                            platform_account_id: accountId,
                            external_id: customerId,
                            fb_page_id: pageId,
                            source_campaign_id: referral?.ad_id || null,
                            is_qualified: !!referral?.ad_id,
                            customer_name: customerName || "Khách hàng",
                            customer_avatar: customerAvatar,
                            ...leadBaseData
                        };

                        const result = await supabase
                            .from("leads")
                            .insert(insertData)
                            .select()
                            .single();
                        dbLead = result.data;
                        const leadError = result.error;
                        if (leadError) {
                            console.error("[FB-Webhook] Lead creation error:", leadError);
                            await supabase.from("debug_sync_logs").insert({
                                function_name: "fb-webhook",
                                event: "E_LEAD_CREATION",
                                payload: { error: leadError, insertData }
                            });
                            continue;
                        }
                        console.log("[FB-Webhook] Created new lead: " + dbLead?.id);
                        await supabase.from("debug_sync_logs").insert({
                            function_name: "fb-webhook",
                            event: "LEAD_CREATED",
                            payload: { leadId: dbLead?.id, customerId, pageId }
                        });
                    }

                    if (!dbLead) {
                        console.error(`[fb-webhook] CRITICAL: Failed to create or find lead for customer ${customerId}`);
                        continue; // Skip to next messaging event if lead is not available
                    }
                    leadsUpdated++;

                    // FINAL LEAD OBJECT FOR NEXT STEPS
                    const finalCustomerName = dbLead?.customer_name || customerName || "Khách hàng";

                    // 5. Prepare message content
                    let messageContent = "";
                    let fbMid = message?.mid || null;
                    const attachments = message?.attachments || null;
                    const sticker = message?.sticker || null;
                    const shares = message?.shares || null;

                    if (message) {
                        // Extract text, preferring quick_reply text if available
                        messageContent = message.quick_reply?.payload || message.text || "";

                        // Handle attachments (images, stickers, files, etc.)
                        if (attachments && attachments.length > 0) {
                            const attachmentDescriptions = attachments.map((att: any) => {
                                if (att.type === "image") return "[Hình ảnh]";
                                if (att.type === "sticker") return "[Sticker]";
                                if (att.type === "video") return "[Video]";
                                if (att.type === "audio") return "[Audio]";
                                if (att.type === "file") return "[File]";
                                if (att.type === "location") return "[Vị trí]";
                                return "[" + att.type + "]";
                            });
                            if (!messageContent) {
                                messageContent = attachmentDescriptions.join(" ");
                            } else {
                                messageContent += " " + attachmentDescriptions.join(" ");
                            }
                        }
                    } else if (adId) {
                        messageContent = "[Bắt đầu từ quảng cáo: " + adId + "]";
                        fbMid = "ref_" + timestamp + "_" + customerId; // Synthetic ID for referrals
                    } else if (messaging.postback) {
                        messageContent = "[Nhấn nút: " + (messaging.postback.title || messaging.postback.payload) + "]";
                        fbMid = "pb_" + timestamp + "_" + customerId; // Synthetic ID for postbacks
                    }

                    // 6. UPDATE LAST MESSAGE SNIPPET
                    // Instead of storing full messages, we just update the snippet for the list view
                    if (dbLead) {
                        const snippet = messageContent || (attachments ? "[Hình ảnh/File]" : (sticker ? "[Sticker]" : ""));
                        if (snippet) {
                            const { error: snippetErr } = await supabase
                                .from("leads")
                                .update({
                                    last_message_at: toUtcIso(timestamp),
                                    is_read: isEcho, // If echoed from page, it's read by us. If from customer, it's unread.
                                    platform_data: {
                                        ...(dbLead.platform_data || {}),
                                        snippet: snippet.substring(0, 100),
                                        last_analysis_message_count: dbLead.platform_data?.last_analysis_message_count || 0
                                    }
                                })
                                .eq("id", dbLead.id);
                            
                            if (snippetErr) {
                                console.error(`[fb-webhook] Failed to update lead snippet: ${snippetErr.message}`);
                            } else {
                                console.log(`[FB-Webhook] Updated lead ${dbLead.id} snippet: "${snippet.substring(0, 30)}..."`);
                            }
                        }
                    }

                    // 7. HISTORIC CONVERSATION CRAWL (Only for USER messages or if force requested)
                    // This ensures the lead has the full history, not just the current message.
                    // Trigger for:
                    // - ANY message from customer (text, quick_reply)
                    // - ANY postback from customer
                    const hasCustomerInteraction = !isFromPage && (message || messaging.postback);
                    if (dbLead && hasCustomerInteraction) {
                        try {
                            console.log(`[FB-Webhook] Calling chatbot for lead ${dbLead.id}...`);
                            const chatbotRes = await fetch(`${supabaseUrl}/functions/v1/fb-chatbot`, {
                                method: "POST",
                                headers: { "Content-Type": "application/json", Authorization: `Bearer ${supabaseKey}` },
                                body: JSON.stringify({
                                    pageId, customerId, leadId: dbLead.id,
                                    messageText: message?.text,
                                    postbackPayload: messaging.postback?.payload,
                                    quickReplyPayload: message?.quick_reply?.payload,
                                    isNewLead: !existingLead
                                })
                            });
                            
                            const chatStatus = chatbotRes.status;
                            const chatBody = await chatbotRes.text();
                            
                            await supabase.from("debug_sync_logs").insert({
                                function_name: "fb-webhook",
                                event: chatStatus === 200 ? "CHATBOT_TRIGGERED" : "E_CHATBOT_TRIGGER",
                                payload: { leadId: dbLead.id, status: chatStatus, response: chatBody.substring(0, 200) }
                            });

                            if (!chatbotRes.ok) {
                                console.error(`[FB-Webhook] Chatbot failed with status ${chatStatus}: ${chatBody}`);
                            }
                        } catch (chatbotErr: any) {
                            console.error("[FB-Webhook] Chatbot error:", chatbotErr.message);
                            await supabase.from("debug_sync_logs").insert({
                                function_name: "fb-webhook",
                                event: "E_CHATBOT_TRIGGER",
                                payload: { leadId: dbLead.id, error: chatbotErr.message }
                            });
                        }
                    }

                    // AI ANALYSIS moved to crawl section for full context

                    // 3. CRAWL ENTIRE CONVERSATION - Only for new leads OR if not crawled today
                    // Check if already crawled today (daily limit: 1 crawl per lead per day)
                    const todayVN = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10); // YYYY-MM-DD in VN timezone
                    const lastCrawledAt = dbLead?.metadata?.last_crawled_at;
                    const lastCrawledDate = lastCrawledAt ? lastCrawledAt.slice(0, 10) : null;
                    const alreadyCrawledToday = lastCrawledDate === todayVN;

                    // Relax crawl condition: crawl if new, not crawled today, OR if AI analysis is missing
                    const shouldCrawl = !existingLead || (!alreadyCrawledToday && dbLead) || (dbLead && !dbLead.ai_analysis);

                    if (shouldCrawl && dbLead && pageToken) {
                        console.log("[FB-Webhook] Crawl check: isNew=" + (!existingLead) + ", lastCrawled=" + lastCrawledDate + ", today=" + todayVN + ", shouldCrawl=" + shouldCrawl);
                        try {
                            console.log("[FB-Webhook] Triggering full conversation crawl for customer " + customerId + "...");
                            // Fetch conversations to find the ID, participants, and labels
                            const convsRes = await fetch(FB_BASE_URL + "/" + pageId + "/conversations?user_id=" + customerId + "&fields=id,updated_time,snippet,participants,labels&access_token=" + pageToken);
                            const convsData = await convsRes.json();

                            const conv = convsData.data?.[0];
                            if (conv) {
                                console.log("[FB-Webhook] Found conversation ID: " + conv.id + ". Fetching historical messages...");

                                // TRY TO GET NAME FROM PARTICIPANTS (backup if we still don't have name)
                                let extractedCustomerName: string | null = null;
                                if (conv.participants?.data) {
                                    const participant = conv.participants.data.find((p: any) => p.id === customerId);
                                    if (participant?.name) {
                                        extractedCustomerName = participant.name;
                                        console.log("[FB-Webhook] Extracted name from conversation participants: \"" + extractedCustomerName + "\"");
                                    }
                                }

                                // TRY TO GET LABELS FOR MANUAL POTENTIAL
                                let isManualPotential = false;
                                if (conv.labels?.data) {
                                    isManualPotential = conv.labels.data.some((l: any) =>
                                        l.name.toLowerCase().includes("tiềm năng") ||
                                        l.name.toLowerCase().includes("potential") ||
                                        l.name.toLowerCase().includes("hot")
                                    );
                                    if (isManualPotential) {
                                        console.log("[FB-Webhook] Manual potential detected via FB label: " + conv.labels.data.map((l: any) => l.name).join(", "));
                                    }
                                }
                                const msgsRes = await fetch(FB_BASE_URL + "/" + conv.id + "/messages?fields=id,message,from,created_time,attachments,shares,sticker&limit=100&access_token=" + pageToken);
                                const msgsData = await msgsRes.json();

                                if (msgsData.data && msgsData.data.length > 0) {
                                    // Try to extract customer name from message senders
                                    // AND detect "đã trả lời một quảng cáo" pattern
                                    let detectedAdReply = false;
                                    let extractedAdTitle = "";
                                    let extractedAdSubtitle = "";
                                    let extractedAdMediaUrl = "";
                                    for (const m of msgsData.data) {
                                        const msgSenderId = String(m.from?.id || "");
                                        if (msgSenderId === customerId && m.from?.name) {
                                            if (!extractedCustomerName) {
                                                extractedCustomerName = m.from.name;
                                                console.log("[FB-Webhook] Extracted name from message from.name: \"" + extractedCustomerName + "\"");
                                            }
                                        }

                                        // DETECT AD REPLY PATTERN: Look for system messages indicating ad interaction
                                        const msgContent = m.message || "";
                                        if (msgContent.includes("đã trả lời một quảng cáo") ||
                                            msgContent.includes("replied to your ad") ||
                                            msgContent.includes("đến từ quảng cáo")) {
                                            detectedAdReply = true;
                                            console.log("[FB-Webhook] DETECTED AD REPLY PATTERN in message: \"" + msgContent.substring(0, 60) + "...\"");
                                        }

                                        // Also check for ads image URL in attachments and extract ad info
                                        if (m.attachments?.data) {
                                            for (const att of m.attachments.data) {
                                                const mediaUrl = att.image_data?.url || att.generic_template?.media_url || "";
                                                if (mediaUrl.includes("facebook.com/ads/image")) {
                                                    detectedAdReply = true;
                                                    console.log("[FB-Webhook] DETECTED AD IMAGE in attachment: " + mediaUrl.substring(0, 80) + "...");

                                                    // Extract ad title/subtitle for matching
                                                    if (!extractedAdTitle && att.generic_template?.title) {
                                                        extractedAdTitle = att.generic_template.title.trim();
                                                        extractedAdSubtitle = att.generic_template.subtitle?.trim() || "";
                                                        extractedAdMediaUrl = mediaUrl;
                                                        console.log("[FB-Webhook] Extracted ad title: \"" + extractedAdTitle.substring(0, 50) + "...\"");
                                                    }
                                                }
                                            }
                                        }
                                    }

                                    // UPDATE LEAD if we got a name or labels OR detected ad reply
                                    const updateData: any = {};
                                    if (extractedCustomerName && dbLead.customer_name === "Khách hàng") {
                                        updateData.customer_name = extractedCustomerName;
                                    }
                                    if (isManualPotential) {
                                        updateData.is_manual_potential = true;
                                    }

                                    // If we detected ad reply, try to find exact ad and mark lead as qualified
                                    if (detectedAdReply && !dbLead.is_qualified) {
                                        let matchedAd = null;

                                        // Try to find matching ad by title in unified_ads
                                        if (extractedAdTitle) {
                                            // Clean title for matching (remove emojis, special chars)
                                            const cleanTitle = extractedAdTitle.replace(/[^\w\sÀ-ỹ]/g, '').trim();
                                            const searchTerms = cleanTitle.split(' ').filter((w: string) => w.length > 3).slice(0, 5);

                                            if (searchTerms.length > 0) {
                                                // Build ILIKE pattern from first few significant words
                                                const searchPattern = '%' + searchTerms.join('%') + '%';

                                                const { data: matchingAds } = await supabase
                                                    .from("unified_ads")
                                                    .select("external_id, name, platform_account_id")
                                                    .ilike("name", searchPattern)
                                                    .limit(1);

                                                if (matchingAds && matchingAds.length > 0) {
                                                    matchedAd = matchingAds[0];
                                                    console.log("[FB-Webhook] MATCHED AD: " + matchedAd.external_id + " (" + matchedAd.name.substring(0, 40) + "...)");
                                                }
                                            }
                                        }

                                        // Update lead with ad info
                                        updateData.is_qualified = true;

                                        const nowVNStr = toUtcIso(new Date());
                                        updateData.metadata = {
                                            ...(dbLead.metadata || {}),
                                            qualified_at: dbLead.metadata?.qualified_at || nowVNStr,
                                            ad_detection_source: matchedAd ? "matched_ad" : "message_pattern",
                                            ad_title: extractedAdTitle || null,
                                            ad_subtitle: extractedAdSubtitle || null
                                        };

                                        if (matchedAd) {
                                            updateData.source_campaign_id = matchedAd.external_id;
                                            updateData.platform_account_id = matchedAd.platform_account_id;
                                            console.log("[FB-Webhook] Setting source_campaign_id=" + matchedAd.external_id + ", platform_account_id=" + matchedAd.platform_account_id);
                                        }

                                        console.log("[FB-Webhook] Marking lead " + dbLead.id + " as QUALIFIED (detected from crawled messages)");
                                    }

                                    if (Object.keys(updateData).length > 0) {
                                        const { error: updateErr } = await supabase
                                            .from("leads")
                                            .update(updateData)
                                            .eq("id", dbLead.id);
                                        if (!updateErr) {
                                            console.log("[FB-Webhook] Updated lead " + dbLead.id + " with:", updateData);
                                            if (updateData.customer_name) dbLead.customer_name = updateData.customer_name;
                                            if (updateData.is_manual_potential) dbLead.is_manual_potential = true;
                                        } else {
                                            console.error("[FB-Webhook] Failed to update lead with extracted data:", updateErr);
                                        }
                                    }

                                    // Use the best available name for messages
                                    const bestCustomerName = dbLead.customer_name !== "Khách hàng" ? dbLead.customer_name : (extractedCustomerName || finalCustomerName);

                                    // Identify the latest and oldest message for lead metadata update
                                    const sortedMsgs = [...msgsData.data].sort((a: any, b: any) =>
                                        new Date(b.created_time).getTime() - new Date(a.created_time).getTime()
                                    );
                                    const latestMsg = sortedMsgs[0];
                                    const oldestMsg = sortedMsgs[sortedMsgs.length - 1];

                                    const dbMessages = msgsData.data.map((m: any) => {
                                        const msgSenderId = String(m.from?.id || "");
                                        const isMsgFromPage = msgSenderId === pageId;
                                        // Use from.name if available, otherwise use our best resolved name
                                        let senderName = m.from?.name;
                                        if (!senderName) {
                                            senderName = isMsgFromPage ? pageName : bestCustomerName;
                                        }
                                        return {
                                            id: crypto.randomUUID(),
                                            lead_id: dbLead.id,
                                            fb_message_id: m.id,
                                            sender_id: msgSenderId,
                                            sender_name: senderName,
                                            message_content: m.message || "",
                                            attachments: m.attachments?.data || null,
                                            sticker: m.sticker || null,
                                            shares: m.shares?.data || null,
                                            sent_at: toUtcIso(m.created_time),
                                            is_from_customer: !isMsgFromPage
                                        };
                                    });

                                    // 4. Update lead metadata without storing full messages
                                    const existingMetadata = dbLead?.metadata || {};
                                    const headUpdate: any = {
                                        metadata: { ...existingMetadata, last_crawled_at: new Date().toISOString() }
                                    };

                                    if (oldestMsg) {
                                        const oldestSentAt = oldestMsg.created_time || oldestMsg.sent_at;
                                        if (oldestSentAt) {
                                            const oldestVN = oldestMsg.sent_at || toUtcIso(oldestSentAt);
                                            if (!dbLead.first_contact_at || new Date(oldestVN) < new Date(dbLead.first_contact_at)) {
                                                headUpdate.first_contact_at = oldestVN;
                                            }
                                        }
                                    }

                                    if (latestMsg) {
                                        headUpdate.last_message_at = toUtcIso(latestMsg.created_time);
                                        headUpdate.is_read = String(latestMsg.from?.id) === pageId;

                                        let snippet = latestMsg.message || "";
                                        if (!snippet && latestMsg.attachments?.data) snippet = "[Hình ảnh/File]";
                                        if (!snippet && latestMsg.sticker) snippet = "[Sticker]";

                                        if (snippet) {
                                            headUpdate.platform_data = {
                                                ...(dbLead.platform_data || {}),
                                                snippet: snippet.substring(0, 100)
                                            };
                                        }
                                    }

                                    await supabase
                                        .from("leads")
                                        .update(headUpdate)
                                        .eq("id", dbLead.id);
                                    
                                    console.log(`[FB-Webhook] Updated metadata for lead ${dbLead.id} from crawl (no messages stored).`);

                                    // --- AUTO AI ANALYSIS IN CRAWL ---
                                    // Trigger AI analysis if messages >= 5 and (never analyzed OR message count changed significantly)
                                    const messageCount = dbMessages.length;
                                    const lastAnalysisMsgCount = dbLead.platform_data?.last_analysis_message_count || 0;
                                    const messagesSinceLastAnalysis = messageCount - lastAnalysisMsgCount;
                                    const hasEnoughMessages = messageCount >= 1; // Lowered from 5 for visibility
                                    const hasManualPotential = dbLead.is_manual_potential === true;
                                    
                                    // Only re-analyze if we have at least 1 new messages since last analysis to save cost
                                    const shouldAnalyze = geminiApiKey && !hasManualPotential && hasEnoughMessages && (!dbLead.ai_analysis || messagesSinceLastAnalysis >= 1);

                                    if (shouldAnalyze) {
                                        console.log(`[FB-Webhook] Delegating analysis for lead ${dbLead.id} to fb-ai-analysis...`);
                                        
                                        const analysisMessages = [...dbMessages]
                                            .sort((a, b) => new Date(a.sent_at).getTime() - new Date(b.sent_at).getTime())
                                            .map(m => ({
                                                sender: m.sender_name,
                                                content: m.message_content,
                                                isFromCustomer: m.is_from_customer,
                                                timestamp: m.sent_at
                                            }));

                                        // Fire and forget - don't wait for AI to finish to avoid webhook timeout
                                        fetch(`${supabaseUrl}/functions/v1/fb-ai-analysis`, {
                                            method: "POST",
                                            headers: { 
                                                "Content-Type": "application/json", 
                                                "Authorization": "Bearer " + supabaseKey 
                                            },
                                            body: JSON.stringify({
                                                leadId: dbLead.id,
                                                messages: analysisMessages,
                                                geminiApiKey: geminiApiKey
                                            })
                                        }).catch(err => console.error("[FB-Webhook] Trigger AI analysis failed:", err));
                                    }
                                }
                            } else {
                                console.warn("[FB-Webhook] Could not find conversation ID for customer " + customerId);
                            }
                        } catch (crawlErr) {
                            console.error("[FB-Webhook] Fatal error during crawl:", crawlErr);
                        }
                    }
                }
            }

            console.log("[FB-Webhook] Done: " + leadsUpdated + " leads, " + messagesInserted + " messages, " + pagesSkipped + " pages skipped");
            return jsonResponse({ status: "ok", leadsUpdated, messagesInserted, pagesSkipped });

        } catch (err: any) {
            console.error("[FB-Webhook] Error:", err);
            return jsonResponse({ status: "error", error: err.message });
        }
    }

    return jsonResponse({ error: "Method not allowed" }, 405);
});
