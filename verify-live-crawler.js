
const PSID = "26913559891566784";
const COOKIE = "datr=zkgxaS9DaEPWcxrIO9uh0dDU; sb=zkgxabycK1SyLFchc9slyUha; ps_l=1; ps_n=1; dpr=1.25; c_user=100089316343240; xs=50%3ACNOOnhiaB9nl0Q%3A2%3A1769829691%3A-1%3A-1%3A%3AAczECHnkwQHc4PAA8_eSbaTQdbo8zfQQksS1ua8Xwg; wd=858x730; fr=1v93ykOmqaLvn305d.AWdTYDGGhvJ27zskOxiDSXxheNTzzC9euNCIbeMC7toHYreZhOo.BpfXVA..AAA.0.0.BpfXVL.AWfVbJNe805y6Z5pN7VYthgNaK0; presence=C%7B%22t3%22%3A%5B%5D%2C%22utc3%22%3A1769829714933%2C%22v%22%3A1%7D";

async function verify() {
    console.log(`Verifying live crawler for PSID: ${PSID}`);
    const url = `https://m.facebook.com/${PSID}`;
    try {
        const res = await fetch(url, {
            headers: {
                "Cookie": COOKIE,
                "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Mobile/15E148 Safari/604.1",
                "Accept": "text/html"
            },
            redirect: "follow"
        });

        console.log(`Redirected to: ${res.url}`);
        const html = await res.text();
        const entityMatch = html.match(/"entity_id":"(\d+)"/);
        const userMatch = html.match(/"userID":"(\d+)"/);
        const uid = entityMatch ? entityMatch[1] : (userMatch ? userMatch[1] : null);

        if (uid) {
            console.log(`SUCCESS! Resolved UID: ${uid}`);
            console.log(`Avatar URL: https://graph.facebook.com/${uid}/picture?type=large`);
        } else {
            console.log("FAILED: Could not find UID in HTML metadata.");
            // Log a bit of body to see why
            console.log("Snippet:", html.substring(0, 500));
        }
    } catch (e) {
        console.error("Verification error:", e.message);
    }
}

verify();
