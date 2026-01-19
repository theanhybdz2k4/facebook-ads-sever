
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
      status: true,
      effectiveStatus: true,
      creativeData: true,
      thumbnailUrl: true,
    }
  });

  console.log('Ads found:', ads.length);
  ads.forEach(ad => {
    console.log(`Ad: ${ad.externalId}`);
    console.log(`  Status: ${ad.status}`);
    console.log(`  Effective: ${ad.effectiveStatus}`);
    console.log(`  Thumbnail: ${ad.thumbnailUrl}`);
    console.log(`  Creative ID: ${(ad.creativeData as any)?.id}`);
  });
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
