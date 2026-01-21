import { Controller, Get, Post, Param, Query, UseGuards, ParseIntPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@n-modules/auth/guards/jwt-auth.guard';
import { CampaignsService } from './campaigns.service';
import { CampaignsSyncService } from './campaigns-sync.service';
import { AdsSyncService } from '../ads/services/ads-sync.service';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { CurrentUser } from '@n-modules/shared/decorators/current-user.decorator';

@ApiTags('Campaigns (Unified)')
@Controller('campaigns')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class CampaignsController {
  constructor(
    private readonly campaignsService: CampaignsService,
    private readonly campaignsSync: CampaignsSyncService,
    private readonly adsSync: AdsSyncService,
    private readonly prisma: PrismaService,
  ) { }

  @Post('sync/account/:id')
  @ApiOperation({ summary: 'Sync campaigns and ads for a platform account' })
  async syncAccount(
    @Param('id', ParseIntPipe) id: number,
    @Query('force') force?: string
  ) {
    const forceFullSync = force === 'true';

    // Use skipSyncedAtUpdate=true to prevent CampaignsSyncService from updating the timestamp
    // until we finish sync both campaigns and ads.
    const campaigns = await this.campaignsSync.syncByAccount(id, forceFullSync, true);
    const ads = await this.adsSync.syncByAccount(id, forceFullSync);

    // Now update syncedAt once
    await this.prisma.platformAccount.update({
      where: { id },
      data: { syncedAt: new Date() }
    });

    return { campaigns, ads };
  }

  @Get()
  @ApiOperation({ summary: 'List all campaigns for user' })
  async getCampaigns(
    @CurrentUser('id') userId: number,
    @Query('accountId') accountId?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('branchId') branchId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.campaignsService.findAll(userId, {
      accountId: accountId ? Number(accountId) : undefined,
      status,
      search,
      branchId: branchId && branchId !== 'all' ? Number(branchId) : undefined,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20,
    });
  }

@Get('by-account/:accountId')
@ApiOperation({ summary: 'List campaigns by unified account ID' })
async getByAccount(
  @CurrentUser('id') userId: number,
  @Param('accountId', ParseIntPipe) accountId: number
) {
  return this.campaignsService.findAll(userId, { accountId });
}

@Get(':id')
@ApiOperation({ summary: 'Get campaign details' })
async getOne(@Param('id') id: string) {
  return this.campaignsService.findOne(id);
}
}
