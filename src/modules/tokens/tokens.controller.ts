import { Controller, Get, Post, Put, Delete, Param, Body, ParseIntPipe, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TokensService } from './services/tokens.service';
import { CurrentUser } from '../shared/decorators/current-user.decorator';

@ApiTags('Tokens')
@Controller('tokens')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class TokensController {
    constructor(private readonly tokensService: TokensService) { }

    @Get('fb-accounts/:fbAccountId')
    @ApiOperation({ summary: 'Get all tokens for a FB account' })
    async getTokens(
        @Param('fbAccountId', ParseIntPipe) fbAccountId: number,
        @CurrentUser() user: any,
    ) {
        return this.tokensService.getTokensForFbAccount(fbAccountId, user.id);
    }

    @Put('fb-accounts/:fbAccountId/tokens/:tokenId/set-default')
    @ApiOperation({ summary: 'Set default token for FB account' })
    async setDefaultToken(
        @Param('fbAccountId', ParseIntPipe) fbAccountId: number,
        @Param('tokenId', ParseIntPipe) tokenId: number,
        @CurrentUser() user: any,
    ) {
        return this.tokensService.setDefaultToken(fbAccountId, tokenId, user.id);
    }

    @Delete('tokens/:tokenId')
    @ApiOperation({ summary: 'Delete a token' })
    async deleteToken(
        @Param('tokenId', ParseIntPipe) tokenId: number,
        @CurrentUser() user: any,
    ) {
        return this.tokensService.deleteToken(tokenId, user.id);
    }
}

