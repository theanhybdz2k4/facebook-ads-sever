/**
 * Facebook Ads - Dispatch
 * Main dispatcher triggered by n8n/cron to run sync jobs based on cron_settings
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const supabase = createClient(supabaseUrl, supabaseKey);

async function verifyAuth(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return { userId: 1, isSystem: true };
  }
  return null;
}

/**
 * Returns current hour in Vietnam (GMT+7)
 */
function getVietnamHour(): number {
  const now = new Date();
  const vnOffset = 7 * 60; // Vietnam is UTC+7
  const vnTime = new Date(now.getTime() + (vnOffset + now.getTimezoneOffset()) * 60000);
  return vnTime.getHours();
}

/**
 * Returns current ISO string for UTC storage
 */
function getUTCNow(): string {
  return new Date().toISOString();
}

const corsHeaders = { 
  "Content-Type": "application/json", 
  "Access-Control-Allow-Origin": "*", 
  "Access-Control-Allow-Methods": "POST, OPTIONS", 
  "Access-Control-Allow-Headers": "Content-Type, Authorization" 
};

const jsonResponse = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: corsHeaders });

async function callEdgeFunction(name: string, body: any): Promise<any> {
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + supabaseKey },
      body: JSON.stringify(body),
    });
    return res.json();
  } catch (e: any) {
    console.error(`[Dispatch] Error calling ${name}:`, e.message);
    return { success: false, error: e.message };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  const auth = await verifyAuth(req);
  if (!auth) return jsonResponse({ success: false, error: "Unauthorized" }, 401);

  try {
    const body = await req.json().catch(() => ({}));
    const { cronType, userId: forcedUserId, force = false } = body;

    const currentHour = getVietnamHour();
    const now = new Date();
    
    console.log(`[Dispatch] Start: VN hour=${currentHour}, force=${force}, cronType=${cronType}`);

    // 1. Fetch all enabled settings
    let query = supabase.from("cron_settings")
      .select("*")
      .eq("enabled", true);

    if (cronType) query = query.eq("cron_type", cronType);
    if (forcedUserId) query = query.eq("user_id", forcedUserId);

    const { data: allSettings, error: cronError } = await query;
    if (cronError) throw cronError;

    // 2. Filter settings that are due
    const settingsByUserId = new Map<number, any[]>();
    for (const s of (allSettings || [])) {
      if (!force) {
        // Allowed hours check
        const allowed = s.allowed_hours || [];
        if (allowed.length > 0 && !allowed.includes(currentHour)) continue;

        // Once per hour check (Timezone robust)
        if (s.last_run_at) {
          const lastRun = new Date(s.last_run_at);
          const diffMs = now.getTime() - lastRun.getTime();
          const diffHours = diffMs / (1000 * 60 * 60);

          // If ran less than 45 mins ago, skip
          if (diffHours < 0.75) {
            console.log(`[Dispatch] Setting ${s.cron_type} for user ${s.user_id} ran too recently (${Math.round(diffHours * 60)}m ago).`);
            continue;
          }
        }
      }

      if (!settingsByUserId.has(s.user_id)) settingsByUserId.set(s.user_id, []);
      settingsByUserId.get(s.user_id)!.push(s);
    }

    if (settingsByUserId.size === 0) {
      return jsonResponse({ success: true, message: "No settings due for this hour", processed: 0 });
    }

    console.log(`[Dispatch] Processing settings for ${settingsByUserId.size} users.`);

    const totalResults: any[] = [];
    const allTriggerPromises: Promise<any>[] = [];

    // 3. Process each user's settings and their associated accounts
    for (const [userId, userSettings] of settingsByUserId.entries()) {
      try {
        // Correct join syntax for Supabase client
        const { data: accs, error: e } = await supabase
          .from("platform_accounts")
          .select("id, name, external_id, platform_id, platform_identities!inner(user_id)")
          .eq("account_status", "1")
          .eq("platform_identities.user_id", userId);

        if (e) {
          console.error(`[Dispatch] Error fetching accounts for user ${userId}:`, e.message);
          continue;
        }

        if (!accs || accs.length === 0) {
          console.log(`[Dispatch] User ${userId} has no active accounts.`);
          continue;
        }

        console.log(`[Dispatch] User ${userId}: Found ${accs.length} accounts to sync for ${userSettings.length} settings.`);

        for (const setting of userSettings) {
          const settingType = setting.cron_type;
          
          for (const acct of accs) {
            const payload: any = { accountId: acct.id };
            let functionName = "";

            switch (settingType) {
              case 'ad_account': functionName = "fb-sync-accounts"; break;
              case 'campaign': functionName = "fb-sync-campaigns"; payload.target = "campaign"; break;
              case 'adset': functionName = "fb-sync-campaigns"; payload.target = "adset"; break;
              case 'ads': functionName = "fb-sync-ads"; break;
              case 'insight':
              case 'insight_hourly':
              case 'insight_hour':
                functionName = "fb-sync-insights";
                payload.granularity = "hourly";
                break;
              case 'insight_daily':
                functionName = "fb-sync-insights";
                payload.granularity = "daily";
                payload.date_preset = "today";
                break;
              case 'insight_region':
                functionName = "fb-sync-insights";
                payload.breakdowns = "region";
                break;
              case 'insight_device':
                functionName = "fb-sync-insights";
                payload.breakdowns = "device";
                break;
              case 'insight_placement':
                functionName = "fb-sync-insights";
                payload.breakdowns = "placement";
                break;
              case 'creative': functionName = "fb-sync-creatives"; break;
              case 'maintenance': functionName = "maintenance"; break;
              default:
                console.warn(`[Dispatch] Unknown cron_type: ${settingType}`);
                continue;
            }

            if (functionName) {
              // Maintenance only needs to run once per user, not per account
              if (settingType === 'maintenance' && acct.id !== accs[0].id) continue;
              
              console.log(`[Dispatch] Queueing: ${functionName} for account ${acct.id}`);
              allTriggerPromises.push(callEdgeFunction(functionName, payload));
            }
          }

          // Update last_run_at to NOW (UTC)
          await supabase.from("cron_settings").update({ last_run_at: getUTCNow() }).eq("id", setting.id);
          totalResults.push({ id: setting.id, type: settingType, status: "dispatched" });
        }
      } catch (userErr: any) {
        console.error(`[Dispatch] Error processing user ${userId}:`, userErr.message);
      }
    }

    // WAIT FOR ALL TRIGGERS TO FINISH
    console.log(`[Dispatch] Waiting for ${allTriggerPromises.length} triggers...`);
    const results = await Promise.allSettled(allTriggerPromises);
    const successCount = results.filter(r => r.status === 'fulfilled').length;
    
    console.log(`[Dispatch] Finished. Success: ${successCount}/${allTriggerPromises.length}`);

    return jsonResponse({ success: true, processed: totalResults.length, triggers: allTriggerPromises.length, successCount });
  } catch (error: any) {
    console.error(`[Dispatch] Fatal error:`, error.message);
    return jsonResponse({ success: false, error: error.message }, 500);
  }
});
