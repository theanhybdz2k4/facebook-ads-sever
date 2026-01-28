
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
import { verify } from "https://deno.land/x/djwt@v3.0.1/mod.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const JWT_SECRET = Deno.env.get("JWT_SECRET") || "";
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
            // Not found in auth_tokens, fallback to JWT
        }

        // FALLBACK: JWT verification
        try {
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

        // GET /leads/stats
        if (method === "GET" && pathParts.includes("stats")) {
            const branchIdParam = url.searchParams.get("branchId") || "all";
            const accountIdParam = url.searchParams.get("accountId");
            const pageIdParam = url.searchParams.get("pageId");

            let adsQuery = supabase
                .from("unified_insights")
                .select("spend, date, purchase_value, platform_accounts!inner(id, platform_identities!inner(user_id))")
                .eq("platform_accounts.platform_identities.user_id", auth.userId);

            // Filter Ads Data
            if (branchIdParam !== "all") {
                adsQuery = adsQuery.eq("platform_accounts.branch_id", parseInt(branchIdParam));
            }
            if (accountIdParam && accountIdParam !== "all") {
                adsQuery = adsQuery.eq("platform_account_id", parseInt(accountIdParam));
            }

            const { data: adsData } = await adsQuery.order("date", { ascending: false }).limit(20000);

            let leadsQuery = supabase
                .from("leads")
                .select("id, created_at, is_qualified, platform_account_id, platform_data, platform_accounts!inner(id, platform_identities!inner(user_id))")
                .eq("platform_accounts.platform_identities.user_id", auth.userId);

            if (branchIdParam !== "all") {
                leadsQuery = leadsQuery.eq("platform_accounts.branch_id", parseInt(branchIdParam));
            }
            if (accountIdParam && accountIdParam !== "all") {
                leadsQuery = leadsQuery.eq("platform_account_id", parseInt(accountIdParam));
            }
            if (pageIdParam && pageIdParam !== "all") {
                leadsQuery = leadsQuery.eq("platform_data->>fb_page_id", pageIdParam);
            }

            const { data: leadsData } = await leadsQuery;

            const today = new Date().toISOString().split('T')[0];
            const yesterday = new Date(new Date().getTime() - 86400000).toISOString().split('T')[0];

            let spendTotal = 0, spendToday = 0, yesterdaySpend = 0;
            let revenueTotal = 0;

            adsData?.forEach((d: any) => {
                const amount = parseFloat(d.spend || "0");
                const revenue = parseFloat(d.purchase_value || "0");
                spendTotal += amount;
                revenueTotal += revenue;
                if (d.date === today) spendToday += amount;
                if (d.date === yesterday) yesterdaySpend += amount;
            });

            const todayLeads = leadsData?.filter((l: any) => l.created_at.startsWith(today)).length || 0;
            const todayQualified = leadsData?.filter((l: any) => l.created_at.startsWith(today) && l.is_qualified).length || 0;

            const roas = spendTotal > 0 ? (revenueTotal / spendTotal) : 0;

            return jsonResponse({
                success: true,
                result: {
                    spendTotal, spendToday, yesterdaySpend, todayLeads, todayQualified,
                    revenue: revenueTotal,
                    avgDailySpend: spendTotal / 30,
                    roas: parseFloat(roas.toFixed(2))
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
                .select("*, platform_accounts!inner(id, name, branch_id, platform_identities!inner(user_id))")
                .eq("platform_accounts.platform_identities.user_id", auth.userId)
                .order("last_message_at", { ascending: false });

            if (branchIdParam !== "all") {
                query = query.eq("platform_accounts.branch_id", parseInt(branchIdParam));
            }

            if (accountIdParam && accountIdParam !== "all") {
                query = query.eq("platform_account_id", parseInt(accountIdParam));
            }

            if (pageIdParam && pageIdParam !== "all") {
                query = query.eq("platform_data->>fb_page_id", pageIdParam);
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

        return jsonResponse({ success: false, error: "Not Found" }, 404);
    } catch (error: any) {
        return jsonResponse({ success: false, error: error.message }, 500);
    }
});
