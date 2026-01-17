import {
    Controller,
    Post,
    Body,
    UseGuards,
    HttpCode,
    HttpStatus,
    Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiHeader } from '@nestjs/swagger';
import { InternalApiKeyGuard } from '../auth/guards/internal-api-key.guard';
import { CrawlSchedulerService } from '../cron/services/cron-scheduler.service';
import { InsightsSyncService } from '../insights/services/insights-sync.service';
import { BranchStatsService } from '../branches/services/branch-stats.service';
import { CrawlJobService } from '../jobs/services/crawl-job.service';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { getVietnamDateString, getVietnamHour } from '@n-utils';
import { IsString, IsOptional, IsNumber, IsArray } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const SUPPORTED_SYNC_TYPES = [
    'insight', // Hourly + Daily (if needed)
    'insight_daily',
    'insight_device',
    'insight_placement',
    'insight_age_gender',
    'insight_region',
    'insight_hourly',
    'ads',
    'adset',
    'campaign',
    'creative',
    'ad_account',
    'full',
];

// DTOs for n8n sync requests
export class N8nSyncDto {
    @ApiProperty({
        description: 'Type of sync to perform',
        enum: SUPPORTED_SYNC_TYPES,
    })
    @IsString()
    type: string;

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
    private readonly logger = new Logger(InternalN8nController.name);

    constructor(
        private readonly schedulerService: CrawlSchedulerService,
        private readonly insightsSyncService: InsightsSyncService,
        private readonly branchStatsService: BranchStatsService,
        private readonly crawlJobService: CrawlJobService,
        private readonly prisma: PrismaService,
    ) { }

    /**
     * Dispatcher endpoint: OPTIMIZED V2 - Syncs ALL enabled types with smart deduplication.
     * - 'insight' = hourly + daily, so skip separate insight_hourly/insight_daily
     * - Groups types into parallel batches for speed
     * - Still ensures full data sync based on user cron settings
     */
    @Post('dispatch')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Dispatch all configured sync types for the current hour (optimized)' })
    async dispatch(@Body() dto: { hour?: number; date?: string }) {
        const startTime = Date.now();
        const currentHour = dto.hour ?? getVietnamHour();
        const currentDate = dto.date ?? getVietnamDateString();

        const results: any[] = [];
        const processedTypes = new Set<string>();

        // Define sync type groups for parallel processing
        // Types in the same group run in PARALLEL, groups run SEQUENTIALLY
        const typeGroups = [
            // Group 1: Critical insights (most important, run first)
            ['insight'],
            // Group 2: Breakdown insights (can run in parallel)
            ['insight_device', 'insight_placement', 'insight_age_gender', 'insight_region'],
            // Group 3: Entity syncs (can run in parallel)
            ['campaign', 'adset', 'ads', 'creative'],
        ];

        for (const group of typeGroups) {
            // Filter types that haven't been processed yet
            const typesToProcess = group.filter(type => {
                // Skip if already processed
                if (processedTypes.has(type)) return false;

                // DEDUPLICATION LOGIC:
                // If 'insight' was processed, skip insight_hourly and insight_daily
                // because 'insight' already does both hourly + daily
                if (processedTypes.has('insight')) {
                    if (type === 'insight_hourly' || type === 'insight_daily') {
                        return false;
                    }
                }

                return true;
            });

            if (typesToProcess.length === 0) continue;

            // Process types in this group IN PARALLEL
            const groupResults = await Promise.all(
                typesToProcess.map(async (type) => {
                    try {
                        const result = await this.processSyncType(type, currentHour, currentDate);
                        processedTypes.add(type);
                        
                        // Mark related types as processed to avoid duplication
                        if (type === 'insight') {
                            processedTypes.add('insight_hourly');
                            processedTypes.add('insight_daily');
                        }
                        
                        return result;
                    } catch (error) {
                        return {
                            type,
                            success: false,
                            error: (error as Error).message,
                        };
                    }
                })
            );

            // Only add results with synced users > 0 or errors
            for (const result of groupResults) {
                if ((result as any).syncedUsers > 0 || (result as any).error) {
                    results.push(result);
                }
            }
        }

        const totalDuration = Date.now() - startTime;

        // 5. Cleanup old crawl jobs (those older than 24h)
        try {
            await this.crawlJobService.cleanupOldJobs();
        } catch (cleanupError) {
            this.logger.error(`Failed to cleanup old jobs: ${cleanupError.message}`);
        }

        return {
            success: true,
            hour: currentHour,
            date: currentDate,
            dispatchedTypes: results.length,
            totalDuration,
            details: results,
        };
    }

    /**
     * Main sync endpoint for specific type
     */
    @Post('sync')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Trigger sync based on type and user cron settings' })
    async handleSync(@Body() dto: N8nSyncDto) {
        return this.processSyncType(
            dto.type,
            dto.hour ?? getVietnamHour(),
            dto.date ?? getVietnamDateString(),
            dto.accountIds
        );
    }

