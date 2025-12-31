import {
    Controller,
    Get,
    Post,
    Delete,
    Body,
    Param,
    Query,
    ParseIntPipe,
    UseGuards,
    Request,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { FbAccountService } from './services/fb-account.service';
import { TokenService } from './services/token.service';
import { CrawlJobService } from './services/crawl-job.service';
import { RateLimiterService } from './services/rate-limiter.service';
import { CrawlSchedulerService } from './jobs/crawl-scheduler.service';
import { TelegramService } from './services/telegram.service';
import { SyncEntitiesDto, SyncInsightsDto } from './dtos';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { IsString, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// DTOs for FB Account management
export class AddFbAccountDto {
    @ApiProperty({ description: 'Facebook access token' })
    @IsString()
    accessToken: string;

    @ApiPropertyOptional({ description: 'Name for this FB account' })
    @IsOptional()
    @IsString()
    name?: string;
}

export class AddTokenDto {
    @ApiProperty({ description: 'Facebook access token' })
    @IsString()
    accessToken: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    name?: string;

    @ApiPropertyOptional()
    @IsOptional()
    isDefault?: boolean;
}

@ApiTags('Facebook Ads')
@Controller('fb-ads')
export class FacebookAdsController {
    constructor(
        private readonly fbAccountService: FbAccountService,
        private readonly tokenService: TokenService,
        private readonly crawlJobService: CrawlJobService,
        private readonly rateLimiterService: RateLimiterService,
        private readonly schedulerService: CrawlSchedulerService,
        private readonly telegramService: TelegramService,
        private readonly prisma: PrismaService,
    ) { }

    // ==================== FB ACCOUNTS ====================

    @Post('fb-accounts')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Add new FB account (enter token)' })
    async addFbAccount(@Request() req: any, @Body() dto: AddFbAccountDto) {
        return this.fbAccountService.addFbAccount(req.user.id, dto.accessToken, dto.name);
    }

    @Get('fb-accounts')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'List user FB accounts' })
    async getFbAccounts(@Request() req: any) {
        return this.fbAccountService.getFbAccountsByUser(req.user.id);
    }

    @Get('fb-accounts/:id')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Get FB account details' })
    async getFbAccount(@Param('id', ParseIntPipe) id: number) {
        return this.fbAccountService.getFbAccountWithDetails(id);
    }

    @Delete('fb-accounts/:id')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Delete FB account' })
    async deleteFbAccount(@Request() req: any, @Param('id', ParseIntPipe) id: number) {
        return this.fbAccountService.deleteFbAccount(req.user.id, id);
    }

    @Post('fb-accounts/:id/sync')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Sync ad accounts from FB' })
    async syncAdAccounts(@Param('id', ParseIntPipe) id: number) {
        return this.fbAccountService.syncAdAccounts(id);
    }

    @Post('fb-accounts/:id/tokens')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Add token to FB account' })
    async addToken(@Param('id', ParseIntPipe) id: number, @Body() dto: AddTokenDto) {
        return this.fbAccountService.addToken(id, dto.accessToken, dto.name, dto.isDefault);
    }

    // ==================== ENTITY SYNC ====================

    @Post('sync/entities')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Sync entities (campaigns, adsets, ads, creatives)' })
    async syncEntities(@Body() dto: SyncEntitiesDto) {
        // If adsetId is provided, sync ads for that specific adset
        if (dto.adsetId) {
            await this.schedulerService.triggerAdsSyncByAdset(dto.adsetId);
            return { message: 'Ads sync job queued for adset', adsetId: dto.adsetId };
        }

        // If campaignId is provided, sync adsets for that specific campaign
        if (dto.campaignId) {
            await this.schedulerService.triggerAdsetsSyncByCampaign(dto.campaignId);
            return { message: 'Adsets sync job queued for campaign', campaignId: dto.campaignId };
        }

        // Otherwise sync by accountId as before
        if (!dto.accountId) {
            throw new Error('Either accountId, campaignId, or adsetId is required');
        }
        await this.schedulerService.triggerEntitySync(dto.accountId, dto.entityType || 'all');
        return { message: 'Entity sync job queued', accountId: dto.accountId };
    }

    // ==================== INSIGHTS SYNC ====================

    @Post('sync/insights')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Sync insights for date range' })
    async syncInsights(@Body() dto: SyncInsightsDto) {
        // If adId is provided, sync insights for that specific ad
        if (dto.adId) {
            await this.schedulerService.triggerInsightsSyncByAd(
                dto.adId,
                dto.dateStart,
                dto.dateEnd,
                dto.breakdown || 'all',
            );
            return {
                message: 'Insights sync job queued for ad',
                adId: dto.adId,
                dateRange: `${dto.dateStart} to ${dto.dateEnd}`,
            };
        }

        // Otherwise sync by accountId
        if (!dto.accountId) {
            throw new Error('Either accountId or adId is required');
        }
        await this.schedulerService.triggerInsightsSync(
            dto.accountId,
            dto.dateStart,
            dto.dateEnd,
            dto.breakdown || 'all',
        );
        return {
            message: 'Insights sync job queued',
            accountId: dto.accountId,
            dateRange: `${dto.dateStart} to ${dto.dateEnd}`,
        };
    }

    // ==================== JOBS ====================

    @Get('jobs')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'List recent crawl jobs' })
    async getJobs(@Query('limit') limit?: string) {
        return this.crawlJobService.getRecentJobs(limit ? parseInt(limit) : 50);
    }

    @Get('jobs/:id')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Get crawl job details' })
    async getJob(@Param('id', ParseIntPipe) id: number) {
        return this.crawlJobService.getJob(id);
    }

    // ==================== RATE LIMIT ====================

    @Get('rate-limit')
    @ApiOperation({ summary: 'Get current rate limit status' })
    async getRateLimitStatus() {
        return this.rateLimiterService.getAllStates();
    }

    // ==================== DATA QUERIES ====================

    @Get('accounts')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'List active ad accounts' })
    async getAdAccounts(@Request() req: any) {
        return this.prisma.adAccount.findMany({
            where: {
                fbAccount: { userId: req.user.id },
                accountStatus: 1, // Only ACTIVE accounts
            },
            orderBy: { syncedAt: 'desc' },
        });
    }

    @Get('campaigns')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'List campaigns' })
    async getCampaigns(
        @Request() req: any,
        @Query('accountId') accountId?: string,
        @Query('effectiveStatus') effectiveStatus?: string,
        @Query('search') search?: string,
    ) {
        return this.prisma.campaign.findMany({
            where: {
                ...(accountId && { accountId }),
                ...(effectiveStatus && { effectiveStatus }),
                ...(search && {
                    OR: [
                        { name: { contains: search, mode: 'insensitive' } },
                        { id: { contains: search } },
                    ],
                }),
                account: { fbAccount: { userId: req.user.id } },
            },
            orderBy: { syncedAt: 'desc' },
            take: 100,
        });
    }

    @Get('adsets')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'List adsets' })
    async getAdsets(
        @Request() req: any,
        @Query('accountId') accountId?: string,
        @Query('campaignId') campaignId?: string,
        @Query('effectiveStatus') effectiveStatus?: string,
        @Query('search') search?: string,
    ) {
        return this.prisma.adset.findMany({
            where: {
                ...(accountId && { accountId }),
                ...(campaignId && { campaignId }),
                ...(effectiveStatus && { effectiveStatus }),
                ...(search && {
                    OR: [
                        { name: { contains: search, mode: 'insensitive' } },
                        { id: { contains: search } },
                    ],
                }),
                account: { fbAccount: { userId: req.user.id } },
            },
            orderBy: { syncedAt: 'desc' },
            take: 100,
        });
    }

    @Get('ads')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'List ads' })
    async getAds(
        @Request() req: any,
        @Query('accountId') accountId?: string,
        @Query('adsetId') adsetId?: string,
        @Query('effectiveStatus') effectiveStatus?: string,
        @Query('search') search?: string,
    ) {
        return this.prisma.ad.findMany({
            where: {
                ...(accountId && { accountId }),
                ...(adsetId && { adsetId }),
                ...(effectiveStatus && { effectiveStatus }),
                ...(search && {
                    OR: [
                        { name: { contains: search, mode: 'insensitive' } },
                        { id: { contains: search } },
                    ],
                }),
                account: { fbAccount: { userId: req.user.id } },
            },
            orderBy: { syncedAt: 'desc' },
            take: 100,
        });
    }

    @Get('insights')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Query daily insights' })
    async getInsights(
        @Request() req: any,
        @Query('accountId') accountId?: string,
        @Query('dateStart') dateStart?: string,
        @Query('dateEnd') dateEnd?: string,
    ) {
        return this.prisma.adInsightsDaily.findMany({
            where: {
                ...(accountId && { accountId }),
                ...(dateStart && dateEnd && {
                    date: { gte: new Date(dateStart), lte: new Date(dateEnd) },
                }),
                account: { fbAccount: { userId: req.user.id } },
            },
            orderBy: { date: 'desc' },
            take: 100,
        });
    }

    // ==================== TELEGRAM ====================

    @Post('telegram/refresh')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Refresh Telegram chat IDs from getUpdates' })
    async refreshTelegramChatIds() {
        await this.telegramService.refreshChatIds();
        return { success: true, chatIds: this.telegramService.getChatIds() };
    }

    @Post('telegram/add-chat')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Manually add a Telegram chat ID' })
    async addTelegramChatId(@Body('chatId') chatId: string) {
        this.telegramService.addChatId(chatId);
        return { success: true, chatId };
    }

    @Get('telegram/chat-ids')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Get all registered Telegram chat IDs' })
    getTelegramChatIds() {
        return { chatIds: this.telegramService.getChatIds() };
    }

    @Post('telegram/test')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Send test message to all Telegram subscribers' })
    async sendTestTelegram() {
        await this.telegramService.sendInsightsSyncReport({
            accountName: 'Test Account',
            date: new Date().toISOString().split('T')[0],
            adsCount: 10,
            totalSpend: 500000,
            totalImpressions: 50000,
            totalClicks: 1500,
            totalReach: 40000,
            currency: 'VND',
        });
        return { success: true, subscriberCount: this.telegramService.getChatIds().length };
    }

    // ==================== PUBLIC CRON ENDPOINTS (for n8n) ====================
    // No authentication required - designed for external cron services

    @Get('health')
    @ApiOperation({ summary: 'Health check endpoint' })
    async healthCheck() {
        return { 
            status: 'ok', 
            timestamp: new Date().toISOString(),
            timezone: process.env.TZ || 'Asia/Ho_Chi_Minh',
        };
    }

    @Post('cron/sync-campaigns')
    @ApiOperation({ summary: '[n8n] Sync campaigns from all ACTIVE ad accounts' })
    async cronSyncCampaigns() {
        const accounts = await this.prisma.adAccount.findMany({
            where: { accountStatus: 1 }, // ACTIVE accounts only
            select: { id: true, name: true },
        });

        for (const account of accounts) {
            await this.schedulerService.triggerEntitySync(account.id, 'campaigns');
        }

        return {
            success: true,
            message: `Campaigns sync jobs queued for ${accounts.length} active accounts`,
            accounts: accounts.map(a => ({ id: a.id, name: a.name })),
        };
    }

    @Post('cron/sync-adsets')
    @ApiOperation({ summary: '[n8n] Sync adsets from all ACTIVE campaigns' })
    async cronSyncAdsets() {
        const campaigns = await this.prisma.campaign.findMany({
            where: { effectiveStatus: 'ACTIVE' },
            select: { id: true, name: true, accountId: true },
        });

        for (const campaign of campaigns) {
            await this.schedulerService.triggerAdsetsSyncByCampaign(campaign.id);
        }

        return {
            success: true,
            message: `Adsets sync jobs queued for ${campaigns.length} active campaigns`,
            campaigns: campaigns.map(c => ({ id: c.id, name: c.name })),
        };
    }

    @Post('cron/sync-ads')
    @ApiOperation({ summary: '[n8n] Sync ads from all ACTIVE adsets' })
    async cronSyncAds() {
        const adsets = await this.prisma.adset.findMany({
            where: { effectiveStatus: 'ACTIVE' },
            select: { id: true, name: true, campaignId: true },
        });

        for (const adset of adsets) {
            await this.schedulerService.triggerAdsSyncByAdset(adset.id);
        }

        return {
            success: true,
            message: `Ads sync jobs queued for ${adsets.length} active adsets`,
            adsets: adsets.map(a => ({ id: a.id, name: a.name })),
        };
    }

    @Post('cron/sync-insights')
    @ApiOperation({ summary: '[n8n] Sync insights from all ACTIVE ads (today)' })
    async cronSyncInsights(
        @Query('dateStart') dateStartParam?: string,
        @Query('dateEnd') dateEndParam?: string,
        @Query('breakdown') breakdown?: string,
    ) {
        const today = new Date().toISOString().split('T')[0];
        const dateStart = dateStartParam || today;
        const dateEnd = dateEndParam || today;

        const ads = await this.prisma.ad.findMany({
            where: { effectiveStatus: 'ACTIVE' },
            select: { id: true, name: true, accountId: true },
        });

        for (const ad of ads) {
            await this.schedulerService.triggerInsightsSyncByAd(
                ad.id,
                dateStart,
                dateEnd,
                breakdown || 'all',
            );
        }

        return {
            success: true,
            message: `Insights sync jobs queued for ${ads.length} active ads`,
            dateRange: `${dateStart} to ${dateEnd}`,
            breakdown: breakdown || 'all',
            adsCount: ads.length,
        };
    }
}

