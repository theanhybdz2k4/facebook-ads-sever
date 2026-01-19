
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    const result = await prisma.$queryRaw`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'unified_ads'
  `;
    console.log('Columns in unified_ads:', result);

    const sample = await prisma.unifiedAd.findFirst({
        where: { effectiveStatus: 'ACTIVE' }
    });
    console.log('Sample Ad from Prisma:', JSON.stringify(sample, null, 2));
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
