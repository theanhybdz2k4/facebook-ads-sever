import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
    const email = 'admin@gmail.com';
    const newPassword = '123456';

    // Hash password with bcrypt (salt rounds = 10, same as auth.service.ts)
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // Upsert user (create if not exists, update if exists)
  const user = await prisma.user.upsert({
    where: { email },
    update: { password: hashedPassword },
    create: {
      email,
      password: hashedPassword,
      name: 'Admin',
      isActive: true,
    },
  });

    console.log(`✅ Password reset successfully for user: ${user.email}`);
    console.log(`   New password: ${newPassword}`);
}

main()
    .catch((e) => {
        console.error('❌ Error:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
