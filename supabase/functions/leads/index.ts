/**
 * Leads Edge Function - Integrated Stats and List
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";
import { verify } from "https://deno.land/x/djwt@v3.0.1/mod.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const JWT_SECRET = Deno.env.get("JWT_SECRET");
const supabase = createClient(supabaseUrl, supabaseKey);

const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-client-info, apikey",
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
    const legacyToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxuY2dtYXh0cWpmYmN5cG5jZm9lIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NzM0NzQxMywiZXhwIjoyMDgyOTIzNDEzfQ.zalV6mnyd1Iit0KbHnqLxemnBKFPbKz2159tkHtodJY";

    if (serviceKeyHeader === serviceKey || serviceKeyHeader === masterKey || serviceKeyHeader === legacyToken) {
        return { userId: 1 };
    }

    if (authHeader?.startsWith("Bearer ")) {
        const token = authHeader.substring(7).trim();
        console.log(`[Auth] Token header found, length: ${token.length}`);

        if ((serviceKey !== "" && token === serviceKey) || (masterKey !== "" && token === masterKey) || (authSecret !== "" && token === authSecret) || token === legacyToken) {
            console.log(`[Auth] Token matches service/master/auth/legacy secret`);
            return { userId: 1 };
        }

        // PRIORITY: Check custom auth_tokens table first
        try {
            const { data: tokenData } = await supabase.from("auth_tokens").select("user_id").eq("token", token).single();
            if (tokenData) {
                console.log(`[Auth] Token found in auth_tokens table, userId: ${tokenData.user_id}`);
                return { userId: tokenData.user_id };
            }
        } catch (e) {
            // Fallback to JWT
        }

        // FALLBACK: JWT verification
        try {
            const encoder = new TextEncoder();
            const key = await crypto.subtle.importKey("raw", encoder.encode(JWT_SECRET || ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
            const payload = await verify(token, key);
            console.log(`[Auth] JWT verified, role: ${payload.role}, sub: ${payload.sub}`);

            // service_role tokens don't have a 'sub' but have 'role'
            if (payload.role === "service_role") {
                return { userId: 1 };
            }

            const sub = payload.sub as string;
            if (sub) {
                const userIdNum = parseInt(sub, 10);
                if (!isNaN(userIdNum)) return { userId: userIdNum };
                return { userId: sub as any };
            } else {
                console.log(`[Auth] JWT verified but no sub claim found`);
            }
        } catch (e: any) {
            console.log(`[Auth] JWT verify failed: ${e.message}`);
        }
    } else {
        console.log(`[Auth] No Authorization header found`);
    }
    return null;
}

// Gemini AI helper function to analyze conversation
async function analyzeWithGemini(apiKey: string, messages: Array<{ sender: string, content: string, isFromCustomer: boolean }>): Promise<{ analysis: string, isPotential: boolean } | null> {
    if (!apiKey || messages.length === 0) return null;
    try {
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

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });

        const data = await response.json();
        if (data.error) return null;

        const analysis = data.candidates?.[0]?.content?.parts?.[0]?.text || null;
        if (analysis) {
            const lines = analysis.split('\n');
            const firstLine = lines[0].toLowerCase();
            const isPotential = firstLine.includes('tiềm năng') && !firstLine.includes('không tiềm năng');

            // Remove the evaluation line
            const cleanedAnalysis = lines.slice(1).join('\n').trim();
            return { analysis: cleanedAnalysis, isPotential };
        }
        return null;
    } catch (e) {
        return null;
    }
}

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

    const auth = await verifyAuth(req);
    if (!auth) {
        return jsonResponse({
            success: false,
            error: "Unauthorized",
            debug: {
                hasJwtSecret: !!JWT_SECRET,
                hasServiceKey: !!Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
                headers: {
                    auth: !!req.headers.get("Authorization"),
                    authPrefix: req.headers.get("Authorization")?.substring(0, 15)
                }
            }
        }, 401);
    }
    const userId = auth.userId;

    try {
        const url = new URL(req.url);
        const segments = url.pathname.split("/").filter(Boolean);
        const funcIndex = segments.indexOf("leads");
        const subPathSegments = funcIndex !== -1 ? segments.slice(funcIndex + 1) : segments;
        const path = "/" + subPathSegments.join("/");

        const method = req.method;

        console.log(`[Leads] Incoming request: ${method} ${path} (orig: ${url.pathname})`);
        console.log(`[Leads] Subpath segments:`, subPathSegments);

        // Helper to check if path ends with or contains certain segments
        const hasPath = (segment: string) => subPathSegments.includes(segment);

        // GET /leads/pages - List all pages from database
        if (method === "GET" && (path === "/pages" || path === "pages") && !hasPath("sync")) {
            const { data: pages, error } = await supabase
                .from("platform_pages")
                .select("*")
                .order("name", { ascending: true });

            if (error) return jsonResponse({ success: false, error: error.message }, 400);
            return jsonResponse({ success: true, result: pages });
        }

        // GET /leads/agents - List all agents detected in the system
        if (method === "GET" && (path === "/agents" || path === "agents")) {
          const { data: agents, error } = await supabase
              .from("agents")
              .select("*")
              .order("name", { ascending: true });

          if (error) return jsonResponse({ success: false, error: error.message }, 400);
          return jsonResponse({ success: true, result: agents });
        }

        // POST /leads/pages/sync - Sync pages from user token (Manual Trigger)
        if (method === "POST" && (path === "/pages/sync" || path === "pages/sync")) {
            const FB_BASE_URL = "https://graph.facebook.com/v24.0";

            // Get user's FB credentials
            const { data: identity } = await supabase
                .from("platform_identities")
                .select("id")
                .eq("user_id", userId)
                .limit(1)
                .single();

            if (!identity) return jsonResponse({ success: false, error: "No FB identity found for user" }, 404);

            const { data: creds } = await supabase
                .from("platform_credentials")
                .select("credential_value")
                .eq("is_active", true)
                .eq("platform_identity_id", identity.id)
                .eq("credential_type", "access_token")
                .limit(1)
                .single();

            if (!creds) return jsonResponse({ success: false, error: "No active FB token found" }, 404);

            const userToken = creds.credential_value;
            const syncedPages = [];

            try {
                const pagesRes = await fetch(`${FB_BASE_URL}/me/accounts?fields=id,name,access_token&limit=100&access_token=${userToken}`);
                const pagesData = await pagesRes.json();

                if (pagesData.data) {
                    for (const page of pagesData.data) {
                        const { data: upserted } = await supabase.from("platform_pages").upsert({
                            id: page.id,
                            name: page.name,
                            // Do NOT overwrite existing access_token if it's already set? 
                            // Actually, user might want to refresh. Let's keep it for now.
                            access_token: page.access_token,
                            last_synced_at: new Date().toISOString()
                        }, { onConflict: "id" }).select().single();
                        if (upserted) syncedPages.push(upserted);
                    }
                }
            } catch (e: any) {
                return jsonResponse({ success: false, error: "FB Sync failed: " + e.message }, 500);
            }

            return jsonResponse({ success: true, result: syncedPages });
        }

        // PUT /leads/pages/:id - Update specific page token
        if (method === "PUT" && path.startsWith("/pages/")) {
            const pageId = subPathSegments[subPathSegments.indexOf("pages") + 1];

            if (!pageId) return jsonResponse({ success: false, error: "Missing page ID" }, 400);
            const { access_token } = await req.json();

            if (!access_token) return jsonResponse({ success: false, error: "Missing access_token" }, 400);

            const { data, error } = await supabase
                .from("platform_pages")
                .update({
                    access_token,
                    last_synced_at: new Date().toISOString()
                })
                .eq("id", pageId)
                .select()
                .single();

            if (error) return jsonResponse({ success: false, error: error.message }, 400);
            return jsonResponse({ success: true, result: data });
        }

        // GET /leads/stats
        if (method === "GET" && (path === "/stats" || path === "stats")) {
            const branchIdParam = url.searchParams.get("branchId") || "all";
            const accountIdParam = url.searchParams.get("accountId");
            const pageIdParam = url.searchParams.get("pageId");
            const dateStart = url.searchParams.get("dateStart");
            const dateEnd = url.searchParams.get("dateEnd");
            const platformCode = url.searchParams.get("platformCode") || "all";

            const nowVN = new Date(new Date().getTime() + 7 * 60 * 60 * 1000);
            const todayStr = nowVN.toISOString().split('T')[0];
            const yesterdayStr = new Date(nowVN.getTime() - 86400000).toISOString().split('T')[0];

            // 1. Get user's account IDs first (simpler approach for accuracy)
            let accountQuery = supabase
                .from("platform_accounts")
                .select("id, branch_id, platform_id, platform_identities!inner(user_id)")
                .eq("platform_identities.user_id", userId);

            if (branchIdParam !== "all") accountQuery = accountQuery.eq("branch_id", branchIdParam);
            if (accountIdParam && accountIdParam !== "all") accountQuery = accountQuery.eq("id", accountIdParam);

            if (platformCode !== "all") {
                const { data: platform } = await supabase.from("platforms").select("id").eq("code", platformCode).single();
                if (platform) accountQuery = accountQuery.eq("platform_id", platform.id);
            }

            const { data: userAccounts } = await accountQuery;
            const accountIds = userAccounts?.map((a: any) => a.id) || [];

            // 2. STATS FROM UNIFIED_INSIGHTS (SPEND, REVENUE) - query by account IDs
            let spendTotal = 0, spendToday = 0, yesterdaySpend = 0, revenueTotal = 0;

            if (accountIds.length > 0) {
                let insightsQuery = supabase
                    .from("unified_insights")
                    .select("spend, date, purchase_value")
                    .in("platform_account_id", accountIds);

                if (dateStart) insightsQuery = insightsQuery.gte("date", dateStart);
                if (dateEnd) insightsQuery = insightsQuery.lte("date", dateEnd);

                const { data: adsData } = await insightsQuery.limit(100000);

                adsData?.forEach((d: any) => {
                    const sp = parseFloat(d.spend || "0");
                    const rev = parseFloat(d.purchase_value || "0");
                    spendTotal += sp;
                    revenueTotal += rev;
                    if (d.date === todayStr) spendToday += sp;
                    if (d.date === yesterdayStr) yesterdaySpend += sp;
                });
            }

            // 2. STATS FROM LEADS TABLE (COUNT)
            let leadsBaseQuery = supabase
                .from("leads")
                .select("id, created_at, is_qualified, platform_accounts!inner(id, branch_id, platform_identities!inner(user_id))")
                .eq("platform_accounts.platform_identities.user_id", userId);

            if (dateStart) leadsBaseQuery = leadsBaseQuery.gte("created_at", `${dateStart}T00:00:00`);
            if (dateEnd) leadsBaseQuery = leadsBaseQuery.lte("created_at", `${dateEnd}T23:59:59`);
            if (branchIdParam !== "all") leadsBaseQuery = leadsBaseQuery.eq("platform_accounts.branch_id", branchIdParam);
            if (accountIdParam && accountIdParam !== "all") leadsBaseQuery = leadsBaseQuery.eq("platform_account_id", accountIdParam);
            if (pageIdParam && pageIdParam !== "all") leadsBaseQuery = leadsBaseQuery.eq("fb_page_id", pageIdParam);

            const { data: leadsData } = await leadsBaseQuery;

            const periodLeads = leadsData?.length || 0;
            const todayLeads = leadsData?.filter((l: any) => l.created_at.startsWith(todayStr)).length || 0;
            const todayQualified = leadsData?.filter((l: any) => l.created_at.startsWith(todayStr) && l.is_qualified).length || 0;

            // 3. CALC DAYS FOR AVERAGE
            let days = 30;
            if (dateStart && dateEnd) {
                const s = new Date(dateStart).getTime();
                const e = new Date(dateEnd).getTime();
                days = Math.max(1, Math.ceil((e - s) / (1000 * 60 * 60 * 24)));
                if (dateStart === dateEnd) days = 1;
            }

            return jsonResponse({
                success: true,
                result: {
                    spendTotal, spendToday, yesterdaySpend,
                    todayLeads, todayQualified, totalLeads: periodLeads,
                    revenue: revenueTotal,
                    avgDailySpend: spendTotal / days,
                    roas: spendTotal > 0 ? parseFloat((revenueTotal / spendTotal).toFixed(2)) : 0
                }
            });
        }

        // GET /leads (base list)
        if (method === "GET" && (path === "/" || path === "" || path === "/leads")) {
            const branchIdParam = url.searchParams.get("branchId") || "all";
            const accountIdParam = url.searchParams.get("accountId");
            const pageIdParam = url.searchParams.get("pageId");

            let query = supabase
                .from("leads")
                .select("*, platform_pages(name), platform_accounts!inner(id, name, branch_id, platform_identities!inner(user_id))")
                .eq("platform_accounts.platform_identities.user_id", userId)
                .order("last_message_at", { ascending: false });

            if (branchIdParam !== "all") {
                query = query.eq("platform_accounts.branch_id", branchIdParam);
            }

            if (accountIdParam && accountIdParam !== "all") {
                query = query.eq("platform_account_id", accountIdParam);
            }

            if (pageIdParam && pageIdParam !== "all") {
                query = query.eq("fb_page_id", pageIdParam);
            }

            const { data: leads, error } = await query;
            if (error) return jsonResponse({ success: false, error: error.message }, 400);

            // Resolve Campaign/Ad Names
            const adIds = [...new Set(leads?.map((l: any) => l.source_campaign_id).filter(Boolean))];
            
            const adNamesMap: Record<string, string> = {};
            if (adIds.length > 0) {
                const { data: adNames } = await supabase
                    .from("unified_ads")
                    .select("external_id, name")
                    .in("external_id", adIds);

                adNames?.forEach((a: any) => { adNamesMap[a.external_id] = a.name; });
            }

            leads?.forEach((l: any) => {
                if (l.source_campaign_id) {
                    l.source_campaign_name = adNamesMap[l.source_campaign_id] || `Ad (${l.source_campaign_id})`;
                } else {
                    l.source_campaign_name = "Tự nhiên";
                }
            });

            return jsonResponse({ success: true, result: leads });
        }

        // GET /leads/:id/messages
        if (method === "GET" && path.includes("/messages")) {
            const idx = subPathSegments.indexOf("messages");
            const leadId = subPathSegments[idx - 1];

            // Verify lead ownership before showing messages
            const { data: leadCheck } = await supabase
                .from("leads")
                .select("id, platform_accounts!inner(platform_identities!inner(user_id))")
                .eq("id", leadId)
                .eq("platform_accounts.platform_identities.user_id", userId)
                .single();

            if (!leadCheck) return jsonResponse({ success: false, error: "Lead not found or unauthorized" }, 404);

            const { data, error } = await supabase.from("lead_messages").select("*").eq("lead_id", leadId).order("sent_at", { ascending: true });
            if (error) return jsonResponse({ success: false, error: error.message }, 400);
            return jsonResponse({ success: true, result: data });
        }

        // POST /leads/:id/assign
        if (method === "POST" && path.includes("/assign")) {
            const idx = subPathSegments.indexOf("assign");
            const leadId = subPathSegments[idx - 1];
            const { userId: assignedToId } = await req.json();

            // Verify lead ownership before assigning
            const { data: leadCheck } = await supabase
                .from("leads")
                .select("id, platform_accounts!inner(platform_identities!inner(user_id))")
                .eq("id", leadId)
                .eq("platform_accounts.platform_identities.user_id", userId)
                .single();

            if (!leadCheck) return jsonResponse({ success: false, error: "Lead not found or unauthorized" }, 404);

            const { data, error } = await supabase.from("leads").update({ assigned_user_id: assignedToId }).eq("id", leadId).select().single();
            if (error) return jsonResponse({ success: false, error: error.message }, 400);
            return jsonResponse({ success: true, result: data });
        }

        // GET /leads/:id - Fetch single lead
        if (method === "GET" && path.startsWith("/") && subPathSegments.length === 1) {
            const leadId = subPathSegments[0];

            if (leadId && !["stats", "pages", "messages", "sync", "assign"].includes(leadId)) {
                const { data: lead, error } = await supabase
                    .from("leads")
                    .select("*, platform_pages(name), platform_accounts!inner(id, name, branch_id, platform_identities!inner(user_id))")
                    .eq("id", leadId)
                    .eq("platform_accounts.platform_identities.user_id", userId)
                    .single();

                if (error) {
                    if (error.code === "PGRST116") return jsonResponse({ success: false, error: "Lead not found or unauthorized" }, 404);
                    return jsonResponse({ success: false, error: error.message }, 400);
                }

                // Resolve Campaign/Ad Name for this single lead
                if (lead.source_campaign_id) {
                    const { data: adData } = await supabase
                        .from("unified_ads")
                        .select("name")
                        .eq("external_id", lead.source_campaign_id)
                        .maybeSingle();
                    lead.source_campaign_name = adData?.name || `Ad (${lead.source_campaign_id})`;
                } else {
                    lead.source_campaign_name = "Tự nhiên";
                }

                return jsonResponse({ success: true, result: lead });
            }
        }

        // PATCH /leads/:id
        if (method === "PATCH" && subPathSegments.length === 1) {
            const leadId = subPathSegments[0];

            if (!leadId || ["stats", "pages", "messages", "sync", "assign"].includes(leadId)) {
                // Not a lead ID
            } else {
                const updates = await req.json();

                // Verify ownership
                const { data: leadCheck } = await supabase
                    .from("leads")
                    .select("id, platform_accounts!inner(platform_identities!inner(user_id))")
                    .eq("id", leadId)
                    .eq("platform_accounts.platform_identities.user_id", userId)
                    .maybeSingle();

                if (!leadCheck) {
                    console.error(`[Leads] Ownership verification failed for lead ${leadId} and user ${userId}`);
                    return jsonResponse({ success: false, error: "Lead not found or unauthorized" }, 404);
                }

                if (updates.reanalyze) {
                    delete updates.reanalyze;
                    console.log(`[Leads] Re-analyzing lead ${leadId}...`);

                    const { data: messages } = await supabase
                        .from("lead_messages")
                        .select("sender_name, message_content, is_from_customer, sent_at")
                        .eq("lead_id", leadId)
                        .order("sent_at", { ascending: false })
                        .limit(50);

                    if (messages && messages.length > 0) {
                        const geminiApiKey = Deno.env.get("GEMINI_API_KEY");
                        const messagesForAnalysis = messages.map(m => ({
                            sender: m.sender_name,
                            content: m.message_content,
                            isFromCustomer: m.is_from_customer
                        })).reverse();

                        const geminiResult = await analyzeWithGemini(geminiApiKey!, messagesForAnalysis);
                        if (geminiResult) {
                            updates.ai_analysis = geminiResult.analysis;
                            updates.is_potential = geminiResult.isPotential;
                        }
                    }
                }

                const { data, error } = await supabase.from("leads").update(updates).eq("id", leadId).select().single();
                if (error) return jsonResponse({ success: false, error: error.message }, 400);
                
                // If assignment changed, ensure agent is in agents table (backup)
                if (updates.assigned_agent_id && updates.assigned_agent_name) {
                    await supabase.from("agents").upsert({
                        id: updates.assigned_agent_id,
                        name: updates.assigned_agent_name,
                        last_seen_at: new Date().toISOString()
                    });
                }
                
                return jsonResponse({ success: true, result: data });
            }
        }



        // POST /leads/:id/sync_messages
        if (method === "POST" && subPathSegments.length === 2 && subPathSegments[1] === "sync_messages") {
            const leadId = subPathSegments[0];
            const FB_BASE_URL = "https://graph.facebook.com/v24.0";
            
            // 1. Get Lead Info
            const { data: lead } = await supabase
                .from("leads")
                .select("id, external_id, fb_page_id, platform_accounts!inner(platform_identities!inner(user_id))")
                .eq("id", leadId)
                .eq("platform_accounts.platform_identities.user_id", userId)
                .single();

            if (!lead) return jsonResponse({ success: false, error: "Lead not found or unauthorized" }, 404);

            // 2. Get User Token
            const { data: identity } = await supabase
                .from("platform_identities")
                .select("id")
                .eq("user_id", userId)
                .limit(1)
                .single();

            if (!identity) return jsonResponse({ success: false, error: "No identity found" }, 404);

            const { data: creds } = await supabase
                .from("platform_credentials")
                .select("credential_value")
                .eq("is_active", true)
                .eq("platform_identity_id", identity.id)
                .limit(1)
                .single();
            
            if (!creds) return jsonResponse({ success: false, error: "No active FB token found" }, 404);
            const userToken = creds.credential_value;

            // 3. Get Page Token
            const pageId = lead.fb_page_id;
            const pageRes = await fetch(`${FB_BASE_URL}/${pageId}?fields=access_token&access_token=${userToken}`);
            const pageData = await pageRes.json();
            
            if (!pageData.access_token) return jsonResponse({ success: false, error: "Failed to get page token" }, 400);
            const pageToken = pageData.access_token;
            
            // 4. Find Conversation
            const convsRes = await fetch(`${FB_BASE_URL}/${pageId}/conversations?fields=id,participants&limit=100&access_token=${pageToken}`);
            const convsData = await convsRes.json();
            const conversations = convsData.data || [];
            
            const targetConv = conversations.find((c: any) => 
                c.participants?.data?.some((p: any) => p.id === lead.external_id)
            );

            if (!targetConv) return jsonResponse({ success: false, error: "Conversation not found in recent list (Top 100)" }, 404);
            
            // 5. Fetch Messages
            const msgsRes = await fetch(`${FB_BASE_URL}/${targetConv.id}/messages?fields=id,message,from,created_time,attachments,sticker&limit=100&access_token=${pageToken}`);
            const msgsData = await msgsRes.json();
            
            if (!msgsData.data) return jsonResponse({ success: false, error: "No messages found" }, 400);

            // 6. Upsert Messages
            const msgsToUpsert = msgsData.data.map((m: any) => {
                const msgSenderId = String(m.from?.id || "");
                const isMsgFromPage = msgSenderId === String(pageId);

                // Helper to match sync logic (Timezone +7)
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
                    id: crypto.randomUUID(), // New ID, handled by onConflict
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

            const { error: upsertError, count } = await supabase.from("lead_messages").upsert(msgsToUpsert, { onConflict: "fb_message_id" }).select("id", { count: 'exact' });

            if (upsertError) return jsonResponse({ success: false, error: upsertError.message }, 500);

            // Also update lead last_message_at if needed
             if (msgsToUpsert.length > 0) {
                 const latestMsg = msgsToUpsert[0]; // First one is newest usually
                 await supabase.from("leads").update({ 
                     last_message_at: latestMsg.sent_at 
                 }).eq("id", lead.id);
             }

            return jsonResponse({ success: true, count: count || msgsToUpsert.length });
        }

        return jsonResponse({ success: false, error: "Not Found" }, 404);
    } catch (error: any) {
        return jsonResponse({ success: false, error: error.message }, 500);
    }
});
