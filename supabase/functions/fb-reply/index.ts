
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const supabase = createClient(supabaseUrl, supabaseKey);

const FB_BASE_URL = "https://graph.facebook.com/v24.0";

const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const jsonResponse = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: corsHeaders });

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

    try {
        const { leadId, message } = await req.json();
        if (!leadId || !message) return jsonResponse({ success: false, error: "Missing leadId or message" }, 400);

        // 1. Get lead and page info
        const { data: lead, error: leadError } = await supabase
            .from("leads")
            .select(`
                *,
                platform_accounts!inner(*)
            `)
            .eq("id", leadId)
            .single();

        if (leadError || !lead) throw new Error("Lead not found");

        const pageId = lead.platform_data?.fb_page_id;
        const customerId = lead.external_id;

        // 2. Get Page Token
        // First try to find token for this specific page
        const { data: credentials } = await supabase
            .from("platform_credentials")
            .select("credential_value")
            .eq("is_active", true)
            .eq("credential_type", "access_token")
            .limit(10); // Check multiple tokens if needed

        let pageToken = null;
        for (const cred of credentials || []) {
            const pagesRes = await fetch(`${FB_BASE_URL}/me/accounts?access_token=${cred.credential_value}`);
            const pagesData = await pagesRes.json();
            const page = pagesData.data?.find((p: any) => p.id === pageId);
            if (page) {
                pageToken = page.access_token;
                break;
            }
        }

        if (!pageToken) throw new Error("Could not find authorized page token");

        // 3. Send message to Facebook
        const sendRes = await fetch(`${FB_BASE_URL}/me/messages?access_token=${pageToken}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                recipient: { id: customerId },
                message: { text: message }
            })
        });

        const sendData = await sendRes.json();
        if (sendData.error) throw new Error(`FB Error: ${sendData.error.message}`);

        // 4. Update local database
        const { error: msgError } = await supabase
            .from("lead_messages")
            .insert({
                id: crypto.randomUUID(),
                lead_id: lead.id,
                fb_message_id: sendData.message_id,
                sender_id: pageId,
                sender_name: lead.platform_data?.fb_page_name || "Page",
                message_content: message,
                sent_at: new Date().toISOString(),
                is_from_customer: false
            });

        return jsonResponse({ success: true, messageId: sendData.message_id });

    } catch (err: any) {
        console.error("[FB-Reply] Error:", err.message);
        return jsonResponse({ success: false, error: err.message }, 500);
    }
});
