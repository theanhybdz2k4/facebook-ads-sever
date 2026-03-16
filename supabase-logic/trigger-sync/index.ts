
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const supabase = createClient(supabaseUrl, serviceKey);

Deno.serve(async (req) => {
    const logs: string[] = [];
    function log(msg: string) {
        console.log(msg);
        logs.push(msg);
    }

    try {
        const branchId = 3;
        log(`Starting manual sync for Branch ${branchId}`);

        // Get accounts
        const { data: accounts, error } = await supabase
            .from("platform_accounts")
            .select("id, name")
            .eq("branch_id", branchId);

        if (error) throw error;
        log(`Found ${accounts?.length} accounts: ${JSON.stringify(accounts)}`);

        const results = [];
        const end = new Date();
        const start = new Date();
        start.setDate(end.getDate() - 5);
        const dateStart = start.toISOString().split("T")[0];
        const dateEnd = end.toISOString().split("T")[0];

        for (const acc of (accounts || [])) {
            const endpoint = `${supabaseUrl}/functions/v1/fb-sync-insights`;
            log(`Syncing Account ${acc.id} (${acc.name}) via ${endpoint}`);

            const res = await fetch(endpoint, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${serviceKey}`
                },
                body: JSON.stringify({
                    accountId: acc.id,
                    dateStart,
                    dateEnd,
                    granularity: "BOTH"
                })
            });

            const text = await res.text();
            log(`Res [${res.status}]: ${text.substring(0, 500)}`);
            results.push({ accountId: acc.id, status: res.status, body: text });
        }

        return new Response(JSON.stringify({ success: true, logs, results }), {
            headers: { "Content-Type": "application/json" }
        });

    } catch (error: any) {
        log(`Error: ${error.message}`);
        return new Response(JSON.stringify({ success: false, error: error.message, logs }), { status: 500 });
    }
});
