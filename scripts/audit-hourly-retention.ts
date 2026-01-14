import { PrismaClient } from '@prisma/client';

/**
 * Audit hourly insights retention per account.
 *
 * Usage:
 *   yarn ts-node scripts/audit-hourly-retention.ts
 *   yarn ts-node scripts/audit-hourly-retention.ts <accountId>
 */
const prisma = new PrismaClient();

async function main() {
    const accountId = process.argv[2];

    if (accountId) {
        const agg = await prisma.adInsightsHourly.aggregate({
            where: { accountId },
            _min: { date: true },
            _max: { date: true },
            _count: { _all: true },
        });

        console.log({
            accountId,
            minDate: agg._min.date,
            maxDate: agg._max.date,
            rows: agg._count._all,
        });
        return;
    }

    // Get all accounts that have any hourly data, then aggregate per account
    const accountIds = await prisma.adInsightsHourly.findMany({
        distinct: ['accountId'],
        select: { accountId: true },
    });

    const results = [];
    for (const row of accountIds) {
        const id = row.accountId;
        const agg = await prisma.adInsightsHourly.aggregate({
            where: { accountId: id },
            _min: { date: true },
            _max: { date: true },
            _count: { _all: true },
        });
        results.push({
            accountId: id,
            minDate: agg._min.date,
            maxDate: agg._max.date,
            rows: agg._count._all,
        });
    }

    // Sort by oldest minDate first
    results.sort((a, b) => {
        const ad = a.minDate ? new Date(a.minDate).getTime() : 0;
        const bd = b.minDate ? new Date(b.minDate).getTime() : 0;
        return ad - bd;
    });

    console.table(results);
}

main()
    .catch((e) => {
        console.error('❌ Error:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });


