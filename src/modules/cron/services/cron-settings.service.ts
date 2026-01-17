import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';

// Types for cron settings
export type CronType =
    | 'insight'
    | 'insight_daily'
    | 'insight_device'
    | 'insight_placement'
    | 'insight_age_gender'
    | 'insight_region'
    | 'insight_hourly'
    | 'ads'
    | 'adset'
    | 'campaign'
    | 'creative'
    | 'ad_account'
    | 'full';

export interface CreateCronSettingDto {
    cronType: CronType;
    allowedHours: number[]; // 0-23
    enabled?: boolean;
}

export interface UpdateCronSettingDto {
    allowedHours?: number[];
    enabled?: boolean;
}

// Estimated API calls per cron type
const ESTIMATED_CALLS_PER_TYPE: Record<CronType, number> = {
    insight: 5,             // Account insights + ad insights
    insight_daily: 2,       // Daily breakdown
    insight_device: 2,      // Device breakdown
    insight_placement: 2,   // Placement breakdown
    insight_age_gender: 2,  // Age/Gender breakdown
    insight_region: 2,      // Region breakdown
    insight_hourly: 5,      // Hourly Breakdown
    ads: 3,                 // Ads list
    adset: 2,               // Adsets list
    campaign: 1,            // Campaigns list
    creative: 10,           // Creatives (heavy)
    ad_account: 1,          // Account info
    full: 20,               // All combined
};

@Injectable()
export class CronSettingsService {
    constructor(private readonly prisma: PrismaService) { }

    /**
     * Get all cron settings for a user
     */
    async getSettings(userId: number) {
        return this.prisma.userCronSettings.findMany({
            where: { userId },
            orderBy: { cronType: 'asc' },
        });
    }

    /**
     * Get count of ad accounts for a user
     */
    async getAdAccountCount(userId: number): Promise<number> {
        return this.prisma.adAccount.count({
            where: { fbAccount: { userId }, accountStatus: 1 },
        });
    }

    /**
     * Get a specific cron setting
     */
    async getSetting(userId: number, cronType: string) {
        return this.prisma.userCronSettings.findFirst({
            where: { userId, cronType },
        });
    }

    /**
     * Create a new cron setting (CREATE only)
     * Throws BadRequestException if setting already exists
     */
    async createSetting(userId: number, dto: CreateCronSettingDto) {
        // Validate hours (must be 0-23)
        if (dto.allowedHours.some((h) => h < 0 || h > 23)) {
            throw new BadRequestException('Hours must be between 0 and 23');
        }

        // Check if setting already exists
        const existing = await this.prisma.userCronSettings.findFirst({
            where: { userId, cronType: dto.cronType },
        });

        if (existing) {
            throw new BadRequestException(`Cron setting for type '${dto.cronType}' already exists. Use PUT to update.`);
        }

        return this.prisma.userCronSettings.create({
            data: {
                userId,
                cronType: dto.cronType,
                allowedHours: dto.allowedHours,
                enabled: dto.enabled ?? true,
            },
        });
    }

    /**
     * Create or update a cron setting (upsert) - for internal use
     */
    async upsertSetting(userId: number, dto: CreateCronSettingDto) {
        // Validate hours (must be 0-23)
        if (dto.allowedHours.some((h) => h < 0 || h > 23)) {
            throw new BadRequestException('Hours must be between 0 and 23');
        }

        // Try to create first, if fails due to unique constraint, update instead
        try {
            return await this.prisma.userCronSettings.create({
                data: {
                    userId,
                    cronType: dto.cronType,
                    allowedHours: dto.allowedHours,
                    enabled: dto.enabled ?? true,
                },
            });
        } catch (error: any) {
            // If unique constraint violation, update instead
            if (error.code === 'P2002') {
                // Find existing record and update
                const existing = await this.prisma.userCronSettings.findFirst({
                    where: { userId, cronType: dto.cronType },
                });

                if (existing) {
                    return this.prisma.userCronSettings.update({
                        where: { id: existing.id },
                        data: {
                            allowedHours: dto.allowedHours,
                            enabled: dto.enabled ?? true,
                        },
                    });
                }
            }
            // Re-throw other errors
            throw error;
        }
    }

