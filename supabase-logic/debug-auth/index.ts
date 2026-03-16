import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { verify } from "https://deno.land/x/djwt@v3.0.1/mod.ts";

Deno.serve(async (req) => {
    const secret = Deno.env.get("JWT_SECRET");
    const authHeader = req.headers.get("Authorization");
    const token = authHeader?.replace("Bearer ", "") || "";

    let result = "no-token";
    let payload = null;

    if (token) {
        try {
            const encoder = new TextEncoder();
            const key = await crypto.subtle.importKey("raw", encoder.encode(secret || ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
            payload = await verify(token, key);
            result = "success";
        } catch (e) {
            result = `fail: ${e.message}`;
        }
    }

    return new Response(JSON.stringify({
        result,
        secretLen: secret?.length || 0,
        payload,
        tokenStart: token.substring(0, 10)
    }), { headers: { "Content-Type": "application/json" } });
});
