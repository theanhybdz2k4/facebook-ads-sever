import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
import { InsightsSyncService } from './src/modules/insights/services/insights-sync.service';
import { PrismaService } from './src/database/prisma/prisma.service';
import { BranchStatsService } from './src/modules/branches/services/branch-stats.service';

async function bootstrap() {
    const app = await NestFactory.createApplicationContext(AppModule);
    const prisma = app.get(PrismaService);
    const insightsService = app.get(InsightsSyncService);
    const branchStatsService = app.get(BranchStatsService);

    console.log('Starting repair process...');

    const branchCode = 'colormesg';
    const missingDates = [
        '2026-01-06',
        '2026-01-15',
        '2026-01-16',
        '2026-01-17'
    ];

    // 1. Get Branch and Accounts
    const branch = await prisma.branch.findFirst({
        where: { code: branchCode },
        include: { adAccounts: true }
    });

    if (!branch) {
        console.error(`Branch ${branchCode} not found!`);
        await app.close();
        return;
    }

    console.log(`Branch: ${branch.name} (${branch.id})`);
    console.log(`Found ${branch.adAccounts.length} ad accounts.`);

    // 2. Sync missing dates for each account
    for (const account of branch.adAccounts) {
        console.log(`\nProcessing Account: ${account.name} (${account.id})`);
        
        for (const date of missingDates) {
            console.log(`  Syncing Daily Insights for ${date}...`);
            
            // Try standard sync first
            let count = 0;
            try {
                count = await insightsService.syncDailyInsights(account.id, undefined, date, date);
                console.log(`    -> Standard sync result: ${count} records.`);
            } catch (error) {
                console.error(`    -> Standard sync FAILED: ${error.message}`);
            }

            if (count === 0) {
                console.log(`    -> Fallback: Aggregating from AdInsightsHourly...`);
                // Aggregate from Hourly
                const hourlyData = await prisma.adInsightsHourly.groupBy({
                    by: ['adId', 'adsetId', 'campaignId', 'date'],
                    where: {
                        accountId: account.id,
                        date: new Date(date + 'T00:00:00.000Z'), // UTC Midnight
                    },
                    _sum: {
                        spend: true,
                        impressions: true,
                        clicks: true,
                        reach: true,
                        results: true,
                        messagingStarted: true,
                    },
                    _min: {
                        cpc: true,
                        cpm: true,
                        ctr: true,
                    } 
                });

                if (hourlyData.length > 0) {
                     console.log(`    -> Found ${hourlyData.length} records in Hourly. converting...`);
                     const dailyRecords = hourlyData.map(h => ({
                        date_start: date,
                        ad_id: h.adId,
                        adset_id: h.adsetId,
                        campaign_id: h.campaignId,
                        spend: Number(h._sum.spend || 0),
                        impressions: Number(h._sum.impressions || 0),
                        clicks: Number(h._sum.clicks || 0),
                        reach: Number(h._sum.reach || 0), // Estimate
                        results: Number(h._sum.results || 0),
                        messaging_started: Number(h._sum.messagingStarted || 0),
                        // Averages/Mins are tricky, just taking what we can or 0
                        ctr: Number(h._min.ctr || 0),
                        cpc: Number(h._min.cpc || 0),
                        cpm: Number(h._min.cpm || 0),
                     }));

                     // We can't use batchUpsertDailyInsights directly because it expects FB API format and does mapping
                     // But wait, the mapInsightMetrics in service handles raw FB data.
                     // Let's just fudge the data to look like FB response
                     
                     // Upsert manually using Prisma
                     for (const r of dailyRecords) {
                         await prisma.adInsightsDaily.upsert({
                             where: { date_adId: { date: new Date(date + 'T00:00:00.000Z'), adId: r.ad_id } },
                             create: {
                                 date: new Date(date + 'T00:00:00.000Z'),
                                 adId: r.ad_id,
                                 accountId: account.id,
                                 adsetId: r.adset_id,
                                 campaignId: r.campaign_id,
                                 spend: r.spend,
                                 impressions: r.impressions,
                                 clicks: r.clicks,
                                 reach: r.reach,
                                 results: r.results,
                                 messagingStarted: r.messaging_started,
                                 syncedAt: new Date(),
                             },
                             update: {
                                 spend: r.spend,
                                 impressions: r.impressions,
                                 clicks: r.clicks,
                                 reach: r.reach,
                                 results: r.results,
                                 messagingStarted: r.messaging_started,
                                 syncedAt: new Date(),
                             }
                         });
                     }
                     console.log(`    -> Upserted ${dailyRecords.length} records from Hourly.`);
                } else {
                     console.log(`    -> No Hourly data found either.`);
                }
            }
        }
    }

    // 3. Rebuild Branch Stats
    console.log('\nRebuilding Branch Stats...');
    for (const date of missingDates) {
        console.log(`  Aggregating stats for branch ${branch.id} on ${date}...`);
        await branchStatsService.aggregateBranchStats(branch.id, date);
    }

    // Also trigger full rebuild for user to be safe
    console.log('\nTriggering full stats rebuild for user...');
    await branchStatsService.rebuildStatsForUser(branch.userId);

    console.log('\nRepair completed.');
    await app.close();
}

bootstrap();
