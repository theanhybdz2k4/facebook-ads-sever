
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";

console.log("FB-DEBUG-MSG: Loaded v2");

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
        const customerId = "25690028623991482";

        // Fetch conversations to find the one with this participant
        const convsRes = await fetch(`${FB_BASE_URL}/${pageId}/conversations?fields=id,participants&limit=50&access_token=${pageToken}`);
        const convsData = await convsRes.json();

        const conversations = convsData.data || [];
        const targetConv = conversations.find((c: any) =>
            c.participants?.data?.some((p: any) => p.id === customerId)
        );

        if (!targetConv) {
            return new Response(JSON.stringify({
                error: "Conversation not found in recent list",
                checked_count: conversations.length,
                raw_list: conversations
            }, null, 2), { headers: corsHeaders });
        }

        const convId = targetConv.id;

        // 4. Fetch Messages
        const msgsRes = await fetch(`${FB_BASE_URL}/${convId}/messages?fields=id,message,from,created_time,attachments,sticker&limit=50&access_token=${pageToken}`);
        const msgsData = await msgsRes.json();

        return new Response(JSON.stringify({
            convId,
            messages: msgsData
        }, null, 2), { headers: corsHeaders });

    } catch (e: any) {
        return new Response(JSON.stringify({ error: "DEBUG_ERR: " + e.message }), { status: 500, headers: corsHeaders });
    }
});
