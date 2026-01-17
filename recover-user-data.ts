import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
import { InsightsSyncService } from './src/modules/insights/services/insights-sync.service';
import { BranchStatsService } from './src/modules/branches/services/branch-stats.service';
import { PrismaService } from './src/database/prisma/prisma.service';
import { EntitySyncService } from './src/modules/facebook-ads/services/entity-sync.service';

/**
 * Script to recover missing daily insights and rebuild branch stats for a user
 * OPTIMIZED: Uses parallel processing and bulk sync
 */
async function recoverData(userId: number) {
    const app = await NestFactory.createApplicationContext(AppModule);
    const insightsSyncService = app.get(InsightsSyncService);
    const entitySyncService = app.get(EntitySyncService);
    const branchStatsService = app.get(BranchStatsService);
    const prisma = app.get(PrismaService);

    console.log(`Starting recovery for user ${userId}...`);

    // 1. Get all active ad accounts for the user
    const adAccounts = await prisma.adAccount.findMany({
        where: { fbAccount: { userId } },
        select: { id: true, name: true }
    });

    console.log(`Found ${adAccounts.length} accounts for user ${userId}`);

    // 2. Sync in parallel batches (Concurrency: 3)
    const BATCH_SIZE = 3;
    for (let i = 0; i < adAccounts.length; i += BATCH_SIZE) {
        const batch = adAccounts.slice(i, i + BATCH_SIZE);
        console.log(`\n--- Processing Batch ${i / BATCH_SIZE + 1} (${batch.length} accounts) ---`);
        
        await Promise.all(batch.map(async (account) => {
            console.log(`  [${account.name}] Starting sync...`);
            try {
                // Use the new optimized syncAllEntities
                await entitySyncService.syncAllEntities(account.id);
                console.log(`  [${account.name}] Entities synced.`);

                const count = await insightsSyncService.syncDailyInsights(account.id, userId, '2026-01-01', '2026-01-17');
                console.log(`  [${account.name}] Insights synced (${count} records).`);
            } catch (err: any) {
                console.error(`  [${account.name}] FAILED: ${err.message}`);
            }
        }));
    }

    // 3. Rebuild branch stats
    console.log('\n--- Rebuilding branch stats ---');
    try {
        await branchStatsService.rebuildStatsForUser(userId);
        console.log('  Branch stats rebuild completed');
    } catch (err: any) {
        console.error(`  Failed to rebuild branch stats: ${err.message}`);
    }

    await app.close();
    console.log('\nRecovery completed!');
    process.exit(0);
}

recoverData(1)
    .catch((err: any) => {
        console.error('Critical failure:', err.message);
        process.exit(1);
    });
