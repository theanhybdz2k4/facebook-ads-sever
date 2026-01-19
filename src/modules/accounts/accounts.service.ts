import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { PlatformsService } from '../platforms/platforms.service';

@Injectable()
export class AccountsService {
  private readonly logger = new Logger(AccountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly platformsService: PlatformsService,
  ) { }

  async addIdentity(userId: number, platformCode: string, token: string, name?: string) {
    const platform = await this.prisma.platform.findUnique({
      where: { code: platformCode },
    });

    if (!platform) {
      throw new NotFoundException(`Platform ${platformCode} not found`);
    }

    const adapter = this.platformsService.getAdapter(platformCode);
    const identityInfo = await adapter.validateToken(token);

    const identity = await this.prisma.platformIdentity.upsert({
      where: {
        platformId_externalId: {
          platformId: platform.id,
          externalId: identityInfo.externalId,
        },
      },
      update: {
        name: name || identityInfo.name,
        isValid: true,
      },
      create: {
        userId,
        platformId: platform.id,
        externalId: identityInfo.externalId,
        name: name || identityInfo.name,
      },
    });

    // Handle credentials
    const existingCred = await this.prisma.platformCredential.findFirst({
      where: { identityId: identity.id, credentialType: 'access_token' }
    });

    await this.prisma.platformCredential.upsert({
      where: {
        id: existingCred?.id || -1
      },
      update: {
        credentialValue: token,
        isActive: true,
      },
      create: {
        identityId: identity.id,
        credentialType: 'access_token',
        credentialValue: token,
      },
    });

    return identity;
  }

  async syncAccounts(identityId: number) {
    const identity = await this.prisma.platformIdentity.findUnique({
      where: { id: identityId },
      include: { platform: true, credentials: { where: { credentialType: 'access_token', isActive: true } } },
    });

    if (!identity) throw new NotFoundException('Identity not found');

    const token = identity.credentials[0]?.credentialValue;
    if (!token) throw new ConflictException('No active token found');

    const adapter = this.platformsService.getAdapter(identity.platform.code);
    const accounts = await adapter.fetchAdAccounts(token);

    const now = new Date();
    const results = await Promise.all(
      accounts.map(acc =>
        this.prisma.platformAccount.upsert({
          where: {
            platformId_externalId: {
              platformId: identity.platformId,
              externalId: acc.externalId,
            }
          },
          update: {
            name: acc.name,
            currency: acc.currency,
            timezone: acc.timezone,
            accountStatus: acc.status,
            platformData: acc.metadata,
            syncedAt: now,
          },
          create: {
            identityId: identity.id,
            platformId: identity.platformId,
            externalId: acc.externalId,
            name: acc.name,
            currency: acc.currency,
            timezone: acc.timezone,
            accountStatus: acc.status,
            platformData: acc.metadata,
            syncedAt: now,
          }
        })
      )
    );

    return { count: results.length, accounts: results };
  }

  async listIdentities(userId: number) {
    return this.prisma.platformIdentity.findMany({
      where: { userId },
      include: { platform: true, _count: { select: { accounts: true } } },
    });
  }

  async listAccounts(userId: number, filters: { accountStatus?: string; search?: string; branchId?: number }) {
    const where: any = {
      identity: { userId: userId },
    };

    if (filters.accountStatus) {
      where.accountStatus = filters.accountStatus;
    }

    if (filters.branchId) {
      where.branchId = filters.branchId;
    }

    if (filters.search) {
      where.OR = [
        { name: { contains: filters.search, mode: 'insensitive' } },
        { externalId: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    return this.prisma.platformAccount.findMany({
      where,
      include: { branch: true, platform: true },
      orderBy: { name: 'asc' },
    });
  }

  async getAccount(id: number, userId: number) {
    const account = await this.prisma.platformAccount.findUnique({
      where: { id },
      include: { branch: true, platform: true, identity: true },
    });

    if (!account || account.identity.userId !== userId) {
      throw new NotFoundException('Account not found');
    }

    return account;
  }

  async assignBranch(id: number, userId: number, branchId: number | null) {
    // Verify account ownership
    await this.getAccount(id, userId);

    // Verify branch ownership if provided
    if (branchId) {
      const branch = await this.prisma.branch.findUnique({
        where: { id: branchId },
      });
      if (!branch || branch.userId !== userId) {
        throw new NotFoundException('Branch not found');
      }
    }

    return this.prisma.platformAccount.update({
      where: { id },
      data: { branchId },
    });
  }
}
