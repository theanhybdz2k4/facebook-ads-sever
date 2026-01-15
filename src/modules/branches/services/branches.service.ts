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

    /**
     * Get all branches for a user
     */
    async getBranches(userId: number) {
        return this.prisma.branch.findMany({
            where: { userId },
            include: {
                adAccounts: {
                    select: { id: true, name: true, accountStatus: true },
                },
                _count: {
                    select: { adAccounts: true },
                },
            },
            orderBy: { name: 'asc' },
        });
    }

    /**
     * Get a specific branch with its ad accounts
     */
    async getBranch(branchId: number, userId: number) {
        const branch = await this.prisma.branch.findFirst({
            where: { id: branchId, userId },
            include: {
                adAccounts: {
                    select: {
                        id: true,
                        name: true,
                        accountStatus: true,
                        currency: true,
                        amountSpent: true,
                    },
                },
            },
        });

        if (!branch) {
            throw new NotFoundException(`Branch not found`);
        }

        return branch;
    }

    /**
     * Get branch by code for a specific user
     */
    async getBranchByCode(code: string, userId: number) {
        const branch = await this.prisma.branch.findFirst({
            where: { code, userId },
        });

        if (!branch) {
            throw new NotFoundException(`Branch with code "${code}" not found`);
        }

        return branch;
    }

    /**
     * Create a new branch
     */
    async createBranch(userId: number, dto: CreateBranchDto) {
        // Check if name already exists for this user
        const existing = await this.prisma.branch.findFirst({
            where: { userId, name: dto.name },
        });

        if (existing) {
            throw new BadRequestException(`Branch "${dto.name}" already exists`);
        }

        return this.prisma.branch.create({
            data: {
                userId,
                name: dto.name,
                code: dto.code,
            },
        });
    }

    /**
     * Update a branch
     */
    async updateBranch(branchId: number, userId: number, dto: UpdateBranchDto) {
        const branch = await this.prisma.branch.findFirst({
            where: { id: branchId, userId },
        });

        if (!branch) {
            throw new NotFoundException(`Branch not found`);
        }

        // Check for name conflict if updating name
        if (dto.name && dto.name !== branch.name) {
            const existing = await this.prisma.branch.findFirst({
                where: { userId, name: dto.name, id: { not: branchId } },
            });

            if (existing) {
                throw new BadRequestException(`Branch "${dto.name}" already exists`);
            }
        }

        return this.prisma.branch.update({
            where: { id: branchId },
            data: {
                ...(dto.name && { name: dto.name }),
                ...(dto.code !== undefined && { code: dto.code }),
            },
        });
    }

    /**
     * Delete a branch
     */
    async deleteBranch(branchId: number, userId: number) {
        const branch = await this.prisma.branch.findFirst({
            where: { id: branchId, userId },
        });

        if (!branch) {
            throw new NotFoundException(`Branch not found`);
        }

        // Unassign all ad accounts first
        await this.prisma.adAccount.updateMany({
            where: { branchId },
            data: { branchId: null },
        });

        return this.prisma.branch.delete({
            where: { id: branchId },
        });
    }

    /**
     * Assign an ad account to a branch
     */
    async assignAdAccountToBranch(adAccountId: string, branchId: number | null, userId: number) {
        // Verify branch belongs to user (if branchId is provided)
        if (branchId !== null) {
            const branch = await this.prisma.branch.findFirst({
                where: { id: branchId, userId },
            });

            if (!branch) {
                throw new NotFoundException(`Branch not found`);
            }
        }

        // Verify ad account belongs to user
        const adAccount = await this.prisma.adAccount.findFirst({
            where: {
                id: adAccountId,
                fbAccount: { userId },
            },
        });

        if (!adAccount) {
            throw new NotFoundException(`Ad account not found`);
        }

        return this.prisma.adAccount.update({
            where: { id: adAccountId },
            data: { branchId },
            include: {
                branch: true,
            },
        });
    }
}
