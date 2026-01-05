import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CampaignsService } from './services/campaigns.service';
import { CurrentUser } from '../shared/decorators/current-user.decorator';

@ApiTags('Campaigns')
@Controller('campaigns')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class CampaignsController {
    constructor(private readonly campaignsService: CampaignsService) { }

    @Get()
    @ApiOperation({ summary: 'List campaigns' })
    async getCampaigns(
        @CurrentUser() user: any,
        @Query('accountId') accountId?: string,
        @Query('effectiveStatus') effectiveStatus?: string,
        @Query('search') search?: string,
    ) {
        return this.campaignsService.getCampaigns(user.id, {
            accountId,
            effectiveStatus,
            search,
        });
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get campaign details' })
    async getCampaign(
        @Param('id') id: string,
        @CurrentUser() user: any,
    ) {
        return this.campaignsService.getCampaign(id, user.id);
    }
}

