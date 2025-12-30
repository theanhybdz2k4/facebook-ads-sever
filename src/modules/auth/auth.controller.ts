import { Controller, Post, Get, Body, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RegisterDto, LoginDto, RefreshTokenDto } from './dtos';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
    constructor(private readonly authService: AuthService) { }

    @Post('register')
    @ApiOperation({ summary: 'Register new user' })
    async register(@Body() dto: RegisterDto) {
        return this.authService.register(dto.email, dto.password, dto.name);
    }

    @Post('login')
    @ApiOperation({ summary: 'Login' })
    async login(@Body() dto: LoginDto) {
        return this.authService.login(dto.email, dto.password);
    }

    @Post('refresh')
    @ApiOperation({ summary: 'Refresh access token' })
    async refresh(@Body() dto: RefreshTokenDto) {
        return this.authService.refreshToken(dto.refreshToken);
    }

    @Post('logout')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Logout' })
    async logout(@Request() req: any) {
        return this.authService.logout(req.user.id);
    }

    @Get('me')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Get current user info' })
    async getMe(@Request() req: any) {
        return this.authService.getMe(req.user.id);
    }
}
