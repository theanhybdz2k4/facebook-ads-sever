
const PSID = "26913559891566784";
// Unofficial public tokens often used in VN for lookups
const PUBLIC_TOKENS = [
    "6628568379|c1e620fa708a1d5696fb991c1bde5662", // Facebook for Windows
    "350685531728|62f8ce9f74b12f84c123cc23437a4e32"  // Facebook for Android
];

async function test() {
    for (const token of PUBLIC_TOKENS) {
        console.log(`\n--- Testing with Token: ${token.substring(0, 15)}... ---`);
        try {
            const url = `https://graph.facebook.com/${PSID}/picture?type=large&redirect=false&access_token=${token}`;
            const res = await fetch(url);
            const data = await res.json();
            console.log(JSON.stringify(data, null, 2));
        } catch (e) { console.error(e.message); }
    }
}

test();
