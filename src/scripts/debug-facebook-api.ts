import { PrismaClient } from '@prisma/client';
import axios from 'axios';

const prisma = new PrismaClient();

const ACCOUNT_EXTERNAL_ID = 'act_461903055427781';
const FB_GRAPH_API_URL = 'https://graph.facebook.com/v24.0';
const INSIGHTS_BREAKDOWN_FIELDS = 'impressions,reach,clicks,unique_clicks,spend,actions,action_values,conversions,cost_per_action_type,video_thruplay_watched_actions';

async function main() {
    console.log('Connecting to database...');

    // 1. Get access token through unified platform models
    const account = await prisma.platformAccount.findFirst({
        where: { externalId: ACCOUNT_EXTERNAL_ID },
        include: {
            identity: {
                include: {
                    credentials: {
                        where: { credentialType: 'access_token', isActive: true },
                        take: 1
                    }
                }
            }
        }
    });

    if (!account || !account.identity || !account.identity.credentials.length) {
        console.error('No valid token found for account', ACCOUNT_EXTERNAL_ID);
        return;
    }

    const accessToken = account.identity.credentials[0].credentialValue;
    console.log('Found access token:', accessToken.substring(0, 10) + '...');

    // 2. Prepare params
    const vnDateStr = new Date(new Date().getTime() + (3600000 * 7)).toISOString().split('T')[0];

    console.log('Using date:', vnDateStr);

    const params = {
        access_token: accessToken,
        fields: INSIGHTS_BREAKDOWN_FIELDS,
        level: 'ad',
        breakdowns: 'hourly_stats_aggregated_by_advertiser_time_zone',
        time_range: JSON.stringify({ since: vnDateStr, until: vnDateStr }),
        time_increment: '1',
        limit: '500',
    };

    const url = `${FB_GRAPH_API_URL}/${ACCOUNT_EXTERNAL_ID}/insights`;

    console.log('Calling Facebook API:', url);
    const logParams = { ...params, access_token: '***' };
    console.log('Params:', JSON.stringify(logParams, null, 2));

    try {
        const response = await axios.get(url, { params });
        console.log('Response Status:', response.status);
        console.log('Data Length:', response.data.data.length);
        if (response.data.data.length > 0) {
            console.log('First Item:', JSON.stringify(response.data.data[0], null, 2));
        } else {
            console.log('No data returned.');
        }
    } catch (error: any) {
        console.error('API Error:', error.response?.data || error.message);
    } finally {
        await prisma.$disconnect();
    }
}

main();
