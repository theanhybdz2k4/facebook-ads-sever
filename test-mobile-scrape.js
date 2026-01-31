
const PSID = "26913559891566784";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Mobile/15E148 Safari/604.1";

async function testMobile() {
    console.log(`Testing Mobile Scrape for PSID: ${PSID}`);
    const url = `https://m.facebook.com/${PSID}`;
    try {
        const res = await fetch(url, {
            headers: { 'User-Agent': UA, 'Accept': 'text/html' },
            redirect: 'follow'
        });
        console.log(`Status: ${res.status}`);
        console.log(`Final URL: ${res.url}`);
        const text = await res.text();
        console.log(`Title: ${text.match(/<title>(.*?)<\/title>/)?.[1]}`);
        console.log(`Images found: ${text.match(/<img/g)?.length || 0}`);
        if (text.includes("login_form") || text.includes("Log in")) {
            console.log("REJECTED: Redirected to Login Page.");
        } else {
            console.log("SUCCESS? No login found.");
        }
    } catch (e) {
        console.error(e.message);
    }
}

testMobile();
