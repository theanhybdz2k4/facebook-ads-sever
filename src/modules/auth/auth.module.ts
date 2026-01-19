import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { PrismaModule } from '@n-database/prisma/prisma.module';
import { AuthController } from './auth.controller';
import { JwtAuthGuard, InternalApiKeyGuard, PlatformAccountPermissionGuard } from './guards';
import { RateLimitGuard } from '../shared/guards/rate-limit.guard';

@Module({
    imports: [
        PrismaModule,
        ConfigModule,
        PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.registerAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (configService: ConfigService) => {
                const secret = configService.get<string>('JWT_SECRET');
                if (!secret) {
                    throw new Error('JWT_SECRET is required but not set in environment variables');
                }
                return {
                    secret,
                    signOptions: { expiresIn: '1h' },
                };
            },
        }),
    ],
    controllers: [AuthController],
    providers: [AuthService, JwtStrategy, JwtAuthGuard, InternalApiKeyGuard, PlatformAccountPermissionGuard, RateLimitGuard],
    exports: [AuthService, JwtModule, JwtAuthGuard, InternalApiKeyGuard, PlatformAccountPermissionGuard],
})
export class AuthModule { }

