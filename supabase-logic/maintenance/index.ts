import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const supabase = createClient(supabaseUrl, supabaseKey);

Deno.serve(async (req) => {
  const logs: string[] = [];
  const log = (msg: string) => {
    const fullMsg = `[${new Date().toISOString()}] ${msg}`;
    console.log(fullMsg);
    logs.push(fullMsg);
  };

  try {
    log("Starting Maintenance Task...");

    // 1. Setup Time Ranges
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const sevenDaysAgoIso = sevenDaysAgo.toISOString();
    const sevenDaysAgoDate = sevenDaysAgoIso.split('T')[0];

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoIso = thirtyDaysAgo.toISOString();
    const thirtyDaysAgoDate = thirtyDaysAgoIso.split('T')[0];

    // 2. Prune Leads (30 days inactivity OR junk "Khách hàng" 7 days)
    log("Pruning leads...");
    const { count: deletedLeads, error: deleteLeadsError } = await supabase
      .from('leads')
      .delete({ count: 'exact' })
      .or(`last_message_at.lt.${thirtyDaysAgoIso},and(last_message_at.is.null,created_at.lt.${thirtyDaysAgoIso}),and(customer_name.eq.Khách hàng,or(last_message_at.lt.${sevenDaysAgoIso},and(last_message_at.is.null,created_at.lt.${sevenDaysAgoIso})))`);
    
    if (deleteLeadsError) log(`Error deleting old leads: ${deleteLeadsError.message}`);
    else log(`Deleted ${deletedLeads || 0} inactive/junk leads.`);

    // 3. Prune Insights
    log("Pruning insights...");
    // Hourly: Keep 7 days
    const { count: delHourly, error: delHourlyErr } = await supabase
      .from('unified_hourly_insights')
      .delete({ count: 'exact' })
      .lt('date', sevenDaysAgoDate);
    if (delHourlyErr) log(`Error deleting hourly insights: ${delHourlyErr.message}`);
    else log(`Deleted ${delHourly || 0} old hourly insights (Keep 7 days).`);

    // Daily: Keep 30 days
    const { count: delDaily, error: delDailyErr } = await supabase
      .from('unified_insights')
      .delete({ count: 'exact' })
      .lt('date', thirtyDaysAgoDate);
    if (delDailyErr) log(`Error deleting daily insights: ${delDailyErr.message}`);
    else log(`Deleted ${delDaily || 0} old daily insights (Keep 30 days).`);

    // 4. Prune Inactive Ad Entities (Status != ACTIVE and no update for 30 days)
    log("Pruning inactive ad entities (Campaigns, Adsets, Ads)...");

    const entities = [
      { table: 'unified_ads', label: 'ads' },
      { table: 'unified_ad_groups', label: 'adsets' },
      { table: 'unified_campaigns', label: 'campaigns' }
    ];

    for (const entity of entities) {
      const { count, error } = await supabase
        .from(entity.table)
        .delete({ count: 'exact' })
        .neq('status', 'ACTIVE')
        .lt('updated_at', thirtyDaysAgoIso);
      
      if (error) log(`Error pruning ${entity.label}: ${error.message}`);
      else log(`Deleted ${count || 0} inactive ${entity.label}.`);
    }

    log("Maintenance Task Completed.");

    return new Response(JSON.stringify({ success: true, logs }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    log(`Fatal Error: ${err.message}`);
    return new Response(JSON.stringify({ success: false, error: err.message, logs }), {
      headers: { "Content-Type": "application/json" },
      status: 500,
    });
  }
});
