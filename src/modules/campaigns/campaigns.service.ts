import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { PlatformsService } from '../platforms/platforms.service';

@Injectable()
export class CampaignsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly platformsService: PlatformsService,
    ) { }

    async findAll(userId: number, filters: { accountId?: number; status?: string; search?: string; branchId?: number }) {
        const where: any = {
            account: { identity: { userId } }
        };

        if (filters.accountId) {
            where.accountId = filters.accountId;
        }

        if (filters.status && filters.status !== 'all') {
            if (filters.status === 'ACTIVE') {
                where.status = 'ACTIVE';
                where.OR = [
                    { endTime: null },
                    { endTime: { gt: new Date() } },
                ];
            } else {
                where.status = filters.status;
            }
        }

        if (filters.branchId) {
            where.account.branchId = filters.branchId;
        }

        if (filters.search) {
            where.OR = [
                { name: { contains: filters.search, mode: 'insensitive' } },
                { externalId: { contains: filters.search, mode: 'insensitive' } },
            ];
        }

        return this.prisma.unifiedCampaign.findMany({
            where,
            include: { 
                _count: { select: { adGroups: true } },
                account: { include: { platform: true } }
            },
            orderBy: { createdAt: 'desc' },
        });
    }

    async findByAccountSimple(accountId: number) {
        return this.prisma.unifiedCampaign.findMany({
            where: { accountId },
            select: { id: true, externalId: true },
        });
    }

    async findOne(id: string) {
        const campaign = await this.prisma.unifiedCampaign.findUnique({
            where: { id },
            include: { adGroups: true, account: { include: { platform: true } } },
        });

        if (!campaign) throw new NotFoundException('Campaign not found');
        return campaign;
    }

    async updateStatus(id: string, status: 'ACTIVE' | 'PAUSED') {
        // 1. Update DB
        const campaign = await this.findOne(id);

        // 2. TODO: Gọi adapter tương ứng để update trực tiếp lên platform
        // const adapter = this.platformsService.getAdapter(campaign.account.platform.code);
        // await adapter.updateCampaignStatus(campaign.externalId, status);

        return this.prisma.unifiedCampaign.update({
            where: { id },
            data: { status },
        });
    }
}
