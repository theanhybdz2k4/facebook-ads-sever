import { Injectable, Logger, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { FacebookApiService } from '../../shared/services/facebook-api.service';

@Injectable()
export class FbAccountsService {
    private readonly logger = new Logger(FbAccountsService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly facebookApi: FacebookApiService,
    ) { }

    /**
     * Thêm nick FB mới cho user
     */
    async addFbAccount(userId: number, accessToken: string, name?: string) {
        // Validate token bằng cách gọi /me
        let fbUserInfo: any;
        try {
            const { data } = await this.facebookApi.get<any>(
                '/me',
                accessToken,
                { fields: 'id,name' },
            );
            fbUserInfo = data;
        } catch (error) {
            throw new BadRequestException('Invalid Facebook access token');
        }

        // Tạo FbAccount
        const fbAccount = await this.prisma.fbAccount.create({
            data: {
                userId,
                fbUserId: fbUserInfo.id,
                name: name || fbUserInfo.name,
            },
        });

        // Tạo token mặc định
        await this.prisma.fbApiToken.create({
            data: {
                fbAccountId: fbAccount.id,
                name: 'Default Token',
                accessToken,
                isDefault: true,
            },
        });

        return this.getFbAccountWithDetails(fbAccount.id, userId);
    }

    /**
     * Lấy danh sách FB accounts của user
     */
    async getFbAccountsByUser(userId: number) {
        return this.prisma.fbAccount.findMany({
            where: { userId },
            include: {
                _count: { select: { adAccounts: true, tokens: true } },
                tokens: {
                    select: {
                        id: true,
                        name: true,
                        isDefault: true,
                        isValid: true,
                        expiresAt: true,
                    },
                },
            },
            orderBy: { createdAt: 'desc' },
        });
    }

    /**
     * Lấy chi tiết 1 FB account (với ownership check)
     */
    async getFbAccountWithDetails(fbAccountId: number, userId: number) {
        const fbAccount = await this.prisma.fbAccount.findFirst({
            where: { id: fbAccountId, userId },
            include: {
                adAccounts: {
                    select: { id: true, name: true, accountStatus: true },
                },
                tokens: {
                    select: {
                        id: true,
                        name: true,
                        isDefault: true,
                        isValid: true,
                        expiresAt: true,
                        lastUsedAt: true,
                    },
                },
            },
        });

        if (!fbAccount) {
            throw new ForbiddenException('FB account not found or access denied');
        }

        return fbAccount;
    }

    /**
     * Thêm token mới cho FB account
     */
    async addToken(
        fbAccountId: number,
        userId: number,
        accessToken: string,
        name?: string,
        isDefault?: boolean,
    ) {
        // Verify ownership
        const fbAccount = await this.prisma.fbAccount.findFirst({
            where: { id: fbAccountId, userId },
        });

        if (!fbAccount) {
            throw new ForbiddenException('FB account not found or access denied');
        }

        // Validate token
        try {
            await this.facebookApi.get<any>('/me', accessToken, { fields: 'id' });
        } catch (error) {
            throw new BadRequestException('Invalid Facebook access token');
        }

        // Nếu isDefault, bỏ flag của tokens cũ
        if (isDefault) {
            await this.prisma.fbApiToken.updateMany({
                where: { fbAccountId, isDefault: true },
                data: { isDefault: false },
            });
        }

        return this.prisma.fbApiToken.create({
            data: {
                fbAccountId,
                name: name || 'Token',
                accessToken,
                isDefault: isDefault || false,
            },
        });
    }

    /**
     * Xóa FB account
     */
    async deleteFbAccount(userId: number, fbAccountId: number) {
        const fbAccount = await this.prisma.fbAccount.findFirst({
            where: { id: fbAccountId, userId },
        });

        if (!fbAccount) {
            throw new NotFoundException('FB account not found');
        }

        // Unlink ad accounts
        await this.prisma.adAccount.updateMany({
            where: { fbAccountId },
            data: { fbAccountId: null },
        });

        // Delete tokens (cascade)
        await this.prisma.fbAccount.delete({ where: { id: fbAccountId } });

        return { message: 'FB account deleted' };
    }

    /**
     * Sync ad accounts từ FB
     */
    async syncAdAccounts(fbAccountId: number, userId: number) {
        // Verify ownership
        const fbAccount = await this.prisma.fbAccount.findFirst({
            where: { id: fbAccountId, userId },
            include: { tokens: { where: { isDefault: true, isValid: true } } },
        });

        if (!fbAccount) {
            throw new ForbiddenException('FB account not found or access denied');
        }

        const token = fbAccount.tokens[0];
        if (!token) {
            throw new BadRequestException('No valid default token for this FB account');
        }

        // Lấy danh sách ad accounts từ FB
        const accounts = await this.facebookApi.getAdAccounts(token.accessToken);
        const now = new Date();

        // Batch upsert all accounts in a single transaction
        await this.prisma.$transaction(
            accounts.map(account =>
                this.prisma.adAccount.upsert({
                    where: { id: account.id },
                    create: {
                        id: account.id,
                        fbAccountId,
                        name: account.name,
                        accountStatus: account.account_status || 1,
                        currency: account.currency || 'USD',
                        syncedAt: now,
                    },
                    update: {
                        fbAccountId,
                        name: account.name,
                        accountStatus: account.account_status || 1,
                        currency: account.currency || 'USD',
                        syncedAt: now,
                    },
                })
            )
        );

        this.logger.log(`Synced ${accounts.length} ad accounts for FbAccount #${fbAccountId}`);
        return { synced: accounts.length, accounts: accounts.map(a => ({ id: a.id, name: a.name })) };
    }

    /**
     * Kiểm tra user có quyền truy cập account không
     */
    async userHasAccess(userId: number, adAccountId: string): Promise<boolean> {
        const adAccount = await this.prisma.adAccount.findFirst({
            where: {
                id: adAccountId,
                fbAccount: { userId },
            },
        });
        return !!adAccount;
    }
}

