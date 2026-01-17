import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
import { PrismaService } from './src/database/prisma/prisma.service';

async function verify() {
    const app = await NestFactory.createApplicationContext(AppModule);
    const prisma = app.get(PrismaService);

    const count = await prisma.adInsightsDaily.count();
    console.log(`Total AdInsightsDaily records: ${count}`);

    const recent = await prisma.adInsightsDaily.findMany({
        orderBy: { date: 'desc' },
        take: 5
    });
    console.log('Recent insights:', recent);

    await app.close();
}

verify();