    /**
     * Core logic to process a sync request for a specific type
     */
    private async processSyncType(type: string, hour: number, date: string, accountIds?: string[]) {
        // Get users who have enabled this cron type at this hour
        const usersToSync = await this.getUsersToSync(type, hour);

        if (usersToSync.length === 0) {
            return {
                success: true,
                type,
                message: `No users configured for ${type} sync at hour ${hour}`,
                syncedUsers: 0,
            };
        }

        // Special handling for insights: use optimized hourly sync + Telegram
        if (type === 'insight' || type === 'insight_hourly') {
            // OPTIMIZED V2: Larger batch, shorter delay
            const BATCH_SIZE = 5; // Process 5 accounts in parallel (was 3)
            const DELAY_BETWEEN_BATCHES_MS = 200; // 200ms between batches (was 500ms)

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
                    type,
                    message: `Users configured but no active ad accounts found`,
                    syncedUsers: usersToSync.length,
                    hour,
                };
            }

            const results: any[] = [];

            // Process accounts in parallel batches
            for (let i = 0; i < allAccounts.length; i += BATCH_SIZE) {
                const batch = allAccounts.slice(i, i + BATCH_SIZE);

                const batchResults = await Promise.all(
                    batch.map(async (account) => {
                        try {
                            // 1. Quick hourly sync (uses account-level API)
                            const hourlyResult = await this.insightsSyncService.syncHourlyInsightsQuick(account.id);

                            // 2. For 'insight' type: also sync daily insights
                            // This ensures complete data for both hourly monitoring and daily reports
                            if (type === 'insight') {
                                try {
                                    await this.insightsSyncService.syncDailyInsights(account.id, undefined, date, date);
                                } catch (dailyError) {
                                    // If daily sync fails, still aggregate if we have hourly data
                                    const branchRes = await this.prisma.adAccount.findUnique({
                                        where: { id: account.id },
                                        select: { branchId: true }
                                    });
                                    if (branchRes?.branchId) {
                                        await this.branchStatsService.aggregateBranchStats(branchRes.branchId, date);
                                    }
                                    // Log error but don't fail the whole sync
                                    console.error(`[InsightSync] Daily sync failed for ${account.id}: ${(dailyError as Error).message}`);
                                }
                            }

                            return {
                                accountId: account.id,
                                name: account.name,
                                userId: account.userId,
                                ...hourlyResult
                            };
                        } catch (error) {
                            return {
                                accountId: account.id,
                                name: account.name,
                                userId: account.userId,
                                error: (error as Error).message,
                            };
                        }
                    })
                );

                results.push(...batchResults);

                // Small delay between batches (only if not last batch)
                if (i + BATCH_SIZE < allAccounts.length) {
                    await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_BATCHES_MS));
                }
            }

            const totalCount = results.reduce((sum, r: any) => sum + (r.count || 0), 0);
            const totalDuration = results.reduce((sum, r: any) => sum + (r.duration || 0), 0);

            // Send Telegram notification AFTER all syncs complete (respecting bot settings + hours)
            let telegramResult = { success: false, message: 'Not sent' };
            try {
                telegramResult = await this.insightsSyncService.sendLatestHourTelegramReport(hour);
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
                type,
                hour,
                date,
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
                const result = await this.executeSyncForUser(user, type, date);
                results.push({ userId: user.id, ...result });
            } catch (error) {
                results.push({ userId: user.id, error: (error as Error).message });
            }
        }

        return {
            success: true,
            type,
            hour,
            date,
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
        return this.processSyncType('insight_hourly', hourParam ?? getVietnamHour(), getVietnamDateString());
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
            insight_daily: 'insight_daily',
            insight_device: 'insight_device',
            insight_placement: 'insight_placement',
            insight_age_gender: 'insight_age_gender',
            insight_region: 'insight_region',
            insight_hourly: 'insight_hourly',
            creative: 'creative',
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
                case 'insight_daily':
                    // REQ: Only sync today, remove 3-day window
                    const dateStart = date;

                    await this.schedulerService.triggerInsightsSync(account.id, dateStart, date, 'daily');
                    break;
                case 'insight_device':
                    await this.schedulerService.triggerInsightsSync(account.id, date, date, 'device');
                    break;
                case 'insight_placement':
                    await this.schedulerService.triggerInsightsSync(account.id, date, date, 'placement');
                    break;
                case 'insight_age_gender':
                    await this.schedulerService.triggerInsightsSync(account.id, date, date, 'age_gender');
                    break;
                case 'insight_region':
                    await this.schedulerService.triggerInsightsSync(account.id, date, date, 'region');
                    break;
                case 'insight_hourly':
                    await this.schedulerService.triggerInsightsSync(account.id, date, date, 'hourly');
                    break;
                case 'creative':
                    await this.schedulerService.triggerEntitySync(account.id, 'creatives');
                    break;
                case 'ad_account':
                    // Sync ad account info only - would need to implement
                    break;
                case 'full':
                    await this.schedulerService.triggerEntitySync(account.id, 'all');
                    await this.schedulerService.triggerInsightsSync(account.id, date, date, 'daily');
                    break;
            }
            accountsSynced++;
        }

        return { accountsSynced, accounts: adAccounts.map((a) => a.name) };
    }
}
