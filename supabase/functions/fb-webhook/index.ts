
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

// Gemini AI helper function to analyze conversation
// Returns { analysis: string, isPotential: boolean } or null
async function analyzeWithGemini(apiKey: string, messages: Array<{sender: string, content: string, isFromCustomer: boolean}>): Promise<{ analysis: string, isPotential: boolean } | null> {
    if (!apiKey || messages.length === 0) return null;
    
    try {
        // Format conversation for analysis
        const conversationText = messages.map(m => 
            `${m.isFromCustomer ? '👤 Khách hàng' : '📄 Page'}: ${m.content}`
        ).join('\n');

const prompt = `Bạn là chuyên gia phân tích hội thoại bán hàng. Hãy phân tích cuộc hội thoại sau và trả lời theo đúng format này:

Đánh giá: [TIỀM NĂNG hoặc KHÔNG TIỀM NĂNG]
(Tiềm năng = khách hỏi chi tiết về khóa học/sản phẩm, hẹn đóng tiền, quan tâm ưu đãi, hỏi lịch học, để lại SĐT hoặc có dấu hiệu muốn mua hàng)
(Không tiềm năng = chỉ hỏi qua loa rồi im lặng, từ chối rõ ràng, hoặc chỉ là tin nhắn rác/spam)

Tóm tắt: [Nội dung chính của cuộc hội thoại, 1-2 câu ngắn gọn]

Nhu cầu khách hàng: [Khách đang thực sự muốn giải quyết vấn đề gì?]

Mức độ quan tâm: [Cao / Trung bình / Thấp. Giải thích ngắn nhất có thể]

Gợi ý follow-up:
[Liệt kê các bước nên làm tiếp theo, mỗi bước một dòng]

---
${conversationText}
---

Trả lời bằng tiếng Việt, cực kỳ súc tích. QUAN TRỌNG: Dòng đầu tiên PHẢI là "Đánh giá: TIỀM NĂNG" hoặc "Đánh giá: KHÔNG TIỀM NĂNG"`;

        console.log(`[FB-Webhook] Calling Gemini API to analyze ${messages.length} messages...`);
        
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }]
            })
        });
        
        const data = await response.json();
        
        if (data.error) {
            console.error(`[FB-Webhook] Gemini API error: ${data.error.message}`);
            return null;
        }
        
        const analysis = data.candidates?.[0]?.content?.parts?.[0]?.text || null;
        if (analysis) {
            console.log(`[FB-Webhook] Gemini analysis received: ${analysis.substring(0, 100)}...`);
            
            // Parse isPotential from analysis and strip the evaluation line
            const lines = analysis.split('\n');
            const firstLine = lines[0].toLowerCase();
            const isPotential = firstLine.includes('tiềm năng') && !firstLine.includes('không tiềm năng');
            
            // Remove the evaluation line (the first line typically starts with "Đánh giá:")
            const cleanedAnalysis = lines.slice(1).join('\n').trim();
            console.log(`[FB-Webhook] Lead classification: isPotential = ${isPotential}`);
            
            return { analysis: cleanedAnalysis, isPotential };
        }
        return null;
    } catch (e: any) {
        console.error(`[FB-Webhook] Gemini API call failed: ${e.message}`);
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

            console.log(`[FB-Webhook] Authorized pages (from cache): ${Object.keys(authorizedPages).join(", ")}`);

            // Get default account IDs to map pages to accounts
            const { data: accountsData } = await supabase
                .from("platform_accounts")
                .select("id, name")
                .eq("platform_id", 1) // Facebook
                .order("id", { ascending: true });
            
            const availableAccountIds = accountsData?.map((a: any) => a.id) || [40];
            const defaultAccountId = availableAccountIds[0];

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
                    console.warn(`[FB-Webhook] REJECTED: Page ${pageId} is not authorized in our system. Authorized pages are: ${Object.keys(authorizedPages).join(", ")}`);
                    pagesSkipped++;
                    continue;
                }

                console.log(`[FB-Webhook] ACCEPTED: Page ${pageId} (${pageAuth.name}) with cached token`);

                const pageToken = pageAuth.token;
                
                // STABLE ACCOUNT MAPPING: Try to find which account this page belongs to based on existing leads
                let accountId = defaultAccountId;
                const { data: pageLeadSample } = await supabase
                    .from("leads")
                    .select("platform_account_id")
                    .eq("fb_page_id", pageId)
                    .limit(1)
                    .maybeSingle();
                
                if (pageLeadSample?.platform_account_id) {
                    accountId = pageLeadSample.platform_account_id;
                    console.log(`[FB-Webhook] Using stable accountId ${accountId} for Page ${pageId}`);
                } else {
                    console.log(`[FB-Webhook] No existing leads for Page ${pageId}, using default accountId ${accountId}`);
                }

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
                    console.log(`[FB-Webhook] Event details: message=${!!message}, mid=${message?.mid}, text=${message?.text?.substring(0, 50)}, attachments=${message?.attachments?.length || 0}, reaction=${!!messaging.reaction}, read=${!!messaging.read}, postback=${!!messaging.postback}`);

                    // Check if lead already exists for this specific (customer, page) combination
                    // STRICT LOOKUP: ONLY external_id + fb_page_id
                    const { data: existingLead } = await supabase
                        .from("leads")
                        .select("id, customer_name, customer_avatar, is_potential, ai_analysis, is_manual_potential")
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
                        // Fetch customer profile (only if we don't have valid info OR we need AI analysis and message is from customer)
                        if (!isFromPage && (!hasValidName || needsAIAnalysis || !customerAvatar)) {
                            console.log(`[FB-Webhook] Need to fetch or re-analyze. hasName=${hasValidName}, needsAI=${needsAIAnalysis}, hasAvatar=${!!customerAvatar}`);
                            
                            // METHOD 1: Get from conversation participants (MOST RELIABLE for Facebook Messenger)
                            // Facebook allows access to participant names in conversations the page owns
                            if (!hasValidName) {
                                try {
                                    console.log(`[FB-Webhook] Trying conversation participants API for ${customerId}...`);
                                    const convsRes = await fetch(`${FB_BASE_URL}/${pageId}/conversations?user_id=${customerId}&fields=participants&access_token=${pageToken}`);
                                    const convsData = await convsRes.json();
                                    
                                    if (convsData.error) {
                                        console.error(`[FB-Webhook] Conversation API error: ${convsData.error.message} (code: ${convsData.error.code})`);
                                    } else {
                                        console.log(`[FB-Webhook] Conversation API response: ${JSON.stringify(convsData)}`);
                                        const participant = convsData.data?.[0]?.participants?.data?.find((p: any) => p.id === customerId);
                                        if (participant?.name) {
                                            customerName = participant.name;
                                            console.log(`[FB-Webhook] SUCCESS: Got name from conversation participants: "${customerName}"`);
                                        } else {
                                            console.warn(`[FB-Webhook] Participant not found in response. Looking for ID: ${customerId}`);
                                        }
                                    }
                                } catch (convErr: any) {
                                    console.error(`[FB-Webhook] Conversation API network error: ${convErr.message}`);
                                }
                            }
                            
                            // METHOD 2: Try direct profile API (may be blocked by Facebook for PSIDs)
                            if (!customerName || customerName === "Khách hàng" || !customerAvatar) {
                                try {
                                    console.log(`[FB-Webhook] Trying direct profile API for ${customerId}...`);
                                    const profileRes = await fetch(`${FB_BASE_URL}/${customerId}?fields=name,profile_pic&access_token=${pageToken}`);
                                    const profileData = await profileRes.json();
                                    
                                    if (profileData.error) {
                                        console.error(`[FB-Webhook] Profile API error: ${profileData.error.message} (code: ${profileData.error.code}, subcode: ${profileData.error.error_subcode})`);
                                    } else {
                                        console.log(`[FB-Webhook] Profile API response: name=${profileData.name}, has_pic=${!!profileData.profile_pic}`);
                                        if ((!customerName || customerName === "Khách hàng") && profileData.name) {
                                            customerName = profileData.name;
                                            console.log(`[FB-Webhook] Got name from profile API: "${customerName}"`);
                                        }
                                        if (!customerAvatar && profileData.profile_pic) {
                                            customerAvatar = profileData.profile_pic;
                                            console.log(`[FB-Webhook] Got avatar from profile API`);
                                        }
                                    }
                                } catch (e: any) {
                                    console.error(`[FB-Webhook] Profile API network error: ${e.message}`);
                                }
                            }
                            
                            console.log(`[FB-Webhook] Final resolved: name="${customerName}", hasAvatar=${!!customerAvatar}`);
                        }
                        
                        // Fetch page name and update centralized info
                        try {
                            const pageInfoRes = await fetch(`${FB_BASE_URL}/${pageId}?fields=name&access_token=${pageToken}`);
                            const pageInfoData = await pageInfoRes.json();
                            if (pageInfoData.name) {
                                pageName = pageInfoData.name;
                                // Update centralized page info
                                await supabase.from("platform_pages").upsert({
                                    id: pageId,
                                    name: pageName,
                                    last_synced_at: new Date().toISOString()
                                });
                            }
                        } catch (e) {
                            console.error(`[FB-Webhook] Failed to fetch page info`);
                        }
                    }

                    let dbLead, leadError;

                    // Build lead data - only include fields that should always be updated
                    const leadBaseData: any = {
                        fb_page_id: pageId,
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
                        dbLead = result.data;
                        leadError = result.error;
                        console.log(`[FB-Webhook] Updated existing lead: ${dbLead?.id}`);
                    } else {
                        // New lead - set defaults for required fields
                        const insertData = {
                            id: crypto.randomUUID(),
                            platform_account_id: accountId,
                            external_id: customerId,
                            fb_page_id: pageId,
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
                        dbLead = result.data;
                        leadError = result.error;
                        console.log(`[FB-Webhook] Created new lead: ${dbLead?.id}`);
                    }

                    if (leadError) {
                        console.error("[FB-Webhook] Lead error:", leadError);
                        continue;
                    }
                    leadsUpdated++;

                    // FINAL LEAD OBJECT FOR NEXT STEPS
                    const finalCustomerName = dbLead?.customer_name || customerName || "Khách hàng";

                    // 1. Insert current message
                    if (message && dbLead) {
                        // Build message content - handle text and attachments
                        let messageContent = message.text || "";
                        
                        // Handle attachments (images, stickers, files, etc.)
                        if (message.attachments && message.attachments.length > 0) {
                            const attachmentDescriptions = message.attachments.map((att: any) => {
                                if (att.type === "image") return "[Hình ảnh]";
                                if (att.type === "sticker") return "[Sticker]";
                                if (att.type === "video") return "[Video]";
                                if (att.type === "audio") return "[Audio]";
                                if (att.type === "file") return "[File]";
                                if (att.type === "location") return "[Vị trí]";
                                return `[${att.type}]`;
                            });
                            if (!messageContent) {
                                messageContent = attachmentDescriptions.join(" ");
                            } else {
                                messageContent += " " + attachmentDescriptions.join(" ");
                            }
                        }

                        // Skip if no content at all
                        if (!messageContent) {
                            console.log(`[FB-Webhook] Skipping message with no content: mid=${message.mid}`);
                        } else if (!message.mid) {
                            console.log(`[FB-Webhook] Skipping message with no mid`);
                        } else {
                            const { error: msgError } = await supabase
                                .from("lead_messages")
                                .upsert({
                                    id: crypto.randomUUID(),
                                    lead_id: dbLead.id,
                                    fb_message_id: message.mid,
                                    sender_id: senderId,
                                    sender_name: isFromPage ? pageName : finalCustomerName,
                                    message_content: messageContent,
                                    sent_at: toVietnamTimestamp(timestamp),
                                    is_from_customer: !isFromPage
                                }, { onConflict: "fb_message_id" });

                            if (!msgError) {
                                messagesInserted++;
                                console.log(`[FB-Webhook] Inserted current message: ${message.mid} content="${messageContent.substring(0, 50)}"`);
                            } else {
                                console.error(`[FB-Webhook] Message insert error for mid=${message.mid}:`, msgError);
                            }
                        }
                    } else if (!message && dbLead) {
                        // Handle read receipts, reactions, postbacks
                        if (messaging.read) {
                            console.log(`[FB-Webhook] Read receipt from ${customerId} - skipping`);
                        } else if (messaging.reaction) {
                            console.log(`[FB-Webhook] Reaction from ${customerId}: ${messaging.reaction.reaction} - skipping`);
                        } else if (messaging.postback) {
                            console.log(`[FB-Webhook] Postback from ${customerId}: ${messaging.postback.title} - skipping`);
                        } else {
                            console.log(`[FB-Webhook] Unknown event type without message object - skipping`);
                        }
                    }

                    // 2. CRAWL ENTIRE CONVERSATION (like pancake.vn)
                    if (dbLead && pageToken) {
                        try {
                            console.log(`[FB-Webhook] Triggering full conversation crawl for customer ${customerId}...`);
                            // Fetch conversations to find the ID, participants, and labels
                            const convsRes = await fetch(`${FB_BASE_URL}/${pageId}/conversations?user_id=${customerId}&fields=id,updated_time,snippet,participants,labels&access_token=${pageToken}`);
                            const convsData = await convsRes.json();

                            const conv = convsData.data?.[0];
                            if (conv) {
                                console.log(`[FB-Webhook] Found conversation ID: ${conv.id}. Fetching historical messages...`);
                                
                                // TRY TO GET NAME FROM PARTICIPANTS (backup if we still don't have name)
                                let extractedCustomerName: string | null = null;
                                if (conv.participants?.data) {
                                    const participant = conv.participants.data.find((p: any) => p.id === customerId);
                                    if (participant?.name) {
                                        extractedCustomerName = participant.name;
                                        console.log(`[FB-Webhook] Extracted name from conversation participants: "${extractedCustomerName}"`);
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
                                        console.log(`[FB-Webhook] Manual potential detected via FB label: ${conv.labels.data.map((l: any) => l.name).join(", ")}`);
                                    }
                                }
                                const msgsRes = await fetch(`${FB_BASE_URL}/${conv.id}/messages?fields=id,message,from,created_time&limit=50&access_token=${pageToken}`);
                                const msgsData = await msgsRes.json();

                                if (msgsData.data && msgsData.data.length > 0) {
                                    // Try to extract customer name from message senders
                                    for (const m of msgsData.data) {
                                        const msgSenderId = String(m.from?.id || "");
                                        if (msgSenderId === customerId && m.from?.name) {
                                            if (!extractedCustomerName) {
                                                extractedCustomerName = m.from.name;
                                                console.log(`[FB-Webhook] Extracted name from message from.name: "${extractedCustomerName}"`);
                                            }
                                            break;
                                        }
                                    }
                                    
                                    // UPDATE LEAD if we got a name or labels
                                    const updateData: any = {};
                                    if (extractedCustomerName && dbLead.customer_name === "Khách hàng") {
                                        updateData.customer_name = extractedCustomerName;
                                    }
                                    if (isManualPotential) {
                                        updateData.is_manual_potential = true;
                                    }

                                    if (Object.keys(updateData).length > 0) {
                                        const { error: updateErr } = await supabase
                                            .from("leads")
                                            .update(updateData)
                                            .eq("id", dbLead.id);
                                        if (!updateErr) {
                                            console.log(`[FB-Webhook] Updated lead ${dbLead.id} with:`, updateData);
                                            if (updateData.customer_name) dbLead.customer_name = updateData.customer_name;
                                            if (updateData.is_manual_potential) dbLead.is_manual_potential = true;
                                        } else {
                                            console.error(`[FB-Webhook] Failed to update lead with extracted data:`, updateErr);
                                        }
                                    }
                                    
                                    // Use the best available name for messages
                                    const bestCustomerName = dbLead.customer_name !== "Khách hàng" ? dbLead.customer_name : (extractedCustomerName || finalCustomerName);
                                    
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
                                            sent_at: toVietnamTimestamp(m.created_time),
                                            is_from_customer: !isMsgFromPage
                                        };
                                    });

                                    const { error: crawlError } = await supabase
                                        .from("lead_messages")
                                        .upsert(dbMessages, { onConflict: "fb_message_id" });

                                    if (!crawlError) {
                                        console.log(`[FB-Webhook] Successfully crawled ${dbMessages.length} historical messages`);
                                        
                                        // GEMINI AI ANALYSIS: Analyze conversation if API key is available
                                        if (geminiApiKey && dbMessages.length > 0) {
                                            // Prepare messages for Gemini analysis
                                            const messagesForAnalysis = dbMessages
                                                .filter((m: any) => m.message_content && m.message_content.trim())
                                                .map((m: any) => ({
                                                    sender: m.sender_name,
                                                    content: m.message_content,
                                                    isFromCustomer: m.is_from_customer
                                                }))
                                                .reverse(); // Oldest first for context
                                            
                                            if (messagesForAnalysis.length > 0) {
                                                console.log(`[FB-Webhook] Analyzing ${messagesForAnalysis.length} messages with Gemini...`);
                                                const geminiResult = await analyzeWithGemini(geminiApiKey, messagesForAnalysis);
                                                
                                                if (geminiResult) {
                                                    const { error: analysisErr } = await supabase
                                                        .from("leads")
                                                        .update({ 
                                                            ai_analysis: geminiResult.analysis,
                                                            is_potential: geminiResult.isPotential,
                                                            last_analysis_at: new Date().toISOString()
                                                        })
                                                        .eq("id", dbLead.id);
                                                    
                                                    if (!analysisErr) {
                                                        console.log(`[FB-Webhook] Updated lead ${dbLead.id} with AI analysis, isPotential=${geminiResult.isPotential}`);
                                                    } else {
                                                        console.error(`[FB-Webhook] Failed to save AI analysis:`, analysisErr);
                                                    }
                                                } else {
                                                    console.warn(`[FB-Webhook] Gemini returned null result for lead ${dbLead.id}`);
                                                }
                                            }
                                        } else {
                                            console.log(`[FB-Webhook] Skipping AI analysis: geminiApiKey=${!!geminiApiKey}, msgCount=${dbMessages.length}`);
                                        }
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
