import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";

console.log("FB-DEBUG-MSG-2: Loaded");

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const supabase = createClient(supabaseUrl, supabaseKey);

const FB_BASE_URL = "https://graph.facebook.com/v24.0";
const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
};

Deno.serve(async (req) => {
    try {
        // 1. Get User Token
        const { data: creds } = await supabase.from("platform_credentials").select("credential_value").eq("is_active", true).limit(1);
        if (!creds?.length) throw new Error("No active FB token found");
        const userToken = creds[0].credential_value;

        // 2. Get Page Token for Color ME Sài Gòn
        const pageId = "263911110732013";
        const pageRes = await fetch(`${FB_BASE_URL}/${pageId}?fields=access_token&access_token=${userToken}`);
        const pageData = await pageRes.json();

        if (!pageData.access_token) return new Response(JSON.stringify({ error: "No page token", raw: pageData }), { headers: corsHeaders });
        const pageToken = pageData.access_token;

        // 3. Find Conversation by Customer ID (API Search)
        const customerId = "9846251672088794";

        // Fetch conversations to find the one with this participant
        const convsRes = await fetch(`${FB_BASE_URL}/${pageId}/conversations?fields=id,participants&limit=50&access_token=${pageToken}`);
        const convsData = await convsRes.json();

        const conversations = convsData.data || [];
        const targetConvIndex = conversations.findIndex((c: any) => 
            c.participants?.data?.some((p: any) => p.id === customerId)
        );
        const targetConv = conversations[targetConvIndex];

        if (!targetConv) {
            return new Response(JSON.stringify({
                error: "Conversation not found in recent list",
                checked_count: conversations.length,
                raw_list: conversations
            }, null, 2), { headers: corsHeaders });
        }

        const convId = targetConv.id;

        // 4. Fetch Messages
        const msgsRes = await fetch(`${FB_BASE_URL}/${convId}/messages?fields=id,message,from,created_time,attachments,sticker&limit=100&access_token=${pageToken}`);
        const msgsData = await msgsRes.json();

        // 5. UPSERT Messages to Fix Data
        const { data: lead } = await supabase.from("leads").select("id, fb_page_id").eq("external_id", customerId).single();
        let upsertCount = 0;
        let upsertError = null;

        if (lead) {
            const msgsToUpsert = msgsData.data.map((m: any) => {
                const msgSenderId = String(m.from?.id || "");
                const isMsgFromPage = msgSenderId === "263911110732013"; // Hardcoded page ID for debugging

                 // Helper to match sync logic
                const toVietnamTimestamp = (timestamp: string) => {
                    const date = new Date(timestamp);
                    const vnTime = new Date(date.getTime() + 7 * 60 * 60 * 1000);
                    return vnTime.toISOString().slice(0, 19).replace('T', ' ');
                }

                let content = m.message || "";
                if (!content && m.attachments?.data) content = "[Attachment]";
                if (!content && m.sticker) content = "[Sticker]";
                if (!content) content = "[Media]";

                return {
                    id: crypto.randomUUID(),
                    lead_id: lead.id,
                    fb_message_id: m.id,
                    sender_id: msgSenderId,
                    sender_name: m.from?.name || (isMsgFromPage ? "Page" : "Customer"),
                    message_content: content,
                    attachments: m.attachments?.data || null,
                    sticker: m.sticker || null,
                    shares: m.shares?.data || null,
                    sent_at: toVietnamTimestamp(m.created_time),
                    is_from_customer: !isMsgFromPage
                };
            });

            const { error: msgErr, count } = await supabase.from("lead_messages").upsert(msgsToUpsert, { onConflict: "fb_message_id" }).select("id", { count: 'exact' });
            upsertError = msgErr;
            upsertCount = count || msgsToUpsert.length; // Approximate if count not returned
        }

        return new Response(JSON.stringify({ 
            convId,
            foundAtIndex: targetConvIndex,
            leadId: lead?.id,
            upserted: upsertCount,
            upsertError,
            messagesResult: msgsData
        }, null, 2), { headers: corsHeaders });

    } catch (e: any) {
        return new Response(JSON.stringify({ error: "DEBUG_ERR: " + e.message }), { status: 500, headers: corsHeaders });
    }
});
