/**
 * Facebook Sync - Ad Accounts (Independent Sync)
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const supabase = createClient(supabaseUrl, supabaseKey);

const FB_API_VERSION = "v24.0";
const FB_BASE_URL = "https://graph.facebook.com/" + FB_API_VERSION;

async function verifyAuth(req: Request) {
    const authHeader = req.headers.get("Authorization");
    const masterKey = Deno.env.get("MASTER_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (authHeader?.startsWith("Bearer ")) {
        const token = authHeader.substring(7).trim();
        if ((masterKey && token === masterKey) || (serviceKey && token === serviceKey)) {
            return { userId: 1, isSystem: true };
        }
    }
    return null;
}

function getVietnamTime(): string {
    const vn = new Date(new Date().getTime() + 7 * 60 * 60 * 1000);
    return vn.toISOString().replace('T', ' ').substring(0, 19);
}

const corsHeaders = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" };
const jsonResponse = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: corsHeaders });

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

    const auth = await verifyAuth(req);
    if (!auth) return jsonResponse({ success: false, error: "Unauthorized" }, 401);

    try {
        const { accountId } = await req.json();
        if (!accountId) return jsonResponse({ success: false, error: "accountId is required" }, 400);

        const { data: account, error: accErr } = await supabase
            .from("platform_accounts")
            .select("id, external_id, currency, platform_identities!inner (platform_credentials (credential_value, is_active))")
            .eq("id", accountId)
            .maybeSingle();

        if (accErr || !account) return jsonResponse({ success: false, error: "Account not found" }, 404);

        const token = account.platform_identities?.platform_credentials?.find((c: any) => c.is_active)?.credential_value;
        if (!token) return jsonResponse({ success: false, error: "No active token" }, 401);

        const fbRes = await fetch(`${FB_BASE_URL}/${account.external_id}?fields=id,name,account_status,currency,amount_spent,balance,timezone_name&access_token=${token}`);
        const fbAccount = await fbRes.json();

        if (fbAccount.error) throw new Error(fbAccount.error.message);

        const offset = ["VND", "JPY", "KRW", "CLP", "PYG", "ISK"].includes(account.currency?.toUpperCase()) ? 1 : 100;

        await supabase.from("platform_accounts").update({
            account_status: fbAccount.account_status ? String(fbAccount.account_status) : undefined,
            name: fbAccount.name,
            platform_data: {
                amount_spent: fbAccount.amount_spent ? parseFloat(fbAccount.amount_spent) / offset : 0,
                balance: fbAccount.balance ? parseFloat(fbAccount.balance) / offset : 0,
                timezone_name: fbAccount.timezone_name,
            },
            synced_at: getVietnamTime()
        }).eq("id", accountId);

        return jsonResponse({ success: true, message: "Account info updated" });
    } catch (error: any) {
        return jsonResponse({ success: false, error: error.message }, 500);
    }
});
