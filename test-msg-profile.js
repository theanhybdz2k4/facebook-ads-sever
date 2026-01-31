
const FB_BASE_URL = "https://graph.facebook.com/v24.0";
const PAGE_TOKEN = "EAAeAaASdYvIBQo21bf8SKzNechyRdUz0mT5CNr9qcutgFwLEEQvRHX4o87RADRqbbwYaX8BGgyuXzqZB2tWKtiZA5HqaM43kmwJdLAp2nZCZBCKwuF5L6wZA3HZB2sThl9Y3b59taxT8xTYlYRpzQaPeQhaO1zPKR1ZAMOh57r3UlfPwwRCWojFhb74pJhZBdYZAQT2GclIRwShiPBiqME87ZALnZAksQZDZD";
const MSG_ID = "m_4__VkW_wp-UQSJjiVoFvATPe60d0lS9tetNY6EPePmMHQWHz2bQKpmMlW2U-blfyyR_YOlvdBMsAUqQdQufDkA";

async function test() {
    console.log(`Testing avatar fetching for Message ID: ${MSG_ID}\n`);

    try {
        console.log("--- Method: Message ID -> from{picture} ---");
        const res = await fetch(`${FB_BASE_URL}/${MSG_ID}?fields=from{id,name,picture}&access_token=${PAGE_TOKEN}`);
        const data = await res.json();
        console.log(JSON.stringify(data, null, 2));
    } catch (e) { console.error(e.message); }
}

test();
