import {
    Controller,
    Get,
    Post,
    Body,
    Param,
    Delete,
    Query,
    UseGuards,
    HttpStatus,
    ParseIntPipe,
    Request,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '@n-modules/auth/guards/jwt-auth.guard';
import { FbAccountService } from './accounts/fb-account.service';
import { EntitySyncService } from './sync/entity-sync.service';
import { InsightsSyncService } from './sync/insights-sync.service';
import { CrawlSchedulerService } from './jobs/crawl-scheduler.service';
import { PrismaService } from '@n-database/prisma/prisma.service';

@ApiTags('Facebook Ads')
@Controller('facebook-ads')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class FacebookAdsController {
    constructor(
        private readonly fbAccountService: FbAccountService,
        private readonly entitySyncService: EntitySyncService,
        private readonly insightsSyncService: InsightsSyncService,
        private readonly schedulerService: CrawlSchedulerService,
        private readonly prisma: PrismaService,
    ) { }

    // ==================== FB ACCOUNTS (Identities) ====================

    @Post('accounts')
    @ApiOperation({ summary: 'Add a new Facebook identity (Personal Account)' })
    async addFbAccount(
        @Request() req: any,
        @Body() body: { accessToken: string; name?: string },
    ) {
        return this.fbAccountService.addFbAccount(req.user.id, body.accessToken, body.name);
    }

    @Get('accounts')
    @ApiOperation({ summary: 'List all Facebook identities for the user' })
    async getFbAccounts(@Request() req: any) {
        return this.fbAccountService.getFbAccountsByUser(req.user.id);
    }

    @Get('accounts/:id')
    @ApiOperation({ summary: 'Get details of a Facebook identity' })
    async getFbAccount(
        @Request() req: any,
        @Param('id', ParseIntPipe) id: number,
    ) {
        return this.fbAccountService.getFbAccountWithDetails(id);
    }

    @Delete('accounts/:id')
    @ApiOperation({ summary: 'Delete a Facebook identity' })
    async deleteFbAccount(
        @Request() req: any,
        @Param('id', ParseIntPipe) id: number,
    ) {
        return this.fbAccountService.deleteFbAccount(req.user.id, id);
    }

    @Post('accounts/:id/tokens')
    @ApiOperation({ summary: 'Add a new access token to a Facebook identity' })
    async addToken(
        @Param('id', ParseIntPipe) id: number,
        @Body() body: { accessToken: string; isDefault?: boolean },
    ) {
        return this.fbAccountService.addToken(id, body.accessToken, undefined, body.isDefault);
    }

    @Post('accounts/:id/sync-ad-accounts')
    @ApiOperation({ summary: 'Sync available Ad Accounts from Facebook' })
    async syncAdAccounts(
        @Param('id', ParseIntPipe) id: number,
    ) {
        return this.fbAccountService.syncAdAccounts(id);
    }

    // ==================== AD ACCOUNTS (PlatformAccounts) ====================

    @Get('ad-accounts')
    @ApiOperation({ summary: 'List all Ad Accounts the user has access to' })
    @ApiQuery({ name: 'platformIdentityId', required: false })
    async getAdAccounts(
        @Request() req: any,
        @Query('platformIdentityId') platformIdentityId?: string,
    ) {
        return this.prisma.platformAccount.findMany({
            where: {
                identity: {
                    userId: req.user.id,
                    id: platformIdentityId ? parseInt(platformIdentityId) : undefined,
                },
                accountStatus: '1', 
            },
            include: { identity: { select: { name: true } } },
        });
    }

    // ==================== SYNC OPERATIONS ====================

    @Post('sync/entities')
    @ApiOperation({ summary: 'Trigger manual sync of entities (Campaigns, AdSets, Ads)' })
    async syncEntities(
        @Body() body: { accountId: string; entityType: string },
    ) {
        return this.schedulerService.triggerEntitySync(parseInt(body.accountId), body.entityType);
    }

    @Post('sync/insights')
    @ApiOperation({ summary: 'Trigger manual sync of insights' })
    async syncInsights(
        @Body() body: {
            accountId: string;
            dateStart: string;
            dateEnd: string;
            breakdown?: string;
        },
    ) {
        return this.schedulerService.triggerInsightsSync(
            parseInt(body.accountId),
            body.dateStart,
            body.dateEnd,
            body.breakdown,
        );
    }

    // ==================== DATA QUERIES (Unified Models) ====================

    @Get('campaigns')
    @ApiOperation({ summary: 'List campaigns by ad account' })
    async getCampaigns(@Query('accountId', ParseIntPipe) accountId: number) {
        return this.prisma.unifiedCampaign.findMany({
            where: { platformAccountId: accountId },
            orderBy: { createdAt: 'desc' },
        });
    }

    @Get('ad-groups')
    @ApiOperation({ summary: 'List adgroups (adsets) by campaign' })
    async getAdGroups(@Query('campaignId') campaignId: string) {
        return this.prisma.unifiedAdGroup.findMany({
            where: { unifiedCampaignId: campaignId },
            orderBy: { createdAt: 'desc' },
        });
    }

    @Get('ads')
    @ApiOperation({ summary: 'List ads by adgroup' })
    async getAds(@Query('adGroupId') adGroupId: string) {
        return this.prisma.unifiedAd.findMany({
            where: { unifiedAdGroupId: adGroupId },
            orderBy: { createdAt: 'desc' },
        });
    }

    @Get('insights/daily')
    @ApiOperation({ summary: 'Get daily insights for an account or ad' })
    async getDailyInsights(
        @Query('accountId', ParseIntPipe) accountId: number,
        @Query('adId') adId?: string,
        @Query('dateStart') dateStart?: string,
        @Query('dateEnd') dateEnd?: string,
    ) {
        return this.prisma.unifiedInsight.findMany({
            where: {
                platformAccountId: accountId,
                unifiedAdId: adId,
                date: {
                    gte: dateStart ? new Date(dateStart) : undefined,
                    lte: dateEnd ? new Date(dateEnd) : undefined,
                },
            },
            include: { ad: { select: { name: true } } },
            orderBy: { date: 'desc' },
        });
    }
}
