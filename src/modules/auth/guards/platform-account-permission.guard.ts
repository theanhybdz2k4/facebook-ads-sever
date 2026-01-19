import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';

@Injectable()
export class PlatformAccountPermissionGuard implements CanActivate {
    constructor(private readonly prisma: PrismaService) { }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest();
        const userId = request.user?.id;

        if (!userId) throw new ForbiddenException('User not authenticated');

        const accountIdStr = request.body?.accountId || request.params?.accountId || request.query?.accountId;
        if (!accountIdStr) return true;

        const accountId = Number(accountIdStr);
        if (isNaN(accountId)) return true;

        const account = await this.prisma.platformAccount.findFirst({
            where: {
                id: accountId,
                identity: { userId },
            },
        });

        if (!account) throw new ForbiddenException('Access denied to this platform account');

        return true;
    }
}
