import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';

/**
 * Guard to verify user has permission to access specific ad account
 * Checks if ad account belongs to user via FbAccount relationship
 * 
 * Extracts accountId from:
 * - body.accountId (POST requests)
 * - params.accountId (route params)
 * - query.accountId (query params)
 */
@Injectable()
export class AdAccountPermissionGuard implements CanActivate {
    constructor(private readonly prisma: PrismaService) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest();
        const userId = request.user?.id;

        if (!userId) {
            throw new ForbiddenException('User not authenticated');
        }

        // Extract accountId from various sources
        const accountId = 
            request.body?.accountId || 
            request.params?.accountId || 
            request.query?.accountId;

        // If no accountId specified, allow (other guards/logic should handle)
        if (!accountId) {
            return true;
        }

        // Check if this ad account belongs to the user via FbAccount
        const adAccount = await this.prisma.adAccount.findFirst({
            where: {
                id: accountId,
                fbAccount: { userId },
            },
        });

        if (!adAccount) {
            throw new ForbiddenException('You do not have permission to access this ad account');
        }

        return true;
    }
}
