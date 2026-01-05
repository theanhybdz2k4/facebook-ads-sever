import { Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';

@Injectable()
export class AdAccountsService {
    constructor(private readonly prisma: PrismaService) { }

    /**
     * List ad accounts for a user
     */
    async getAdAccounts(userId: number, filters?: {
        accountStatus?: number;
        search?: string;
    }) {
        return this.prisma.adAccount.findMany({
            where: {
                fbAccount: { userId },
                ...(filters?.accountStatus && { accountStatus: filters.accountStatus }),
                ...(filters?.search && {
                    OR: [
                        { name: { contains: filters.search, mode: 'insensitive' } },
                        { id: { contains: filters.search } },
                    ],
                }),
            },
            include: {
                fbAccount: {
                    select: {
                        id: true,
                        name: true,
                    },
                },
                _count: {
                    select: {
                        campaigns: true,
                        adsets: true,
                        ads: true,
                    },
                },
            },
            orderBy: { syncedAt: 'desc' },
        });
    }

    /**
     * Get ad account by ID (with ownership check)
     */
    async getAdAccount(adAccountId: string, userId: number) {
        const adAccount = await this.prisma.adAccount.findFirst({
            where: {
                id: adAccountId,
                fbAccount: { userId },
            },
            include: {
                fbAccount: {
                    select: {
                        id: true,
                        name: true,
                    },
                },
            },
        });

        if (!adAccount) {
            throw new ForbiddenException('Ad account not found or access denied');
        }

        return adAccount;
    }

    /**
     * Verify user has access to ad account
     */
    async verifyAccess(userId: number, adAccountId: string): Promise<boolean> {
        const adAccount = await this.prisma.adAccount.findFirst({
            where: {
                id: adAccountId,
                fbAccount: { userId },
            },
        });
        return !!adAccount;
    }
}

