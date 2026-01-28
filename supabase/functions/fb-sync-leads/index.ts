
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

// CRITICAL: DO NOT REMOVE THIS AUTH LOGIC. 
// IT PRIORITIZES auth_tokens TABLE FOR CUSTOM AUTHENTICATION.
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

        // PRIORITY: Check custom auth_tokens table first
        try {
            const { data: tokenData } = await supabase.from("auth_tokens").select("user_id").eq("token", token).single();
            if (tokenData) return { userId: tokenData.user_id, isSystem: false };
        } catch (e) {
            // Not found in auth_tokens, fallback to JWT
        }

        // FALLBACK: JWT verification
        try {
            const encoder = new TextEncoder();
            const key = await crypto.subtle.importKey("raw", encoder.encode(JWT_SECRET || ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
            const payload = await verify(token, key);
            const sub = payload.sub as string;
            const userIdNum = parseInt(sub, 10);
            if (!isNaN(userIdNum)) return { userId: userIdNum, isSystem: false };
            return { userId: sub as any, isSystem: false };
        } catch (e: any) {
            console.log("Auth: JWT verify failed:", e.message);
        }
    }
    return null;
}

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

    const auth = await verifyAuth(req);
    if (!auth) return jsonResponse({ success: false, error: "Unauthorized" }, 401);

    try {
        const body = await req.json().catch(() => ({}));
        const { accountId: forcedAccountId, userId: forcedUserId } = body;

        // Determine the target userId
        const targetUserId = auth.isSystem ? forcedUserId : auth.userId;
        if (!targetUserId) return jsonResponse({ success: false, error: "Missing Target User ID" }, 400);

        console.log(`[FB-Sync-Leads] Triggered. Target User: ${targetUserId}. System Call: ${auth.isSystem}`);

        // 1. Build Page -> AdAccount Map and Ad -> Account Map from DB (Filtered by User)
        const { data: creativeMappingData } = await supabase
            .from("unified_ad_creatives")
            .select("platform_account_id, platform_data->object_story_spec->>page_id, platform_accounts!inner(platform_identities!inner(user_id))")
            .eq("platform_accounts.platform_identities.user_id", targetUserId)
            .not("platform_data->object_story_spec->>page_id", "is", null);

        const pageToAccountMap: Record<string, number> = {};
        creativeMappingData?.forEach((row: any) => {
            const pageId = row.page_id;
            if (pageId && !pageToAccountMap[pageId]) {
                pageToAccountMap[pageId] = row.platform_account_id;
            }
        });

        const { data: adsData } = await supabase
            .from("unified_ads")
            .select("external_id, platform_account_id");

        const adToAccountMap: Record<string, number> = {};
        adsData?.forEach((a: any) => {
            adToAccountMap[a.external_id] = a.platform_account_id;
        });

        // 2. Get User Token (Filtered by User)
        const { data: credentials, error: credError } = await supabase
            .from("platform_credentials")
            .select("credential_value, platform_identities!inner(user_id)")
            .eq("is_active", true)
            .eq("credential_type", "access_token")
            .eq("platform_identities.user_id", targetUserId)
            .limit(1);

        if (credError || !credentials?.length) return jsonResponse({ success: false, error: "No valid FB credentials found for this user" }, 401);
        const userToken = credentials[0].credential_value;

        // 3. Fetch Pages
        const pagesRes = await fetch(`${FB_BASE_URL}/me/accounts?access_token=${userToken}`);
        const pagesData = await pagesRes.json();
        if (pagesData.error) throw new Error(`FB Pages: ${pagesData.error.message}`);

        const pages = pagesData.data || [];
        let leadCount = 0;
        let msgCount = 0;

        const errors: string[] = [];

        for (const page of pages) {
            const pageToken = page.access_token;
            const pageId = page.id;
            const pageName = page.name;

            console.log(`[FB-Sync-Leads] Syncing Page: ${pageName} (${pageId})`);

            // 4. Fetch Conversations with participant profile pics
            const convRes = await fetch(`${FB_BASE_URL}/${pageId}/conversations?fields=id,participants{id,name,email},updated_time,snippet,labels&access_token=${pageToken}`);
            const convData = await convRes.json();
            if (convData.error) {
                const errMsg = `${pageName}: ${convData.error.message} (code: ${convData.error.code})`;
                console.error(`[FB-Sync-Leads] Error fetching convs:`, errMsg);
                errors.push(errMsg);
                continue;
            }

            const convCount = convData.data?.length || 0;
            console.log(`[FB-Sync-Leads] Found ${convCount} conversations for ${pageName}`);

            for (const conv of convData.data || []) {
                const customer = conv.participants?.data?.find((p: any) => p.id !== pageId);
                if (!customer) continue;

                const mappedAccountId = forcedAccountId || pageToAccountMap[pageId] || 5;

                // 5. Fetch Messages & Avatar
                const msgRes = await fetch(`${FB_BASE_URL}/${conv.id}/messages?fields=id,message,from,created_time,referral&limit=20&access_token=${pageToken}`);
                const msgData = await msgRes.json();

                // Fetch Avatar (PSID-based)
                let avatarUrl = null;
                try {
                    const picRes = await fetch(`${FB_BASE_URL}/${customer.id}/picture?redirect=false&type=normal&access_token=${pageToken}`);
                    const picData = await picRes.json();
                    if (picData.data?.url) {
                        avatarUrl = picData.data.url;
                    }
                } catch (e) {
                    console.warn(`[FB-Sync-Leads] Failed to fetch avatar for ${customer.id}`, e);
                }

                let sourceCampaignId = null;
                let lastStaffName = null;
                let finalAccountId = mappedAccountId;

                if (msgData.data) {
                    // Look for referral (Ad ID)
                    const referralMsg = msgData.data.find((m: any) => m.referral?.ad_id);
                    if (referralMsg) sourceCampaignId = referralMsg.referral.ad_id;

                    // Resolve the specific ad account for this ad if possible
                    if (sourceCampaignId && adToAccountMap[sourceCampaignId]) {
                        finalAccountId = adToAccountMap[sourceCampaignId];
                    }

                    // Identify latest Page responder (staff)
                    const pageMsgs = msgData.data.filter((m: any) => m.from.id === pageId);
                    if (pageMsgs.length > 0) {
                        lastStaffName = pageMsgs[0].from.name;
                    }
                }

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
                    console.error(`[FB-Sync-Leads] Error upserting lead:`, leadError);
                    continue;
                }
                leadCount++;

                // 7. Upsert Messages
                if (msgData.data) {
                    const messages = msgData.data.map((m: any) => ({
                        lead_id: lead.id,
                        fb_message_id: m.id,
                        sender_id: m.from.id,
                        sender_name: m.from.name,
                        message_content: m.message,
                        sent_at: m.created_time,
                        is_from_customer: m.from.id !== pageId
                    }));

                    const { error: msgError } = await supabase.from("lead_messages").upsert(messages, { onConflict: "fb_message_id" });
                    if (!msgError) msgCount += messages.length;
                }
            }
        }

        return jsonResponse({
            success: true,
            result: {
                pagesSynced: pages.length,
                leadsSynced: leadCount,
                messagesSynced: msgCount,
                errors: errors.length > 0 ? errors : undefined
            }
        });

    } catch (err: any) {
        console.error(`[FB-Sync-Leads] Fatal Error:`, err);
        return jsonResponse({ success: false, error: err.message }, 500);
    }
});
