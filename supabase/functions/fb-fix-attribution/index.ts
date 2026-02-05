
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const supabase = createClient(supabaseUrl, supabaseKey);

const FB_BASE_URL = "https://graph.facebook.com/v24.0";

const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const jsonResponse = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: corsHeaders });

// Helper to convert timestamp to Vietnam timezone (UTC+7) for storage
function toVietnamTimestamp(timestamp: number | string | Date): string {
    const date = new Date(timestamp);
    const vnTime = new Date(date.getTime() + 7 * 60 * 60 * 1000);
    return vnTime.toISOString().slice(0, 19).replace('T', ' ');
}

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

    try {
        const body = await req.json().catch(() => ({}));
        const { date, limit = 100 } = body; // date format: YYYY-MM-DD
        
        const targetDate = date || new Date().toISOString().split('T')[0];
        const nextDate = new Date(new Date(targetDate).getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        
        console.log(`[Fix Attribution] Processing leads from ${targetDate} to ${nextDate}`);

        // 1. Get active User Token
        const { data: creds } = await supabase.from("platform_credentials").select("credential_value").eq("is_active", true).limit(1);
        if (!creds?.length) throw new Error("No active FB token found");
        const userToken = creds[0].credential_value;

        // 2. Fetch Pages with tokens
        const pagesRes = await fetch(`${FB_BASE_URL}/me/accounts?fields=id,name,access_token&limit=50&access_token=${userToken}`);
        const pagesData = await pagesRes.json();
        const pages = pagesData.data || [];
        
        const pageTokens: Record<string, string> = {};
        const pageNames: Record<string, string> = {};
        pages.forEach((p: any) => {
            pageTokens[p.id] = p.access_token;
            pageNames[p.id] = p.name;
        });

        // 3. Get Ad mapping
        const { data: adsData } = await supabase.from("unified_ads").select("external_id, platform_account_id");
        const adToAccountMap: Record<string, number> = {};
        adsData?.forEach((a: any) => adToAccountMap[a.external_id] = a.platform_account_id);

        // 4. Get active leads on the target date (both new and existing students)
        // This is crucial to match Meta's definition which includes returning customers clicking ads
        const { data: leads } = await supabase
            .from("leads")
            .select("id, external_id, fb_page_id, customer_name, source_campaign_id, platform_account_id, metadata, platform_data")
            .gte("last_message_at", `${targetDate} 00:00:00`)
            .lt("last_message_at", `${nextDate} 23:59:59`)
            .limit(limit);

        if (!leads || leads.length === 0) {
            return jsonResponse({ success: true, message: "No active leads found to check attribution", checked: 0 });
        }

        console.log(`[Fix Attribution] Checking ${leads.length} active leads for ad interactions on ${targetDate}`);

        let fixed = 0;
        let errors = 0;
        const results: any[] = [];

        for (const lead of leads) {
            const pageId = lead.fb_page_id;
            const pageToken = pageTokens[pageId];
            
            if (!pageToken) {
                console.log(`[Fix Attribution] No token for page ${pageId}, skipping ${lead.customer_name}`);
                continue;
            }

            try {
                // Fetch conversations for this page to find this customer
                const customerId = lead.external_id;
                
                // Call conversations endpoint and find the one with this customer
                // Add referral to fields
                const convUrl = `${FB_BASE_URL}/${pageId}/conversations?fields=id,participants,snippet,updated_time,referral&user_id=${customerId}&access_token=${pageToken}`;
                const convRes = await fetch(convUrl);
                const convData = await convRes.json();
                
                if (convData.error) {
                    console.log(`[Fix Attribution] Conv error for ${lead.customer_name}: ${convData.error.message}`);
                    errors++;
                    continue;
                }

                const conversations = convData.data || [];
                if (conversations.length === 0) {
                    // Fallback: query all recent conversations
                    const allConvUrl = `${FB_BASE_URL}/${pageId}/conversations?fields=id,participants,snippet,referral&limit=100&access_token=${pageToken}`;
                    const allConvRes = await fetch(allConvUrl);
                    const allConvData = await allConvRes.json();
                    
                    const allConversations = allConvData.data || [];
                    const matched = allConversations.find((c: any) => 
                        c.participants?.data?.some((p: any) => String(p.id) === customerId)
                    );
                    
                    if (matched) {
                        conversations.push(matched);
                    }
                }

                if (conversations.length === 0) {
                    console.log(`[Fix Attribution] No conversation found for ${lead.customer_name}`);
                    continue;
                }

                const conv = conversations[0];
                const convId = conv.id;

                // 1. Try referral from conversation context
                let adId: string | null = conv.referral?.ad_id || 
                                        conv.referral?.campaign_id || 
                                        conv.referral?.id; // sometimes referral itself has ID

                // 2. Try messages if conversation referral is missing
                if (!adId) {
                    const msgUrl = `${FB_BASE_URL}/${convId}/messages?fields=id,referral,created_time&limit=50&access_token=${pageToken}`;
                    const msgRes = await fetch(msgUrl);
                    const msgData = await msgRes.json();
                    
                    if (!msgData.error) {
                        const messages = msgData.data || [];
                        for (const m of messages) {
                            const foundId = m.referral?.ad_id || 
                                           m.referral?.campaign_id || 
                                           m.referral?.ads_context_data?.ad_id;
                            if (foundId) {
                                adId = String(foundId);
                                console.log(`[Fix Attribution] Found ad_id ${adId} in messages for ${lead.customer_name}`);
                                break;
                            }
                        }
                    }
                }

                // 3. Try matching by title if it exists in lead metadata
                if (!adId && lead.metadata?.ad_title) {
                    const adTitle = lead.metadata.ad_title;
                    console.log(`[Fix Attribution] Attempting title match for "${adTitle}"...`);
                    
                    // Fuzzy match: check if any ad name contains the title (excluding emojis/special chars)
                    const cleanTitle = adTitle.replace(/[^\w\sÀ-ỹ]/g, '').trim();
                    const searchTerms = cleanTitle.split(' ').filter((w: string) => w.length > 3).slice(0, 3);
                    
                    if (searchTerms.length > 0) {
                        const searchPattern = '%' + searchTerms.join('%') + '%';
                        const { data: matchedAds } = await supabase
                            .from("unified_ads")
                            .select("external_id, platform_account_id")
                            .ilike("name", searchPattern)
                            .limit(1);
                            
                        if (matchedAds && matchedAds.length > 0) {
                            adId = matchedAds[0].external_id;
                            console.log(`[Fix Attribution] TITLE MATCH SUCCESS: Found ad_id ${adId} for title "${adTitle}"`);
                        }
                    }
                }

                if (adId) {
                    // Get correct platform_account_id for this ad
                    let newAccountId = adToAccountMap[adId] || lead.platform_account_id;
                    
                    // Update lead
                    const { error: updateErr } = await supabase
                        .from("leads")
                        .update({
                            source_campaign_id: adId,
                            is_qualified: true,
                            platform_account_id: newAccountId,
                            metadata: {
                                ...(lead.metadata || {}),
                                qualified_at: targetDate === new Date().toISOString().split('T')[0] 
                                    ? toVietnamTimestamp(new Date()) 
                                    : `${targetDate} 12:00:00`
                            },
                            platform_data: {
                                ...(lead.platform_data || {}),
                                fb_conv_id: convId,
                                fb_page_id: pageId,
                                fb_page_name: pageNames[pageId],
                                snippet: conv.snippet
                            }
                        })
                        .eq("id", lead.id);

                    if (updateErr) {
                        console.log(`[Fix Attribution] Update error for ${lead.customer_name}: ${updateErr.message}`);
                        errors++;
                    } else {
                        fixed++;
                        results.push({ name: lead.customer_name, ad_id: adId });
                        console.log(`[Fix Attribution] Fixed ${lead.customer_name} with ad_id ${adId}`);
                    }
                } else {
                    // No ad found - this is organic, update with conv_id at least
                    await supabase
                        .from("leads")
                        .update({
                            platform_data: {
                                fb_conv_id: convId,
                                fb_page_id: pageId,
                                fb_page_name: pageNames[pageId],
                                snippet: conv.snippet
                            }
                        })
                        .eq("id", lead.id);
                    
                    console.log(`[Fix Attribution] ${lead.customer_name} is organic (no ad referral)`);
                }

                // Small delay to avoid rate limiting
                await new Promise(r => setTimeout(r, 100));

            } catch (e: any) {
                console.log(`[Fix Attribution] Error processing ${lead.customer_name}: ${e.message}`);
                errors++;
            }
        }

        return jsonResponse({
            success: true,
            date: targetDate,
            total_leads: leads.length,
            fixed,
            errors,
            results
        });

    } catch (err: any) {
        console.log(`[Fix Attribution] FATAL: ${err.message}`);
        return jsonResponse({ success: false, error: err.message }, 500);
    }
});
