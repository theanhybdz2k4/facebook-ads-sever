
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const ads = await prisma.unifiedAd.findMany({
    where: {
      effectiveStatus: 'ACTIVE'
    },
    take: 10,
    select: {
      externalId: true,
      accountId: true,
      status: true,
      effectiveStatus: true,
      creativeId: true,
      creative: {
        select: {
          thumbnailUrl: true
        }
      }
    }
  });

  console.log('Ads found:', ads.length);
  ads.forEach(ad => {
    console.log(`Ad: ${ad.externalId} (Account: ${ad.accountId})`);
    console.log(`  Status: ${ad.status}`);
    console.log(`  Effective: ${ad.effectiveStatus}`);
    console.log(`  Creative ID (Internal): ${ad.creativeId}`);
    console.log(`  Thumbnail: ${ad.creative?.thumbnailUrl}`);
  });
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
