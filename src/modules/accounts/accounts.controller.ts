import { Controller, Get, Post, Body, Param, UseGuards, ParseIntPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@n-modules/auth/guards/jwt-auth.guard';
import { CurrentUser } from '@n-modules/shared/decorators/current-user.decorator';
import { AccountsService } from './accounts.service';

@ApiTags('Accounts (Unified)')
@Controller('accounts')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AccountsController {
  constructor(private readonly accountsService: AccountsService) {}

  @Post('connect')
  @ApiOperation({ summary: 'Connect a new platform account/identity' })
  async connect(
    @CurrentUser('id') userId: number,
    @Body() body: { platformCode: string; token: string; name?: string },
  ) {
    return this.accountsService.addIdentity(userId, body.platformCode, body.token, body.name);
  }

  @Get('identities')
  @ApiOperation({ summary: 'List connected identities' })
  async getIdentities(@CurrentUser('id') userId: number) {
    return this.accountsService.listIdentities(userId);
  }

  @Post('identities/:id/sync-accounts')
  @ApiOperation({ summary: 'Sync sub-accounts from an identity' })
  async syncAccounts(@Param('id', ParseIntPipe) id: number) {
    return this.accountsService.syncAccounts(id);
  }
}
