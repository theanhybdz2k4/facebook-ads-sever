
import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";

/**
 * Resolves a Facebook PSID to a Real UID/Avatar using a session cookie or user token.
 */
export async function resolveAvatarWithCrawler(supabase: SupabaseClient, psid: string): Promise<string | null> {
    console.log("[FB-Crawler] Attempting to resolve avatar for PSID: " + psid + "...");

    try {
        // 1. Get the crawler credential from platform_credentials
        const { data: credential } = await supabase
            .from("platform_credentials")
            .select("credential_value, credential_type")
            .in("credential_type", ["fb_crawler_cookie", "fb_crawler_user_token"])
            .eq("is_active", true)
            .order("credential_type", { ascending: false }) // Prioritize cookie for now
            .limit(1)
            .maybeSingle();

        if (!credential) {
            console.log("[FB-Crawler] No active crawler cookies/tokens found in platform_credentials.");
            return null;
        }

        if (credential.credential_type === "fb_crawler_cookie") {
            const cookie = credential.credential_value;
            console.log("[FB-Crawler] Using session cookie strategy...");

            // Strategy: Visit m.facebook.com/{psid} with cookie to find the real ID
            const url = "https://m.facebook.com/" + psid;
            const res = await fetch(url, {
                headers: {
                    "Cookie": cookie,
                    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Mobile/15E148 Safari/604.1",
                    "Accept": "text/html"
                },
                redirect: "follow"
            });

            const finalUrl = res.url;
            console.log("[FB-Crawler] Final URL after redirects: " + finalUrl);

            // Try to extract UID from URL (e.g., id=1000... or /username)
            let uidMatch = finalUrl.match(/id=(\d+)/);
            let uid = uidMatch ? uidMatch[1] : null;

            if (!uid) {
                try {
                    const parsedUrl = new URL(finalUrl);
                    const pathParts = parsedUrl.pathname.split("/");
                    const profileId = pathParts[1];
                    if (profileId && !["login.php", "profile.php", "login"].includes(profileId)) {
                        uid = profileId;
                    }
                } catch (e) { }
            }

            // If URL didn't yield ID, try HTML body
            if (!uid) {
                const html = await res.text();
                const bodyMatch = html.match(/"entity_id":"(\d+)"/);
                const uidMatchHtml = html.match(/"userID":"(\d+)"/);
                uid = bodyMatch ? bodyMatch[1] : (uidMatchHtml ? uidMatchHtml[1] : null);
            }

            if (uid) {
                console.log("[FB-Crawler] Successfully resolved UID: " + uid);
                return "https://graph.facebook.com/" + uid + "/picture?type=large";
            } else {
                console.log("[FB-Crawler] Failed to extract UID from redirect or HTML.");
            }
        } else if (credential.credential_type === "fb_crawler_user_token") {
            // Fallback strategy using a high-privilege user token if available
            console.log("[FB-Crawler] Using public user token strategy...");
            const token = credential.credential_value;
            const res = await fetch("https://graph.facebook.com/" + psid + "/picture?type=large&redirect=false&access_token=" + token);
            const data = await res.json();
            if (data.data?.url) return data.data.url;
        }

    } catch (e: any) {
        console.error("[FB-Crawler] Error during resolution: " + e.message);
    }

    return null;
}
