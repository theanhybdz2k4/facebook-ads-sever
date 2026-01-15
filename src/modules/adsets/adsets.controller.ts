import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdSetsService } from './services/adsets.service';
import { CurrentUser } from '../shared/decorators/current-user.decorator';

@ApiTags('AdSets')
@Controller('adsets')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AdSetsController {
    constructor(private readonly adsetsService: AdSetsService) { }

    @Get()
    @ApiOperation({ summary: 'List adsets' })
    async getAdsets(
        @CurrentUser() user: any,
        @Query('accountId') accountId?: string,
        @Query('campaignId') campaignId?: string,
        @Query('effectiveStatus') effectiveStatus?: string,
        @Query('search') search?: string,
        @Query('branchId') branchId?: string,
    ) {
        return this.adsetsService.getAdsets(user.id, {
            accountId,
            campaignId,
            effectiveStatus,
            search,
            branchId,
        });
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get adset details' })
    async getAdset(
        @Param('id') id: string,
        @CurrentUser() user: any,
    ) {
        return this.adsetsService.getAdset(id, user.id);
    }
}

