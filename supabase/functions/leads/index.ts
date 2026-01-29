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
        return { userId: 1 };
    }

    if (authHeader?.startsWith("Bearer ")) {
        const token = authHeader.substring(7).trim();
        if ((serviceKey !== "" && token === serviceKey) || (masterKey !== "" && token === masterKey) || (authSecret !== "" && token === authSecret)) {
            return { userId: 1 };
        }

        // PRIORITY: Check custom auth_tokens table first
        try {
            const { data: tokenData } = await supabase.from("auth_tokens").select("user_id").eq("token", token).single();
            if (tokenData) return { userId: tokenData.user_id };
        } catch (e) {
            // Fallback to JWT
        }

        // FALLBACK: JWT verification
        try {
            console.log("DEBUG: JWT_SECRET length:", JWT_SECRET?.length || 0);
            const encoder = new TextEncoder();
            const key = await crypto.subtle.importKey("raw", encoder.encode(JWT_SECRET || ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
            const payload = await verify(token, key);
            const sub = payload.sub as string;
            const userIdNum = parseInt(sub, 10);
            if (!isNaN(userIdNum)) return { userId: userIdNum };
            return { userId: sub as any };
        } catch (e: any) {
            console.log("Auth: JWT verify failed:", e.message);
        }
    }
    return null;
}

Deno.serve(async (req: any) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

    const auth = await verifyAuth(req);
    if (!auth) return jsonResponse({ success: false, error: "Unauthorized" }, 401);

    try {
        const url = new URL(req.url);
        const method = req.method;
        const pathParts = url.pathname.split("/").filter(Boolean);

        // GET /leads/pages - Fetch available Facebook Pages from FB API
        if (method === "GET" && pathParts.includes("pages")) {
            const FB_BASE_URL = "https://graph.facebook.com/v24.0";
            
            // Get user's FB credentials
            const { data: credentials } = await supabase
                .from("platform_credentials")
                .select(`
                    credential_value,
                    platform_identity_id,
                    platform_identities!inner(id, user_id)
                `)
                .eq("is_active", true)
                .eq("credential_type", "access_token")
                .eq("platform_identities.user_id", auth.userId);
            
            if (!credentials || credentials.length === 0) {
                return jsonResponse({ success: true, result: [] });
            }
            
            const allPages: { id: string; name: string }[] = [];
            const seenPageIds = new Set<string>();
            
            for (const cred of credentials) {
                const token = cred.credential_value;
                try {
                    const pagesRes = await fetch(`${FB_BASE_URL}/me/accounts?fields=id,name&access_token=${token}`);
                    const pagesData = await pagesRes.json();
                    
                    if (pagesData.data) {
                        for (const page of pagesData.data) {
                            if (!seenPageIds.has(page.id)) {
                                seenPageIds.add(page.id);
                                allPages.push({ id: page.id, name: page.name });
                            }
                        }
                    }
                } catch (e) {
                    console.warn(`[Leads] Failed to fetch pages for credential`, e);
                }
            }
            
            return jsonResponse({ success: true, result: allPages });
        }

        // GET /leads/stats
        if (method === "GET" && pathParts.includes("stats")) {
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
                .eq("platform_identities.user_id", auth.userId);

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
                .eq("platform_accounts.platform_identities.user_id", auth.userId);

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

        // GET /leads
        if (method === "GET" && pathParts.length === 1 && pathParts[0] === "leads") {
            const branchIdParam = url.searchParams.get("branchId") || "all";
            const accountIdParam = url.searchParams.get("accountId");
            const pageIdParam = url.searchParams.get("pageId");

            let query = supabase
                .from("leads")
                .select("*, platform_pages(name), platform_accounts!inner(id, name, branch_id, platform_identities!inner(user_id))")
                .eq("platform_accounts.platform_identities.user_id", auth.userId)
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
            if (adIds.length > 0) {
                const { data: adNames } = await supabase
                    .from("unified_ads")
                    .select("external_id, name")
                    .in("external_id", adIds);

                const adNamesMap: Record<string, string> = {};
                adNames?.forEach((a: any) => { adNamesMap[a.external_id] = a.name; });

                leads?.forEach((l: any) => {
                    if (l.source_campaign_id && adNamesMap[l.source_campaign_id]) {
                        l.source_campaign_name = adNamesMap[l.source_campaign_id];
                    } else {
                        l.source_campaign_name = "Tự nhiên";
                    }
                });
            } else {
                leads?.forEach((l: any) => {
                    l.source_campaign_name = "Tự nhiên";
                });
            }

            return jsonResponse({ success: true, result: leads });
        }

        // Other endpoints ... (messages, assign)
        if (method === "GET" && pathParts.includes("messages")) {
            const idx = pathParts.indexOf("messages");
            const leadId = pathParts[idx - 1];

            // Verify lead ownership before showing messages
            const { data: leadCheck } = await supabase
                .from("leads")
                .select("id, platform_accounts!inner(platform_identities!inner(user_id))")
                .eq("id", leadId)
                .eq("platform_accounts.platform_identities.user_id", auth.userId)
                .single();

            if (!leadCheck) return jsonResponse({ success: false, error: "Lead not found or unauthorized" }, 404);

            const { data, error } = await supabase.from("lead_messages").select("*").eq("lead_id", leadId).order("sent_at", { ascending: true });
            if (error) return jsonResponse({ success: false, error: error.message }, 400);
            return jsonResponse({ success: true, result: data });
        }

        if (method === "POST" && pathParts.includes("assign")) {
            const idx = pathParts.indexOf("assign");
            const leadId = pathParts[idx - 1];
            const { userId } = await req.json();

            // Verify lead ownership before assigning
            const { data: leadCheck } = await supabase
                .from("leads")
                .select("id, platform_accounts!inner(platform_identities!inner(user_id))")
                .eq("id", leadId)
                .eq("platform_accounts.platform_identities.user_id", auth.userId)
                .single();

            if (!leadCheck) return jsonResponse({ success: false, error: "Lead not found or unauthorized" }, 404);

            const { data, error } = await supabase.from("leads").update({ assigned_user_id: userId }).eq("id", leadId).select().single();
            if (error) return jsonResponse({ success: false, error: error.message }, 400);
            return jsonResponse({ success: true, result: data });
        }

        if (method === "PATCH" && pathParts.length === 2 && pathParts[0] === "leads") {
            const leadId = pathParts[1];
            const updates = await req.json();
            
            // Verify ownership
            const { data: leadCheck } = await supabase
                .from("leads")
                .select("id")
                .eq("id", leadId)
                .eq("platform_accounts.platform_identities.user_id", auth.userId)
                .single();
            
            if (!leadCheck) return jsonResponse({ success: false, error: "Lead not found or unauthorized" }, 404);

            const { data, error } = await supabase.from("leads").update(updates).eq("id", leadId).select().single();
            if (error) return jsonResponse({ success: false, error: error.message }, 400);
            return jsonResponse({ success: true, result: data });
        }

        return jsonResponse({ success: false, error: "Not Found" }, 404);
    } catch (error: any) {
        return jsonResponse({ success: false, error: error.message }, 500);
    }
});
