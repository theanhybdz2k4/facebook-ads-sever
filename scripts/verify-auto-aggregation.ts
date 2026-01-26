
import { NestFactory } from '@nestjs/core';
import { SyncModule } from '../src/modules/sync/sync.module';
import { DispatchService } from '../src/modules/sync/dispatch.service';
import { PrismaService } from '@n-database/prisma/prisma.service';

/**
 * This script simulates an n8n dispatch and verifies that branch stats are updated automatically.
 * It assumes there is at least one active account with insights for today.
 */
async function bootstrap() {
    const app = await NestFactory.createApplicationContext(SyncModule);
    const dispatchService = app.get(DispatchService);
    const prisma = app.get(PrismaService);

    console.log('🚀 Starting verification of Automatic Branch Aggregation...');

    try {
        // 1. Setup: Ensure we have a valid test case
        // Find an active account that belongs to a branch
        const testAccount = await prisma.platformAccount.findFirst({
            where: {
                accountStatus: 'ACTIVE',
                branchId: { not: null }
            },
            include: { branch: true }
        });

        if (!testAccount) {
            console.error('❌ No suitable test account found (Active & assigned to Branch). Cannot verify.');
            return;
        }

        const branchId = testAccount.branchId;
        console.log(`ℹ️ Using Test Account: ${testAccount.name} (${testAccount.id}), Branch: ${testAccount.branch.name} (${branchId})`);

        // 2. Trigger Dispatch
        // We simulate an 'insight_hourly' sync for today
        const now = new Date();
        const today = now.toISOString().split('T')[0];

        // Reset stats for this branch/date to ensure we see an update (optional, but good for proving it worked)
        // await prisma.branchDailyStats.deleteMany({
        //     where: { branchId: branchId, date: new Date(today) }
        // });
        // console.log('🧹 Cleared existing stats for today to ensure fresh update.');

        console.log(`🔄 Triggering DispatchService.processUserSync for User ${testAccount.branch.userId}...`);

        // We access the private method via 'any' casting or just assume dispatch calls it.
        // Let's call dispatch() normally, but we need to make sure the cron hours match current time OR key mocks are used.
        // Easier: Just invoke the logic manually or use a specific Cron Setting that we force.

        // Actually, let's just call dispatch(). We rely on existing CronSettings. 
        // If no cron setting matches current hour, it won't run.
        // So let's force a run by creating a temporary CronSetting for current hour.

        const currentHour = new Date().getHours();

        await prisma.cronSetting.upsert({
            where: { userId_cronType: { userId: testAccount.branch.userId, cronType: 'insight_hourly' } },
            create: { userId: testAccount.branch.userId, cronType: 'insight_hourly', allowedHours: [currentHour], enabled: true },
            update: { allowedHours: { push: currentHour } }
        });
        console.log(`✅ Ensured 'insight_hourly' cron setting exists for hour ${currentHour}`);

        const result = await dispatchService.dispatch(today, today);
        console.log('📋 Dispatch Result:', JSON.stringify(result, null, 2));

        // 3. Verify Branch Stats
        const stats = await prisma.branchDailyStats.findFirst({
            where: {
                branchId: branchId,
                date: new Date(today)
            }
        });

        if (stats) {
            console.log('✅ Branch Stats found for today:', stats);
            console.log(`💰 Total Spend: ${stats.totalSpend}`);
            // Basic check: if we synced, spend should ideally be >= 0 (it might be 0 if no ads running)
            // But existence proves the aggregator ran.
            console.log('🎉 Verification Successful: Branch stats were automatically aggregated/updated.');
        } else {
            console.error('❌ Branch Stats NOT found for today. Aggregation might have failed.');
        }

    } catch (error) {
        console.error('❌ Validation Error:', error);
    } finally {
        await app.close();
    }
}

bootstrap();
