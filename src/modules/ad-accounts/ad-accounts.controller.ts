import { Controller, Get, Put, Param, Query, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdAccountsService } from './services/ad-accounts.service';
import { BranchesService } from '../branches/services/branches.service';
import { CurrentUser } from '../shared/decorators/current-user.decorator';

@ApiTags('Ad Accounts')
@Controller('ad-accounts')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AdAccountsController {
    constructor(
        private readonly adAccountsService: AdAccountsService,
        private readonly branchesService: BranchesService,
    ) { }

    @Get()
    @ApiOperation({ summary: 'List active ad accounts' })
    async getAdAccounts(
        @CurrentUser() user: any,
        @Query('accountStatus') accountStatus?: string,
        @Query('search') search?: string,
    ) {
        return this.adAccountsService.getAdAccounts(user.id, {
            accountStatus: accountStatus ? parseInt(accountStatus, 10) : undefined,
            search,
        });
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get ad account details' })
    async getAdAccount(
        @Param('id') id: string,
        @CurrentUser() user: any,
    ) {
        return this.adAccountsService.getAdAccount(id, user.id);
    }

    @Put(':id/branch')
    @ApiOperation({ summary: 'Assign or remove branch for ad account' })
    async assignBranch(
        @Param('id') id: string,
        @CurrentUser() user: any,
        @Body() dto: { branchId: number | null },
    ) {
        return this.branchesService.assignAdAccountToBranch(id, dto.branchId, user.id);
    }
}

