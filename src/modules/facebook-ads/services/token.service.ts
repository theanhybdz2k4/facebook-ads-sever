import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';

@Injectable()
export class TokenService {
    private readonly logger = new Logger(TokenService.name);

    constructor(private readonly prisma: PrismaService) { }

    /**
     * Lấy token mặc định cho FB account
     */
    async getDefaultTokenForFbAccount(fbAccountId: number): Promise<string | null> {
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
    async getTokenForAdAccount(adAccountId: string): Promise<string | null> {
        const adAccount = await this.prisma.adAccount.findUnique({
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

    /**
     * Mark token as invalid
     */
    async markTokenInvalid(tokenId: number, errorMessage?: string) {
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
    async getTokensForFbAccount(fbAccountId: number) {
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
    async setDefaultToken(fbAccountId: number, tokenId: number) {
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
    async deleteToken(tokenId: number) {
        return this.prisma.fbApiToken.delete({
            where: { id: tokenId },
        });
    }
}
