import { Controller, Get, Post, Param, Query, UseGuards, ParseIntPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@n-modules/auth/guards/jwt-auth.guard';
import { AdsService } from './services/ads.service';
import { AdsSyncService } from './services/ads-sync.service';
import { CurrentUser } from '@n-modules/shared/decorators/current-user.decorator';

@ApiTags('Ads (Unified)')
@Controller('ads')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AdsController {
    constructor(
        private readonly adsService: AdsService,
        private readonly adsSync: AdsSyncService,
    ) { }

    @Post('sync/account/:id')
    @ApiOperation({ summary: 'Sync ads for a platform account' })
    async syncAccount(
        @Param('id', ParseIntPipe) id: number,
        @Query('force') force?: string
    ) {
        const forceFullSync = force === 'true';
        return this.adsSync.syncByAccount(id, forceFullSync);
    }

    @Get()
    @ApiOperation({ summary: 'List all ads for user' })
    async getAds(
        @CurrentUser('id') userId: number,
        @Query('accountId') accountId?: string,
        @Query('adGroupId') adGroupId?: string,
        @Query('status') status?: string,
        @Query('effectiveStatus') effectiveStatus?: string,
        @Query('search') search?: string,
        @Query('branchId') branchId?: string,
    ) {
        return this.adsService.findAll(userId, {
            accountId: accountId ? Number(accountId) : undefined,
            adGroupId,
            status,
            effectiveStatus,
            search,
            branchId: branchId && branchId !== 'all' ? Number(branchId) : undefined,
        });
    }

    @Get('by-ad-group/:adGroupId')
    @ApiOperation({ summary: 'List ads by unified ad group ID' })
    async getByAdGroup(@Param('adGroupId') adGroupId: string) {
        return this.adsService.findByAdGroup(adGroupId);
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get ad details' })
    async getOne(@Param('id') id: string) {
        return this.adsService.findOne(id);
    }
}
