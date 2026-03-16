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

// Helper to get current time (standard UTC)
function getNow(): Date {
    return new Date();
}

// Format a Date to Vietnam range for SQL
// Vietnam Feb 28 starts at UTC Feb 27 17:00:00
function getVnDayRange(date: Date): { start: string; end: string } {
    const vnDate = new Intl.DateTimeFormat('en-ZA', {
        timeZone: 'Asia/Ho_Chi_Minh',
        year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(date).replace(/\//g, '-');

    // Start of VN day in UTC: YYYY-MM-DD 00:00:00+07
    // End of VN day in UTC: YYYY-MM-DD 23:59:59+07
    return {
        start: `${vnDate}T00:00:00+07:00`,
        end: `${vnDate}T23:59:59+07:00`
    };
}

// Robust Auth Logic (DB-Only: auth_tokens & refresh_tokens)
async function verifyAuth(req: Request): Promise<{ userId: string | number; isSystem: boolean } | null> {
    const authHeader = req.headers.get("Authorization");
    const serviceKeyHeader = req.headers.get("x-service-key") || req.headers.get("x-master-key");
    const masterKey = Deno.env.get("MASTER_KEY") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const authSecret = Deno.env.get("AUTH_SECRET") || "";
    const JWT_SECRET = Deno.env.get("JWT_SECRET");

    // 1. Service Role / Master Key check (Headers)
    if (serviceKeyHeader === serviceKey || (masterKey && serviceKeyHeader === masterKey)) {
        return { userId: 1, isSystem: true };
    }

    if (!authHeader?.startsWith("Bearer ")) return null;
    const token = authHeader.substring(7).trim();

    // 2. Secret token check (Bearer)
    if ((serviceKey && token === serviceKey) || (masterKey && token === masterKey) || (authSecret && token === authSecret)) {
        return { userId: 1, isSystem: true };
    }

    // 3. PRIORITY: Check custom auth_tokens table
    try {
        const { data: tokenData } = await supabase
            .from("auth_tokens")
            .select("user_id")
            .eq("token", token)
            .eq("is_active", true)
            .gte("expires_at", new Date().toISOString())
            .maybeSingle();
        
        if (tokenData) return { userId: tokenData.user_id, isSystem: false };
    } catch (e: any) {
        console.error("[AuthLeads] auth_tokens check error:", e.message);
    }

    // 4. Manual JWT verification
    if (JWT_SECRET) {
        try {
            const encoder = new TextEncoder();
            const key = await crypto.subtle.importKey("raw", encoder.encode(JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
            const payload = await verify(token, key);

            if (payload.role === "service_role") return { userId: 1, isSystem: true };

            const sub = payload.sub as string;
            if (sub) {
                return { userId: /^\d+$/.test(sub) ? parseInt(sub, 10) : sub, isSystem: false };
            }
        } catch (e: any) {
            console.error("[AuthLeads] JWT verification failed:", e.message);
        }
    }

    // 5. Fallback: Check refresh_tokens table
    try {
        const { data: refreshData } = await supabase
            .from("refresh_tokens")
            .select("user_id")
            .eq("token", token)
            .gte("expires_at", new Date().toISOString())
            .maybeSingle();
        if (refreshData) return { userId: refreshData.user_id, isSystem: false };
    } catch (e: any) {
        console.error("[AuthLeads] refresh_tokens check error:", e.message);
    }

    // 6. Native Supabase Auth
    try {
        const { data: { user } } = await supabase.auth.getUser(token);
        if (user) return { userId: user.id, isSystem: false };
    } catch (e: any) {
        // Final fail
    }

    console.log("[AuthLeads] Authentication failed.");
    return null;
}



// Authentication and helper functions follow

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

        // GET /leads/pages - List ONLY pages belonging to current user
        if (method === "GET" && (path === "/pages" || path === "pages") && !hasPath("sync")) {
            // Logic: A page belongs to a user if it has leads belonging to that user's accounts
            // OR if it's the configured page in chatbot_config for this user.
            const { data: pages, error } = await supabase
                .from("platform_pages")
                .select(`
                    *,
                    leads!inner(platform_account_id, platform_accounts!inner(platform_identities!inner(user_id)))
                `)
                .eq("leads.platform_accounts.platform_identities.user_id", userId)
                .order("name", { ascending: true });

            if (error) return jsonResponse({ success: false, error: error.message }, 400);

            // Format to remove the extra join data
            const formatted = pages.map((p: any) => {
                const { leads, ...rest } = p;
                return rest;
            });

            // Unique pages only (though leads!inner should handle it)
            const uniquePages = Array.from(new Map(formatted.map(p => [p.id, p])).values());

            return jsonResponse({ success: true, result: uniquePages });
        }

        // GET /leads/agents - List ONLY agents for current user's pages
        if (method === "GET" && (path === "/agents" || path === "agents")) {
            try {
                const { data: agents, error } = await supabase
                    .from("agents")
                    .select(`
                        *,
                        platform_pages!inner(leads!inner(platform_account_id, platform_accounts!inner(platform_identities!inner(user_id))))
                    `)
                    .eq("platform_pages.leads.platform_accounts.platform_identities.user_id", userId)
                    .order("name", { ascending: true });

                if (error) {
                    console.error("[Leads/Agents] Query error:", error.message);
                    // Fallback: Nếu không join được (có thể do thiếu FK hoặc data), trả về mảng rỗng thay vì lỗi 400
                    return jsonResponse({ success: true, result: [], note: "Query failed, returned empty" });
                }

                const uniqueAgents = Array.from(new Map(agents?.map((a: any) => {
                    const { platform_pages, ...rest } = a;
                    return [a.id, rest];
                }) || []).values());

                return jsonResponse({ success: true, result: uniqueAgents });
            } catch (e: any) {
                console.error("[Leads/Agents] Fatal error:", e.message);
                return jsonResponse({ success: true, result: [] });
            }
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

            // SECURITY: Verify ownership of this page via leads/accounts
            const { data: pageCheck } = await supabase
                .from("platform_pages")
                .select("id, leads!inner(platform_account_id, platform_accounts!inner(platform_identities!inner(user_id)))")
                .eq("id", pageId)
                .eq("leads.platform_accounts.platform_identities.user_id", userId)
                .limit(1)
                .maybeSingle();

            if (!pageCheck) return jsonResponse({ success: false, error: "Page not found or unauthorized to update" }, 404);

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
            const campaignIdParam = url.searchParams.get("campaignId");
            const pageIdParam = url.searchParams.get("pageId");
            const dateStart = url.searchParams.get("dateStart");
            const dateEnd = url.searchParams.get("dateEnd");
            const platformCode = url.searchParams.get("platformCode") || "all";

            const now = getNow();
            const todayRange = getVnDayRange(now);
            const todayStr = todayRange.start.slice(0, 10);

            const yesterday = new Date(now.getTime() - 86400000);
            const yesterdayRange = getVnDayRange(yesterday);
            const yesterdayStr = yesterdayRange.start.slice(0, 10);

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
            let accountIds = userAccounts?.map((a: any) => a.id) || [];

            // If pageId filter is applied, find accounts that have leads on this page
            // This ensures spend stats are filtered by the selected fanpage
            if (pageIdParam && pageIdParam !== "all" && accountIds.length > 0) {
                const { data: pageAccounts } = await supabase
                    .from("leads")
                    .select("platform_account_id")
                    .eq("fb_page_id", pageIdParam)
                    .in("platform_account_id", accountIds);

                // Get unique account IDs that have leads on this page
                const pageAccountIds = [...new Set(pageAccounts?.map((l: any) => l.platform_account_id) || [])];
                accountIds = pageAccountIds.length > 0 ? pageAccountIds : [];
            }

            // 2. STATS FROM UNIFIED_INSIGHTS (SPEND, REVENUE, MESSAGING_NEW) - query by account IDs
            let spendTotal = 0, spendToday = 0, spendTodayRaw = 0, yesterdaySpend = 0, yesterdayResults = 0, revenueTotal = 0, messagingNewFromAds = 0;

            let unifiedCampaignId = null;
            let externalCampaignId = null;

            if (accountIds.length > 0) {
                // Resolve IDs if campaignIdParam is provided
                unifiedCampaignId = null;
                externalCampaignId = null;

                if (campaignIdParam) {
                    // Try to find by UUID first (common in report URLs)
                    let { data: campaignData } = await supabase
                        .from("unified_campaigns")
                        .select("id, external_id")
                        .eq("id", campaignIdParam)
                        .limit(1)
                        .maybeSingle();

                    if (!campaignData) {
                        // Fallback: Try to find by external FB ID
                        const { data: campaignDataByExt } = await supabase
                            .from("unified_campaigns")
                            .select("id, external_id")
                            .eq("external_id", campaignIdParam)
                            .limit(1)
                            .maybeSingle();
                        campaignData = campaignDataByExt;
                    }

                    if (campaignData) {
                        unifiedCampaignId = campaignData.id;
                        externalCampaignId = campaignData.external_id;
                    } else {
                        // If not found in unified_campaigns, assume the param itself might be the external ID
                        externalCampaignId = campaignIdParam;
                    }
                }

                // Query for selected date range - include messaging_new for accurate lead count from Meta
                let insightsQuery = supabase
                    .from("unified_insights")
                    .select("spend, date, purchase_value, messaging_new")
                    .in("platform_account_id", accountIds);

                if (dateStart) insightsQuery = insightsQuery.gte("date", dateStart);
                if (dateEnd) insightsQuery = insightsQuery.lte("date", dateEnd);
                if (unifiedCampaignId) insightsQuery = insightsQuery.eq("unified_campaign_id", unifiedCampaignId);

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

            // Use precise ISO strings with VN offset for true UTC comparison in DB
            const rangeStart = dateStart ? `${dateStart}T${startTime}+07:00` : todayRange.start;
            const rangeEnd = dateEnd ? `${dateEnd}T${endTime}+07:00` : todayRange.end;

            // 1. STATS FROM LEADS TABLE (COUNT NEW CONTACTS)
            // Use accountIds fetched above to avoid complex join issues
            let leadsBaseQuery = supabase
                .from("leads")
                .select("id, first_contact_at, is_qualified, is_potential, is_manual_potential, source_campaign_id, platform_data, metadata, platform_account_id")
                .in("platform_account_id", accountIds);

            if (pageIdParam && pageIdParam !== "all") leadsBaseQuery = leadsBaseQuery.eq("fb_page_id", pageIdParam);
            if (externalCampaignId) leadsBaseQuery = leadsBaseQuery.eq("source_campaign_id", externalCampaignId);

            // Filter by FIRST contact in range
            leadsBaseQuery = leadsBaseQuery.gte("first_contact_at", rangeStart).lte("first_contact_at", rangeEnd);

            const { data: leadsData, error: leadsError } = await leadsBaseQuery;

            // NEW CONTACTS in range
            const rangeNewContacts = leadsData || [];
            const rangeNewTotal = rangeNewContacts.length;

            // AGGREGATION: Ad leads are those marked as qualified (attribute of ad interaction)
            const adsLeads = rangeNewContacts.filter((l: any) => l.source_campaign_id || l.is_qualified);
            const organicLeads = rangeNewContacts.filter((l: any) => !l.source_campaign_id && !l.is_qualified);

            const rangeNewAds = adsLeads.length;
            const rangeNewOrganic = organicLeads.length;

            // Count potential leads in each group (is_potential = AI analysis, is_manual_potential = starred by user)
            const potentialFromAds = adsLeads.filter((l: any) => l.is_potential === true || l.is_manual_potential === true).length;
            const potentialFromOrganic = organicLeads.filter((l: any) => l.is_potential === true || l.is_manual_potential === true).length;

            // Count ALL starred (manual potential) leads - không giới hạn theo ngày
            // Query riêng để đếm tất cả leads đã đánh dấu sao
            let starredQuery = supabase
                .from("leads")
                .select("id", { count: "exact", head: true })
                .in("platform_account_id", accountIds)
                .or("is_potential.eq.true,is_manual_potential.eq.true");

            if (pageIdParam && pageIdParam !== "all") starredQuery = starredQuery.eq("fb_page_id", pageIdParam);

            const { count: starredCount } = await starredQuery;

            // Debug info for the developer (can be seen in network tab)
            const statsDebug = {
                leadsCount: rangeNewTotal,
                leadsError: leadsError,
                range: { start: rangeStart, end: rangeEnd },
                userId,
                accountIdsCount: accountIds.length
            };

            // 2. UNIQUE MESSAGING CONTACTS in range - Approximation using leads last_message_at
            // Since lead_messages is deleted, we use leads table to count those active in range
            let msgQuery = supabase
                .from("leads")
                .select("id", { count: "exact", head: true })
                .in("platform_account_id", accountIds)
                .gte("last_message_at", rangeStart)
                .lte("last_message_at", rangeEnd);

            if (pageIdParam && pageIdParam !== "all") msgQuery = msgQuery.eq("fb_page_id", pageIdParam);

            const { count: uniqueLeadsInRangeCount } = await msgQuery;
            const uniqueLeadsInRange = uniqueLeadsInRangeCount || 0;

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
                todayLeads: rangeNewTotal,
                todayQualified: rangeNewAds,
                messagingNewFromAds, // Values from Facebook Ads Insights
                todayNewOrganic: rangeNewOrganic,
                potentialFromAds,
                potentialFromOrganic,
                todayMessagesCount: uniqueLeadsInRange,
                starredCount,
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
            const platformCode = url.searchParams.get("platformCode") || "all";

            // New: Granular Date/Time Filters
            const dateStart = url.searchParams.get("dateStart");
            const dateEnd = url.searchParams.get("dateEnd");
            const startTime = url.searchParams.get("startTime") || "00:00:00";
            const endTime = url.searchParams.get("endTime") || "23:59:59";

            const now = getNow();
            const todayRange = getVnDayRange(now);
            const todayStr = todayRange.start.slice(0, 10);

            const rangeStart = dateStart ? `${dateStart}T${startTime}+07:00` : todayRange.start;
            const rangeEnd = dateEnd ? `${dateEnd}T${endTime}+07:00` : todayRange.end;

            // Shorthand helpers
            if (qualifiedTodayParam === "true") {
                isToday = true;
            }
            if (potentialTodayParam === "true") {
                isToday = true;
            }

            // Determine which userId to use for filtering (param takes priority)
            const effectiveUserId = userId;

            // Build main query - OPTIMIZED: Only select needed fields to reduce egress
            let query = supabase
                .from("leads")
                .select(`
                    id, external_id, customer_name, customer_avatar, phone, 
                    first_contact_at, last_message_at, created_at, updated_at,
                    is_qualified, is_potential, is_manual_potential, is_read,
                    source_campaign_id, fb_page_id, platform_account_id,
                    assigned_user_id,
                    ai_analysis, platform_data,
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

            if (platformCode !== "all") {
                const { data: platform } = await supabase.from("platforms").select("id").eq("code", platformCode).single();
                if (platform) {
                    query = query.eq("platform_accounts.platform_id", platform.id);
                    countQuery = countQuery.eq("platform_accounts.platform_id", platform.id);
                }
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
            // NEW LOGIC: Fetch messages on-demand from Facebook API
            const FB_BASE_URL = "https://graph.facebook.com/v24.0";
            
            // 1. Get identity and credentials
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

            // 2. Get Lead Detail for FB Page and External ID
            const { data: leadInfo } = await supabase
                .from("leads")
                .select("external_id, fb_page_id")
                .eq("id", leadId)
                .single();
            
            if (!leadInfo) return jsonResponse({ success: false, error: "Lead not found" }, 404);

            // 3. Get Page Token (PRIORITY: from DB, FALLBACK: fetch from FB)
            let pageToken = null;
            const { data: pageRecord } = await supabase
                .from("platform_pages")
                .select("access_token")
                .eq("id", leadInfo.fb_page_id)
                .maybeSingle();
            
            if (pageRecord?.access_token) {
                pageToken = pageRecord.access_token;
            } else {
                console.log(`[Leads/Messages] Page token not in DB for ${leadInfo.fb_page_id}, fetching from FB...`);
                const pageRes = await fetch(`${FB_BASE_URL}/${leadInfo.fb_page_id}?fields=access_token&access_token=${userToken}`);
                const pageData = await pageRes.json();
                if (pageData.access_token) {
                    pageToken = pageData.access_token;
                    // Proactively save back to DB
                    await supabase.from("platform_pages").update({ access_token: pageToken }).eq("id", leadInfo.fb_page_id);
                }
            }

            if (!pageToken) return jsonResponse({ success: false, error: "Failed to get page token" }, 400);

            // 4. Find Conversation ID
            const convsRes = await fetch(`${FB_BASE_URL}/${leadInfo.fb_page_id}/conversations?user_id=${leadInfo.external_id}&fields=id,updated_time,snippet,participants&access_token=${pageToken}`);
            const convsData = await convsRes.json();
            const convId = convsData.data?.[0]?.id;

            if (!convId) return jsonResponse({ success: true, result: [], note: "No conversation found on Facebook" });

            // 5. Fetch Messages
            const msgsRes = await fetch(`${FB_BASE_URL}/${convId}/messages?fields=id,message,from,created_time,attachments,shares,sticker&limit=100&access_token=${pageToken}`);
            const msgsData = await msgsRes.json();

            if (!msgsData.data) return jsonResponse({ success: true, result: [] });

            // Format for Frontend
            const formatted = msgsData.data.map((m: any) => {
                const msgSenderId = String(m.from?.id || "");
                const isMsgFromPage = msgSenderId === String(leadInfo.fb_page_id);
                return {
                    id: crypto.randomUUID(),
                    lead_id: leadId,
                    fb_message_id: m.id,
                    sender_id: msgSenderId,
                    sender_name: m.from?.name || (isMsgFromPage ? "Trang" : "Khách hàng"),
                    message_content: m.message || "",
                    attachments: m.attachments?.data || null,
                    sticker: m.sticker || null,
                    shares: m.shares?.data || null,
                    sent_at: new Date(m.created_time).toISOString(),
                    is_from_customer: !isMsgFromPage
                };
            }).reverse();

            // 5. Update lead metadata: last_message_at, snippet and last_analysis_message_count
            const latestMsg = formatted.length > 0 ? formatted[formatted.length - 1] : null;
            if (latestMsg) {
                let snippet = latestMsg.message_content || "";
                if (!snippet && latestMsg.attachments) snippet = "[Hình ảnh/File]";
                if (!snippet && latestMsg.sticker) snippet = "[Sticker]";

                await supabase.from("leads")
                    .update({ 
                        last_message_at: latestMsg.sent_at,
                        platform_data: {
                            ...(leadInfo.platform_data || {}),
                            snippet: snippet.substring(0, 100),
                            last_analysis_message_count: leadInfo.platform_data?.last_analysis_message_count || 0
                        }
                    })
                    .eq("id", leadId);
            }

            // --- AUTO AI ANALYSIS LOGIC ---
            // Trigger AI analysis if messages >= 5 and (never analyzed OR message count changed significantly)
            const messageCount = formatted.length;
            const lastAnalysisMsgCount = leadInfo.platform_data?.last_analysis_message_count || 0;
            const messagesSinceLastAnalysis = messageCount - lastAnalysisMsgCount;
            const hasEnoughMessages = messageCount >= 5;
            // Only re-analyze if we have at least 3 new messages since last analysis to save cost
            const shouldAnalyze = hasEnoughMessages && (!leadInfo.ai_analysis || messagesSinceLastAnalysis >= 3);

            if (shouldAnalyze) {
                console.log(`[AI Analysis] Auto-triggering analysis via fb-ai-analysis for lead ${leadId}...`);
                
                try {
                    const { data: userData } = await supabase.from("users").select("gemini_api_key").eq("id", userId).maybeSingle();
                    const geminiApiKey = userData?.gemini_api_key;
                    
                    if (geminiApiKey) {
                        const messagesForAnalysis = formatted.map((m: any) => ({
                            sender: m.sender_name,
                            content: m.message_content,
                            isFromCustomer: m.is_from_customer,
                            timestamp: m.sent_at
                        }));

                        // Fetch centralized AI analysis
                        fetch(`${supabaseUrl}/functions/v1/fb-ai-analysis`, {
                            method: "POST",
                            headers: { 
                                "Content-Type": "application/json", 
                                "Authorization": "Bearer " + supabaseKey 
                            },
                            body: JSON.stringify({
                                leadId: leadId,
                                messages: messagesForAnalysis,
                                geminiApiKey: geminiApiKey
                            })
                        }).catch(err => console.error("[Leads] Auto AI trigger failed:", err));
                    }
                } catch (aiErr) {
                    console.error(`[AI Analysis] Error triggering auto-analysis for lead ${leadId}:`, aiErr);
                }
            }
            // --- END AUTO AI ANALYSIS LOGIC ---

            return jsonResponse({ success: true, result: formatted });
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
                        assigned_user_id,
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
                    console.log(`[Leads] Re-analyzing lead ${leadId} (Fetching history from FB first)...`);

                    // 1. Fetch History from FB
                    const { data: leadRec } = await supabase.from("leads").select("external_id, fb_page_id").eq("id", leadId).single();
                    if (leadRec) {
                        const FB_BASE_URL = "https://graph.facebook.com/v24.0";
                        const { data: identity } = await supabase.from("platform_identities").select("id").eq("user_id", userId).limit(1).single();
                        const { data: creds } = await supabase.from("platform_credentials").select("credential_value").eq("is_active", true).eq("platform_identity_id", identity?.id).limit(1).single();
                        
                        if (creds?.credential_value) {
                            const pageRes = await fetch(`${FB_BASE_URL}/${leadRec.fb_page_id}?fields=access_token&access_token=${creds.credential_value}`);
                            const pageData = await pageRes.json();
                            if (pageData.access_token) {
                                const convsRes = await fetch(`${FB_BASE_URL}/${leadRec.fb_page_id}/conversations?user_id=${leadRec.external_id}&access_token=${pageData.access_token}`);
                                const convsData = await convsRes.json();
                                const convId = convsData.data?.[0]?.id;
                                if (convId) {
                                    const msgsRes = await fetch(`${FB_BASE_URL}/${convId}/messages?fields=id,message,from&limit=50&access_token=${pageData.access_token}`);
                                    const msgsData = await msgsRes.json();
                                    
                                    if (msgsData.data && msgsData.data.length > 0) {
                                        const { data: userData } = await supabase.from("users").select("gemini_api_key").eq("id", userId).maybeSingle();
                                        const geminiApiKey = userData?.gemini_api_key || null;
                                        
                                        const messagesForAnalysis = msgsData.data.map((m: any) => ({
                                            sender: m.from?.name || "Người dùng",
                                            content: m.message || "",
                                            isFromCustomer: String(m.from?.id) !== String(leadRec.fb_page_id)
                                        })).reverse();

                                        // Use the centralized fb-ai-analysis function
                                        const analysisRes = await fetch(`${supabaseUrl}/functions/v1/fb-ai-analysis`, {
                                            method: "POST",
                                            headers: { 
                                                "Content-Type": "application/json", 
                                                "Authorization": "Bearer " + supabaseKey 
                                            },
                                            body: JSON.stringify({
                                                leadId: leadId,
                                                messages: messagesForAnalysis,
                                                geminiApiKey: geminiApiKey
                                            })
                                        });

                                        if (analysisRes.ok) {
                                            const result = await analysisRes.json();
                                            if (result.success && result.analysis) {
                                                updates.ai_analysis = result.analysis;
                                                updates.is_potential = result.isPotential;
                                            }
                                            console.log(`[Leads] AI Analysis completed and synchronized for lead ${leadId}`);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                const { data, error } = await supabase.from("leads").update(updates).eq("id", leadId).select().single();
                if (error) return jsonResponse({ success: false, error: error.message }, 400);

                return jsonResponse({ success: true, result: data });
            }
        }



        // POST /leads/:id/sync_messages - Update lead metadata from FB (On-demand)
        if (method === "POST" && subPathSegments.length === 2 && subPathSegments[1] === "sync_messages") {
            const leadId = subPathSegments[0];
            const FB_BASE_URL = "https://graph.facebook.com/v24.0";

            // 1. Get Lead Info
            const { data: lead } = await supabase
                .from("leads")
                .select("id, external_id, fb_page_id, platform_data, platform_accounts!inner(platform_identities!inner(user_id))")
                .eq("id", leadId)
                .eq("platform_accounts.platform_identities.user_id", userId)
                .single();

            if (!lead) return jsonResponse({ success: false, error: "Lead not found or unauthorized" }, 404);

            // 2. Get User Token
            const { data: identity } = await supabase.from("platform_identities").select("id").eq("user_id", userId).limit(1).single();
            const { data: creds } = await supabase.from("platform_credentials").select("credential_value").eq("is_active", true).eq("platform_identity_id", identity?.id).limit(1).single();
            if (!creds) return jsonResponse({ success: false, error: "No active FB token found" }, 404);
            const userToken = creds.credential_value;

            // 3. Get Page Token
            const pageId = lead.fb_page_id;
            const pageRes = await fetch(`${FB_BASE_URL}/${pageId}?fields=access_token&access_token=${userToken}`);
            const pageData = await pageRes.json();
            if (!pageData.access_token) return jsonResponse({ success: false, error: "Failed to get page token" }, 400);
            const pageToken = pageData.access_token;

            // 4. Find Conversation
            const convsRes = await fetch(`${FB_BASE_URL}/${pageId}/conversations?user_id=${lead.external_id}&fields=id,updated_time,snippet&access_token=${pageToken}`);
            const convsData = await convsRes.json();
            const targetConv = convsData.data?.[0];

            if (!targetConv) return jsonResponse({ success: false, error: "Conversation not found on Facebook" }, 404);

            // 5. Update lead metadata with the latest conversation info from FB
            const { data: updatedLead, error: updateError } = await supabase.from("leads").update({
                last_message_at: new Date(targetConv.updated_time).toISOString(),
                platform_data: {
                    ...(lead.platform_data || {}),
                    fb_conv_id: targetConv.id,
                    snippet: targetConv.snippet || (lead.platform_data?.snippet || "")
                }
            }).eq("id", lead.id).select().single();

            if (updateError) return jsonResponse({ success: false, error: updateError.message }, 500);

            return jsonResponse({ success: true, count: 1, result: updatedLead });
        }

        // POST /leads/reanalyze_all - Bulk re-analyze leads
        if (method === "POST" && path.includes("reanalyze_all")) {
            console.log(`[Leads] reanalyze_all match: ${path}`);

            const { data: userData } = await supabase
                .from("users")
                .select("gemini_api_key")
                .eq("id", userId)
                .maybeSingle();

            const geminiApiKey = userData?.gemini_api_key;
            if (!geminiApiKey) return jsonResponse({ success: false, error: "AI key missing for your account. Please check your settings." }, 400);

            // Fetch leads needing analysis - Filter ONLY for current user's leads
            const { data: leadsToAnalyze, error: leadsError } = await supabase
                .from("leads")
                .select("id, external_id, fb_page_id, platform_accounts!inner(platform_identities!inner(user_id))")
                .eq("platform_accounts.platform_identities.user_id", userId)
                .not("last_message_at", "is", null)
                .or("ai_analysis.is.null,ai_analysis.not.ilike.Tổng điểm%")
                .order("last_message_at", { ascending: false })
                .limit(50);

            if (leadsError) return jsonResponse({ success: false, error: "DB Error: " + leadsError.message }, 400);

            console.log(`[Leads] Processing batch of ${leadsToAnalyze?.length || 0}`);
            const processedLeads = [];
            const startTime = Date.now();

            for (const lead of (leadsToAnalyze || [])) {
                if (Date.now() - startTime > 45000) break;

                // 1. Fetch History from FB for this specific lead
                const FB_BASE_URL = "https://graph.facebook.com/v24.0";
                const { data: identity } = await supabase.from("platform_identities").select("id").eq("user_id", userId).limit(1).single();
                const { data: creds } = await supabase.from("platform_credentials").select("credential_value").eq("is_active", true).eq("platform_identity_id", identity?.id).limit(1).single();

                if (creds?.credential_value) {
                    const pageRes = await fetch(`${FB_BASE_URL}/${lead.fb_page_id}?fields=access_token&access_token=${creds.credential_value}`);
                    const pageData = await pageRes.json();
                    if (pageData.access_token) {
                        const convsRes = await fetch(`${FB_BASE_URL}/${lead.fb_page_id}/conversations?user_id=${lead.external_id}&access_token=${pageData.access_token}`);
                        const convsData = await convsRes.json();
                        const convId = convsData.data?.[0]?.id;
                        if (convId) {
                            const msgsRes = await fetch(`${FB_BASE_URL}/${convId}/messages?fields=id,message,from&limit=50&access_token=${pageData.access_token}`);
                            const msgsData = await msgsRes.json();

                            if (msgsData.data && msgsData.data.length > 0) {
                                const messagesForAnalysis = msgsData.data.map((m: any) => ({
                                    sender: m.from?.name || "Người dùng",
                                    content: m.message || "",
                                    isFromCustomer: String(m.from?.id) !== String(lead.fb_page_id)
                                })).reverse();

                                // Use the centralized fb-ai-analysis function
                                const analysisRes = await fetch(`${supabaseUrl}/functions/v1/fb-ai-analysis`, {
                                    method: "POST",
                                    headers: { 
                                        "Content-Type": "application/json", 
                                        "Authorization": "Bearer " + supabaseKey 
                                    },
                                    body: JSON.stringify({
                                        leadId: lead.id,
                                        messages: messagesForAnalysis,
                                        geminiApiKey: geminiApiKey
                                    })
                                });

                                if (analysisRes.ok) {
                                    processedLeads.push(lead.id);
                                }
                            }
                        }
                    }
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
