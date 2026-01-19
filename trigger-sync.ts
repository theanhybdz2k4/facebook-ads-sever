
import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
import { AdsSyncService } from '@n-modules/ads/services/ads-sync.service';
import { PrismaService } from '@n-database/prisma/prisma.service';
import * as fs from 'fs';
import * as path from 'path';

async function bootstrap() {
    const logFile = path.join(process.cwd(), 'sync-debug.log');
    const logStream = fs.createWriteStream(logFile, { flags: 'w' });

    // Redirect console logs to file
    const originalLog = console.log;
    console.log = (...args) => {
        logStream.write(args.join(' ') + '\n');
        originalLog(...args);
    };
    const originalError = console.error;
    console.error = (...args) => {
        logStream.write('ERROR: ' + args.join(' ') + '\n');
        originalError(...args);
    };

    const app = await NestFactory.createApplicationContext(AppModule);
    const adsSync = app.get(AdsSyncService);
    const prisma = app.get(PrismaService);

    const accounts = await prisma.platformAccount.findMany({
        where: { platform: { code: 'facebook' }, id: { in: [1, 6] } }
    });

    if (accounts.length === 0) {
        console.error('No Facebook accounts found');
        await app.close();
        return;
    }

    for (const account of accounts) {
        console.log(`\n--- Starting sync for account: ${account.name} (ID: ${account.id}) ---`);
        try {
            const result = await adsSync.syncByAccount(account.id, true);
            console.log('Sync Result:', result);
        } catch (error) {
            console.error(`Sync Error for account ${account.id}:`, error);
        }
    }

    await app.close();
}

bootstrap();
