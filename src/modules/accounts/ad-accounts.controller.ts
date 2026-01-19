import { Controller, Get, Put, Body, Param, Query, UseGuards, ParseIntPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@n-modules/auth/guards/jwt-auth.guard';
import { CurrentUser } from '@n-modules/shared/decorators/current-user.decorator';
import { AccountsService } from './accounts.service';

@ApiTags('Ad Accounts (Unified)')
@Controller('ad-accounts')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AdAccountsController {
  constructor(private readonly accountsService: AccountsService) {}

  @Get()
  @ApiOperation({ summary: 'List all platform accounts for user' })
  async getAccounts(
    @CurrentUser('id') userId: number,
    @Query('accountStatus') accountStatus?: string,
    @Query('search') search?: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.accountsService.listAccounts(userId, {
      accountStatus,
      search,
      branchId: branchId && branchId !== 'all' ? Number(branchId) : undefined,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get single account detail' })
  async getAccount(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser('id') userId: number,
  ) {
    return this.accountsService.getAccount(id, userId);
  }

  @Put(':id/branch')
  @ApiOperation({ summary: 'Assign account to a branch' })
  async assignBranch(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser('id') userId: number,
    @Body() body: { branchId: number | null },
  ) {
    return this.accountsService.assignBranch(id, userId, body.branchId);
  }
}
