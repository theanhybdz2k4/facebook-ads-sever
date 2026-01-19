import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('Seed started...');

  // 1. Platforms
  const platforms = [
    { code: 'facebook', name: 'Facebook Ads' },
    { code: 'tiktok', name: 'TikTok Ads' },
    { code: 'google', name: 'Google Ads' },
  ];

  for (const p of platforms) {
    await prisma.platform.upsert({
      where: { code: p.code },
      update: { name: p.name },
      create: p,
    });
  }
  console.log('Platforms seeded.');

  // 2. Default User
  const hashedPassword = await bcrypt.hash('123456', 10);
  const user = await prisma.user.upsert({
    where: { email: 'admin@gmail.com' },
    update: { password: hashedPassword },
    create: {
      email: 'admin@gmail.com',
      password: hashedPassword,
      name: 'System Admin',
    },
  });
  console.log('User seeded.');

  // 3. Default Branch
  await prisma.branch.upsert({
    where: {
      userId_name: {
        userId: user.id,
        name: 'Main Office'
      }
    },
    update: {},
    create: {
      userId: user.id,
      name: 'Main Office',
      code: 'main',
    },
  });
  console.log('Branch seeded.');

  console.log('Seed completed successfully.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
