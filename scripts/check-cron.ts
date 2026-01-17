import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    const settings = await prisma.userCronSettings.findMany({
        where: { enabled: true },
        select: { cronType: true, allowedHours: true, enabled: true },
        orderBy: { cronType: 'asc' }
    });

    console.log('=== ENABLED CRON SETTINGS ===');
    for (const s of settings) {
        console.log(`${s.cronType}: hours=[${s.allowedHours.join(',')}]`);
    }

    // Find hours with most enabled types
    const hourCounts: Record<number, number> = {};
    for (const s of settings) {
        for (const h of s.allowedHours) {
            hourCounts[h] = (hourCounts[h] || 0) + 1;
        }
    }

    const sorted = Object.entries(hourCounts).sort((a, b) => Number(b[1]) - Number(a[1]));
    console.log('\nBest hours to test:');
    sorted.slice(0, 5).forEach(([h, c]) => console.log(`  Hour ${h}: ${c} types enabled`));

    // Get accounts
    const accounts = await prisma.adAccount.findMany({
        where: { accountStatus: 1 },
        select: { id: true, name: true }
    });
    console.log(`\nActive ad accounts: ${accounts.length}`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
