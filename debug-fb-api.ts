import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
import { FacebookApiService } from './src/modules/shared/services/facebook-api.service';
import { TokensService } from './src/modules/tokens/services/tokens.service';
import * as fs from 'fs';

/**
 * Debug script to fetch raw campaigns from Facebook API
 */
async function debugFbApi(accountId: string) {
    const app = await NestFactory.createApplicationContext(AppModule);
    const fbApi = app.get(FacebookApiService);
    const tokensService = app.get(TokensService);

    console.log(`Fetching campaigns for ${accountId} from Facebook API...`);

    const accessToken = await tokensService.getTokenForAdAccountInternal(accountId);
    if (!accessToken) {
        console.error('No access token found');
        await app.close();
        return;
    }

    // Try fetching ALL campaigns
    const allCampaigns = await fbApi.getCampaigns(accountId, accessToken, false);
    
    // Try fetching ONLY ACTIVE campaigns
    const activeCampaigns = await fbApi.getCampaigns(accountId, accessToken, true);

    const output = {
        allCampaigns: allCampaigns.map(c => ({
            id: c.id,
            name: c.name,
            status: c.status,
            effective_status: c.effective_status,
            stop_time: c.stop_time
        })),
        activeCampaigns: activeCampaigns.map(c => ({
            id: c.id,
            name: c.name,
            status: c.status,
            effective_status: c.effective_status,
            stop_time: c.stop_time
        }))
    };

    fs.writeFileSync('debug-fb-api-output.json', JSON.stringify(output, null, 2));
    console.log('Results written to debug-fb-api-output.json');

    await app.close();
}

debugFbApi('act_568594108265682')
    .catch(console.error);
