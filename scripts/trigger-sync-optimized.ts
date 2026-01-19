import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { CampaignsSyncService } from '../src/modules/campaigns/campaigns-sync.service';
import { AdsSyncService } from '../src/modules/ads/services/ads-sync.service';
import { InsightsSyncService } from '../src/modules/insights/services/insights-sync.service';

async function main() {
    const app = await NestFactory.createApplicationContext(AppModule);
    const campaignsSync = app.get(CampaignsSyncService);
    const adsSync = app.get(AdsSyncService);
    const insightsSync = app.get(InsightsSyncService);

    const accountId = 1; // colorME 01 (act_174629217787917)
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

    console.log('--- Starting Optimized Sync for Account 1 ---');

    try {
        console.log('Syncing Campaigns (Incremental)...');
        const campResult = await campaignsSync.syncByAccount(accountId, false);
        console.log('Campaign Sync Result (Incremental):', JSON.stringify(campResult, null, 2));

        console.log('\nSyncing Ads & AdGroups (Incremental)...');
        const adsResult = await adsSync.syncByAccount(accountId, false);
        console.log('Ads Sync Result (Incremental):', JSON.stringify(adsResult, null, 2));

        console.log('\nSyncing Insights (HOURLY)...');
        const hourlyResult = await insightsSync.syncAccountHourlyInsights(accountId, yesterday, today);
        console.log('Insights Sync Result (HOURLY):', JSON.stringify(hourlyResult, null, 2));

        console.log('\nSyncing Insights (DAILY)...');
        const insightsResult = await insightsSync.syncAccountInsights(accountId, yesterday, today);
        console.log('Insights Sync Result (DAILY):', JSON.stringify(insightsResult, null, 2));

    } catch (error: any) {
        console.error('Sync failed:', error.message);
        if (error.stack) console.error(error.stack);
    } finally {
        await app.close();
    }
}

main().catch(console.error);
