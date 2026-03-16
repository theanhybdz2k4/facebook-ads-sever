import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const supabaseUrl = Deno.env.get('SUPABASE_URL') || process.env.SUPABASE_URL;
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkMessages() {
    const { data, error } = await supabase
        .from('leads')
        .select('customer_name, messages')
        .ilike('customer_name', '%Trần Thế Anh%')
        .order('last_message_at', { ascending: false })
        .limit(1);

    if (error) {
        console.error("DB Error:", error);
        return;
    }

    if (!data || data.length === 0) {
        console.log("Lead not found");
        return;
    }

    const messages = data[0].messages || [];

    console.log(`Found ${messages.length} messages for lead ${data[0].customer_name}`);

    // Show the last 15 messages to capture the context
    console.log(JSON.stringify(messages.slice(-15), null, 2));
}

checkMessages();
