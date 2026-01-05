import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';

@Injectable()
export class TokensService {
    private readonly logger = new Logger(TokensService.name);

    constructor(private readonly prisma: PrismaService) { }

    /**
     * Lấy token mặc định cho FB account
     */
    async getDefaultTokenForFbAccount(fbAccountId: number, userId: number): Promise<string | null> {
        // Verify ownership
        const fbAccount = await this.prisma.fbAccount.findFirst({
            where: { id: fbAccountId, userId },
        });

        if (!fbAccount) {
            throw new ForbiddenException('FB account not found or access denied');
        }

        const token = await this.prisma.fbApiToken.findFirst({
            where: {
                fbAccountId,
                isDefault: true,
                isValid: true,
                OR: [
                    { expiresAt: null },
                    { expiresAt: { gt: new Date() } },
                ],
            },
        });

        if (token) {
            await this.prisma.fbApiToken.update({
                where: { id: token.id },
                data: { lastUsedAt: new Date() },
            });
            return token.accessToken;
        }

        return null;
    }

    /**
     * Lấy token cho AdAccount (thông qua FbAccount)
     */
    async getTokenForAdAccount(adAccountId: string, userId: number): Promise<string | null> {
        const adAccount = await this.prisma.adAccount.findFirst({
            where: { 
                id: adAccountId,
                fbAccount: { userId },
            },
            include: {
                fbAccount: {
                    include: {
                        tokens: {
                            where: { isDefault: true, isValid: true },
                            take: 1,
                        },
                    },
                },
            },
        });

        const token = adAccount?.fbAccount?.tokens?.[0];
        if (token) {
            await this.prisma.fbApiToken.update({
                where: { id: token.id },
                data: { lastUsedAt: new Date() },
            });
            return token.accessToken;
        }

        return null;
    }

    /**
     * Mark token as invalid
     */
    async markTokenInvalid(tokenId: number, userId: number, errorMessage?: string) {
        // Verify ownership
        const token = await this.prisma.fbApiToken.findFirst({
            where: {
                id: tokenId,
                fbAccount: { userId },
            },
        });

        if (!token) {
            throw new ForbiddenException('Token not found or access denied');
        }

        return this.prisma.fbApiToken.update({
            where: { id: tokenId },
            data: {
                isValid: false,
                errorMessage,
            },
        });
    }

    /**
     * Get all tokens for a FB account
     */
    async getTokensForFbAccount(fbAccountId: number, userId: number) {
        // Verify ownership
        const fbAccount = await this.prisma.fbAccount.findFirst({
            where: { id: fbAccountId, userId },
        });

        if (!fbAccount) {
            throw new ForbiddenException('FB account not found or access denied');
        }

        return this.prisma.fbApiToken.findMany({
            where: { fbAccountId },
            select: {
                id: true,
                name: true,
                tokenType: true,
                isDefault: true,
                isValid: true,
                expiresAt: true,
                lastUsedAt: true,
                errorMessage: true,
                createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
        });
    }

    /**
     * Set default token
     */
    async setDefaultToken(fbAccountId: number, tokenId: number, userId: number) {
        // Verify ownership
        const fbAccount = await this.prisma.fbAccount.findFirst({
            where: { id: fbAccountId, userId },
        });

        if (!fbAccount) {
            throw new ForbiddenException('FB account not found or access denied');
        }

        // Unset old default
        await this.prisma.fbApiToken.updateMany({
            where: { fbAccountId, isDefault: true },
            data: { isDefault: false },
        });

        // Set new default
        return this.prisma.fbApiToken.update({
            where: { id: tokenId },
            data: { isDefault: true },
        });
    }

    /**
     * Delete token
     */
    async deleteToken(tokenId: number, userId: number) {
        // Verify ownership
        const token = await this.prisma.fbApiToken.findFirst({
            where: {
                id: tokenId,
                fbAccount: { userId },
            },
        });

        if (!token) {
            throw new ForbiddenException('Token not found or access denied');
        }

        return this.prisma.fbApiToken.delete({
            where: { id: tokenId },
        });
    }

    /**
     * Get token for AdAccount (internal use - no userId check)
     * Used by processors and cron jobs that don't have user context
     */
    async getTokenForAdAccountInternal(adAccountId: string): Promise<string | null> {
        const adAccount = await this.prisma.adAccount.findFirst({
            where: { id: adAccountId },
            include: {
                fbAccount: {
                    include: {
                        tokens: {
                            where: { isDefault: true, isValid: true },
                            take: 1,
                        },
                    },
                },
            },
        });

        const token = adAccount?.fbAccount?.tokens?.[0];
        if (token) {
            await this.prisma.fbApiToken.update({
                where: { id: token.id },
                data: { lastUsedAt: new Date() },
            });
            return token.accessToken;
        }

        return null;
    }
}

