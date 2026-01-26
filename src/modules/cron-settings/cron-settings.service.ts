import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { UpsertCronSettingDto } from './dtos/upsert-cron-setting.dto';
import { UpdateUserBotSettingDto } from './dtos/update-user-bot-setting.dto';

@Injectable()
export class CronSettingsService {
  private readonly logger = new Logger(CronSettingsService.name);

  constructor(private readonly prisma: PrismaService) { }

  async getSettings(userId: number) {
    const [settings, adAccountsCount] = await Promise.all([
      this.prisma.cronSetting.findMany({
        where: { userId },
      }),
      this.prisma.platformAccount.count({
        where: { identity: { userId } },
      }),
    ]);

    return {
      settings,
      adAccountCount: adAccountsCount,
    };
  }

  async upsertSetting(userId: number, dto: UpsertCronSettingDto) {
    return this.prisma.cronSetting.upsert({
      where: {
        userId_cronType: {
          userId,
          cronType: dto.cronType,
        },
      },
      update: {
        allowedHours: dto.allowedHours,
        enabled: dto.enabled,
      },
      create: {
        userId,
        cronType: dto.cronType,
        allowedHours: dto.allowedHours,
        enabled: dto.enabled,
      },
    });
  }

  async deleteSetting(userId: number, cronType: string) {
    return this.prisma.cronSetting.deleteMany({
      where: {
        userId,
        cronType,
      },
    });
  }

  async getEstimate(userId: number) {
    const adAccountCount = await this.prisma.platformAccount.count({
      where: { identity: { userId }, accountStatus: 'ACTIVE' },
    });

    const settings = await this.prisma.cronSetting.findMany({
      where: { userId, enabled: true },
    });

    let totalCalls = 0;
    const perHour: Record<number, number> = {};
    for (let i = 0; i < 24; i++) perHour[i] = 0;

    for (const setting of settings) {
      let callsPerExecution = 0;
      if (setting.cronType === 'insight' || setting.cronType === 'insight_hourly' || setting.cronType === 'insight_daily') {
        callsPerExecution = adAccountCount;
      } else if (setting.cronType.startsWith('insight_')) {
        // Breakdowns (device, placement, age_gender, region)
        callsPerExecution = adAccountCount;
      } else if (setting.cronType === 'campaign' || setting.cronType === 'ads' || setting.cronType === 'adset' || setting.cronType === 'creative') {
        callsPerExecution = adAccountCount;
      } else if (setting.cronType === 'full') {
        callsPerExecution = adAccountCount * 3 + adAccountCount; // Entities + Insights
      } else {
        callsPerExecution = adAccountCount;
      }

      totalCalls += callsPerExecution * setting.allowedHours.length;
      for (const hour of setting.allowedHours) {
        perHour[hour] = (perHour[hour] || 0) + callsPerExecution;
      }
    }

    let warning: string | undefined;
    if (totalCalls > 5000) {
      warning = 'Số lượng API call dự kiến khá cao. Hãy cân nhắc giảm tần suất sync.';
    }

    return {
      totalCalls,
      perHour,
      warning,
      adAccountCount,
    };
  }

  // Deprecated - use telegramService for bot settings
  async updateBotSetting(userId: number, dto: UpdateUserBotSettingDto) {
    // This is kept for backward compatibility if any parts still use it
    // but now it should probably update the first bot it finds or throw
    this.logger.warn(`updateBotSetting is deprecated. Use telegram service instead.`);
    return { success: false, message: 'Deprecated' };
  }

  
}
