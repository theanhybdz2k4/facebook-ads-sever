import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const masterKey = Deno.env.get("MASTER_KEY") || "";

async function testReport() {
    console.log("Fetching AI Report from Edge Function...");
    const functionUrl = `${supabaseUrl}/functions/v1/ads-analytics-report/report/campaign/bf4a1964-8c1c-4e8b-8a2b-97e45fcad887`;

    try {
        const response = await fetch(functionUrl, {
            method: "GET",
            headers: {
                "Authorization": `Bearer ${masterKey}`,
                "Content-Type": "application/json"
            }
        });

        console.log(`Status: ${response.status} ${response.statusText}`);
        const data = await response.json();

        if (response.ok) {
            console.log("SUCCESS ✅");
            console.log(`Report Title: ${data.data?.report?.title || "N/A"}`);
            if (data.data?.raw_response) {
                console.log("\n--- Preview Markdown ---");
                console.log(data.data.raw_response.slice(0, 300) + "...\n------------------------");
            }
        } else {
            console.error("FAILED ❌");
            console.error(data);
        }
    } catch (e: any) {
        console.error("Network Error:", e.message);
    }
}

testReport();
