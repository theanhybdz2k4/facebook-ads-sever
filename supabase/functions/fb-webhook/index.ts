
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";
import { resolveAvatarWithCrawler } from "../_shared/fb_crawler.ts";


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

// Gemini AI helper function to analyze conversation
// Returns { analysis: string, isPotential: boolean } or null
async function analyzeWithGemini(apiKey: string, messages: Array<{ sender: string, content: string, isFromCustomer: boolean, timestamp: string }>): Promise<{ analysis: string, isPotential: boolean } | null> {
    if (!apiKey || messages.length === 0) return null;

    try {
        // Format conversation for analysis with timestamps
        const conversationText = messages.map(m => {
            const time = new Date(m.timestamp).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
            return `[${time}] ${m.isFromCustomer ? '👤 Khách hàng' : '📄 Page'}: ${m.content}`;
        }).join('\n');

        const prompt = "Bạn là chuyên gia phân tích hội thoại bán hàng cho ColorME (trung tâm đào tạo thiết kế). Hãy phân tích cuộc hội thoại (kèm mốc thời gian) và CHẤM ĐIỂM mức độ tiềm năng trên thang 10.\n\n" +
            "TIÊU CHÍ CHẤM ĐIỂM (Thang 10):\n" +
            "1. Nhu cầu (2đ): Khách hỏi sâu về lộ trình, bài tập, sản phẩm đầu ra, hoặc muốn giải quyết vấn đề cụ thể.\n" +
            "2. Thời gian (2đ): Khách hỏi lịch khai giảng, ca học, hoặc muốn bắt đầu học sớm.\n" +
            "3. Tài chính (2đ): Khách hỏi học phí/ưu đãi VÀ có phản hồi tích cực (không im lặng sau khi biết giá).\n" +
            "4. Liên lạc (2đ): Khách đã để lại SĐT hoặc sẵn sàng cung cấp khi được yêu cầu.\n" +
            "5. Tương tác & Phản hồi (2đ): Khách chủ động trao đổi, phản hồi nhanh. TRỪ ĐIỂM nếu: Khách rep quá chậm (>24h-48h mỗi tin), hoặc đã ngưng tương tác lâu dù Page có nhắn tin (hội thoại bị 'nguội').\n\n" +
            "QUY TẮC PHÂN LOẠI:\n" +
            "- TIỀM NĂNG: Tổng điểm >= 8/10.\n" +
            "- KHÔNG TIỀM NĂNG: Tổng điểm < 8/10 hoặc chỉ hỏi giá rồi im lặng, hoặc tương tác quá rời rạc/không còn phản hồi.\n\n" +
            "CẤU TRÚC PHẢN HỒI (BẮT BUỘC):\n" +
            "Đánh giá: [TIỀM NĂNG hoặc KHÔNG TIỀM NĂNG]\n" +
            "Tổng điểm: [Số điểm]/10\n" +
            "Chi tiết điểm: [Nhu cầu: xđ, Thời gian: xđ, Tài chính: xđ, Liên lạc: xđ, Tương tác: xđ]\n" +
            "Tóm tắt: [Diễn biến chính: Khách hỏi -> Sale đáp -> Khách phản hồi. Lưu ý về nhịp độ phản hồi của khách]\n" +
            "Giai đoạn: [Nhận thức/Quan tâm/Cân nhắc/Quyết định]\n" +
            "Gợi ý: [Hành động tiếp theo cho Sale]\n\n" +
            "---\n" +
            conversationText + "\n" +
            "---\n\n" +
            "Dòng đầu tiên PHẢI là \"Đánh giá: TIỀM NĂNG\" hoặc \"Đánh giá: KHÔNG TIỀM NĂNG\"";

        console.log("[FB-Webhook] Calling Gemini API to analyze " + messages.length + " messages...");

        const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" + apiKey, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }]
            })
        });

        const data = await response.json();

        if (data.error) {
            console.error("[FB-Webhook] Gemini API error: " + data.error.message);
            return null;
        }

        const analysis = data.candidates?.[0]?.content?.parts?.[0]?.text || null;
        if (analysis) {
            console.log("[FB-Webhook] Gemini analysis received: " + analysis.substring(0, 100) + "...");

            // Parse isPotential from analysis and strip the evaluation line
            const lines = analysis.split('\n');
            const firstLine = lines[0].toLowerCase();
            const isPotential = firstLine.includes('tiềm năng') && !firstLine.includes('không tiềm năng');

            // Remove the evaluation line (the first line typically starts with "Đánh giá:")
            const cleanedAnalysis = lines.slice(1).join('\n').trim();
            console.log("[FB-Webhook] Lead classification: isPotential = " + isPotential);

            return { analysis: cleanedAnalysis, isPotential };
        }
        return null;
    } catch (e: any) {
        console.error("[FB-Webhook] Gemini API call failed: " + e.message);
        return null;
    }
}

