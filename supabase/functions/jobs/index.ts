import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const url = new URL(req.url);
    const path = url.pathname.split("/").filter(Boolean);

    // GET /jobs - List recent jobs
    if (req.method === "GET") {
      const limit = parseInt(url.searchParams.get("limit") || "50");
      const offset = parseInt(url.searchParams.get("offset") || "0");

      const { data, error, count } = await supabase
        .from("sync_jobs")
        .select(`
          *,
          account:platform_accounts(id, name, external_id)
        `, { count: "exact" })
        .order("createdAt", { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) throw error;

      return new Response(JSON.stringify({ data, total: count }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /jobs/dispatch - Trigger a new sync dispatch
    if (req.method === "POST" && path[1] === "dispatch") {
      const body = await req.json().catch(() => ({}));
      
      // Proxy to fb-dispatch
      const res = await fetch(`${supabaseUrl}/functions/v1/fb-dispatch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: req.headers.get("Authorization") || "",
        },
        body: JSON.stringify({ ...body, force: true }),
      });

      const result = await res.json();
      return new Response(JSON.stringify(result), {
        status: res.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
