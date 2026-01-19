
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    const creativeCount = await prisma.unifiedAdCreative.count();
    console.log('Creative Count:', creativeCount);

    const adWithCreativeCount = await prisma.unifiedAd.count({
        where: { creativeId: { not: null } }
    });
    console.log('Ads linked to Creative:', adWithCreativeCount);

    const sampleCreatives = await prisma.unifiedAdCreative.findMany({
        take: 5
    });
    console.log('Sample Creatives:', JSON.stringify(sampleCreatives, null, 2));
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
