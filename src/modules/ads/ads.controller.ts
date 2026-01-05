import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdsService } from './services/ads.service';
import { CurrentUser } from '../shared/decorators/current-user.decorator';

@ApiTags('Ads')
@Controller('ads')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AdsController {
    constructor(private readonly adsService: AdsService) { }

    @Get()
    @ApiOperation({ summary: 'List ads' })
    async getAds(
        @CurrentUser() user: any,
        @Query('accountId') accountId?: string,
        @Query('adsetId') adsetId?: string,
        @Query('effectiveStatus') effectiveStatus?: string,
        @Query('search') search?: string,
    ) {
        return this.adsService.getAds(user.id, {
            accountId,
            adsetId,
            effectiveStatus,
            search,
        });
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get single ad details' })
    async getAd(
        @Param('id') id: string,
        @CurrentUser() user: any,
    ) {
        return this.adsService.getAd(id, user.id);
    }
}

