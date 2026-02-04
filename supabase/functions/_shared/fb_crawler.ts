
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

            // If URL didn't yield ID or as a primary strategy, scrape the HTML for the direct CDN link
            const html = await res.text();
            
            // Look for actual Facebook CDN links (scontent) which are the "real" images
            // We look for common patterns in m.facebook.com HTML for profile pictures
            const cdnPatterns = [
                /https:\/\/scontent\.[^"&?]+\/v\/[^"&?]+\.(?:jpg|png|webp)[^"&?]*/gi,
                /https:\\[\/][\/]scontent\.[^"&?]+\/v\/[^"&?]+\.(?:jpg|png|webp)[^"&?]*/gi
            ];

            for (const pattern of cdnPatterns) {
                const matches = html.match(pattern);
                if (matches) {
                    // Find the most likely profile picture (usually has 'p100x100', 'p200x200' or similar in the URL)
                    // Or just pick the first one that looks like a profile pic
                    for (let match of matches) {
                        match = match.replace(/\\/g, ''); // Clean up escaped slashes
                        if (match.includes('/v/') && (match.includes('stp=') || match.includes('_n.'))) {
                            console.log("[FB-Crawler] Found direct CDN avatar: " + match.substring(0, 50) + "...");
                            return match.replace(/&amp;/g, "&");
                        }
                    }
                }
            }

            // Fallback: try to find the UID and return a standard placeholder ONLY if absolutely necessary,
            // but we'll try to find any scontent link first.
            const bodyMatch = html.match(/"entity_id":"(\d+)"/);
            uid = bodyMatch ? bodyMatch[1] : (html.match(/"userID":"(\d+)"/)?.[1] || null);

            if (uid) {
                console.log("[FB-Crawler] Successfully resolved UID as fallback: " + uid);
                // Even with UID, we prefer the scraped link. 
                // Using a public URL that might work without API if scraping fails 
                return `https://www.facebook.com/search/top/?q=${uid}`; // Not an image, just a fallback marker
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
