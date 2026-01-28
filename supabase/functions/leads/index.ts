
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const supabase = createClient(supabaseUrl, supabaseKey);

const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const jsonResponse = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: corsHeaders });

Deno.serve(async (req: any) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

    try {
        const url = new URL(req.url);
        const method = req.method;
        const pathParts = url.pathname.split("/").filter(Boolean);

        // GET /leads/stats
        if (method === "GET" && pathParts.includes("stats")) {
            const branchIdParam = url.searchParams.get("branchId") || "all";
            const accountIdParam = url.searchParams.get("accountId");
            const pageIdParam = url.searchParams.get("pageId");

            let adsQuery = supabase.from("unified_insights").select("spend, date, purchase_value");

            // Filter Ads Data
            if (branchIdParam !== "all") {
                adsQuery = adsQuery.eq("platform_accounts.branch_id", parseInt(branchIdParam));
                // We need to join platform_accounts if filtering by branch
                adsQuery = supabase.from("unified_insights").select("spend, date, purchase_value, platform_accounts!inner(branch_id)");
                adsQuery = adsQuery.eq("platform_accounts.branch_id", parseInt(branchIdParam));
            }
            if (accountIdParam && accountIdParam !== "all") {
                adsQuery = adsQuery.eq("platform_account_id", parseInt(accountIdParam));
            }
            // Page filter for ads is complex because ads are not directly linked to page in unified_insights easily without join.
            // But we can approximate or ignore page filter for Ads Spend/Revenue if needed, or filter by account (usually 1:1 or 1:N). 
            // For now, let's skip page filter for Ads Data unless we assume accountId is passed.

            const { data: adsData } = await adsQuery.order("date", { ascending: false }).limit(20000);

            let leadsQuery = supabase.from("leads").select("id, created_at, is_qualified, platform_account_id, platform_data");
            if (branchIdParam !== "all") {
                leadsQuery = leadsQuery.eq("platform_accounts.branch_id", parseInt(branchIdParam));
                leadsQuery = supabase.from("leads").select("id, created_at, is_qualified, platform_account_id, platform_data, platform_accounts!inner(branch_id)");
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
                .select("*, platform_account:platform_accounts(id, name, branch_id)")
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
            const { data, error } = await supabase.from("lead_messages").select("*").eq("lead_id", leadId).order("sent_at", { ascending: true });
            if (error) return jsonResponse({ success: false, error: error.message }, 400);
            return jsonResponse({ success: true, result: data });
        }

        if (method === "POST" && pathParts.includes("assign")) {
            const idx = pathParts.indexOf("assign");
            const leadId = pathParts[idx - 1];
            const { userId } = await req.json();
            const { data, error } = await supabase.from("leads").update({ assigned_user_id: userId }).eq("id", leadId).select().single();
            if (error) return jsonResponse({ success: false, error: error.message }, 400);
            return jsonResponse({ success: true, result: data });
        }

        return jsonResponse({ success: false, error: "Not Found" }, 404);
    } catch (error: any) {
        return jsonResponse({ success: false, error: error.message }, 500);
    }
});
