import { Controller, Get, Post, Delete, Put, Param, Body, Query, UseGuards, Request, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TelegramService } from './services/telegram.service';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { CurrentUser } from '../shared/decorators/current-user.decorator';

@ApiTags('Telegram')
@Controller('telegram')
export class TelegramController {
    constructor(
        private readonly telegramService: TelegramService,
        private readonly prisma: PrismaService,
    ) { }

    @Get('bots')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Get user Telegram bot configurations' })
    async getUserTelegramBots(@CurrentUser() user: any) {
        const bots = await this.prisma.userTelegramBot.findMany({
            where: { userId: user.id },
            include: {
                adAccount: { select: { id: true, name: true } },
                subscribers: { where: { isActive: true } },
                settings: true,
            },
            orderBy: { createdAt: 'desc' },
        });

        const botsWithLinks = bots.map(bot => ({
            ...bot,
            subscriberCount: bot.subscribers.length,
            activeSubscribers: bot.subscribers.filter(s => s.receiveNotifications).length,
            telegramLink: bot.botUsername ? `https://t.me/${bot.botUsername}` : null,
            notificationSettings: bot.settings && bot.settings.length > 0 ? bot.settings[0] : null,
        }));

        return { bots: botsWithLinks };
    }

    @Post('bots')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Add or update user Telegram bot' })
    async upsertUserTelegramBot(
        @CurrentUser() user: any,
        @Body() dto: { botToken: string; botName?: string; adAccountId?: string },
    ) {
        const validation = await this.telegramService.validateBotToken(dto.botToken);
        if (!validation.valid) {
            return { success: false, error: `Invalid bot token: ${validation.error}` };
        }

        const botInfo = validation.botInfo;

        // Handle null adAccountId manually to avoid Prisma upsert issues with null in composite key
        const existingBot = await this.prisma.userTelegramBot.findFirst({
            where: {
                userId: user.id,
                adAccountId: dto.adAccountId || null,
            },
        });

        let bot;
        if (existingBot) {
            // Update existing bot
            bot = await this.prisma.userTelegramBot.update({
                where: { id: existingBot.id },
                data: {
                    botToken: dto.botToken,
                    botName: dto.botName || botInfo?.first_name,
                    botUsername: botInfo?.username,
                    isActive: true,
                },
            });
        } else {
            // Create new bot
            bot = await this.prisma.userTelegramBot.create({
                data: {
                    userId: user.id,
                    adAccountId: dto.adAccountId || null,
                    botToken: dto.botToken,
                    botName: dto.botName || botInfo?.first_name,
                    botUsername: botInfo?.username,
                },
            });
        }

        // Set bot commands
        await this.telegramService.setBotCommands(dto.botToken);

        // Register webhook with Telegram
        const webhookResult = await this.telegramService.setWebhookForBot(dto.botToken, bot.id);
        if (!webhookResult.success) {
            // Log warning but don't fail - bot is saved, webhook can be retried
            console.warn(`Webhook registration failed for bot ${bot.id}: ${webhookResult.error}`);
        }

        return {
            success: true,
            bot,
            botInfo,
            telegramLink: botInfo?.username ? `https://t.me/${botInfo.username}` : null,
            webhookRegistered: webhookResult.success,
        };
    }

    @Delete('bots/:id')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Delete Telegram bot' })
    async deleteTelegramBot(
        @CurrentUser() user: any,
        @Param('id') id: string,
    ) {
        const bot = await this.prisma.userTelegramBot.findFirst({
            where: { id: parseInt(id, 10), userId: user.id },
        });

        if (!bot) {
            return { success: false, error: 'Bot not found' };
        }

        await this.prisma.userTelegramBot.delete({
            where: { id: parseInt(id, 10) },
        });

        return { success: true, message: 'Bot deleted' };
    }

    @Post('webhook/:botId')
    @ApiOperation({ summary: 'Telegram webhook endpoint for specific bot' })
    async handleWebhook(
        @Param('botId') botId: string,
        @Body() update: any,
    ) {
        try {
            const botIdNum = parseInt(botId, 10);
            console.log(`[Webhook] Received update for botId: ${botIdNum}`, JSON.stringify(update));
            await this.telegramService.processWebhookUpdate(botIdNum, update);
        } catch (error) {
            console.error(`[Webhook] Error processing webhook for botId ${botId}:`, error);
        }
        return { ok: true };
    }

