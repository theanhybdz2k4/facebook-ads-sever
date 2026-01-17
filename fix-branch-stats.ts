import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
import { BranchStatsService } from './src/modules/branches/services/branch-stats.service';
import { PrismaService } from '@n-database/prisma/prisma.service';

async function fixStats() {
    const app = await NestFactory.createApplicationContext(AppModule);
    const branchStatsService = app.get(BranchStatsService);
    const prisma = app.get(PrismaService);

    // 1. Find the branch (assuming 'code' or just listing all)
    // Based on user's url 'branches/colormesg/stats', 'colormesg' is likely the code.
    const branch = await prisma.branch.findFirst({
        where: { code: 'colormesg' }
    });

    if (!branch) {
        console.error('Branch colormesg not found!');

        // List all branches to be helpful
        const allBranches = await prisma.branch.findMany();
        console.log('Available branches:', allBranches);
        return;
    }

    console.log(`Found branch: ${branch.name} (ID: ${branch.id})`);

    // 2. Re-aggregate for Jan 15
    const targetDate = '2026-01-15';
    console.log(`Re-aggregating for ${targetDate}...`);

    await branchStatsService.aggregateBranchStats(branch.id, targetDate);

    // 3. Verify
    const stats = await prisma.branchDailyStats.findUnique({
        where: {
            branchId_date: {
                date: new Date(targetDate),
                branchId: branch.id
            }
        }
    });

    console.log('Updated Stats:', stats);
    await app.close();
}

fixStats().catch(console.error);
