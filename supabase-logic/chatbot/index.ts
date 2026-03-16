/**
 * Chatbot Admin CRUD API
 * GET/POST /chatbot/config — chatbot config (enabled, test_mode, test_psids)
 * GET/POST/DELETE /chatbot/flows — CRUD flow nodes
 * POST /chatbot/test — test send welcome message
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";
import { verify } from "https://deno.land/x/djwt@v3.0.1/mod.ts";
import { AwsClient } from "https://esm.sh/aws4fetch@1.0.20";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const JWT_SECRET = Deno.env.get("JWT_SECRET") || "your-secret-key";
const supabase = createClient(supabaseUrl, supabaseKey);

const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-client-info, apikey",
};

const jsonResponse = (data: any, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: corsHeaders });

// CRITICAL: DO NOT REMOVE THIS AUTH LOGIC.
async function verifyAuth(req: Request) {
    const authHeader = req.headers.get("Authorization");
    const serviceKeyHeader = req.headers.get("x-service-key") || req.headers.get("x-master-key");
    const masterKey = Deno.env.get("MASTER_KEY") || "";
    const authSecret = Deno.env.get("AUTH_SECRET") || "";

    if (serviceKeyHeader === supabaseKey || serviceKeyHeader === masterKey) return { userId: 1 };

    if (authHeader?.startsWith("Bearer ")) {
        const token = authHeader.substring(7).trim();
        if ((supabaseKey && token === supabaseKey) || (masterKey && token === masterKey) || (authSecret && token === authSecret)) return { userId: 1 };

        try {
            const { data: tokenData } = await supabase.from("auth_tokens").select("user_id").eq("token", token).single();
            if (tokenData) return { userId: tokenData.user_id };
        } catch { }

        try {
            const encoder = new TextEncoder();
            const key = await crypto.subtle.importKey("raw", encoder.encode(JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
            const payload = await verify(token, key);
            return { userId: parseInt(payload.sub as string, 10) };
        } catch { }
    }
    return null;
}

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

    const auth = await verifyAuth(req);
    if (!auth) return jsonResponse({ success: false, error: "Unauthorized" }, 401);
    const userId = auth.userId;

    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter(Boolean);
    // Find "chatbot" in path and get sub-path
    const chatbotIdx = segments.indexOf("chatbot");
    const subPath = chatbotIdx >= 0 ? segments.slice(chatbotIdx + 1) : segments;
    const resource = subPath[0] || "";
    const resourceId = subPath[1];
    const method = req.method;

    try {
        console.log(`[Chatbot] ${method} /${resource}/${resourceId || ""} user=${userId}`);

        // ==================== CONFIG ====================
        if (resource === "config") {
            if (method === "GET") {
                const { data, error } = await supabase
                    .from("chatbot_config")
                    .select("*")
                    .eq("user_id", userId)
                    .maybeSingle();

                if (error && error.code !== "PGRST116") throw error;

                // Return default config if none exists
                const config = data || {
                    id: null,
                    user_id: userId,
                    is_enabled: false,
                    test_mode: true,
                    test_psids: ["7302212653229178"],
                    page_id: null
                };

                return jsonResponse({ success: true, result: config });
            }

            if (method === "POST") {
                const body = await req.json();
                const { is_enabled, test_mode, test_psids, page_id } = body;

                const { data, error } = await supabase
                    .from("chatbot_config")
                    .upsert({
                        user_id: userId,
                        is_enabled: is_enabled ?? false,
                        test_mode: test_mode ?? true,
                        test_psids: test_psids || ["7302212653229178"],
                        page_id: page_id || null,
                        updated_at: new Date().toISOString()
                    }, { onConflict: "user_id" })
                    .select()
                    .single();

                if (error) throw error;
                return jsonResponse({ success: true, result: data });
            }
        }

        // ==================== ADS ====================
        if (resource === "ads") {
            if (method === "GET") {
                // Fetch ads linked to this user's accounts
                const { data: accounts } = await supabase
                    .from("platform_accounts")
                    .select("id, platform_identities!inner(user_id)")
                    .eq("platform_identities.user_id", userId);

                const accountIds = accounts?.map(a => a.id) || [];

                if (accountIds.length === 0) {
                    return jsonResponse({ success: true, result: [] });
                }

                const { data, error } = await supabase
                    .from("unified_ads")
                    .select(`
                        id, 
                        name, 
                        external_id,
                        status,
                        platform_account_id,
                        creative:unified_ad_creatives (
                            thumbnail_url
                        ),
                        group:unified_ad_groups (
                            name,
                            campaign:unified_campaigns (
                                name
                            )
                        )
                    `)
                    .in("platform_account_id", accountIds)
                    .eq("status", "ACTIVE")
                    .order("created_at", { ascending: false })
                    .limit(200);

                if (error) throw error;

                // Flatten the results for the frontend
                const ads = (data || []).map((ad: any) => {
                    const creative = Array.isArray(ad.creative) ? ad.creative[0] : ad.creative;
                    const group = Array.isArray(ad.group) ? ad.group[0] : ad.group;
                    const campaign = Array.isArray(group?.campaign) ? group.campaign[0] : group?.campaign;

                    return {
                        id: ad.external_id, // Use external_id as the key for linking
                        name: ad.name,
                        status: ad.status,
                        creative_thumbnail: creative?.thumbnail_url || null,
                        campaign_name: campaign?.name || group?.name || 'Khác'
                    };
                });

                return jsonResponse({ success: true, result: ads });
            }
        }

        // ==================== FLOWS ====================
        if (resource === "flows") {
            if (method === "GET") {
                const { data, error } = await supabase
                    .from("chatbot_flows")
                    .select("*")
                    .eq("user_id", userId)
                    .order("sort_order", { ascending: true });

                if (error) throw error;
                return jsonResponse({ success: true, result: data || [] });
            }

            if (method === "POST") {
                const body = await req.json();
                const { id, linked_ad_ids, flow_key, display_name, message_type, content, trigger_payloads, trigger_keywords, is_entry_point, is_daily_welcome, sort_order, is_active } = body;

                const flowData: any = {
                    user_id: userId,
                    linked_ad_ids: linked_ad_ids || [],
                    flow_key,
                    display_name,
                    message_type,
                    content: typeof content === "string" ? JSON.parse(content) : content,
                    trigger_payloads: trigger_payloads || [],
                    trigger_keywords: trigger_keywords || [],
                    is_entry_point: is_entry_point ?? false,
                    is_daily_welcome: is_daily_welcome ?? false,
                    sort_order: sort_order ?? 0,
                    is_active: is_active ?? true,
                    updated_at: new Date().toISOString()
                };

                let result;
                if (id) {
                    // Update existing
                    const { data, error } = await supabase
                        .from("chatbot_flows")
                        .update(flowData)
                        .eq("id", id)
                        .eq("user_id", userId)
                        .select()
                        .single();
                    if (error) throw error;
                    result = data;
                } else {
                    // Insert new (upsert by user_id + flow_key)
                    const { data, error } = await supabase
                        .from("chatbot_flows")
                        .upsert(flowData, { onConflict: "user_id,flow_key" })
                        .select()
                        .single();
                    if (error) throw error;
                    result = data;
                }

                return jsonResponse({ success: true, result });
            }

            if (method === "DELETE" && resourceId) {
                const { error } = await supabase
                    .from("chatbot_flows")
                    .delete()
                    .eq("id", parseInt(resourceId))
                    .eq("user_id", userId);

                if (error) throw error;
                return jsonResponse({ success: true });
            }
        }

        // ==================== SESSIONS ====================
        if (resource === "sessions") {
            // Look up user's page_id from config for isolation
            const { data: userConfig } = await supabase
                .from("chatbot_config")
                .select("page_id")
                .eq("user_id", userId)
                .maybeSingle();

            const userPageId = userConfig?.page_id;

            if (method === "GET") {
                let query = supabase
                    .from("chatbot_sessions")
                    .select("*")
                    .order("last_interaction_at", { ascending: false })
                    .limit(50);

                // Filter by user's page_id to ensure isolation
                if (userPageId) {
                    query = query.eq("page_id", userPageId);
                } else {
                    // No page configured — return empty
                    return jsonResponse({ success: true, result: [] });
                }

                const { data, error } = await query;
                if (error) throw error;
                return jsonResponse({ success: true, result: data || [] });
            }

            // Reset a session (reactivate bot for a customer)
            if (method === "DELETE" && resourceId) {
                // Ownership check: only delete sessions belonging to user's page
                if (!userPageId) {
                    return jsonResponse({ success: false, error: "No page configured" }, 400);
                }

                const { error } = await supabase
                    .from("chatbot_sessions")
                    .delete()
                    .eq("id", resourceId)
                    .eq("page_id", userPageId);

                if (error) throw error;
                return jsonResponse({ success: true });
            }
        }

        // ==================== TEST ====================
        if (resource === "test" && method === "POST") {
            const body = await req.json();
            let { psid, pageId } = body;

            if (!psid) return jsonResponse({ success: false, error: "Missing psid" }, 400);

            // Auto-detect pageId: first check which page this PSID belongs to via leads
            if (!pageId) {
                // 1. Check user's chatbot_config
                const { data: userConfig } = await supabase
                    .from("chatbot_config")
                    .select("page_id")
                    .eq("user_id", userId)
                    .maybeSingle();
                
                if (userConfig?.page_id) {
                    pageId = userConfig.page_id;
                    console.log(`[Chatbot] Test: found pageId=${pageId} from chatbot_config`);
                } else {
                    // 2. Check which page this PSID belongs to via leads
                    const { data: leadMatch } = await supabase
                        .from("leads")
                        .select("fb_page_id")
                        .eq("external_id", psid)
                        .not("fb_page_id", "is", null)
                        .limit(1)
                        .maybeSingle();

                    if (leadMatch?.fb_page_id) {
                        pageId = leadMatch.fb_page_id;
                        console.log(`[Chatbot] Test: found pageId=${pageId} from leads table`);
                    } else {
                        // 3. Fallback: most recent lead for this user
                        const { data: recentLead } = await supabase
                            .from("leads")
                            .select("fb_page_id")
                            .not("fb_page_id", "is", null)
                            .order("created_at", { ascending: false })
                            .limit(1)
                            .maybeSingle();
                        
                        if (recentLead?.fb_page_id) {
                            pageId = recentLead.fb_page_id;
                            console.log(`[Chatbot] Test: fallback pageId=${pageId} from recent leads`);
                        } else {
                            // 4. Final fallback: first page with a token in platform_pages
                            const { data: firstPage } = await supabase
                                .from("platform_pages")
                                .select("id")
                                .not("access_token", "is", null)
                                .limit(1)
                                .maybeSingle();
                            pageId = firstPage?.id || null;
                            console.log(`[Chatbot] Test: absolute fallback pageId=${pageId} from platform_pages`);
                        }
                    }
                }
            }

            if (!pageId) {
                return jsonResponse({ success: false, error: "No page with access token found" }, 400);
            }

            // Call fb-chatbot with isNewLead + isTestMode to bypass config check
            const res = await fetch(`${supabaseUrl}/functions/v1/fb-chatbot`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${supabaseKey}`
                },
                body: JSON.stringify({
                    pageId,
                    customerId: psid,
                    isNewLead: true,
                    isTestMode: true
                })
            });

            const result = await res.json();
            console.log(`[Chatbot] Test result:`, JSON.stringify(result));
            return jsonResponse({ success: true, result });
        }

        // ==================== UPLOAD IMAGE (Cloudflare R2) ====================
        if (resource === "upload-image" && method === "POST") {
            try {
                const formData = await req.formData();
                const file = formData.get("file");
                if (!file || !(file instanceof File) || !file.type.startsWith("image/")) {
                    return jsonResponse({ success: false, error: "No valid image file" }, 400);
                }
                if (file.size > 5 * 1024 * 1024) {
                    return jsonResponse({ success: false, error: "File too large (max 5MB)" }, 400);
                }

                const bytes = new Uint8Array(await file.arrayBuffer());
                const ext = file.type.split("/")[1] || "jpg";
                const fileName = `chatbot/${userId}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;

                const R2_ACCOUNT_ID = Deno.env.get("R2_ACCOUNT_ID") || "";
                const R2_ACCESS_KEY_ID = Deno.env.get("R2_ACCESS_KEY_ID") || "";
                const R2_SECRET_ACCESS_KEY = Deno.env.get("R2_SECRET_ACCESS_KEY") || "";
                const R2_BUCKET_NAME = Deno.env.get("R2_BUCKET_NAME") || "";
                const R2_PUBLIC_URL = Deno.env.get("R2_PUBLIC_URL") || "";

                if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME || !R2_PUBLIC_URL) {
                    return jsonResponse({ success: false, error: "R2 not configured" }, 500);
                }

                console.log(`[Chatbot] Upload to R2: ${fileName} (${bytes.length} bytes)`);

                const r2 = new AwsClient({
                    accessKeyId: R2_ACCESS_KEY_ID,
                    secretAccessKey: R2_SECRET_ACCESS_KEY,
                });

                const r2Url = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET_NAME}/${fileName}`;
                const uploadRes = await r2.fetch(r2Url, {
                    method: "PUT",
                    headers: { "Content-Type": file.type },
                    body: bytes,
                });

                if (!uploadRes.ok) {
                    const errText = await uploadRes.text();
                    console.error("[Chatbot] R2 error:", uploadRes.status, errText);
                    return jsonResponse({ success: false, error: `R2 upload failed: ${uploadRes.status}` }, 500);
                }

                const publicUrl = `${R2_PUBLIC_URL}/${fileName}`;
                console.log(`[Chatbot] Uploaded to R2: ${publicUrl}`);
                return jsonResponse({ success: true, result: { url: publicUrl } });
            } catch (uploadErr: any) {
                console.error("[Chatbot] R2 Upload error:", uploadErr.message);
                return jsonResponse({ success: false, error: uploadErr.message }, 500);
            }
        }

        return jsonResponse({ success: false, error: "Not found" }, 404);

    } catch (err: any) {
        console.error("[Chatbot] Error:", err.message);
        return jsonResponse({ success: false, error: err.message }, 500);
    }
});
