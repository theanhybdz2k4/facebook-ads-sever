import { Controller, Post, Get, Delete, Param, Body, ParseIntPipe, UseGuards, Request } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { FbAccountsService } from './services/fb-accounts.service';
import { AddFbAccountDto, AddTokenDto } from './dtos';
import { CurrentUser } from '../shared/decorators/current-user.decorator';

@ApiTags('FB Accounts')
@Controller('fb-accounts')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class FbAccountsController {
    constructor(private readonly fbAccountsService: FbAccountsService) { }

    @Post()
    @ApiOperation({ summary: 'Add new FB account (enter token)' })
    async addFbAccount(
        @CurrentUser() user: any,
        @Body() dto: AddFbAccountDto,
    ) {
        return this.fbAccountsService.addFbAccount(user.id, dto.accessToken, dto.name);
    }

    @Get()
    @ApiOperation({ summary: 'List user FB accounts' })
    async getFbAccounts(@CurrentUser() user: any) {
        return this.fbAccountsService.getFbAccountsByUser(user.id);
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get FB account details' })
    async getFbAccount(
        @Param('id', ParseIntPipe) id: number,
        @CurrentUser() user: any,
    ) {
        return this.fbAccountsService.getFbAccountWithDetails(id, user.id);
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Delete FB account' })
    async deleteFbAccount(
        @Param('id', ParseIntPipe) id: number,
        @CurrentUser() user: any,
    ) {
        return this.fbAccountsService.deleteFbAccount(user.id, id);
    }

    @Post(':id/sync')
    @ApiOperation({ summary: 'Sync ad accounts from FB' })
    async syncAdAccounts(
        @Param('id', ParseIntPipe) id: number,
        @CurrentUser() user: any,
    ) {
        return this.fbAccountsService.syncAdAccounts(id, user.id);
    }

    @Post(':id/tokens')
    @ApiOperation({ summary: 'Add token to FB account' })
    async addToken(
        @Param('id', ParseIntPipe) id: number,
        @CurrentUser() user: any,
        @Body() dto: AddTokenDto,
    ) {
        return this.fbAccountsService.addToken(id, user.id, dto.accessToken, dto.name, dto.isDefault);
    }
}

