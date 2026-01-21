import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { InsightsSyncService } from '../src/modules/insights/services/insights-sync.service';
import { PrismaClient } from '@prisma/client';

async function main() {
    const app = await NestFactory.createApplicationContext(AppModule);
    const sync = app.get(InsightsSyncService);
    const prisma = new PrismaClient();

    // Test range: Yesterday and Today
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

    // Use account 2 as it has known active ads for testing
  const account = await prisma.platformAccount.findUnique({
    where: { id: 2 }
  });

    if (!account) {
        console.error('No account found for testing');
        await app.close();
        return;
    }

    console.log(`Testing multi-day HOURLY sync for account ${account.id} from ${yesterday} to ${today}`);

    // Clean up existing hourly insights for this range to be sure
  await prisma.unifiedHourlyInsight.deleteMany({
    where: {
      accountId: account.id,
      date: { in: [new Date(`${yesterday}T00:00:00.000Z`), new Date(`${today}T00:00:00.000Z`)] }
    }
  });

  const res = await sync.syncAccountHourlyInsights(account.id, yesterday, today, false, undefined, true);
  console.log('Sync Result:', JSON.stringify(res, null, 2));

  // Verify counts in DB
  const insights = await prisma.unifiedHourlyInsight.findMany({
    where: {
      accountId: account.id,
      date: { in: [new Date(`${yesterday}T00:00:00.000Z`), new Date(`${today}T00:00:00.000Z`)] }
    },
    select: { date: true }
  });

  const counts: Record<string, number> = {};
  for (const item of insights) {
    const d = item.date.toISOString().split('T')[0];
    counts[d] = (counts[d] || 0) + 1;
  }

  console.log('Counts per day in DB:', JSON.stringify(counts, null, 2));

    await app.close();
    await prisma.$disconnect();
}

main().catch(console.error);
