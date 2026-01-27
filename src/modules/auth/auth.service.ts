import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '@n-database/prisma/prisma.service';
import * as bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
// import { UpdateProfileDto, UpdatePasswordDto } from './dtos';

@Injectable()
export class AuthService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly jwtService: JwtService,
    ) { }

    async register(email: string, password: string, name?: string) {
        // Check if user exists
        const existing = await this.prisma.user.findUnique({ where: { email } });
        if (existing) {
            throw new ConflictException('Email already registered');
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Create user
        const user = await this.prisma.user.create({
            data: {
                email,
                password: hashedPassword,
                name,
            },
        });

        return this.generateTokens(user.id, user.email);
    }

    async login(email: string, password: string) {
        const user = await this.prisma.user.findUnique({ where: { email } });
        if (!user) {
            throw new UnauthorizedException('Invalid credentials');
        }

        if (!user.isActive) {
            throw new UnauthorizedException('Account is disabled');
        }

        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
            throw new UnauthorizedException('Invalid credentials');
        }

        return this.generateTokens(user.id, user.email);
    }

    async refreshToken(refreshToken: string) {
        const tokenRecord = await this.prisma.refreshToken.findUnique({
            where: { token: refreshToken },
            include: { user: true },
        });

        if (!tokenRecord) {
            throw new UnauthorizedException('Invalid refresh token');
        }

        if (new Date() > tokenRecord.expiresAt) {
            await this.prisma.refreshToken.delete({ where: { id: tokenRecord.id } });
            throw new UnauthorizedException('Refresh token expired');
        }

        // Delete old refresh token
        await this.prisma.refreshToken.delete({ where: { id: tokenRecord.id } });

        // Generate new tokens
        return this.generateTokens(tokenRecord.userId, tokenRecord.user.email);
    }

    async logout(userId: number) {
        await this.prisma.refreshToken.deleteMany({ where: { userId } });
        return { message: 'Logged out successfully' };
    }

    async getMe(userId: number) {
        return this.prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                email: true,
                name: true,
                isActive: true,
                createdAt: true,
                identities: {
                    select: {
                        id: true,
                        name: true,
                        externalId: true,
                        isValid: true,
                        platform: { select: { name: true, code: true } },
                        _count: { select: { accounts: true, credentials: true } },
                    },
                },
            },
        });
    }

    private async generateTokens(userId: number, email: string) {
        const payload = { sub: userId, email };
        const accessToken = this.jwtService.sign(payload);

        // Create refresh token
        const refreshToken = uuidv4();
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 7); // 7 days

        await this.prisma.refreshToken.create({
            data: {
                userId,
                token: refreshToken,
                expiresAt,
            },
        });

        return {
            accessToken,
            refreshToken,
            expiresIn: 3600, // 1 hour
        };
    }
}
