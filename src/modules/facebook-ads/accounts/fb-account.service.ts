import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { FacebookApiService } from '../api/facebook-api.service';

@Injectable()
export class FbAccountService {
    private readonly logger = new Logger(FbAccountService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly facebookApi: FacebookApiService,
    ) { }

    /**
     * Get or create Facebook Platform entry
     */
    private async getFbPlatformId() {
        const platform = await this.prisma.platform.upsert({
            where: { id: 1 }, // Assuming ID 1 or find by code
            create: { id: 1, name: 'Facebook', code: 'facebook' },
            update: { code: 'facebook' },
        });
        return platform.id;
    }

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

        const platformId = await this.getFbPlatformId();

        // Tìm hoặc tạo PlatformIdentity
        let identity = await this.prisma.platformIdentity.findFirst({
            where: { platformId, externalId: fbUserInfo.id }
        });

        if (identity) {
            identity = await this.prisma.platformIdentity.update({
                where: { id: identity.id },
                data: { 
                    userId,
                    name: name || fbUserInfo.name,
                    isValid: true,
                }
            });
        } else {
            identity = await this.prisma.platformIdentity.create({
                data: {
                    userId,
                    platformId,
                    externalId: fbUserInfo.id,
                    name: name || fbUserInfo.name,
                },
            });
        }

        // Tạo PlatformCredential
        await this.prisma.platformCredential.create({
            data: {
                platformIdentityId: identity.id,
                credentialValue: accessToken,
                credentialType: 'access_token',
                isActive: true,
            },
        });

        return this.getFbAccountWithDetails(identity.id);
    }

    /**
     * Lấy danh sách FB identities của user
     */
    async getFbAccountsByUser(userId: number) {
        return this.prisma.platformIdentity.findMany({
            where: { userId },
            include: {
                _count: { select: { accounts: true, credentials: true } },
                credentials: {
                    where: { isActive: true },
                    select: {
                        id: true,
                        isActive: true,
                        expiresAt: true,
                    },
                },
            },
            orderBy: { createdAt: 'desc' },
        });
    }

    /**
     * Lấy chi tiết 1 FB identity
     */
    async getFbAccountWithDetails(platformIdentityId: number) {
        return this.prisma.platformIdentity.findUnique({
            where: { id: platformIdentityId },
            include: {
                accounts: {
                    select: { id: true, name: true, accountStatus: true },
                },
                credentials: {
                    where: { isActive: true },
                    select: {
                        id: true,
                        isActive: true,
                        expiresAt: true,
                        updatedAt: true,
                    },
                },
            },
        });
    }

    /**
     * Thêm token mới cho FB account
     */
    async addToken(
        platformIdentityId: number,
        accessToken: string,
        name?: string, // Legacy param, not in schema for credential
        isDefault?: boolean, // Legacy param
    ) {
        // Validate token
        try {
            await this.facebookApi.get<any>('/me', accessToken, { fields: 'id' });
        } catch (error) {
            throw new BadRequestException('Invalid Facebook access token');
        }

        // Nếu isDefault, deactivate tokens cũ
        if (isDefault) {
            await this.prisma.platformCredential.updateMany({
                where: { platformIdentityId, isActive: true },
                data: { isActive: false },
            });
        }

        return this.prisma.platformCredential.create({
            data: {
                platformIdentityId,
                credentialValue: accessToken,
                isActive: true,
                credentialType: 'access_token',
            },
        });
    }

    /**
     * Xóa FB account
     */
    async deleteFbAccount(userId: number, platformIdentityId: number) {
        const identity = await this.prisma.platformIdentity.findFirst({
            where: { id: platformIdentityId, userId },
        });

        if (!identity) {
            throw new NotFoundException('FB identity not found');
        }

        // platform_accounts will be handled by foreign key or manually
        await this.prisma.platformIdentity.delete({ where: { id: platformIdentityId } });

        return { message: 'FB identity deleted' };
    }

    /**
     * Sync ad accounts từ FB
     */
    async syncAdAccounts(platformIdentityId: number) {
        const identity = await this.prisma.platformIdentity.findUnique({
            where: { id: platformIdentityId },
            include: { credentials: { where: { isActive: true }, orderBy: { createdAt: 'desc' }, take: 1 } },
        });

        if (!identity) {
            throw new NotFoundException('FB identity not found');
        }

        const credential = identity.credentials[0];
        if (!credential) {
            throw new BadRequestException('No valid token for this FB account');
        }

        // Lấy danh sách ad accounts từ FB
        const accounts = await this.facebookApi.getAdAccounts(credential.credentialValue);
        const now = new Date();
        const platformId = identity.platformId;
        let synced = 0;

        for (const account of accounts) {
            const offset = ["VND", "JPY", "KRW", "CLP", "PYG", "ISK"].includes(account.currency?.toUpperCase()) ? 1 : 100;
            const platformData = {
                ...account,
                amount_spent: account.amount_spent ? Number(account.amount_spent) / offset : 0,
                balance: account.balance ? Number(account.balance) / offset : 0,
            };

            await this.prisma.platformAccount.upsert({
                where: { externalId: account.id },
                create: {
                    platformIdentityId,
                    platformId,
                    externalId: account.id,
                    name: account.name,
                    accountStatus: String(account.account_status || 1),
                    currency: account.currency || 'USD',
                    timezone: account.timezone_name,
                    platformData,
                    syncedAt: now,
                },
                update: {
                    platformIdentityId,
                    name: account.name,
                    accountStatus: String(account.account_status || 1),
                    currency: account.currency || 'USD',
                    timezone: account.timezone_name,
                    platformData,
                    syncedAt: now,
                },
            });
            synced++;
        }

        this.logger.log(`Synced ${synced} ad accounts for Identity #${platformIdentityId}`);
        return { synced, accounts: accounts.map(a => ({ id: a.id, name: a.name })) };
    }

    /**
     * Kiểm tra user có quyền truy cập account không 
     */
    async userHasAccess(userId: number, platformAccountId: number): Promise<boolean> {
        const account = await this.prisma.platformAccount.findFirst({
            where: {
                id: platformAccountId,
                identity: { userId },
            },
        });
        return !!account;
    }
}
