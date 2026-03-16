import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';

@Injectable()
export class TokenService {
    private readonly logger = new Logger(TokenService.name);

    constructor(private readonly prisma: PrismaService) { }

    /**
     * Get default token for a Platform Identity
     */
    async getDefaultTokenForFbAccount(platformIdentityId: number): Promise<string | null> {
        // Since schema doesn't have isDefault, we take the most recent active credential
        const credential = await this.prisma.platformCredential.findFirst({
            where: {
                platformIdentityId,
                isActive: true,
                OR: [
                    { expiresAt: null },
                    { expiresAt: { gt: new Date() } },
                ],
            },
            orderBy: { createdAt: 'desc' },
        });

        return credential?.credentialValue || null;
    }

    /**
     * Get token for a Platform Account (e.g. Ad Account)
     */
    async getTokenForAdAccount(platformAccountId: number): Promise<string | null> {
        const account = await this.prisma.platformAccount.findUnique({
            where: { id: platformAccountId },
            include: {
                identity: {
                    include: {
                        credentials: {
                            where: { isActive: true },
                            orderBy: { createdAt: 'desc' },
                            take: 1,
                        },
                    },
                },
            },
        });

        const credential = account?.identity?.credentials?.[0];
        return credential?.credentialValue || null;
    }

    /**
     * Mark token as invalid (Updated: platformIdentity handles errors in this schema)
     */
    async markTokenInvalid(credentialId: number, errorMessage?: string) {
        const credential = await this.prisma.platformCredential.findUnique({
            where: { id: credentialId },
            select: { platformIdentityId: true }
        });

        if (credential) {
            // Update identity status as well since it holds the error fields
            await this.prisma.platformIdentity.update({
                where: { id: credential.platformIdentityId },
                data: { 
                    isValid: false,
                    errorMessage 
                }
            });
        }

        return this.prisma.platformCredential.update({
            where: { id: credentialId },
            data: { isActive: false },
        });
    }

    /**
     * Get all credentials for a Platform Identity
     */
    async getTokensForFbAccount(platformIdentityId: number) {
        return this.prisma.platformCredential.findMany({
            where: { platformIdentityId },
            orderBy: { createdAt: 'desc' },
        });
    }

    /**
     * Delete credential
     */
    async deleteToken(credentialId: number) {
        return this.prisma.platformCredential.delete({
            where: { id: credentialId },
        });
    }
}
