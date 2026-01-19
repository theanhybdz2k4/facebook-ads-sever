import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { UpsertTelegramBotDto, UpsertBotSettingsDto } from './dtos/upsert-telegram-bot.dto';
import axios from 'axios';

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);

  constructor(private readonly prisma: PrismaService) { }

  async getBots(userId: number) {
    const bots = await this.prisma.telegramBot.findMany({
      where: { userId },
      include: {
        adAccount: { select: { id: true, name: true } },
        notificationSettings: true,
        _count: { select: { subscribers: { where: { isActive: true } } } },
      },
    });

    return {
      bots: bots.map(bot => ({
        ...bot,
        activeSubscribers: (bot as any)._count.subscribers,
        subscriberCount: (bot as any)._count.subscribers, // Simplification
        telegramLink: `https://t.me/${bot.botUsername || 'your_bot'}`,
      })),
    };
  }

  async upsertBot(userId: number, dto: UpsertTelegramBotDto) {
    // Validate bot token via Telegram API
    let botUsername = '';
    try {
      const resp = await axios.get(`https://api.telegram.org/bot${dto.botToken}/getMe`);
      botUsername = resp.data.result.username;
    } catch (error: any) {
      throw new Error(`Invalid Bot Token: ${error.response?.data?.description || error.message}`);
    }

    const bot = await this.prisma.telegramBot.upsert({
      where: {
        id: -1, // We don't have id in upsert from frontend in this specific mutation
      },
      update: {
        botName: dto.botName,
        botUsername,
        adAccountId: dto.adAccountId,
      },
      create: {
        userId,
        botToken: dto.botToken,
        botName: dto.botName,
        botUsername,
        adAccountId: dto.adAccountId,
      },
    });

    return {
      success: true,
      bot,
      telegramLink: `https://t.me/${botUsername}`,
    };
  }

  async deleteBot(id: number, userId: number) {
    const bot = await this.prisma.telegramBot.findUnique({ where: { id } });
    if (!bot || bot.userId !== userId) throw new NotFoundException('Bot not found');

    return this.prisma.telegramBot.delete({ where: { id } });
  }

  async getBotSettings(botId: number, userId: number) {
    const bot = await this.prisma.telegramBot.findUnique({
      where: { id: botId },
      include: { notificationSettings: true },
    });

    if (!bot || bot.userId !== userId) throw new NotFoundException('Bot not found');

    return {
      setting: bot.notificationSettings,
    };
  }

  async upsertBotSettings(botId: number, userId: number, dto: UpsertBotSettingsDto) {
    const bot = await this.prisma.telegramBot.findUnique({ where: { id: botId } });
    if (!bot || bot.userId !== userId) throw new NotFoundException('Bot not found');

    const setting = await this.prisma.telegramBotNotificationSetting.upsert({
      where: { botId },
      update: {
        allowedHours: dto.allowedHours,
        enabled: dto.enabled ?? true,
      },
      create: {
        botId,
        allowedHours: dto.allowedHours,
        enabled: dto.enabled ?? true,
      },
    });

    return {
      success: true,
      setting,
    };
  }

  async testConnection(token: string, chatId: string) {
    try {
      const testMsg = `🔔 *Connection Test*\n\nYour AAMS Dashboard is successfully connected to this bot.`;
      const resp = await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chatId,
        text: testMsg,
        parse_mode: 'Markdown',
      });
      return { success: true, result: resp.data.result };
    } catch (error: any) {
      this.logger.error(`Telegram connection test failed: ${error.message}`);
      return {
        success: false,
        error: error.response?.data?.description || error.message,
      };
    }
  }

  async sendTestMessage(botId: number, userId: number) {
    const bot = await this.prisma.telegramBot.findUnique({
      where: { id: botId },
      include: { subscribers: { where: { isActive: true } } },
    });

    if (!bot || bot.userId !== userId) throw new NotFoundException('Bot not found');

    const subscribers = bot.subscribers;
    if (subscribers.length === 0) {
      return {
        success: false,
        subscriberCount: 0,
        message: 'No active subscribers found. Please /subscribe to the bot first.',
      };
    }

    const testMsg = `🔔 *Test Message*\n\nBot: ${bot.botName || 'Ads Bot'}\nStatus: Active\n\nThis is a test notification from your AAMS Dashboard.`;

    let successCount = 0;
    for (const sub of subscribers) {
      try {
        await axios.post(`https://api.telegram.org/bot${bot.botToken}/sendMessage`, {
          chat_id: sub.chatId,
          text: testMsg,
          parse_mode: 'Markdown',
        });
        successCount++;
      } catch (err) {
        this.logger.error(`Failed to send test message to ${sub.chatId}: ${err.message}`);
      }
    }

    return {
      success: true,
      subscriberCount: successCount,
      message: `Successfully sent test message to ${successCount} subscribers.`,
    };
  }

  async sendMessage(userId: number, message: string, parseMode: 'HTML' | 'Markdown' = 'HTML') {
    const bots = await this.prisma.telegramBot.findMany({
      where: { userId, isActive: true },
      include: { subscribers: { where: { isActive: true } } },
    });

    for (const bot of bots) {
      for (const sub of bot.subscribers) {
        try {
          await axios.post(`https://api.telegram.org/bot${bot.botToken}/sendMessage`, {
            chat_id: sub.chatId,
            text: message,
            parse_mode: parseMode,
          });
        } catch (err) {
          this.logger.error(`Failed to send message to ${sub.chatId}: ${err.message}`);
        }
      }
    }
  }

  // Helper for actual sync notification

  async sendNotification(userId: number, message: string, adAccountId?: number) {
    const bots = await this.prisma.telegramBot.findMany({
      where: {
        userId,
        isActive: true,
        OR: [
          { adAccountId },
          { adAccountId: null },
        ],
      },
      include: {
        notificationSettings: true,
        subscribers: { where: { isActive: true } },
      },
    });

    const now = new Date();
    const currentHour = now.getHours();

    for (const bot of bots) {
      // Check notification settings
      if (bot.notificationSettings && !bot.notificationSettings.enabled) continue;
      if (bot.notificationSettings && !bot.notificationSettings.allowedHours.includes(currentHour)) continue;

      for (const sub of bot.subscribers) {
        try {
          await axios.post(`https://api.telegram.org/bot${bot.botToken}/sendMessage`, {
            chat_id: sub.chatId,
            text: message,
            parse_mode: 'HTML',
          });
        } catch (err) {
          this.logger.error(`Failed to send notification to ${sub.chatId}: ${err.message}`);
        }
      }
    }
  }
}
