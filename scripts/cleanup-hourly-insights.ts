import { PrismaClient } from '@prisma/client';
import moment from 'moment';
import 'moment-timezone';

/**
 * One-off cleanup: keep ONLY today and yesterday in ad_insights_hourly.
 *
 * Usage:
 *   yarn ts-node scripts/cleanup-hourly-insights.ts
 *   yarn ts-node scripts/cleanup-hourly-insights.ts --dry-run
 */
const prisma = new PrismaClient();

function getVietnamDateString(date: Date = new Date()): string {
    return moment(date).tz('Asia/Ho_Chi_Minh').format('YYYY-MM-DD');
}

function parseLocalDate(dateStr: string): Date {
    return new Date(`${dateStr}T00:00:00.000Z`);
}

async function main() {
    const dryRun = process.argv.includes('--dry-run');

    const todayStr = getVietnamDateString();
    const today = parseLocalDate(todayStr);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    // Anything older than yesterday should be removed
    const cutoff = yesterday;

    // Pre-check
    const beforeAgg = await prisma.adInsightsHourly.aggregate({
        _min: { date: true },
        _max: { date: true },
        _count: { _all: true },
    });

    console.log('[HourlyCleanup] window keep:', { todayStr, yesterdayStr });
    console.log('[HourlyCleanup] cutoff (delete date < cutoff):', cutoff);
    console.log('[HourlyCleanup] before:', {
        minDate: beforeAgg._min.date,
        maxDate: beforeAgg._max.date,
        rows: beforeAgg._count._all,
        dryRun,
    });

    if (dryRun) {
        const wouldDelete = await prisma.adInsightsHourly.count({
            where: { date: { lt: cutoff } },
        });
        console.log('[HourlyCleanup] wouldDelete:', wouldDelete);
        return;
    }

    const result = await prisma.adInsightsHourly.deleteMany({
        where: { date: { lt: cutoff } },
    });

    const afterAgg = await prisma.adInsightsHourly.aggregate({
        _min: { date: true },
        _max: { date: true },
        _count: { _all: true },
    });

    console.log('[HourlyCleanup] deleted:', result.count);
    console.log('[HourlyCleanup] after:', {
        minDate: afterAgg._min.date,
        maxDate: afterAgg._max.date,
        rows: afterAgg._count._all,
    });
}

main()
    .catch((e) => {
        console.error('❌ Error:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });


