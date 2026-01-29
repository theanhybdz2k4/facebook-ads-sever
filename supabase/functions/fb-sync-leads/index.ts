
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";
import { verify } from "https://deno.land/x/djwt@v3.0.1/mod.ts";

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

// Unified Auth Logic
async function verifyAuth(req: Request) {
    const authHeader = req.headers.get("Authorization");
    const serviceKeyHeader = req.headers.get("x-service-key") || req.headers.get("x-master-key");
    const masterKey = Deno.env.get("MASTER_KEY") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const authSecret = Deno.env.get("AUTH_SECRET") || "";

    if (serviceKeyHeader === serviceKey || serviceKeyHeader === masterKey) {
        return { userId: 1, isSystem: true };
    }

    if (authHeader?.startsWith("Bearer ")) {
        const token = authHeader.substring(7).trim();
        if ((serviceKey !== "" && token === serviceKey) || (masterKey !== "" && token === masterKey) || (authSecret !== "" && token === authSecret)) {
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

// Helper to fetch all pages of a Facebook Graph API edge
async function fetchAll(url: string) {
    let results: any[] = [];
    let nextUrl = url;

    while (nextUrl) {
        const res = await fetch(nextUrl);
        const data = await res.json();
        if (data.error) throw new Error(data.error.message);
        if (data.data) results = results.concat(data.data);
        nextUrl = data.paging?.next || null;
    }
    return results;
}

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

    const auth = await verifyAuth(req);
    if (!auth) return jsonResponse({ success: false, error: "Unauthorized" }, 401);

    try {
        const body = await req.json().catch(() => ({}));
        const { userId: forcedUserId } = body;
        const targetUserId = auth.isSystem ? forcedUserId : auth.userId;
        if (!targetUserId) return jsonResponse({ success: false, error: "Missing Target User ID" }, 400);

        console.log(`[FB-Sync-Leads] Crawling data for user: ${targetUserId}`);

        // 1. Get Ad Account Map
        const { data: adsData } = await supabase.from("unified_ads").select("external_id, platform_account_id");
        const adToAccountMap: Record<string, number> = {};
        adsData?.forEach((a: any) => adToAccountMap[a.external_id] = a.platform_account_id);

        const { data: creativesData } = await supabase
            .from("unified_ad_creatives")
            .select("platform_account_id, platform_data->object_story_spec->>page_id")
            .not("platform_data->object_story_spec->>page_id", "is", null);
        
        const pageToAccountMap: Record<string, number> = {};
        creativesData?.forEach((c: any) => {
            const pageId = c.page_id;
            if (pageId && !pageToAccountMap[pageId]) pageToAccountMap[pageId] = c.platform_account_id;
        });

        // 2. Get User Token
        const { data: credentials } = await supabase
            .from("platform_credentials")
            .select("credential_value")
            .eq("credential_type", "access_token")
            .eq("is_active", true)
            .limit(1);

        if (!credentials?.length) throw new Error("No active Facebook credentials found");
        const userToken = credentials[0].credential_value;

        // 3. Fetch Pages
        const pages = await fetchAll(`${FB_BASE_URL}/me/accounts?fields=id,name,access_token&access_token=${userToken}`);
        
        let leadCount = 0;
        let msgCount = 0;

        for (const page of pages) {
            const pageToken = page.access_token;
            const pageId = page.id;
            const pageName = page.name;

            console.log(`[FB-Sync-Leads] Syncing Page: ${pageName} (${pageId})`);

            // 4. Fetch All Conversations
            const conversations = await fetchAll(`${FB_BASE_URL}/${pageId}/conversations?fields=id,participants,updated_time,snippet,labels&access_token=${pageToken}`);

            for (const conv of conversations) {
                const customer = conv.participants?.data?.find((p: any) => p.id !== pageId);
                if (!customer) continue;

                const defaultAccountId = pageToAccountMap[pageId] || 40; // Fallback to 40 if not mapped

                // 5. Fetch All Messages for this conversation
                const messages = await fetchAll(`${FB_BASE_URL}/${conv.id}/messages?fields=id,message,from,created_time,referral&access_token=${pageToken}`);

                // Try to get customer picture
                let avatarUrl = null;
                try {
                    const picRes = await fetch(`${FB_BASE_URL}/${customer.id}/picture?redirect=false&type=normal&access_token=${pageToken}`);
                    const picData = await picRes.json();
                    avatarUrl = picData.data?.url;
                } catch (e) {}

                // Look for source campaign from referral
                let sourceCampaignId = null;
                const referralMsg = messages.find((m: any) => m.referral?.ad_id);
                if (referralMsg) sourceCampaignId = referralMsg.referral.ad_id;

                let finalAccountId = defaultAccountId;
                if (sourceCampaignId && adToAccountMap[sourceCampaignId]) {
                    finalAccountId = adToAccountMap[sourceCampaignId];
                }

                // Identify latest staff
                const pageMsgs = messages.filter((m: any) => m.from.id === pageId);
                const lastStaffName = pageMsgs.length > 0 ? pageMsgs[0].from.name : null;

                // 6. Upsert Lead
                const { data: lead, error: leadError } = await supabase
                    .from("leads")
                    .upsert({
                        platform_account_id: finalAccountId,
                        external_id: customer.id,
                        customer_name: customer.name,
                        customer_avatar: avatarUrl,
                        last_message_at: conv.updated_time,
                        source_campaign_id: sourceCampaignId,
                        platform_data: {
                            fb_conv_id: conv.id,
                            fb_page_id: pageId,
                            fb_page_name: pageName,
                            snippet: conv.snippet,
                            last_staff_name: lastStaffName,
                            labels: conv.labels?.data || []
                        }
                    }, { onConflict: "platform_account_id,external_id" })
                    .select()
                    .single();

                if (leadError) {
                    console.error(`[FB-Sync-Leads] Lead upsert failed: ${leadError.message}`);
                    continue;
                }
                leadCount++;

                // 7. Upsert All Messages
                if (messages.length > 0) {
                    const dbMessages = messages.map((m: any) => ({
                        lead_id: lead.id,
                        fb_message_id: m.id,
                        sender_id: m.from.id,
                        sender_name: m.from.name,
                        message_content: m.message,
                        sent_at: m.created_time,
                        is_from_customer: m.from.id !== pageId
                    }));

                    const { error: msgError } = await supabase.from("lead_messages").upsert(dbMessages, { onConflict: "fb_message_id" });
                    if (!msgError) msgCount += dbMessages.length;
                    else console.error(`[FB-Sync-Leads] Message upsert failed: ${msgError.message}`);
                }
            }
        }

        return jsonResponse({
            success: true,
            result: {
                pagesSynced: pages.length,
                leadsSynced: leadCount,
                messagesSynced: msgCount
            }
        });

    } catch (err: any) {
        console.error(`[FB-Sync-Leads] Fatal:`, err);
        return jsonResponse({ success: false, error: err.message }, 500);
    }
});
