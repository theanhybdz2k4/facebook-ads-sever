import { Controller, Get, Post, Body } from '@nestjs/common';
import { AppService } from './app.service';
import { TelegramService } from './modules/telegram/services/telegram.service';
import { PrismaService } from '@n-database/prisma/prisma.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly telegramService: TelegramService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  // Route without /v1 prefix for Telegram webhook compatibility
  @Post('api/telegram/webhook')
  async handleTelegramWebhook(@Body() update: any) {
    try {
      console.log('[Webhook] Legacy webhook called (no prefix)', JSON.stringify(update));
      
      // Find first active bot
      const bot = await this.prisma.userTelegramBot.findFirst({
        where: { isActive: true },
        orderBy: { createdAt: 'desc' },
      });
      
      if (bot) {
        console.log(`[Webhook] Found bot ${bot.id} for legacy webhook`);
        await this.telegramService.processWebhookUpdate(bot.id, update);
      } else {
        console.warn('[Webhook] No active bot found for legacy webhook');
      }
    } catch (error) {
      console.error('[Webhook] Error processing legacy webhook:', error);
    }
    return { ok: true };
  }
}

