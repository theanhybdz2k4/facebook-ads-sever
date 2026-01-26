/**
 * Facebook Sync - Insights (BATCH OPTIMIZED)
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const supabase = createClient(supabaseUrl, supabaseKey);

const FB_BASE_URL = "https://graph.facebook.com/v19.0";

function getVietnamToday(): string {
    const vn = new Date(new Date().getTime() + 7 * 60 * 60 * 1000);
    return vn.toISOString().split("T")[0];
}

function getVietnamYesterday(): string {
    const vn = new Date(new Date().getTime() + 7 * 60 * 60 * 1000);
    vn.setDate(vn.getDate() - 1);
    return vn.toISOString().split("T")[0];
}

function getVietnamTime(): string {
    const vn = new Date(new Date().getTime() + 7 * 60 * 60 * 1000);
    const y = vn.getUTCFullYear();
    const m = String(vn.getUTCMonth() + 1).padStart(2, '0');
    const d = String(vn.getUTCDate()).padStart(2, '0');
    const h = String(vn.getUTCHours()).padStart(2, '0');
    const min = String(vn.getUTCMinutes()).padStart(2, '0');
    const s = String(vn.getUTCSeconds()).padStart(2, '0');
    return `${y}-${m}-${d} ${h}:${min}:${s}`;
}

class FacebookApiClient {
    constructor(private accessToken: string) { }

    async getInsights(entityId: string, level: string, dateRange: { start: string; end: string }, granularity: "DAILY" | "HOURLY" = "DAILY", breakdowns?: string): Promise<any[]> {
        if (granularity === "HOURLY" && dateRange.start !== dateRange.end) {
            const arr = [];
            const dt = new Date(dateRange.start);
            const end = new Date(dateRange.end);
            while (dt <= end) {
                arr.push(dt.toISOString().split("T")[0]);
                dt.setDate(dt.getDate() + 1);
            }
            
            let all: any[] = [];
            for (const d of arr) {
                const chunk = await this.getInsights(entityId, level, { start: d, end: d }, granularity, breakdowns);
                all = all.concat(chunk);
            }
            return all;
        }

        const fields = ["ad_id", "adset_id", "campaign_id", "date_start", "date_stop", "spend", "impressions", "clicks", "actions", "action_values"];
        if (granularity !== "HOURLY") fields.push("reach");

        const params: any = {
            level,
            time_range: JSON.stringify({ since: dateRange.start, until: dateRange.end }),
            fields: fields.join(","),
            limit: "1000",
        };

        if (granularity === "HOURLY") params.breakdowns = "hourly_stats_aggregated_by_advertiser_time_zone";
        else {
            params.time_increment = "1";
            if (breakdowns) {
                if (breakdowns === "device") params.breakdowns = "device_platform";
                else if (breakdowns === "age_gender") params.breakdowns = "age,gender";
                else if (breakdowns === "region") params.breakdowns = "region";
                else params.breakdowns = breakdowns;
            }
        }

        const url = new URL(`${FB_BASE_URL}/${entityId}/insights`);
        url.searchParams.set("access_token", this.accessToken);
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v as string);

        let allData: any[] = [];
        let nextUrl: string | null = url.toString();

        while (nextUrl) {
            const response = await fetch(nextUrl);
            const data = await response.json();
            if (data.error) throw new Error(`FB API: ${data.error.message}`);
            if (data.data) allData = allData.concat(data.data);
            nextUrl = data.paging && data.paging.next ? data.paging.next : null;
        }
        return allData;
    }
}

function extractResults(raw: any): number {
    if (!raw.actions) return 0;
    const types = ["onsite_conversion.messaging_conversation_started_7d", "onsite_conversion.messaging_first_reply", "lead", "purchase"];
    return raw.actions.filter((a: any) => types.includes(a.action_type)).reduce((s: number, a: any) => s + Number(a.value), 0);
}

const corsHeaders = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" };
const jsonResponse = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: corsHeaders });

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

    const url = new URL(req.url);
    try {
        if (req.method === "GET") {
            const dateStart = url.searchParams.get("dateStart");
            const dateEnd = url.searchParams.get("dateEnd");
            const adId = url.searchParams.get("adId");
            const accountId = url.searchParams.get("accountId");

            let query = supabase.from("unified_insights").select(`
                *,
                unified_ads(id, name, external_id),
                unified_ad_groups(id, name),
                unified_campaigns(id, name)
             `);

            if (dateStart) query = query.gte("date", dateStart);
            if (dateEnd) query = query.lte("date", dateEnd);
            if (adId) query = query.eq("unified_ad_id", adId);
            if (accountId) query = query.eq("platform_account_id", accountId);

            const { data, error } = await query.order("date", { ascending: false }).limit(1000);
            if (error) throw error;

            // Map to camelCase for frontend
            const mapped = (data || []).map((i: any) => ({
                id: i.id,
                date: i.date,
                adId: i.unified_ad_id,
                impressions: i.impressions,
                clicks: i.clicks,
                spend: i.spend,
                reach: i.reach,
                results: i.results,
                ad: i.unified_ads ? {
                    id: i.unified_ads.id,
                    name: i.unified_ads.name,
                    externalId: i.unified_ads.external_id,
                    account: i.unified_ads.platform_account_id
                } : null
            }));

            return jsonResponse(mapped);
        }

        if (req.method === "POST") {
            const body = await req.json();
            const { accountId: bodyAccountId, adId: bodyAdId, dateStart = getVietnamYesterday(), dateEnd = getVietnamToday(), granularity = "DAILY", breakdown } = body;

            let targetAccountId = bodyAccountId;
            let fbEntityId: string | null = null;

            if (bodyAdId) {
                const { data: ad } = await supabase.from("unified_ads").select("external_id, platform_account_id").eq("id", bodyAdId).single();
                if (ad) { targetAccountId = ad.platform_account_id; fbEntityId = ad.external_id; }
            }

            if (!targetAccountId) return jsonResponse({ success: false, error: "Missing accountId" }, 400);

            const { data: account, error: accountError } = await supabase.from("platform_accounts").select(`id, external_id, platform_identities!inner(platform_credentials(credential_value))`).eq("id", targetAccountId).single();

            if (accountError || !account) return jsonResponse({ success: false, error: "Account not found" }, 404);

            if (!fbEntityId) fbEntityId = account.external_id;

            const token = account?.platform_identities?.platform_credentials?.find((c: any) => c.credential_value)?.credential_value;
            if (!token) return jsonResponse({ success: false, error: "No token" }, 401);

            const fb = new FacebookApiClient(token);
            const vnNow = getVietnamTime();
            console.log(`[Insights] Sync start at VN Time: ${vnNow}`);
            const result: any = { insights: 0, hourly: 0, breakdowns: 0, debug: { vnNow } };

            const { data: campaigns } = await supabase.from("unified_campaigns").select("id, external_id").eq("platform_account_id", targetAccountId);
            const { data: adGroups } = await supabase.from("unified_ad_groups").select("id, external_id").eq("platform_account_id", targetAccountId);
            const { data: ads } = await supabase.from("unified_ads").select("id, external_id").eq("platform_account_id", targetAccountId);

            const campaignMap = new Map(campaigns?.map((c: any) => [c.external_id, c.id]));
            const adGroupMap = new Map(adGroups?.map((ag: any) => [ag.external_id, ag.id]));
            const adMap = new Map(ads?.map((a: any) => [a.external_id, a.id]));

            // Pre-fetch existing insights for ID mapping
            const { data: existingInsights } = await supabase.from("unified_insights").select("id, platform_account_id, unified_campaign_id, unified_ad_group_id, unified_ad_id, date").eq("platform_account_id", targetAccountId).gte("date", dateStart).lte("date", dateEnd);
            const getInsightKey = (i: any) => `${i.platform_account_id}|${i.unified_campaign_id}|${i.unified_ad_group_id}|${i.unified_ad_id}|${i.date}`;
            const insightIdMap = new Map(existingInsights?.map((i: any) => [getInsightKey(i), i.id]));

            if (granularity === "DAILY" || granularity === "BOTH") {
                const fbInsights = await fb.getInsights(fbEntityId as string, "ad", { start: dateStart, end: dateEnd });
                if (fbInsights.length > 0) {
                    const upserts = fbInsights.map(raw => {
                        const cid = campaignMap.get(raw.campaign_id) || null;
                        const agid = adGroupMap.get(raw.adset_id) || null;
                        const adid = adMap.get(raw.ad_id) || null;
                        const key = `${targetAccountId}|${cid}|${agid}|${adid}|${raw.date_start}`;
                        return {
                            id: insightIdMap.get(key) || crypto.randomUUID(),
                            platform_account_id: targetAccountId,
                            unified_campaign_id: cid,
                            unified_ad_group_id: agid,
                            unified_ad_id: adid,
                            date: raw.date_start,
                            spend: parseFloat(raw.spend || "0"),
                            impressions: parseInt(raw.impressions || "0", 10),
                            clicks: parseInt(raw.clicks || "0", 10),
                            reach: parseInt(raw.reach || "0", 10),
                            results: extractResults(raw),
                            platform_metrics: { raw_actions: raw.actions },
                            synced_at: getVietnamTime()
                        };
                    });

                    const { data: saved, error: insErr } = await supabase.from("unified_insights").upsert(upserts, { onConflict: "platform_account_id,unified_campaign_id,unified_ad_group_id,unified_ad_id,date" }).select("id, platform_account_id, unified_campaign_id, unified_ad_group_id, unified_ad_id, date");
                    if (insErr) result.debug.insightError = insErr.message;
                    if (saved) {
                        result.insights = saved.length;
                        const { data: accInfo } = await supabase.from("platform_accounts").select("branch_id").eq("id", targetAccountId).single();
                        const skipAggregation = body.skipBranchAggregation === true;
                        if (!skipAggregation && (accInfo as any)?.branch_id) {
                            await aggregateBranchStats((accInfo as any).branch_id, dateStart, dateEnd);
                        }
                    }
                }
            }

            if (granularity === "HOURLY" || granularity === "BOTH") {
                const { data: existingHourly } = await supabase.from("unified_hourly_insights").select("id, platform_account_id, unified_campaign_id, unified_ad_group_id, unified_ad_id, date, hour").eq("platform_account_id", targetAccountId).gte("date", dateStart).lte("date", dateEnd);
                const getHourlyKey = (h: any) => `${h.platform_account_id}|${h.unified_campaign_id}|${h.unified_ad_group_id}|${h.unified_ad_id}|${h.date}|${h.hour}`;
                const hourlyIdMap = new Map(existingHourly?.map((h: any) => [getHourlyKey(h), h.id]));

                let adList = ads || [];
                if (bodyAdId) {
                    const specificAd = adList.find((a: any) => a.id === bodyAdId);
                    if (specificAd) adList = [specificAd];
                    else {
                        const { data: adData } = await supabase.from("unified_ads").select("id, external_id").eq("id", bodyAdId).single();
                        if (adData) adList = [adData];
                        else adList = [];
                    }
                }

                console.log(`[Insights] Syncing hourly for ${adList.length} ads: ${dateStart} to ${dateEnd}`);

                // Process ads in batches. Use small batch or single if targeting one ad.
                const CONCURRENCY = bodyAdId ? 1 : 30;
                for (let i = 0; i < adList.length; i += CONCURRENCY) {
                    const chunk = adList.slice(i, i + CONCURRENCY);
                    await Promise.all(chunk.map(async (ad: any) => {
                        try {
                            // Fetch all hours for the whole range in one go per ad
                            const fbHourly = await fb.getInsights(ad.external_id, "ad", { start: dateStart, end: dateEnd }, "HOURLY");
                            
                            if (fbHourly.length > 0) {
                                const hUpserts = fbHourly.map(raw => {
                                    const cid = campaignMap.get(raw.campaign_id) || null;
                                    const agid = adGroupMap.get(raw.adset_id) || null;
                                    const adid = ad.id;
                                    const hrRaw = raw.hourly_stats_aggregated_by_advertiser_time_zone || "0:0";
                                    const hr = parseInt(hrRaw.split(":")[0], 10);
                                    const key = `${targetAccountId}|${cid}|${agid}|${adid}|${raw.date_start}|${hr}`;
                                    return {
                                        id: hourlyIdMap.get(key) || crypto.randomUUID(),
                                        platform_account_id: targetAccountId,
                                        unified_campaign_id: cid,
                                        unified_ad_group_id: agid,
                                        unified_ad_id: adid,
                                        date: raw.date_start,
                                        hour: hr,
                                        spend: parseFloat(raw.spend || "0"),
                                        impressions: parseInt(raw.impressions || "0", 10),
                                        clicks: parseInt(raw.clicks || "0", 10),
                                        results: extractResults(raw),
                                        synced_at: getVietnamTime()
                                    };
                                });

                                console.log(`[Insights] Upserting ${hUpserts.length} hourly items for ad ${ad.id}`);
                                const { error: hrErr } = await supabase.from("unified_hourly_insights").upsert(hUpserts, {
                                    onConflict: "platform_account_id,unified_campaign_id,unified_ad_group_id,unified_ad_id,date,hour"
                                });

                                if (hrErr) {
                                    console.error(`[Insights] Hourly upsert error for ad ${ad.id}: ${hrErr.message}`);
                                } else {
                                    result.hourly += hUpserts.length;
                                }
                            }
                        } catch (e: any) {
                            console.error(`[Insights] Error syncing hourly for ad ${ad.id}:`, e.message);
                        }
                    }));
                }
            }

            if (breakdown) {
                const fbBreakdowns = await fb.getInsights(fbEntityId as string, "ad", { start: dateStart, end: dateEnd }, "DAILY", breakdown);
                result.debug.fbBreakdownsCount = fbBreakdowns.length;
                if (fbBreakdowns.length > 0) {
                    const parentUpserts = Array.from(new Set(fbBreakdowns.map(r => `${r.date_start}|${r.ad_id}`))).map(key => {
                        const [date, ad_id] = key.split("|");
                        const raw = fbBreakdowns.find(r => r.ad_id === ad_id && r.date_start === date);
                        const cid = campaignMap.get(raw?.campaign_id) || null;
                        const agid = adGroupMap.get(raw?.adset_id) || null;
                        const adid = adMap.get(ad_id) || null;
                        const pKey = `${targetAccountId}|${cid}|${agid}|${adid}|${date}`;
                        return {
                            id: insightIdMap.get(pKey) || crypto.randomUUID(),
                            platform_account_id: targetAccountId,
                            unified_campaign_id: cid,
                            unified_ad_group_id: agid,
                            unified_ad_id: adid,
                            date: date, synced_at: getVietnamTime()
                        };
                    });

                    const { data: parents, error: pErr } = await supabase.from("unified_insights").upsert(parentUpserts, { onConflict: "platform_account_id,unified_campaign_id,unified_ad_group_id,unified_ad_id,date" }).select("id, date, unified_ad_id");
                    result.debug.parentsCount = parents?.length || 0;
                    if (pErr) result.debug.parentError = pErr.message;

                    if (parents) {
                        const getParentId = (raw: any) => {
                            const dbAdId = adMap.get(raw.ad_id);
                            const match = parents.find((p: any) => p.date === raw.date_start && (p.unified_ad_id === dbAdId));
                            return match?.id;
                        };

                        if (breakdown === "device") {
                            const deviceUpserts = fbBreakdowns.map(raw => ({
                                id: `${getParentId(raw)}_${raw.device_platform}`,
                                unified_insight_id: getParentId(raw),
                                device: raw.device_platform,
                                spend: parseFloat(raw.spend || "0"),
                                impressions: parseInt(raw.impressions || "0", 10),
                                clicks: parseInt(raw.clicks || "0", 10),
                                results: extractResults(raw)
                            })).filter(u => u.unified_insight_id);
                            const { error: devErr } = await supabase.from("unified_insight_devices").upsert(deviceUpserts);
                            if (devErr) result.debug.deviceError = devErr.message;
                            else result.breakdowns += deviceUpserts.length;
                        } else if (breakdown === "age_gender") {
                            const agUpserts = fbBreakdowns.map(raw => ({
                                id: `${getParentId(raw)}_${raw.age}_${raw.gender}`,
                                unified_insight_id: getParentId(raw),
                                age: raw.age, gender: raw.gender,
                                spend: parseFloat(raw.spend || "0"),
                                impressions: parseInt(raw.impressions || "0", 10),
                                clicks: parseInt(raw.clicks || "0", 10),
                                results: extractResults(raw)
                            })).filter(u => u.unified_insight_id);
                            const { error: agErr } = await supabase.from("unified_insight_age_gender").upsert(agUpserts);
                            if (agErr) result.debug.agError = agErr.message;
                            else result.breakdowns += agUpserts.length;
                        } else if (breakdown === "region") {
                            const regUpserts = fbBreakdowns.map(raw => ({
                                id: `${getParentId(raw)}_${raw.region}`,
                                unified_insight_id: getParentId(raw),
                                region: raw.region, country: raw.country,
                                spend: parseFloat(raw.spend || "0"),
                                impressions: parseInt(raw.impressions || "0", 10),
                                clicks: parseInt(raw.clicks || "0", 10),
                                results: extractResults(raw)
                            })).filter(u => u.unified_insight_id);
                            const { error: regErr } = await supabase.from("unified_insight_regions").upsert(regUpserts);
                            if (regErr) result.debug.regError = regErr.message;
                            else result.breakdowns += regUpserts.length;
                        }
                    }
                }
            }

            // Update account sync timestamp
            await supabase.from("platform_accounts").update({ synced_at: getVietnamTime() }).eq("id", targetAccountId);

            return jsonResponse({ success: true, data: result });
        }
        return jsonResponse({ success: false, error: "Invalid method" }, 405);
    } catch (error: any) {
        return jsonResponse({ success: false, error: error.message }, 500);
    }
});

async function aggregateBranchStats(branchId: number, dateStart: string, dateEnd: string) {
    const start = new Date(dateStart), end = new Date(dateEnd);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().split("T")[0];
        const { data: accounts } = await supabase.from("platform_accounts").select("id, platform:platforms(code)").eq("branch_id", branchId);
        if (!accounts || accounts.length === 0) continue;
        const platformGroups = new Map<string, number[]>();
        accounts.forEach((acc: any) => {
            const code = acc.platform.code;
            if (!platformGroups.has(code)) platformGroups.set(code, []);
            platformGroups.get(code)!.push(acc.id);
        });
        for (const [platformCode, accountIds] of platformGroups.entries()) {
            const { data: aggregation } = await supabase.from("unified_insights").select("spend, impressions, clicks, results").in("platform_account_id", accountIds).eq("date", dateStr);
            const totals = (aggregation || []).reduce((s: any, i: any) => ({
                spend: s.spend + Number(i.spend || 0),
                impressions: s.impressions + Number(i.impressions || 0),
                clicks: s.clicks + Number(i.clicks || 0),
                results: s.results + Number(i.results || 0),
            }), { spend: 0, impressions: 0, clicks: 0, results: 0 });
            await supabase.from("branch_daily_stats").upsert({ branch_id: branchId, date: dateStr, platform_code: platformCode, totalSpend: totals.spend, totalImpressions: totals.impressions, totalClicks: totals.clicks, totalResults: totals.results }, { onConflict: 'branch_id, date, platform_code' });
        }
    }
}
