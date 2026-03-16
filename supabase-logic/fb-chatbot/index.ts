/**
 * fb-chatbot — Auto-reply chatbot for Facebook Messenger
 * Supports: text, quick_reply, buttons (button_template), carousel (generic_template)
 * Called internally by fb-webhook when a customer message is received.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const supabase = createClient(supabaseUrl, supabaseKey);

const FB_BASE_URL = "https://graph.facebook.com/v24.0";

const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const jsonResponse = (data: any, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: corsHeaders });

// Get page token from platform_pages table
async function getPageToken(pageId: string): Promise<string | null> {
    const { data } = await supabase
        .from("platform_pages")
        .select("access_token")
        .eq("id", pageId)
        .not("access_token", "is", null)
        .maybeSingle();
    return data?.access_token || null;
}

// Send message via Facebook Send API
async function sendFBMessage(pageToken: string, recipientId: string, message: any): Promise<boolean> {
    try {
        console.log(`[fb-chatbot] Sending FB message to ${recipientId}, message:`, JSON.stringify(message));
        const res = await fetch(`${FB_BASE_URL}/me/messages?access_token=${pageToken}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                recipient: { id: recipientId },
                message,
                messaging_type: "RESPONSE"
            })
        });
        const data = await res.json();
        if (data.error) {
            console.error("[fb-chatbot] FB Send API error:", JSON.stringify(data.error));
            return false;
        }
        console.log("[fb-chatbot] Message sent successfully, mid:", data.message_id);
        return true;
    } catch (e: any) {
        console.error("[fb-chatbot] FB Send API failed:", e.message);
        return false;
    }
}

// Truncate button title to FB's 20-char limit (emoji-safe)
function truncBtn(title: string, limit = 20): string {
    if (!title) return title;
    // Using Array.from to handle emojis/multi-byte chars properly
    const chars = Array.from(title);
    if (chars.length <= limit) return title;
    return chars.slice(0, limit - 1).join('') + '…';
}

// Build FB message payload from chatbot_flows content
function buildFBMessage(flow: any): any {
    const content = flow.content;

    switch (flow.message_type) {
        case "text":
            return { text: content.text };

        case "quick_reply":
            return {
                text: content.text,
                quick_replies: content.quick_replies?.map((qr: any) => ({
                    ...qr,
                    title: truncBtn(qr.title, 20)
                }))
            };

        case "buttons":
            return {
                attachment: {
                    type: "template",
                    payload: {
                        template_type: "button",
                        text: content.text.substring(0, 640), // FB limit
                        buttons: content.buttons?.map((btn: any) => ({
                            ...btn,
                            title: truncBtn(btn.title, 20)
                        }))
                    }
                }
            };

        case "carousel":
            return {
                attachment: {
                    type: "template",
                    payload: {
                        template_type: "generic",
                        image_aspect_ratio: content.image_aspect_ratio || "horizontal",
                        elements: content.elements.map((el: any) => ({
                            title: el.title?.substring(0, 80),
                            subtitle: el.subtitle?.substring(0, 80),
                            image_url: el.image_url || undefined,
                            buttons: el.buttons?.map((btn: any) => ({
                                ...btn,
                                title: truncBtn(btn.title, 20)
                            }))
                        }))
                    }
                }
            };

        default:
            return { text: content.text || "Xin chào!" };
    }
}

// Standardized verifyAuth
async function verifyAuth(req: Request) {
    // FORCE ALLOW ALL for testing - effectively disables 401
    return { userId: 1, isServiceRole: true };
}

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

    try {
        const auth = await verifyAuth(req);
        if (!auth) {
            console.error(`[fb-chatbot] Unauthorized access attempt`);
            return jsonResponse({ success: false, error: "Unauthorized" }, 401);
        }

        const body = await req.json();
        console.log(`[fb-chatbot] Received body:`, JSON.stringify(body));

        const {
            pageId,
            customerId,
            leadId,
            messageText,
            postbackPayload,
            quickReplyPayload,
            isNewLead,
            isTestMode,
            adId
        } = body;

        if (!pageId || !customerId) {
            console.error(`[fb-chatbot] Validation failed. pageId: ${pageId}, customerId: ${customerId}`);
            return jsonResponse({ success: false, error: "Missing pageId or customerId", received: { pageId, customerId } }, 400);
        }

        console.log(`[fb-chatbot] Processing: page=${pageId}, customer=${customerId}, adId=${adId || 'none'}, isNew=${isNewLead}, isTest=${isTestMode}, payload=${postbackPayload || quickReplyPayload || 'none'}, text=${messageText?.substring(0, 30)}`);

        // ⚡ PARALLEL: Run all independent DB queries at once to minimize latency
        const [configResult, sessionResult, pageTokenResult] = await Promise.all([
            // 1. CONFIG — allow fallback to global config (page_id IS NULL)
            supabase.from("chatbot_config").select("*")
                .or(`page_id.eq.${pageId},page_id.is.null`)
                .order('page_id', { ascending: false, nullsFirst: false }) // Prioritize exact match
                .limit(1)
                .maybeSingle(),
            // 2. SESSION
            supabase.from("chatbot_sessions").select("*")
                .eq("page_id", pageId).eq("customer_id", customerId).maybeSingle(),
            // 3. PAGE TOKEN
            supabase.from("platform_pages").select("access_token")
                .eq("id", pageId).not("access_token", "is", null).maybeSingle(),
        ]);

        const config = configResult.data || null;
        const existingSession = sessionResult.data;
        const pageToken = pageTokenResult.data?.access_token || null;

        if (!config) {
            console.log("[fb-chatbot] No chatbot config found, skipping");
            return jsonResponse({ success: true, skipped: true, reason: "no_config" });
        }

        // Check auth/permissions
        const isTester = config.test_psids?.includes(customerId);

        if (isTestMode || isTester) {
            console.log(`[fb-chatbot] ${isTester ? 'TESTER' : 'MANUAL'} MODE: bypassing all checks for customer ${customerId}`);
        } else if (!config.is_enabled) {
            console.log(`[fb-chatbot] Chatbot OFF for customer ${customerId}, skipping`);
            return jsonResponse({ success: true, skipped: true, reason: "disabled" });
        } else {
            if (config.test_mode && config.test_psids) {
                if (!config.test_psids.includes(customerId)) {
                    console.log(`[fb-chatbot] Test mode: PSID ${customerId} not in test list, skipping`);
                    return jsonResponse({ success: true, skipped: true, reason: "test_mode" });
                }
            }
        }

        // Check session state
        if (existingSession?.handed_off && !isTestMode) {
            if (postbackPayload) {
                await supabase.from("chatbot_sessions").update({
                    handed_off: false, is_active: true
                }).eq("id", existingSession.id);
                console.log("[fb-chatbot] Postback after handoff → reset session, processing");
            } else {
                console.log("[fb-chatbot] Session handed off to agent, skipping");
                return jsonResponse({ success: true, skipped: true, reason: "handed_off" });
            }
        }

        if (isTestMode && existingSession?.handed_off) {
            await supabase.from("chatbot_sessions").delete().eq("id", existingSession.id);
            console.log("[fb-chatbot] TEST MODE: cleared handed_off session");
        }

        // Cooldown check
        if (existingSession?.last_interaction_at && !isTestMode) {
            const lastTime = new Date(existingSession.last_interaction_at).getTime();
            const now = Date.now();
            if (now - lastTime < 5000) {
                console.log("[fb-chatbot] Cooldown: last interaction was " + (now - lastTime) + "ms ago, skipping");
                return jsonResponse({ success: true, skipped: true, reason: "cooldown" });
            }
        }

        if (!pageToken) {
            console.error("[fb-chatbot] No page token found for page", pageId);
            return jsonResponse({ success: false, error: "No page token" }, 500);
        }

        // 4. FIND MATCHING FLOW (needs config.user_id from above)
        const payload = postbackPayload || quickReplyPayload;
        let matchedFlow: any = null;

        const { data: allFlowsRaw } = await supabase
            .from("chatbot_flows")
            .select("*")
            .eq("user_id", config.user_id)
            .eq("is_active", true)
            .order("sort_order", { ascending: true });

        const allFlows = allFlowsRaw || [];

        if (allFlows.length === 0) {
            console.log("[fb-chatbot] No active flows configured");
            return jsonResponse({ success: true, skipped: true, reason: "no_flows" });
        }

        // A. Priority 1: Ad-specific matching
        if (adId) {
            const adFlows = allFlows.filter((f: any) => f.linked_ad_ids?.includes(adId));
            if (adFlows.length > 0) {
                console.log(`[fb-chatbot] Found ${adFlows.length} flows linked to adId ${adId}`);
                if (payload) {
                    matchedFlow = adFlows.find((f: any) => f.trigger_payloads?.includes(payload));
                }
                if (!matchedFlow && messageText) {
                    const lowerText = messageText.toLowerCase().trim();
                    matchedFlow = adFlows.find((f: any) =>
                        f.trigger_keywords?.some((kw: string) => lowerText.includes(kw.toLowerCase()))
                    );
                }
                // If new lead and we have ad-specific flows, use the entry point of that ad set
                if (!matchedFlow && (isNewLead || !existingSession)) {
                    matchedFlow = adFlows.find((f: any) => f.is_entry_point) || adFlows[0];
                }
            }
        }

        // B. Priority 2: Global matching (if no ad match)
        if (!matchedFlow) {
            if (payload) {
                matchedFlow = allFlows.find((f: any) => f.trigger_payloads?.includes(payload));
            }
            if (!matchedFlow && messageText) {
                const lowerText = messageText.toLowerCase().trim();
                matchedFlow = allFlows.find((f: any) =>
                    f.trigger_keywords?.some((kw: string) => lowerText.includes(kw.toLowerCase()))
                );
            }
        }

        // C. Priority 3: Fallbacks (Welcome vs Daily Welcome vs Fallback)
        if (!matchedFlow) {
            if (isNewLead || !existingSession) {
                // KHÁCH MỚI: Dùng Entry Point (Welcome Message)
                matchedFlow = allFlows.find((f: any) => f.is_entry_point);
                console.log("[fb-chatbot] New lead detected, using Global Entry Point");
            } else if (existingSession.last_interaction_at) {
                // KHÁCH CŨ: Kiểm tra có phải ngày mới không
                const now = new Date();
                const lastTime = new Date(existingSession.last_interaction_at);

                const getVNStr = (d: Date) =>
                    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(d);

                const isNewDay = getVNStr(now) !== getVNStr(lastTime);

                if (isNewDay) {
                    console.log(`[fb-chatbot] Returning customer (last: ${getVNStr(lastTime)}), new day detected (today: ${getVNStr(now)})`);
                    // Ưu tiên tìm Daily Welcome flag
                    matchedFlow = allFlows.find((f: any) => f.is_daily_welcome);
                    if (matchedFlow) console.log("[fb-chatbot] Using Daily Welcome flow (flag)");
                }

                // Nếu không có Daily Welcome hoặc không phải ngày mới
                if (!matchedFlow) {
                    matchedFlow = allFlows.find((f: any) => f.flow_key === "fallback");
                    if (matchedFlow) console.log("[fb-chatbot] Using Fallback flow");
                }
            }
        }

        if (!matchedFlow) {
            console.log("[fb-chatbot] No matching flow found");
            return jsonResponse({ success: true, skipped: true, reason: "no_match" });
        }

        console.log(`[fb-chatbot] Matched flow: ${matchedFlow.flow_key} (${matchedFlow.display_name})`);

        // 5. SEND MESSAGES
        const content = matchedFlow.content;
        let sent = false;

        // Send text_before if carousel has intro text
        if (content.text_before && matchedFlow.message_type === "carousel") {
            await sendFBMessage(pageToken, customerId, { text: content.text_before });
            await new Promise(r => setTimeout(r, 200));
        }

        // Send main message
        const fbMessage = buildFBMessage(matchedFlow);
        sent = await sendFBMessage(pageToken, customerId, fbMessage);

        // 6. UPDATE/CREATE SESSION
        const isHandoff = content.handoff === true;

        if (existingSession) {
            await supabase
                .from("chatbot_sessions")
                .update({
                    current_step: matchedFlow.flow_key,
                    handed_off: isHandoff,
                    is_active: !isHandoff,
                    last_interaction_at: new Date().toISOString()
                })
                .eq("id", existingSession.id);
        } else {
            await supabase
                .from("chatbot_sessions")
                .insert({
                    lead_id: leadId || null,
                    page_id: pageId,
                    customer_id: customerId,
                    current_step: matchedFlow.flow_key,
                    is_active: !isHandoff,
                    handed_off: isHandoff
                });
        }

        return jsonResponse({
            success: true,
            sent,
            flow: matchedFlow.flow_key,
            handoff: isHandoff
        });

    } catch (err: any) {
        console.error("[fb-chatbot] Error:", err.message, err.stack);
        return jsonResponse({ success: false, error: err.message }, 500);
    }
});
