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

const jsonResponse = (data: any, status = 200) => new Response(JSON.stringify(data), {
    status,
    headers: {
        ...corsHeaders,
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
    }
});

// Helper to get current time in Vietnam timezone (UTC+7)
function getNowVN(): Date {
    return new Date(Date.now() + 7 * 60 * 60 * 1000);
}

// Format a VN-adjusted Date to YYYY-MM-DD string (use getUTC* methods since we already added +7 hours)
function formatVNDate(date: Date): string {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

// Format a VN-adjusted Date to YYYY-MM-DD HH:mm:ss string
function formatVNTimestamp(date: Date): string {
    return `${formatVNDate(date)} ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}:${String(date.getUTCSeconds()).padStart(2, '0')}`;
}

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
async function analyzeWithGemini(apiKey: string, messages: Array<{ sender: string, content: string, isFromCustomer: boolean, timestamp?: string }>): Promise<{ analysis: string, isPotential: boolean } | null> {
    if (!apiKey || messages.length === 0) return null;
    try {
        const conversationText = messages.map(m => {
            const time = new Date(m.timestamp || "").toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
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

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[Leads] Gemini API error (${response.status}): ${errorText.substring(0, 200)}`);
            return null;
        }

        const data = await response.text();
        try {
            const jsonData = JSON.parse(data);
            if (jsonData.error) {
                console.error(`[Leads] Gemini returned error object:`, jsonData.error);
                return null;
            }
            const analysis = jsonData.candidates?.[0]?.content?.parts?.[0]?.text || null;
            if (analysis) {
                const lines = analysis.split('\n');
                const firstLine = lines[0].toLowerCase();
                const isPotential = firstLine.includes('tiềm năng') && !firstLine.includes('không tiềm năng');

                // Remove the evaluation line
                const cleanedAnalysis = lines.slice(1).join('\n').trim();
                return { analysis: cleanedAnalysis, isPotential };
            }
        } catch (parseError) {
            console.error(`[Leads] Failed to parse Gemini response as JSON. Status: ${response.status}. Body start: ${data.substring(0, 100)}`);
            return null;
        }
        return null;
    } catch (e: any) {
        console.error(`[Leads] analyzeWithGemini fatal error: ${e.message}`);
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

    const url = new URL(req.url);
    const method = req.method;
    const segments = url.pathname.split("/").filter(Boolean);
    const funcIndex = segments.indexOf("leads");
    const subPathSegments = funcIndex !== -1 ? segments.slice(funcIndex + 1) : segments;
    const path = "/" + subPathSegments.join("/");

    try {
        console.log(`[Leads] Processing ${method} ${path} for user ${userId}`);

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

            // Calculate VN timezone dates using helper functions
            const nowVN = getNowVN();
            const todayStr = formatVNDate(nowVN);
            const yesterdayVN = new Date(nowVN.getTime() - 86400000);
            const yesterdayStr = formatVNDate(yesterdayVN);

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

            // 2. STATS FROM UNIFIED_INSIGHTS (SPEND, REVENUE, MESSAGING_NEW) - query by account IDs
            let spendTotal = 0, spendToday = 0, spendTodayRaw = 0, yesterdaySpend = 0, revenueTotal = 0, messagingNewFromAds = 0;

            if (accountIds.length > 0) {
                // Query for selected date range - include messaging_new for accurate lead count from Meta
                let insightsQuery = supabase
                    .from("unified_insights")
                    .select("spend, date, purchase_value, messaging_new")
                    .in("platform_account_id", accountIds);

                if (dateStart) insightsQuery = insightsQuery.gte("date", dateStart);
                if (dateEnd) insightsQuery = insightsQuery.lte("date", dateEnd);

                const { data: adsData } = await insightsQuery.limit(100000);

                adsData?.forEach((d: any) => {
                    const spRaw = parseFloat(d.spend || "0");
                    const sp = spRaw * 1.1; // Add 10% tax for display
                    const rev = parseFloat(d.purchase_value || "0");
                    const msgNew = parseInt(d.messaging_new || "0", 10);
                    spendTotal += sp;
                    revenueTotal += rev;
                    messagingNewFromAds += msgNew;
                    if (d.date === todayStr) {
                        spendToday += sp;
                        spendTodayRaw += spRaw; // Without tax
                    }
                    if (d.date === yesterdayStr) yesterdaySpend += sp;
                });

                // ALWAYS query today's spend separately if today is not in the date range
                const isTodayInRange = (!dateStart || todayStr >= dateStart) && (!dateEnd || todayStr <= dateEnd);
                if (!isTodayInRange) {
                    const { data: todayData } = await supabase
                        .from("unified_insights")
                        .select("spend")
                        .in("platform_account_id", accountIds)
                        .eq("date", todayStr);
                    
                    todayData?.forEach((d: any) => {
                        const spRaw = parseFloat(d.spend || "0");
                        spendTodayRaw += spRaw; // Without tax
                        spendToday += spRaw * 1.1;
                    });
                }
            }

            // FETCH PARAMETERS: dateStart, dateEnd, startTime, endTime
            const startTime = url.searchParams.get("startTime") || "00:00:00";
            const endTime = url.searchParams.get("endTime") || "23:59:59";
            const rangeStart = dateStart ? `${dateStart} ${startTime}` : `${todayStr} 00:00:00`;
            const rangeEnd = dateEnd ? `${dateEnd} ${endTime}` : `${todayStr} 23:59:59`;

            // 1. STATS FROM LEADS TABLE (COUNT NEW CONTACTS)
            // Use accountIds fetched above to avoid complex join issues
            let leadsBaseQuery = supabase
                .from("leads")
                .select("id, first_contact_at, is_qualified, source_campaign_id, platform_data, metadata, platform_account_id")
                .in("platform_account_id", accountIds);

            if (pageIdParam && pageIdParam !== "all") leadsBaseQuery = leadsBaseQuery.eq("fb_page_id", pageIdParam);

            // Filter by FIRST contact in range
            leadsBaseQuery = leadsBaseQuery.gte("first_contact_at", rangeStart).lte("first_contact_at", rangeEnd);

            const { data: leadsData, error: leadsError } = await leadsBaseQuery;
            
            // NEW CONTACTS in range
            const rangeNewContacts = leadsData || [];
            const rangeNewTotal = rangeNewContacts.length;
            
            // AGGREGATION: Ad leads are those marked as qualified (attribute of ad interaction)
            const rangeNewAds = rangeNewContacts.filter((l: any) => l.source_campaign_id || l.is_qualified).length;

            const rangeNewOrganic = rangeNewTotal - rangeNewAds;
            
            // Debug info for the developer (can be seen in network tab)
            const statsDebug = {
                leadsCount: rangeNewTotal,
                leadsError: leadsError,
                range: { start: rangeStart, end: rangeEnd },
                userId,
                accountIdsCount: accountIds.length
            };

            // 2. UNIQUE MESSAGING CONTACTS in range (New + Old Leads who sent messages - used for "Total Messages")
            let msgQuery = supabase
                .from("lead_messages")
                .select("lead_id, leads!inner(platform_account_id, fb_page_id)")
                .in("leads.platform_account_id", accountIds)
                .eq("is_from_customer", true)
                .gte("sent_at", rangeStart)
                .lte("sent_at", rangeEnd);

            if (pageIdParam && pageIdParam !== "all") msgQuery = msgQuery.eq("leads.fb_page_id", pageIdParam);

            const { data: msgData } = await msgQuery;
            const uniqueLeadsInRange = new Set(msgData?.map((m: any) => m.lead_id)).size;

            // 4. CALC DAYS FOR AVERAGE
            let days = 30;
            const effectiveEndDate = dateEnd || todayStr;
            if (dateStart) {
                const s = new Date(dateStart).getTime();
                const e = new Date(effectiveEndDate).getTime();
                days = Math.max(1, Math.ceil((e - s) / (1000 * 60 * 60 * 24)) + 1);
                if (dateStart === effectiveEndDate) days = 1;
            }

            const result = {
                spendTotal, spendToday, spendTodayRaw, yesterdaySpend,
                todayLeads: rangeNewTotal,      // Base on rangeNewTotal: 47
                todayQualified: rangeNewAds,    // EXACT MATCH with list filter: 45
                todayNewOrganic: rangeNewOrganic, // 2
                todayMessagesCount: uniqueLeadsInRange, // 111 (New + Old)
                totalLeads: rangeNewTotal,
                totalQualified: rangeNewAds,
                revenue: revenueTotal,
                avgDailySpend: spendTotal / days,
                roas: spendTotal > 0 ? parseFloat((revenueTotal / spendTotal).toFixed(2)) : 0,
                debug: statsDebug
            };

                            console.log("[Leads-Stats] Final Result:", JSON.stringify(result));

            return jsonResponse({
                success: true,
                result: result
            });
        }

        // GET /leads (base list)
        if (method === "GET" && (path === "/" || path === "" || path === "/leads")) {
            const branchIdParam = url.searchParams.get("branchId") || "all";
            const accountIdParam = url.searchParams.get("accountId");
            const pageIdParam = url.searchParams.get("pageId");

            // Pagination params
            const page = parseInt(url.searchParams.get("page") || "1", 10);
            const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 200); // Max 200
            const offset = (page - 1) * limit;

            // Filter params
            const qualifiedParam = url.searchParams.get("qualified"); // "true" or "false"
            const potentialParam = url.searchParams.get("potential"); // "true" or "false" (AI evaluation)
            let isToday = url.searchParams.get("today") === "true";
            const qualifiedTodayParam = url.searchParams.get("qualifiedToday");
            const potentialTodayParam = url.searchParams.get("potentialToday");
            const userIdParam = url.searchParams.get("userId");
            const assignedIdParam = url.searchParams.get("assignedId"); // Filter by assigned_user_id

            // New: Granular Date/Time Filters
            const dateStart = url.searchParams.get("dateStart");
            const dateEnd = url.searchParams.get("dateEnd");
            const startTime = url.searchParams.get("startTime") || "00:00:00";
            const endTime = url.searchParams.get("endTime") || "23:59:59";
            
            // Calculate VN timezone dates
            const nowVN = getNowVN();
            const todayStr = formatVNDate(nowVN);
            
            const rangeStart = dateStart ? `${dateStart} ${startTime}` : `${todayStr} 00:00:00`;
            const rangeEnd = dateEnd ? `${dateEnd} ${endTime}` : `${todayStr} 23:59:59`;

            // Shorthand helpers
            if (qualifiedTodayParam === "true") {
                isToday = true;
            }
            if (potentialTodayParam === "true") {
                isToday = true;
            }

            // Determine which userId to use for filtering (param takes priority)
            const effectiveUserId = userIdParam ? parseInt(userIdParam, 10) : userId;

            // Build main query - OPTIMIZED: Only select needed fields to reduce egress
            let query = supabase
                .from("leads")
                .select(`
                    id, external_id, customer_name, customer_avatar, phone, 
                    first_contact_at, last_message_at, created_at, updated_at,
                    is_qualified, is_potential, is_manual_potential, is_read,
                    source_campaign_id, fb_page_id, platform_account_id,
                    assigned_user_id, assigned_agent_id, assigned_agent_name,
                    notes, platform_data,
                    platform_pages(name, avatar_url), 
                    platform_accounts!inner(id, name, branch_id, platform_identities!inner(user_id))
                `)
                .eq("platform_accounts.platform_identities.user_id", effectiveUserId)
                .order("last_message_at", { ascending: false, nullsFirst: false });

            // Base count query - using a simpler select
            let countQuery = supabase
                .from("leads")
                .select("id, platform_accounts!inner(platform_identities!inner(user_id))", { count: "exact", head: true })
                .eq("platform_accounts.platform_identities.user_id", effectiveUserId);

            if (branchIdParam !== "all") {
                query = query.eq("platform_accounts.branch_id", branchIdParam);
                countQuery = countQuery.eq("platform_accounts.branch_id", branchIdParam);
            }

            if (accountIdParam && accountIdParam !== "all") {
                query = query.eq("platform_account_id", accountIdParam);
                countQuery = countQuery.eq("platform_account_id", accountIdParam);
            }

            if (pageIdParam && pageIdParam !== "all") {
                query = query.eq("fb_page_id", pageIdParam);
                countQuery = countQuery.eq("fb_page_id", pageIdParam);
            }

            // Filter: by assigned_user_id
            if (assignedIdParam) {
                const assignedId = parseInt(assignedIdParam, 10);
                if (!isNaN(assignedId)) {
                    query = query.eq("assigned_user_id", assignedId);
                    countQuery = countQuery.eq("assigned_user_id", assignedId);
                }
            }

            // Filter: by Date/Time (Daily stats view)
            if (qualifiedTodayParam === "true") {
                query = query.eq("is_qualified", true).gte("last_message_at", rangeStart).lte("last_message_at", rangeEnd);
                countQuery = countQuery.eq("is_qualified", true).gte("last_message_at", rangeStart).lte("last_message_at", rangeEnd);
            } else if (potentialTodayParam === "true") {
                query = query.eq("is_potential", true).gte("last_message_at", rangeStart).lte("last_message_at", rangeEnd);
                countQuery = countQuery.eq("is_potential", true).gte("last_message_at", rangeStart).lte("last_message_at", rangeEnd);
            } else if (isToday) {
                // Return everyone active in range
                query = query.gte("last_message_at", rangeStart).lte("last_message_at", rangeEnd);
                countQuery = countQuery.gte("last_message_at", rangeStart).lte("last_message_at", rangeEnd);
            } else {
                if (dateStart) {
                    query = query.gte("first_contact_at", rangeStart);
                    countQuery = countQuery.gte("first_contact_at", rangeStart);
                }
                if (dateEnd) {
                    query = query.lte("first_contact_at", rangeEnd);
                    countQuery = countQuery.lte("first_contact_at", rangeEnd);
                }
            }

            // Filter: by qualified status (Manual override)
            if (qualifiedParam === "true") {
                query = query.eq("is_qualified", true);
                countQuery = countQuery.eq("is_qualified", true);
            } else if (qualifiedParam === "false") {
                query = query.eq("is_qualified", false);
                countQuery = countQuery.eq("is_qualified", false);
            }

            // Filter: by potential status (AI)
            if (potentialParam === "true") {
                query = query.eq("is_potential", true);
                countQuery = countQuery.eq("is_potential", true);
            } else if (potentialParam === "false") {
                query = query.eq("is_potential", false);
                countQuery = countQuery.eq("is_potential", false);
            }

            // Apply pagination
            query = query.range(offset, offset + limit - 1);

            // Execute both queries
            const [{ count: totalCount }, { data: leads, error }] = await Promise.all([
                countQuery,
                query
            ]);

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
                const isFromAd = !!l.source_campaign_id || !!l.is_qualified;

                if (l.source_campaign_id) {
                    l.source_campaign_name = adNamesMap[l.source_campaign_id] || `Quảng cáo (ID: ${l.source_campaign_id})`;
                } else if (isFromAd) {
                    const adTitle = l.metadata?.ad_title;
                    l.source_campaign_name = adTitle ? `Quảng cáo: ${adTitle}` : "Quảng cáo (Click từ Ad)";
                } else {
                    l.source_campaign_name = "Tự nhiên";
                }
            });

            // Return with pagination metadata
            const total = totalCount || 0;
            const totalPages = Math.ceil(total / limit);

            return jsonResponse({
                success: true,
                result: leads,
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages,
                    hasNextPage: page < totalPages,
                    hasPrevPage: page > 1
                }
            });
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

            // OPTIMIZED: Select specific columns instead of * to reduce egress
            const { data, error } = await supabase.from("lead_messages")
                .select("id, lead_id, fb_message_id, sender_id, sender_name, message_content, is_from_customer, sent_at, created_at, sticker, attachments, shares")
                .eq("lead_id", leadId)
                .order("sent_at", { ascending: true });
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
                // OPTIMIZED: Select specific columns for single lead view
                const { data: lead, error } = await supabase
                    .from("leads")
                    .select(`
                        id, external_id, customer_name, customer_avatar, phone,
                        first_contact_at, last_message_at, created_at, updated_at,
                        is_qualified, is_potential, is_manual_potential, is_read,
                        source_campaign_id, fb_page_id, platform_account_id,
                        assigned_user_id, assigned_agent_id, assigned_agent_name,
                        notes, platform_data, ai_analysis, metadata, last_analysis_at,
                        platform_pages(name, avatar_url), 
                        platform_accounts!inner(id, name, branch_id, platform_identities!inner(user_id))
                    `)
                    .eq("id", leadId)
                    .eq("platform_accounts.platform_identities.user_id", userId)
                    .single();

                if (error) {
                    if (error.code === "PGRST116") return jsonResponse({ success: false, error: "Lead not found or unauthorized" }, 404);
                    return jsonResponse({ success: false, error: error.message }, 400);
                }

                // Resolve Campaign/Ad Name for this single lead
                const hasAdSnippet = lead.platform_data?.snippet?.includes("trả lời một quảng cáo") ||
                    lead.platform_data?.snippet?.includes("quảng cáo");
                if (lead.source_campaign_id) {
                    const { data: adData } = await supabase
                        .from("unified_ads")
                        .select("name")
                        .eq("external_id", lead.source_campaign_id)
                        .maybeSingle();
                    lead.source_campaign_name = adData?.name || `Quảng cáo (ID: ${lead.source_campaign_id})`;
                } else if (hasAdSnippet || lead.is_qualified) {
                    lead.source_campaign_name = "Quảng cáo (Không rõ chiến dịch)";
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
                        // Get Gemini API key from users table for reliability
                        const { data: userData } = await supabase
                            .from("users")
                            .select("gemini_api_key")
                            .not("gemini_api_key", "is", null)
                            .limit(1)
                            .maybeSingle();

                        const geminiApiKey = userData?.gemini_api_key || null;
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
                if (!content && m.attachments?.data) content = "[Hình ảnh/File]";
                if (!content && m.sticker) content = "[Sticker]";
                if (!content) content = "[Media]";

                return {
                    id: crypto.randomUUID(), // New ID, handled by onConflict
                    lead_id: lead.id,
                    fb_message_id: m.id,
                    sender_id: msgSenderId,
                    sender_name: m.from?.name || (isMsgFromPage ? "Page" : "Customer"),
                    message_content: content.substring(0, 1000),
                    attachments: m.attachments?.data || null,
                    sticker: m.sticker || null,
                    shares: m.shares?.data || null,
                    sent_at: toVietnamTimestamp(m.created_time),
                    is_from_customer: !isMsgFromPage
                };
            });

            const { error: upsertError, count } = await supabase.from("lead_messages").upsert(msgsToUpsert, { onConflict: "fb_message_id" }).select("id", { count: 'exact' });

            if (upsertError) return jsonResponse({ success: false, error: upsertError.message }, 500);

            // 7. Update lead metadata with the latest message from the sync
            if (msgsToUpsert.length > 0) {
                // Find the latest message by sorting by sent_at
                const sortedMsgs = [...msgsToUpsert].sort((a, b) =>
                    new Date(b.sent_at).getTime() - new Date(a.sent_at).getTime()
                );
                const latestMsg = sortedMsgs[0];

                await supabase.from("leads").update({
                    last_message_at: latestMsg.sent_at,
                    is_read: !latestMsg.is_from_customer,
                    platform_data: {
                        ...(lead.platform_data || {}),
                        snippet: latestMsg.message_content.substring(0, 100)
                    }
                }).eq("id", lead.id);
            }

            return jsonResponse({ success: true, count: count || msgsToUpsert.length });
        }

        // POST /leads/reanalyze_all - Bulk re-analyze leads
        if (method === "POST" && path.includes("reanalyze_all")) {
            console.log(`[Leads] reanalyze_all match: ${path}`);

            const { data: userData } = await supabase
                .from("users")
                .select("gemini_api_key")
                .not("gemini_api_key", "is", null)
                .limit(1)
                .maybeSingle();

            const geminiApiKey = userData?.gemini_api_key;
            if (!geminiApiKey) return jsonResponse({ success: false, error: "AI key missing" }, 500);

            // Fetch leads needing analysis - Filter for old format
            const { data: leadsToAnalyze, error: leadsError } = await supabase
                .from("leads")
                .select("id")
                .not("last_message_at", "is", null)
                .or("ai_analysis.is.null,ai_analysis.not.ilike.Tổng điểm%")
                .order("last_message_at", { ascending: false })
                .limit(50);

            if (leadsError) return jsonResponse({ success: false, error: "DB Error: " + leadsError.message }, 400);

            console.log(`[Leads] Processing batch of ${leadsToAnalyze?.length || 0}`);
            const processedLeads = [];
            const startTime = Date.now();

            for (const lead of (leadsToAnalyze || [])) {
                // Graceful timeout check: stop if we've been running for > 45s
                if (Date.now() - startTime > 45000) {
                    console.warn(`[Leads] Time limit reached (45s). Returning partial results.`);
                    break;
                }

                const leadId = lead.id;
                const { data: messages } = await supabase
                    .from("lead_messages")
                    .select("sender_name, message_content, is_from_customer, sent_at")
                    .eq("lead_id", leadId)
                    .order("sent_at", { ascending: false })
                    .limit(50);

                if (messages && messages.length > 0) {
                    const messagesForAnalysis = messages.map(m => ({
                        sender: m.sender_name,
                        content: m.message_content,
                        isFromCustomer: m.is_from_customer,
                        timestamp: m.sent_at
                    })).reverse();

                    const geminiResult = await analyzeWithGemini(geminiApiKey!, messagesForAnalysis);
                    if (geminiResult) {
                        await supabase.from("leads").update({
                            ai_analysis: geminiResult.analysis,
                            is_potential: geminiResult.isPotential,
                            updated_at: new Date().toISOString()
                        }).eq("id", leadId);
                        processedLeads.push(leadId);
                    }
                } else {
                    // No messages found - mark to avoid re-fetching in next batch
                    await supabase.from("leads").update({
                        ai_analysis: "Tổng điểm: 0/10\nChi tiết điểm: [Nhu cầu: 0đ, Thời gian: 0đ, Tài chính: 0đ, Liên lạc: 0đ, Tương tác: 0đ]\nTóm tắt: Không có tin nhắn hội thoại để phân tích.\nGiai đoạn: Chưa xác định\nGợi ý: Kiểm tra lại đồng bộ tin nhắn.",
                        is_potential: false,
                        updated_at: new Date().toISOString()
                    }).eq("id", leadId);
                    processedLeads.push(leadId);
                }
            }

            return jsonResponse({
                success: true,
                processed: processedLeads.length,
                totalMatched: (leadsToAnalyze || []).length,
                timeSpentMs: Date.now() - startTime
            });
        }

        return jsonResponse({ success: false, error: "Not Found" }, 404);
    } catch (error: any) {
        console.error(`[Leads] Unhandled error: ${error.message}`, error.stack);
        return jsonResponse({
            success: false,
            error: error.message,
            stack: error.stack,
            path: path,
            method: method
        }, 500);
    }
});