    /**
     * Update an existing cron setting (UPDATE only)
     * Throws NotFoundException if setting does not exist
     */
    async updateSetting(userId: number, cronType: string, dto: UpdateCronSettingDto) {
        // Validate hours if provided
        if (dto.allowedHours && dto.allowedHours.some((h) => h < 0 || h > 23)) {
            throw new BadRequestException('Hours must be between 0 and 23');
        }

        // Check if setting exists
        const existing = await this.prisma.userCronSettings.findFirst({
            where: { userId, cronType },
        });

        if (!existing) {
            throw new NotFoundException(`Cron setting for type '${cronType}' not found. Use POST to create.`);
        }

        // Update only provided fields
        return this.prisma.userCronSettings.update({
            where: { id: existing.id },
            data: {
                ...(dto.allowedHours && { allowedHours: dto.allowedHours }),
                ...(dto.enabled !== undefined && { enabled: dto.enabled }),
            },
        });
    }

    /**
     * Delete a cron setting
     */
    async deleteSetting(userId: number, cronType: string) {
        const existing = await this.prisma.userCronSettings.findFirst({
            where: { userId, cronType },
        });

        if (!existing) {
            throw new NotFoundException(`Cron setting for type '${cronType}' not found`);
        }

        return this.prisma.userCronSettings.delete({
            where: { id: existing.id },
        });
    }

    /**
     * Check if user should sync at current hour
     */
    async shouldSync(userId: number, cronType: string, currentHour: number): Promise<boolean> {
        const setting = await this.prisma.userCronSettings.findFirst({
            where: { userId, cronType },
        });

        if (!setting || !setting.enabled) {
            return false;
        }

        return setting.allowedHours.includes(currentHour);
    }

    /**
     * Get effective cron types to run for a given hour (handles duplicates)
     * If 'full' is enabled for the hour, skip individual cron types to avoid duplicate crawls
     */
    async getEffectiveSettingsForHour(userId: number, hour: number): Promise<string[]> {
        const settings = await this.prisma.userCronSettings.findMany({
            where: { userId },
        });

        const enabledAtHour = settings.filter(s => s.enabled && s.allowedHours.includes(hour));

        // If 'full' is enabled for this hour, only return 'full' to avoid duplicate crawls
        const fullEnabled = enabledAtHour.some(s => s.cronType === 'full');
        if (fullEnabled) {
            return ['full'];
        }

        return enabledAtHour.map(s => s.cronType);
    }

    /**
     * Get all users who should sync at the given hour for a cron type
     */
    async getUsersToSync(cronType: string, currentHour: number) {
        const settings = await this.prisma.userCronSettings.findMany({
            where: {
                cronType,
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
     * Get estimated API calls for user's current configuration
     * Returns a warning if the configuration might cause quota issues
     */
    async getEstimatedApiCalls(userId: number): Promise<{
        totalCalls: number;
        perHour: Record<number, number>;
        warning?: string;
        adAccountCount: number;
    }> {
        const settings = await this.prisma.userCronSettings.findMany({
            where: { userId, enabled: true },
        });

        // Count ad accounts for this user
        const adAccountCount = await this.prisma.adAccount.count({
            where: { fbAccount: { userId }, accountStatus: 1 },
        });

        // Calculate calls per hour
        const perHour: Record<number, number> = {};
        let totalCalls = 0;

        for (const setting of settings) {
            const callsPerSync = ESTIMATED_CALLS_PER_TYPE[setting.cronType as CronType] || 1;
            const totalCallsForType = callsPerSync * adAccountCount;

            for (const hour of setting.allowedHours) {
                perHour[hour] = (perHour[hour] || 0) + totalCallsForType;
                totalCalls += totalCallsForType;
            }
        }

        // Check for potential issues
        let warning: string | undefined;
        const maxCallsPerHour = Math.max(...Object.values(perHour), 0);

        if (maxCallsPerHour > 50) {
            warning = `~${maxCallsPerHour} API calls/hour có thể ảnh hưởng quota`;
        } else if (Object.keys(perHour).length > 12) {
            warning = `Nhiều giờ sync được cấu hình (${Object.keys(perHour).length}). Cân nhắc giảm tần suất để tránh sử dụng API không cần thiết.`;
        }

        return { totalCalls, perHour, warning, adAccountCount };
    }

    /**
     * Initialize default cron settings for a new user
     */
    async initializeDefaults(userId: number) {
        const defaults: CreateCronSettingDto[] = [
            { cronType: 'insight', allowedHours: [7, 12, 18], enabled: true },
            { cronType: 'full', allowedHours: [6], enabled: true },
        ];

        for (const setting of defaults) {
            await this.upsertSetting(userId, setting);
        }

        return this.getSettings(userId);
    }
}
