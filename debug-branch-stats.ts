import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function debugMapping() {
    const accountId = 'act_568594108265682';

    console.log(`Checking mapping for account: ${accountId}`);

    const account = await prisma.adAccount.findUnique({
        where: { id: accountId },
        include: {
            branch: true,
        }
    });

    if (!account) {
        console.log('Account not found in DB!');
        return;
    }

    console.log('Account Mapping:');
    console.log(JSON.stringify({
        id: account.id,
        name: account.name,
        branchId: account.branchId,
        branchName: account.branch?.name,
        branchCode: account.branch?.code,
    }, null, 2));

    console.log('\nFinal status check for Campaign 120239298536620740:');
    const campaignId = '120239298536620740';
    const campaign = await prisma.campaign.findUnique({
        where: { id: campaignId },
        select: { id: true, name: true, effectiveStatus: true, syncedAt: true }
    });
    console.log(JSON.stringify(campaign, null, 2));
}

debugMapping()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
