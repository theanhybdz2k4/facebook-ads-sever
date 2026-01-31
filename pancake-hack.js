
/**
 * Pancake-style Avatar Fetcher
 * Uses a Facebook Admin Cookie to fetch user info via mobile site redirects or GraphQL.
 */
async function fetchAvatarWithCookie(psid, cookie) {
    console.log(`[Pancake-Hack] Attempting fetch for PSID: ${psid}`);
    
    // Step 1: Try Mobile Redirect (Fastest)
    const url = `https://m.facebook.com/${psid}`;
    try {
        const res = await fetch(url, {
            headers: {
                'Cookie': cookie,
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Mobile/15E148 Safari/604.1',
                'Accept': 'text/html'
            },
            redirect: 'follow'
        });

        const finalUrl = res.url;
        console.log(`[Pancake-Hack] Redirected to: ${finalUrl}`);

        // If redirected to /profile.php?id=... or a username, we can get the UID
        let uid = null;
        const uidMatch = finalUrl.match(/id=(\d+)/);
        if (uidMatch) uid = uidMatch[1];
        else {
            // Handle username style results
            const usernameMatch = finalUrl.match(/m.facebook.com\/([^/?#]+)/);
            if (usernameMatch && !['login', 'profile.php'].includes(usernameMatch[1])) {
                uid = usernameMatch[1];
            }
        }

        if (uid) {
            console.log(`[Pancake-Hack] Found UID/Username: ${uid}`);
            return `https://graph.facebook.com/${uid}/picture?type=large`;
        }

        // Step 2: Extract from HTML if redirect didn't help
        const text = await res.text();
        const entityMatch = text.match(/"entity_id":"(\d+)"/);
        if (entityMatch) {
            console.log(`[Pancake-Hack] Extracted UID from HTML: ${entityMatch[1]}`);
            return `https://graph.facebook.com/${entityMatch[1]}/picture?type=large`;
        }

    } catch (e) {
        console.error(`[Pancake-Hack] Error: ${e.message}`);
    }

    return null;
}

// Test block (using placeholders)
const COOKIE = "pancake_style_cookie_placeholder"; 
const TEST_PSID = "26913559891566784";

fetchAvatarWithCookie(TEST_PSID, COOKIE).then(url => {
    console.log("Resulting Avatar URL:", url);
});
