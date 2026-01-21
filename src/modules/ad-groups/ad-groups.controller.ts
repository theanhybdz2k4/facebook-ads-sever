import { Controller, Get, Param, Query, UseGuards, ParseIntPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@n-modules/auth/guards/jwt-auth.guard';
import { AdGroupsService } from './services/ad-groups.service';
import { CurrentUser } from '@n-modules/shared/decorators/current-user.decorator';

@ApiTags('Ad Groups (Unified)')
@Controller('ad-groups')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class AdGroupsController {
    constructor(private readonly adGroupsService: AdGroupsService) { }

    @Get()
    @ApiOperation({ summary: 'List all ad groups for user' })
    async getAdGroups(
        @CurrentUser('id') userId: number,
        @Query('accountId') accountId?: string,
        @Query('campaignId') campaignId?: string,
        @Query('status') status?: string,
        @Query('search') search?: string,
        @Query('branchId') branchId?: string,
        @Query('page') page?: string,
        @Query('limit') limit?: string,
    ) {
        return this.adGroupsService.findAll(userId, {
            accountId: accountId ? Number(accountId) : undefined,
            campaignId,
            status,
            search,
            branchId: branchId && branchId !== 'all' ? Number(branchId) : undefined,
            page: page ? Number(page) : 1,
            limit: limit ? Number(limit) : 20,
        });
    }

@Get('by-campaign/:campaignId')
@ApiOperation({ summary: 'List ad groups by unified campaign ID' })
async getByCampaign(
    @CurrentUser('id') userId: number,
    @Param('campaignId') campaignId: string
) {
    return this.adGroupsService.findAll(userId, { campaignId });
}

@Get(':id')
@ApiOperation({ summary: 'Get ad group details' })
async getOne(@Param('id') id: string) {
    // Logic for single entity detail
    return { id, name: 'Ad Group Detail Mock' };
}
}
