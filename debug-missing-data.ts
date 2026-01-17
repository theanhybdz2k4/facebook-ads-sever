import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function debugStats() {
    const targetDate = new Date('2026-01-15T00:00:00.000Z');
    
    console.log('--- Debugging Data for 2026-01-15 ---');

    // 1. Check AdInsightsDaily
    const insightsCount = await prisma.adInsightsDaily.count({
        where: { date: targetDate }
    });
    console.log(`AdInsightsDaily count for 2026-01-15: ${insightsCount}`);

    if (insightsCount > 0) {
        const sample = await prisma.adInsightsDaily.findFirst({
            where: { date: targetDate },
            select: { accountId: true, spend: true, impressions: true }
        });
        console.log('Sample insight:', sample);
    }

    // 2. Check BranchDailyStats
    const branchStats = await prisma.branchDailyStats.findMany({
        where: { date: targetDate }
    });
    console.log(`BranchDailyStats records for 2026-01-15: ${branchStats.length}`);
    branchStats.forEach(s => {
        console.log(`Branch ${s.branchId}: Spend=${s.totalSpend}, Imp=${s.totalImpressions}`);
    });

    // 3. Check Ad Accounts linked to branches
    const accounts = await prisma.adAccount.findMany({
        where: { branchId: { not: null } },
        select: { id: true, name: true, branchId: true }
    });
    console.log(`\nTotal Ad Accounts with Branch: ${accounts.length}`);
}

debugStats()
  .catch(e => console.error(e))
  .finally(async () => {
    await prisma.$disconnect();
  });