// Cache for authorized pages - maps pageId to { name, token }


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
                return jsonResponse({ status: "ignored", reason: "not a page event" });
            }

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

            // Get Gemini API key from users table
            const { data: userData } = await supabase
                .from("users")
                .select("gemini_api_key")
                .not("gemini_api_key", "is", null)
                .limit(1)
                .maybeSingle();

            const geminiApiKey = userData?.gemini_api_key || null;
            if (geminiApiKey) {
                console.log("[FB-Webhook] Gemini API key found, AI analysis enabled");
            } else {
                console.log("[FB-Webhook] No Gemini API key configured, AI analysis disabled");
            }

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

                const pageToken = pageAuth.token;

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

                    const isFromPage = senderId === pageId || message?.is_echo === true;
                    const customerId = isFromPage ? recipientId : senderId;
                    if (!customerId) {
                        console.warn("[FB-Webhook] Missing customerId in messaging event");
                        continue;
                    }

                    console.log("[FB-Webhook] Processing message from " + (isFromPage ? 'PAGE' : 'CUSTOMER') + " " + customerId + " on Page " + pageId);
                    console.log("[FB-Webhook] Event details: message=" + (!!message) + ", mid=" + message?.mid + ", text=" + message?.text?.substring(0, 50) + ", attachments=" + (message?.attachments?.length || 0) + ", reaction=" + (!!messaging.reaction) + ", read=" + (!!messaging.read) + ", postback=" + (!!messaging.postback));

                    // Check if lead already exists for this specific (customer, page) combination
                    // STRICT LOOKUP: ONLY external_id + fb_page_id
                    const { data: existingLead } = await supabase
                        .from("leads")
                        .select("id, customer_name, customer_avatar, is_potential, ai_analysis, is_manual_potential, metadata")
                        .eq("external_id", customerId)
                        .eq("fb_page_id", pageId)
                        .limit(1)
                        .maybeSingle();

                    let customerName = existingLead?.customer_name || null;
                    let customerAvatar = existingLead?.customer_avatar || null;
                    let pageName = pageAuth.name || pageId;

                    // Check if we have valid existing data
                    const hasValidName = customerName && customerName !== "Khách hàng" && customerName !== customerId;
                    const needsAIAnalysis = existingLead && existingLead.is_potential === null && (!existingLead.ai_analysis || existingLead.ai_analysis === "NULL");

                    if (pageToken) {
                        // Fetch customer profile (only if we don't have valid info OR we need AI analysis)
                        if (!hasValidName || needsAIAnalysis || !customerAvatar) {
                            console.log("[FB-Webhook] Need to resolve name/info. hasName=" + hasValidName + ", needsAI=" + needsAIAnalysis + ", hasAvatar=" + (!!customerAvatar));

                            let resolvedName: string | null = null;
                            let resolvedAvatar: string | null = null;

                            // METHOD 1: Try direct profile API
                            try {
                                console.log("[FB-Webhook] Trying direct profile API for " + customerId + "...");
                                const profileRes = await fetch(FB_BASE_URL + "/" + customerId + "?fields=name,first_name,last_name,profile_pic,picture&access_token=" + pageToken);
                                const profileData = await profileRes.json();

                                if (profileData.error) {
                                    console.error("[FB-Webhook] Profile API error: " + profileData.error.message);
                                } else {
                                    resolvedName = profileData.name;
                                    if (!resolvedName && (profileData.first_name || profileData.last_name)) {
                                        resolvedName = [profileData.first_name, profileData.last_name].filter(Boolean).join(" ");
                                    }
                                    resolvedAvatar = profileData.profile_pic || profileData.picture?.data?.url;
                                }

                                // Fallback for avatar if still missing
                                if (!resolvedAvatar) {
                                    try {
                                        console.log("[FB-Webhook] Trying /picture fallback for " + customerId + "...");
                                        const picRes = await fetch(FB_BASE_URL + "/" + customerId + "/picture?type=large&redirect=false&access_token=" + pageToken);
                                        const picData = await picRes.json();
                                        if (picData.data?.url) {
                                            resolvedAvatar = picData.data.url;
                                            console.log("[FB-Webhook] Avatar resolved from fallback /picture endpoint");
                                        }
                                    } catch (picErr: any) {
                                        console.error("[FB-Webhook] Picture fallback error: " + picErr.message);
                                    }
                                }
                            } catch (e: any) {
                                console.error("[FB-Webhook] Profile API network error: " + e.message);
                            }

                            // METHOD 1.5: Crawler Fallback (Pancake Strategy)
                            if (!resolvedAvatar) {
                                try {
                                    resolvedAvatar = await resolveAvatarWithCrawler(supabase, customerId);
                                    if (resolvedAvatar) {
                                        console.log("[FB-Webhook] Avatar resolved via Crawler! " + resolvedAvatar);
                                    }
                                } catch (crawlErr: any) {
                                    console.error("[FB-Webhook] Crawler fallback error: " + crawlErr.message);
                                }
                            }


                            // METHOD 2: Fallback to conversation participants API if name still missing
                            if (!resolvedName) {
                                try {
                                    console.log("[FB-Webhook] Trying fallback conversation participants API for " + customerId + "...");
                                    const convsRes = await fetch(FB_BASE_URL + "/" + pageId + "/conversations?user_id=" + customerId + "&fields=participants&access_token=" + pageToken);
                                    const convsData = await convsRes.json();

                                    if (!convsData.error && convsData.data?.[0]) {
                                        const participant = convsData.data[0].participants?.data?.find((p: any) => p.id === customerId);
                                        if (participant?.name) {
                                            resolvedName = participant.name;
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

                    let dbLead, leadError;

                    // Build lead data
                    const leadBaseData: any = {
                        fb_page_id: pageId,
                        platform_data: {
                            fb_page_id: pageId,
                            fb_page_name: pageName,
                            snippet: message?.text?.substring(0, 100) ||
                                (referral ? "Khách hàng đến từ quảng cáo" :
                                    (messaging.postback ? `Nhấn nút: ${messaging.postback.title || 'menu'}` : "Tin nhắn mới"))
                        }
                    };

                    // ALWAYS set last_message_at from timestamp to ensure sorting
                    leadBaseData.last_message_at = toVietnamTimestamp(timestamp);
                    
                    // Set first_contact_at only for NEW leads (not existing ones)
                    if (!existingLead) {
                        leadBaseData.first_contact_at = toVietnamTimestamp(timestamp);
                        console.log("[FB-Webhook] NEW LEAD - Setting first_contact_at: " + leadBaseData.first_contact_at);
                    }

                    // EXTRACT AD ID SMARTERY
                    // Log referral data for debugging
                    if (referral) {
                        console.log("[FB-Webhook] REFERRAL DATA FOUND:", JSON.stringify(referral));
                    }
                    
                    const adIdFromReferral = referral?.ad_id || referral?.campaign_id || referral?.ad_id_key || referral?.ads_context_data?.ad_id;
                    const adIdFromPostback = messaging.postback?.referral?.ad_id || messaging.postback?.referral?.campaign_id;
                    const adIdFromMessage = message?.referral?.ad_id || message?.ad_id;
                    
                    // Also check payload for common patterns like ad_id:123
                    let adIdFromPayload = null;
                    if (messaging.postback?.payload && typeof messaging.postback.payload === 'string') {
                        const match = messaging.postback.payload.match(/ad_id[:=]([0-9]+)/);
                        if (match) adIdFromPayload = match[1];
                    }

                    const adId = adIdFromReferral || adIdFromPostback || adIdFromMessage || adIdFromPayload;
                    
                    console.log("[FB-Webhook] AD ID EXTRACTION: adIdFromReferral=" + adIdFromReferral + ", adIdFromPostback=" + adIdFromPostback + ", adIdFromMessage=" + adIdFromMessage + ", adIdFromPayload=" + adIdFromPayload + " => FINAL=" + adId);

                    if (adId) {
                        leadBaseData.source_campaign_id = adId;
                        leadBaseData.is_qualified = true;
                        
                        // Set qualified_at in metadata for accurate daily filtering
                        const nowVNStr = toVietnamTimestamp(new Date());
                        leadBaseData.metadata = {
                            ...(existingLead?.metadata || {}),
                            qualified_at: existingLead?.metadata?.qualified_at || nowVNStr
                        };
                    }

                    // If we have an ad_id, try to find the correct platform_account_id for it
                    if (adId) {
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
                                console.log(`[FB-Webhook] Detected ad click: synced platform_account_id ${adData.platform_account_id} from ad_id ${adId}`);
                            } else {
                                console.log(`[FB-Webhook] Ad ID ${adId} not found in our system yet, will use default/mapped account ${accountId}`);
                                leadBaseData.platform_account_id = accountId;
                            }
                        } catch (e) {
                            console.error("[FB-Webhook] Failed to lookup ad account info:", e);
                            leadBaseData.platform_account_id = accountId;
                        }
                    } else {
                        // Ensure accountId is set even if no adId
                        leadBaseData.platform_account_id = accountId;
                    }

                    // Always try to set name/avatar if available
                    if (customerName) leadBaseData.customer_name = customerName;
                    if (customerAvatar) leadBaseData.customer_avatar = customerAvatar;

                    // Enhance metadata with referral info
                    if (referral) {
                        const nowVNStr = toVietnamTimestamp(new Date());
                        leadBaseData.metadata = {
                            ...(leadBaseData.metadata || existingLead?.metadata || {}),
                            qualified_at: (leadBaseData.metadata?.qualified_at || existingLead?.metadata?.qualified_at) || nowVNStr,
                            referral: {
                                source: referral.source || "ADS",
                                ad_id: referral.ad_id,
                                ref: referral.ref,
                                adgroup_id: referral.adgroup_id,
                                campaign_id: referral.campaign_id
                            }
                        };
                    }

                    if (existingLead) {
                        const result = await supabase
                            .from("leads")
                            .update(leadBaseData)
                            .eq("id", existingLead.id)
                            .select()
                            .single();
                        dbLead = result.data;
                        leadError = result.error;
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
                        leadError = result.error;
                        console.log("[FB-Webhook] Created new lead: " + dbLead?.id);
                    }

                    if (leadError) {
                        console.error("[FB-Webhook] Lead error:", leadError);
                        continue;
                    }
                    leadsUpdated++;

                    // FINAL LEAD OBJECT FOR NEXT STEPS
                    const finalCustomerName = dbLead?.customer_name || customerName || "Khách hàng";

                    // 1. Insert current message OR virtual message from referral/postback
                    if (dbLead) {
                        let messageContent = "";
                        let fbMid = message?.mid || null;

                        if (message) {
                            messageContent = message.text || "";
                            // Handle attachments (images, stickers, files, etc.)
                            if (message.attachments && message.attachments.length > 0) {
                                const attachmentDescriptions = message.attachments.map((att: any) => {
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

                        // Save message if we have content
                        if (messageContent && fbMid) {
                            const { error: msgError } = await supabase
                                .from("lead_messages")
                                .upsert({
                                    id: crypto.randomUUID(),
                                    lead_id: dbLead.id,
                                    fb_message_id: fbMid,
                                    sender_id: senderId,
                                    sender_name: isFromPage ? (messaging.message?.from?.name || pageName) : finalCustomerName,
                                    message_content: messageContent,
                                    attachments: message?.attachments || null,
                                    sticker: message?.sticker || null,
                                    shares: message?.shares || null,
                                    sent_at: toVietnamTimestamp(timestamp),
                                    is_from_customer: !isFromPage
                                }, { onConflict: "fb_message_id" });

                            if (!msgError) {
                                messagesInserted++;
                                console.log("[FB-Webhook] Inserted message/event: " + fbMid + " content=\"" + messageContent.substring(0, 50) + "\"");

                                // AUTO-ASSIGNMENT LOGIC: If message is from Page, detect agent
                                if (isFromPage && senderId !== pageId) {
                                    const agentId = senderId;
                                    const agentName = messaging.message?.from?.name || "Nhân viên";

                                    console.log(`[FB-Webhook] Detected agent reply: ${agentName} (${agentId})`);

                                    // 1. Upsert agent info
                                    await supabase.from("agents").upsert({
                                        id: agentId,
                                        name: agentName,
                                        fb_page_id: pageId,
                                        last_seen_at: new Date().toISOString()
                                    });

                                    // 2. Auto-assign lead if not already assigned
                                    if (!dbLead.assigned_agent_id) {
                                        console.log(`[FB-Webhook] Auto-assigning lead ${dbLead.id} to agent ${agentName}`);
                                        await supabase.from("leads").update({
                                            assigned_agent_id: agentId,
                                            assigned_agent_name: agentName
                                        }).eq("id", dbLead.id);
                                    }
                                }
                            } else {
                                console.error("[FB-Webhook] Message insert error for mid=" + fbMid + ":", msgError);
                            }
                        }
                    }

                    // 2. AI ANALYSIS: Run when message is from customer and lead needs analysis
                    // This uses messages from DB (already saved), NOT from crawl
                    if (dbLead && geminiApiKey && !isFromPage) {
                        // Check if we should run analysis (no manual override + either no analysis yet or cooldown passed)
                        const hasManualPotential = existingLead?.is_manual_potential === true;
                        const lastAnalysis = existingLead?.metadata?.last_analysis_at;
                        const analysisCooldownMs = 30 * 60 * 1000; // 30 minutes cooldown
                        const canAnalyze = !hasManualPotential && (!lastAnalysis || (Date.now() - new Date(lastAnalysis).getTime() > analysisCooldownMs));

                        if (canAnalyze) {
                            console.log("[FB-Webhook] Running AI analysis from DB messages for lead " + dbLead.id + "...");

                            // Fetch messages from DB (already saved)
                            const { data: dbMessages } = await supabase
                                .from("lead_messages")
                                .select("sender_name, message_content, is_from_customer, sent_at")
                                .eq("lead_id", dbLead.id)
                                .order("sent_at", { ascending: true })
                                .limit(50);

                            if (dbMessages && dbMessages.length > 0) {
                                const messagesForAnalysis = dbMessages
                                    .filter((m: any) => m.message_content && m.message_content.trim())
                                    .map((m: any) => ({
                                        sender: m.sender_name,
                                        content: m.message_content,
                                        isFromCustomer: m.is_from_customer,
                                        timestamp: m.sent_at
                                    }));

                                if (messagesForAnalysis.length > 0) {
                                    console.log("[FB-Webhook] Analyzing " + messagesForAnalysis.length + " messages from DB with Gemini (with timing context)...");
                                    const geminiResult = await analyzeWithGemini(geminiApiKey, messagesForAnalysis);

                                    if (geminiResult) {
                                        const existingMetadata = existingLead?.metadata || {};
                                        const { error: analysisErr } = await supabase
                                            .from("leads")
                                            .update({
                                                ai_analysis: geminiResult.analysis,
                                                is_potential: geminiResult.isPotential,
                                                last_analysis_at: new Date().toISOString(),
                                                metadata: { ...existingMetadata, last_analysis_at: new Date().toISOString() }
                                            })
                                            .eq("id", dbLead.id);

                                        if (!analysisErr) {
                                            console.log("[FB-Webhook] Updated lead " + dbLead.id + " with AI analysis, isPotential=" + geminiResult.isPotential);
                                        } else {
                                            console.error("[FB-Webhook] Failed to save AI analysis:", analysisErr);
                                        }
                                    }
                                }
                            }
                        } else {
                            console.log("[FB-Webhook] Skipping AI analysis: hasManualPotential=" + hasManualPotential + ", cooldown not passed");
                        }
                    }

                    // 3. CRAWL ENTIRE CONVERSATION - Only for new leads OR if not crawled today
                    // Check if already crawled today (daily limit: 1 crawl per lead per day)
                    const todayVN = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10); // YYYY-MM-DD in VN timezone
                    const lastCrawledAt = existingLead?.metadata?.last_crawled_at;
                    const lastCrawledDate = lastCrawledAt ? lastCrawledAt.slice(0, 10) : null;
                    const alreadyCrawledToday = lastCrawledDate === todayVN;

                    const shouldCrawl = !existingLead || (!alreadyCrawledToday && dbLead);

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
                                    if (detectedAdReply) {
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
                                        if (!dbLead.is_qualified) {
                                            updateData.is_qualified = true;
                                        }
                                        
                                        const nowVNStr = toVietnamTimestamp(new Date());
                                        updateData.metadata = {
                                            ...(dbLead.metadata || existingLead?.metadata || {}),
                                            qualified_at: dbLead.metadata?.qualified_at || existingLead?.metadata?.qualified_at || nowVNStr,
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

                                    // Identify the latest message for lead metadata update
                                    const sortedMsgs = [...msgsData.data].sort((a: any, b: any) => 
                                        new Date(b.created_time).getTime() - new Date(a.created_time).getTime()
                                    );
                                    const latestMsg = sortedMsgs[0];

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
                                            sent_at: toVietnamTimestamp(m.created_time),
                                            is_from_customer: !isMsgFromPage
                                        };
                                    });

                                    const { error: crawlError } = await supabase
                                        .from("lead_messages")
                                        .upsert(dbMessages, { onConflict: "fb_message_id" });

                                    if (!crawlError) {
                                        console.log("[FB-Webhook] Successfully crawled " + dbMessages.length + " historical messages");

                                        // Update metadata and lead head info with latest message
                                        const existingMetadata = existingLead?.metadata || {};
                                        
                                        const headUpdate: any = {
                                            metadata: { ...existingMetadata, last_crawled_at: new Date().toISOString() }
                                        };

                                        if (latestMsg) {
                                            headUpdate.last_message_at = toVietnamTimestamp(latestMsg.created_time);
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
                                    } else {
                                        console.error("[FB-Webhook] Crawl upsert error:", crawlError);
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
