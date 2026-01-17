import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function debugMissingStats() {
    const branchCode = 'colormesg';
    const startDate = new Date('2026-01-01T00:00:00.000Z');
    const endDate = new Date('2026-01-17T00:00:00.000Z');

    console.log(`Debugging stats for branch: ${branchCode}`);

    // 1. Get Branch
    const branch = await prisma.branch.findFirst({
        where: { code: branchCode },
        include: { adAccounts: true }
    });

    if (!branch) {
        console.error(`Branch ${branchCode} not found!`);
        return;
    }

    console.log(`Branch ID: ${branch.id}, Name: ${branch.name}`);
    console.log(`Mapped Ad Accounts: ${branch.adAccounts.length}`);
    branch.adAccounts.forEach(acc => {
        console.log(` - ${acc.id} (${acc.name})`);
    });

    const accountIds = branch.adAccounts.map(a => a.id);

    // 2. Check AdInsightsDaily (Source Data)
    console.log('\nChecking AdInsightsDaily (Source Data)...');

    // Check aggregate for the period
    const insightsAggregate = await prisma.adInsightsDaily.aggregate({
        where: {
            accountId: { in: accountIds },
            date: {
                gte: startDate,
                lte: endDate,
            },
        },
        _sum: {
            spend: true,
            impressions: true,
            clicks: true,
            results: true
        },
        _count: {
            id: true
        }
    });

    // console.log(JSON.stringify(insightsAggregate, null, 2)); // BigInt fail
    console.log('Source Data Aggregate (AdInsightsDaily):');
    const serializeBigInt = (obj: any) => JSON.parse(JSON.stringify(obj, (key, value) =>
        typeof value === 'bigint' ? value.toString() : value
    ));
    console.log(JSON.stringify(serializeBigInt(insightsAggregate), null, 2));

    // Check specific days
    const dailyInsights = await prisma.adInsightsDaily.groupBy({
        by: ['date'],
        where: {
            accountId: { in: accountIds },
            date: {
                gte: new Date('2026-01-15T00:00:00.000Z'),
                lte: endDate,
            },
        },
        _sum: {
            spend: true,
        },
        orderBy: { date: 'asc' }
    });

    console.log(`\nDaily Source Data (Jan 15-17):`);
    if (dailyInsights.length === 0) console.log('No Daily data found.');
    dailyInsights.forEach(d => {
        console.log(`${d.date.toISOString().split('T')[0]}: Spend ${d._sum.spend}`);
    });

    console.log('\nChecking AdInsightsHourly (Source Data)...');
    const hourlyInsights = await prisma.adInsightsHourly.groupBy({
        by: ['date'],
        where: {
            accountId: { in: accountIds },
            date: {
                gte: new Date('2026-01-15T00:00:00.000Z'),
                lte: endDate,
            },
        },
        _sum: {
            spend: true,
        },
        orderBy: { date: 'asc' }
    });
    console.log(`\nHourly Source Data (Jan 15-17):`);
    if (hourlyInsights.length === 0) console.log('No Hourly data found.');
    hourlyInsights.forEach(d => {
        console.log(`${d.date.toISOString().split('T')[0]}: Spend ${d._sum.spend}`);
    });


    // 3. Check BranchDailyStats (Aggregated Data)
    console.log('\nChecking BranchDailyStats (Aggregated Table)...');
    const branchStats = await prisma.branchDailyStats.findMany({
        where: {
            branchId: branch.id,
            date: {
                gte: startDate,
                lte: endDate,
            },
        },
        orderBy: { date: 'asc' }
    });

    console.log(`Found ${branchStats.length} stats records.`);
    if (branchStats.length > 0) {
        branchStats.forEach(s => {
            console.log(`${s.date.toISOString().split('T')[0]}: Spend ${s.totalSpend}, Impressions ${s.totalImpressions}`);
        });
    } else {
        console.log('No stats records found in BranchDailyStats for this period.');
    }

}

debugMissingStats()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
