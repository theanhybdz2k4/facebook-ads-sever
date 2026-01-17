import {
    Controller,
    Post,
    Body,
    UseGuards,
    HttpCode,
    HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiHeader } from '@nestjs/swagger';
import { InternalApiKeyGuard } from '../auth/guards/internal-api-key.guard';
import { CrawlSchedulerService } from '../cron/services/cron-scheduler.service';
import { InsightsSyncService } from './services/insights-sync.service';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { getVietnamDateString, getVietnamHour } from '@n-utils';
import { IsString, IsOptional, IsNumber, IsArray } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// DTOs for n8n sync requests
export class N8nSyncDto {
    @ApiProperty({
        description: 'Type of sync to perform',
        enum: ['ads', 'adset', 'campaign', 'insight', 'ad_account', 'full'],
    })
    @IsString()
    type: 'ads' | 'adset' | 'campaign' | 'insight' | 'ad_account' | 'full';

    @ApiPropertyOptional({ description: 'Hour when this cron was triggered (0-23)' })
    @IsOptional()
    @IsNumber()
    hour?: number;

    @ApiPropertyOptional({ description: 'Date for sync (YYYY-MM-DD format)' })
    @IsOptional()
    @IsString()
    date?: string;

    @ApiPropertyOptional({ description: 'Specific account IDs to sync (optional)' })
    @IsOptional()
    @IsArray()
    accountIds?: string[];
}

/**
 * Internal controller for n8n cron jobs
 * Protected by InternalApiKeyGuard - requires x-internal-api-key header
 */
@ApiTags('Internal n8n')
@Controller('internal/n8n')
@UseGuards(InternalApiKeyGuard)
@ApiHeader({
    name: 'x-internal-api-key',
    description: 'Internal API key for n8n authentication',
    required: true,
})
export class InternalN8nController {
    constructor(
        private readonly schedulerService: CrawlSchedulerService,
        private readonly insightsSyncService: InsightsSyncService,
        private readonly prisma: PrismaService,
    ) { }

    /**
     * Main sync endpoint for n8n
     * n8n sends request every hour, backend decides which users to sync
     */
    @Post('sync')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Trigger sync based on type and user cron settings' })
    async handleSync(@Body() dto: N8nSyncDto) {
        const currentHour = dto.hour ?? getVietnamHour();
        const currentDate = dto.date ?? getVietnamDateString();

        // Get users who have enabled this cron type at this hour
        const usersToSync = await this.getUsersToSync(dto.type, currentHour);

        if (usersToSync.length === 0) {
            return {
                success: true,
                message: `No users configured for ${dto.type} sync at hour ${currentHour}`,
                syncedUsers: 0,
            };
        }

        // Special handling for insights: use optimized hourly sync + Telegram,
        // so n8n chỉ cần gọi /sync với type='insight' là đủ (không cần endpoint riêng)
        if (dto.type === 'insight') {
            const DELAY_BETWEEN_ACCOUNTS_MS = 2000; // 2 seconds delay to avoid quota

            // Get all ad accounts for these users
            const allAccounts: { id: string; name: string; userId: number }[] = [];
            for (const user of usersToSync) {
                const userAccounts = user.fbAccounts.flatMap((fb) =>
                    fb.adAccounts.map((acc) => ({ ...acc, userId: user.id })),
                );
                allAccounts.push(...userAccounts);
            }

            if (allAccounts.length === 0) {
                return {
                    success: true,
                    message: `Users configured but no active ad accounts found`,
                    syncedUsers: usersToSync.length,
                    hour: currentHour,
                };
            }

            const results = [];
            for (let i = 0; i < allAccounts.length; i++) {
                const account = allAccounts[i];
                try {
                    const result = await this.insightsSyncService.syncHourlyInsightsQuick(account.id);
                    results.push({ accountId: account.id, name: account.name, userId: account.userId, ...result });
                } catch (error) {
                    results.push({
                        accountId: account.id,
                        name: account.name,
                        userId: account.userId,
                        error: error.message,
                    });
                }

                // Rate limit: delay between accounts (skip delay after last account)
                if (i < allAccounts.length - 1) {
                    await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_ACCOUNTS_MS));
                }
            }