    @Post('webhook')
    @ApiOperation({ summary: 'Legacy webhook endpoint - auto-detect bot from token or find first active bot' })
    async handleLegacyWebhook(@Body() update: any) {
        try {
            console.log('[Webhook] Legacy webhook called', JSON.stringify(update));
            
            // Try to find bot from webhook token in headers or find first active bot
            // For now, find first active bot as fallback
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

    @Get('register-webhook')
    @ApiOperation({ summary: 'Register Telegram webhook URL (legacy)' })
    async registerWebhook(@Query('url') webhookUrl: string) {
        if (!webhookUrl) {
            return {
                success: false,
                message: 'Please provide webhook URL as query parameter: ?url=https://your-domain.com/api/v1/telegram/webhook',
            };
        }
        // This requires bot token - should be done per bot
        return { success: false, message: 'Use POST /telegram/bots to set up bot with webhook' };
    }

    @Get('webhook-info')
    @ApiOperation({ summary: 'Get current Telegram webhook info (legacy)' })
    async getWebhookInfo() {
        return { message: 'Use GET /telegram/bots to see bot configurations' };
    }

    @Get('delete-webhook')
    @ApiOperation({ summary: 'Delete Telegram webhook (legacy)' })
    async deleteWebhook() {
        return { message: 'Use DELETE /telegram/bots/:id to remove bot' };
    }

    // ==================== BOT NOTIFICATION SETTINGS ====================

    @Get('bots/:botId/settings')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Get notification settings for a bot' })
    async getBotSettings(
        @CurrentUser() user: any,
        @Param('botId') botId: string,
    ) {
        const bot = await this.prisma.userTelegramBot.findFirst({
            where: { id: parseInt(botId, 10), userId: user.id },
        });

        if (!bot) {
            throw new BadRequestException('Bot not found');
        }

        const setting = await this.prisma.userTelegramBotSettings.findFirst({
            where: { userId: user.id, botId: parseInt(botId, 10) },
        });

        return { setting: setting || null };
    }

    @Post('bots/:botId/settings')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Create or update notification settings for a bot' })
    async upsertBotSettings(
        @CurrentUser() user: any,
        @Param('botId') botId: string,
        @Body() dto: { allowedHours: number[]; enabled?: boolean },
    ) {
        const bot = await this.prisma.userTelegramBot.findFirst({
            where: { id: parseInt(botId, 10), userId: user.id },
        });

        if (!bot) {
            throw new BadRequestException('Bot not found');
        }

        // Validate hours (must be 0-23)
        if (dto.allowedHours.some((h) => h < 0 || h > 23)) {
            throw new BadRequestException('Hours must be between 0 and 23');
        }

        // Remove duplicates and sort
        const uniqueHours = [...new Set(dto.allowedHours)].sort((a, b) => a - b);

        // Use findFirst + create/update instead of upsert to avoid Prisma client issues
        const existing = await this.prisma.userTelegramBotSettings.findFirst({
            where: { userId: user.id, botId: parseInt(botId, 10) },
        });

        const setting = existing
            ? await this.prisma.userTelegramBotSettings.update({
                  where: { id: existing.id },
                  data: {
                      allowedHours: uniqueHours,
                      enabled: dto.enabled ?? true,
                  },
              })
            : await this.prisma.userTelegramBotSettings.create({
                  data: {
                      userId: user.id,
                      botId: parseInt(botId, 10),
                      allowedHours: uniqueHours,
                      enabled: dto.enabled ?? true,
                  },
              });

        return { success: true, setting };
    }

    @Delete('bots/:botId/settings')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Delete notification settings for a bot' })
    async deleteBotSettings(
        @CurrentUser() user: any,
        @Param('botId') botId: string,
    ) {
        const bot = await this.prisma.userTelegramBot.findFirst({
            where: { id: parseInt(botId, 10), userId: user.id },
        });

        if (!bot) {
            throw new BadRequestException('Bot not found');
        }

        await this.prisma.userTelegramBotSettings.deleteMany({
            where: { userId: user.id, botId: parseInt(botId, 10) },
        });

        return { success: true, message: 'Settings deleted' };
    }

    // ==================== DEBUG & TESTING ====================

    @Get('bots/:botId/subscribers')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Get all subscribers for a bot (debug)' })
    async getBotSubscribers(
        @CurrentUser() user: any,
        @Param('botId') botId: string,
    ) {
        const bot = await this.prisma.userTelegramBot.findFirst({
            where: { id: parseInt(botId, 10), userId: user.id },
        });

        if (!bot) {
            throw new BadRequestException('Bot not found');
        }

        const allSubscribers = await this.prisma.telegramBotSubscriber.findMany({
            where: { botId: parseInt(botId, 10) },
            orderBy: { createdAt: 'desc' },
        });

        const activeSubscribers = await this.prisma.telegramBotSubscriber.findMany({
            where: { 
                botId: parseInt(botId, 10),
                isActive: true,
                receiveNotifications: true,
            },
        });

        return {
            botId: parseInt(botId, 10),
            botName: bot.botName,
            totalSubscribers: allSubscribers.length,
            activeSubscribers: activeSubscribers.length,
            subscribers: allSubscribers,
            activeSubscribersList: activeSubscribers,
        };
    }

    @Post('bots/:botId/test')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Send test message to all subscribers of a bot' })
    async sendTestMessageToBot(
        @CurrentUser() user: any,
        @Param('botId') botId: string,
    ) {
        const bot = await this.prisma.userTelegramBot.findFirst({
            where: { id: parseInt(botId, 10), userId: user.id },
        });

        if (!bot) {
            throw new BadRequestException('Bot not found');
        }

        const testMessage = `✅ <b>Test Message</b>

Đây là tin nhắn test từ hệ thống!

🕐 ${new Date().toLocaleString('vi-VN')}

Nếu bạn nhận được tin nhắn này, bot đang hoạt động đúng!`;

        const sentCount = await this.telegramService.sendToAllSubscribers(
            parseInt(botId, 10),
            testMessage,
        );

        return {
            success: true,
            subscriberCount: sentCount,
            message: `Đã gửi test message đến ${sentCount} người`,
        };
    }

    @Post('bots/:botId/migrate-subscribers')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Migrate subscribers from telegram_subscribers to telegram_bot_subscribers' })
    async migrateSubscribers(
        @CurrentUser() user: any,
        @Param('botId') botId: string,
    ) {
        const bot = await this.prisma.userTelegramBot.findFirst({
            where: { id: parseInt(botId, 10), userId: user.id },
        });

        if (!bot) {
            throw new BadRequestException('Bot not found');
        }

        // Get all subscribers from old table
        const oldSubscribers = await this.prisma.telegramSubscriber.findMany({
            where: {
                isActive: true,
                receiveNotifications: true,
            },
        });

        let migrated = 0;
        let skipped = 0;

        for (const oldSub of oldSubscribers) {
            try {
                await this.prisma.telegramBotSubscriber.upsert({
                    where: {
                        botId_chatId: {
                            botId: parseInt(botId, 10),
                            chatId: oldSub.chatId,
                        },
                    },
                    create: {
                        botId: parseInt(botId, 10),
                        chatId: oldSub.chatId,
                        name: oldSub.name,
                        isActive: oldSub.isActive,
                        receiveNotifications: oldSub.receiveNotifications,
                    },
                    update: {
                        isActive: oldSub.isActive,
                        receiveNotifications: oldSub.receiveNotifications,
                        name: oldSub.name,
                    },
                });
                migrated++;
            } catch (error) {
                skipped++;
            }
        }

        return {
            success: true,
            migrated,
            skipped,
            message: `Đã migrate ${migrated} subscribers, bỏ qua ${skipped}`,
        };
    }

    @Post('bots/:botId/add-subscriber')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({ summary: 'Manually add a subscriber to a bot' })
    async addSubscriber(
        @CurrentUser() user: any,
        @Param('botId') botId: string,
        @Body() dto: { chatId: string; name?: string },
    ) {
        const bot = await this.prisma.userTelegramBot.findFirst({
            where: { id: parseInt(botId, 10), userId: user.id },
        });

        if (!bot) {
            throw new BadRequestException('Bot not found');
        }

        const subscriber = await this.prisma.telegramBotSubscriber.upsert({
            where: {
                botId_chatId: {
                    botId: parseInt(botId, 10),
                    chatId: dto.chatId,
                },
            },
            create: {
                botId: parseInt(botId, 10),
                chatId: dto.chatId,
                name: dto.name,
                isActive: true,
                receiveNotifications: true,
            },
            update: {
                isActive: true,
                receiveNotifications: true,
                name: dto.name,
            },
        });

        return {
            success: true,
            subscriber,
            message: 'Đã thêm subscriber thành công',
        };
    }
}

