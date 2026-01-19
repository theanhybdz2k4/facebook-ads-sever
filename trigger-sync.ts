
import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
import { AdsSyncService } from '@n-modules/ads/services/ads-sync.service';
import { PrismaService } from '@n-database/prisma/prisma.service';

async function bootstrap() {
    const app = await NestFactory.createApplicationContext(AppModule);
    const adsSync = app.get(AdsSyncService);
    const prisma = app.get(PrismaService);

    const account = await prisma.platformAccount.findFirst({
        where: { platform: { code: 'facebook' } }
    });

    if (!account) {
        console.error('No Facebook account found');
        await app.close();
        return;
    }

    console.log(`Starting sync for account: ${account.name} (ID: ${account.id})`);

    try {
        const result = await adsSync.syncByAccount(account.id, true); // Force full sync to be sure
        console.log('Sync Result:', result);
    } catch (error) {
        console.error('Sync Error:', error);
    }

    await app.close();
}

bootstrap();