            const totalCount = results.reduce((sum, r: any) => sum + (r.count || 0), 0);
            const totalDuration = results.reduce((sum, r: any) => sum + (r.duration || 0), 0);

            // Send Telegram notification AFTER all syncs complete (respecting bot settings + hours)
            let telegramResult = { success: false, message: 'Not sent' };
            try {
                telegramResult = await this.insightsSyncService.sendLatestHourTelegramReport(currentHour);
            } catch (error) {
                telegramResult = { success: false, message: (error as Error).message };
            }

            // Auto-cleanup old hourly insights after sync
            let cleanedUp = 0;
            try {
                cleanedUp = await this.insightsSyncService.cleanupAllOldHourlyInsights();
            } catch (error) {
                // Log but don't fail the sync
            }

            return {
                success: true,
                type: dto.type,
                hour: currentHour,
                date: currentDate,
                syncedUsers: usersToSync.length,
                totalCount,
                totalDuration,
                accounts: results,
                telegram: telegramResult,
                cleanedUp,
            };
        }

        // Default path for other types (ads, adset, campaign, full, ...)
        const results = [];

        for (const user of usersToSync) {
            try {
                const result = await this.executeSyncForUser(user, dto.type, currentDate);
                results.push({ userId: user.id, ...result });
            } catch (error) {
                results.push({ userId: user.id, error: (error as Error).message });
            }
        }

        return {
            success: true,
            type: dto.type,
            hour: currentHour,
            date: currentDate,
            syncedUsers: usersToSync.length,
            results,
        };
    }

    /**
     * Quick hourly insights sync (optimized, respects user cron settings)
     * - Only syncs for users who have 'insight' cron enabled at current hour
     * - Adds delay between accounts to avoid Facebook quota limits
     * - Sends Telegram notification AFTER all syncs complete
     */
    @Post('sync-hourly-insights')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Quick sync hourly insights based on user cron settings' })
    async syncHourlyInsights(@Body('hour') hourParam?: number) {
        const currentHour = hourParam ?? getVietnamHour();
        const DELAY_BETWEEN_ACCOUNTS_MS = 2000; // 2 seconds delay to avoid quota

        // 1. Check user cron settings - only sync for users with 'insight' enabled at this hour
        const usersToSync = await this.getUsersToSync('insight', currentHour);

        if (usersToSync.length === 0) {
            return {
                success: true,
                message: `No users configured for insight sync at hour ${currentHour}`,
                syncedUsers: 0,
                hour: currentHour,
            };
        }

        // 2. Get all ad accounts for these users
        const allAccounts: { id: string; name: string; userId: number }[] = [];
        for (const user of usersToSync) {
            const userAccounts = user.fbAccounts.flatMap((fb) =>
                fb.adAccounts.map((acc) => ({ ...acc, userId: user.id }))
            );
            allAccounts.push(...userAccounts);
        }

        if (allAccounts.length === 0) {
            return {
                success: true,
                message: `Users configured but no active ad accounts found`,
                syncedUsers: usersToSync.length,
                hour: currentHour,
            };
        }

        // 3. Sync each account with delay to avoid quota limits
        const results = [];
        for (let i = 0; i < allAccounts.length; i++) {
            const account = allAccounts[i];
            try {
                const result = await this.insightsSyncService.syncHourlyInsightsQuick(account.id);
                results.push({ accountId: account.id, name: account.name, userId: account.userId, ...result });
            } catch (error) {
                results.push({ accountId: account.id, name: account.name, userId: account.userId, error: error.message });
            }

            // Rate limit: delay between accounts (skip delay after last account)
            if (i < allAccounts.length - 1) {
                await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_ACCOUNTS_MS));
            }
        }

        const totalCount = results.reduce((sum, r) => sum + (r.count || 0), 0);
        const totalDuration = results.reduce((sum, r) => sum + (r.duration || 0), 0);

        // 4. Send Telegram notification AFTER all syncs complete
        // Pass the hour parameter so Telegram service checks against correct allowedHours
        let telegramResult = { success: false, message: 'Not sent' };
        try {
            telegramResult = await this.insightsSyncService.sendLatestHourTelegramReport(currentHour);
        } catch (error) {
            telegramResult = { success: false, message: error.message };
        }

        return {
            success: true,
            message: `Synced ${totalCount} hourly insights from ${allAccounts.length} accounts in ${totalDuration}ms`,
            hour: currentHour,
            syncedUsers: usersToSync.length,
            totalCount,
            totalDuration,
            accounts: results,
            telegram: telegramResult,
        };
    }

    /**
     * Full sync for all accounts (entities + insights)
     */
    @Post('full-sync')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Full sync: entities + 7 days insights for all accounts' })
    async fullSync(@Body('days') daysParam?: number) {
        const days = daysParam || 7;

        // Calculate date range
        const dateEnd = getVietnamDateString();
        const [year, month, day] = dateEnd.split('-').map(Number);
        const startDate = new Date(year, month - 1, day);
        startDate.setDate(startDate.getDate() - days + 1);
        const dateStart = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')}`;

        const accounts = await this.prisma.adAccount.findMany({
            where: { accountStatus: 1 },
            select: { id: true, name: true },
        });

        if (accounts.length === 0) {
            return {
                success: false,
                message: 'No active ad accounts found',
            };
        }

        for (const account of accounts) {
            await this.schedulerService.triggerEntitySync(account.id, 'all');
            await this.schedulerService.triggerInsightsSync(account.id, dateStart, dateEnd, 'all');
        }

        return {
            success: true,
            message: `Full sync initiated for ${accounts.length} accounts`,
            summary: {
                accounts: accounts.length,
                dateRange: `${dateStart} to ${dateEnd}`,
                days,
            },
        };
    }

    /**
     * Cleanup old hourly insights from all accounts
     * Should be called daily to ensure no orphan data remains
     */
    @Post('cleanup-hourly')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Cleanup old hourly insights older than yesterday' })
    async cleanupHourlyInsights() {
        const deletedCount = await this.insightsSyncService.cleanupAllOldHourlyInsights();

        return {
            success: true,
            message: `Cleaned up ${deletedCount} old hourly insights`,
            deletedCount,
        };
    }

    /**
     * Get users who should be synced based on their cron settings
     */
    private async getUsersToSync(cronType: string, currentHour: number) {
        // Map the dto type to cron_type in DB
        const cronTypeMapping: Record<string, string> = {
            ads: 'ads',
            adset: 'adset',
            campaign: 'campaign',
            insight: 'insight',
            ad_account: 'ad_account',
            full: 'full',
        };

        const mappedType = cronTypeMapping[cronType] || cronType;

        const settings = await this.prisma.userCronSettings.findMany({
            where: {
                cronType: mappedType,
                enabled: true,
                allowedHours: { has: currentHour },
            },
            include: {
                user: {
                    select: {
                        id: true,
                        email: true,
                        fbAccounts: {
                            select: {
                                adAccounts: {
                                    where: { accountStatus: 1 },
                                    select: { id: true, name: true },
                                },
                            },
                        },
                    },
                },
            },
        });

        return settings.map((s) => s.user);
    }

    /**
     * Execute sync for a specific user
     */
    private async executeSyncForUser(
        user: { id: number; fbAccounts: { adAccounts: { id: string; name: string }[] }[] },
        type: string,
        date: string,
    ) {
        // Get all ad accounts for this user
        const adAccounts = user.fbAccounts.flatMap((fb) => fb.adAccounts);

        if (adAccounts.length === 0) {
            return { message: 'No active ad accounts', accountsSynced: 0 };
        }

        let accountsSynced = 0;

        for (const account of adAccounts) {
            switch (type) {
                case 'campaign':
                    await this.schedulerService.triggerEntitySync(account.id, 'campaigns');
                    break;
                case 'adset':
                    await this.schedulerService.triggerEntitySync(account.id, 'adsets');
                    break;
                case 'ads':
                    await this.schedulerService.triggerEntitySync(account.id, 'ads');
                    break;
                case 'insight':
                    await this.schedulerService.triggerInsightsSync(account.id, date, date, 'all');
                    break;
                case 'ad_account':
                    // Sync ad account info only - would need to implement
                    break;
                case 'full':
                    await this.schedulerService.triggerEntitySync(account.id, 'all');
                    await this.schedulerService.triggerInsightsSync(account.id, date, date, 'all');
                    break;
            }
            accountsSynced++;
        }

        return { accountsSynced, accounts: adAccounts.map((a) => a.name) };
    }
}
