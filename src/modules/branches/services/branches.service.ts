import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';

export interface CreateBranchDto {
    name: string;
    code?: string;
}

export interface UpdateBranchDto {
    name?: string;
    code?: string;
}

@Injectable()
export class BranchesService {
    constructor(private readonly prisma: PrismaService) { }

    async getBranches(userId: number) {
        return this.prisma.branch.findMany({
            where: { userId },
            include: {
                accounts: {
                    select: { id: true, name: true, accountStatus: true, platform: { select: { name: true } } },
                },
                _count: {
                    select: { accounts: true },
                },
            },
            orderBy: { name: 'asc' },
        });
    }

    async getBranchesSimple(userId: number) {
        return this.prisma.branch.findMany({
            where: { userId },
            select: { id: true, name: true, code: true },
            orderBy: { name: 'asc' },
        });
    }

    async getBranch(branchId: number, userId: number) {
        const branch = await this.prisma.branch.findFirst({
            where: { id: branchId, userId },
            include: {
                accounts: {
                    select: {
                        id: true,
                        name: true,
                        accountStatus: true,
                        currency: true,
                        platform: { select: { name: true } }
                    },
                },
            },
        });

        if (!branch) throw new NotFoundException('Branch not found');
        return branch;
    }

    async getBranchByCode(code: string, userId: number) {
        const branch = await this.prisma.branch.findFirst({
            where: { code, userId },
        });
        if (!branch) throw new NotFoundException(`Branch "${code}" not found`);
        return branch;
    }

    async createBranch(userId: number, dto: CreateBranchDto) {
        const existing = await this.prisma.branch.findFirst({
            where: { userId, name: dto.name },
        });
        if (existing) throw new BadRequestException(`Branch "${dto.name}" already exists`);

        return this.prisma.branch.create({
            data: {
                userId,
                name: dto.name,
                code: dto.code,
            },
        });
    }

    async updateBranch(branchId: number, userId: number, dto: UpdateBranchDto) {
        const branch = await this.getBranch(branchId, userId);

        if (dto.name && dto.name !== branch.name) {
            const existing = await this.prisma.branch.findFirst({
                where: { userId, name: dto.name, id: { not: branchId } },
            });
            if (existing) throw new BadRequestException(`Branch "${dto.name}" already exists`);
        }

        return this.prisma.branch.update({
            where: { id: branchId },
            data: {
                ...(dto.name && { name: dto.name }),
                ...(dto.code !== undefined && { code: dto.code }),
            },
        });
    }

    async deleteBranch(branchId: number, userId: number) {
        await this.getBranch(branchId, userId);

        // Unassign accounts
        await this.prisma.platformAccount.updateMany({
            where: { branchId },
            data: { branchId: null },
        });

        return this.prisma.branch.delete({
            where: { id: branchId },
        });
    }

    async assignAccountToBranch(accountId: number, branchId: number | null, userId: number) {
        if (branchId !== null) {
            await this.getBranch(branchId, userId);
        }

        const account = await this.prisma.platformAccount.findFirst({
            where: {
                id: accountId,
                identity: { userId },
            },
        });

        if (!account) throw new NotFoundException('Account not found');

        return this.prisma.platformAccount.update({
            where: { id: accountId },
            data: { branchId },
            include: { branch: true },
        });
    }
}
