import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { getVietnamHour } from '@n-utils';

/**
 * TelegramService - Per-User Bot Architecture with Multiple Subscribers
 * 
 * Each user/business adds their own bot token.
 * Team members subscribe via /subscribe command.
 * Notifications sent to all subscribers of that bot.
 */
@Injectable()
export class TelegramService {
    private readonly logger = new Logger(TelegramService.name);

    constructor(
        private readonly httpService: HttpService,
        private readonly prisma: PrismaService,
    ) { }

    // ==================== BOT VALIDATION & SETUP ====================

    /**
     * Validate a bot token and get bot info
     */
    async validateBotToken(botToken: string): Promise<{ valid: boolean; botInfo?: any; error?: string }> {
        try {
            const response = await firstValueFrom(
                this.httpService.get(`https://api.telegram.org/bot${botToken}/getMe`),
            );

            if (response.data?.ok) {
                return { valid: true, botInfo: response.data.result };
            }
            return { valid: false, error: 'Invalid response from Telegram' };
        } catch (error) {
            return { valid: false, error: error.message };
        }
    }

    /**
     * Set bot commands menu
     */
    async setBotCommands(botToken: string): Promise<boolean> {
        try {
            const commands = [
                { command: 'start', description: 'Bắt đầu' },
                { command: 'subscribe', description: '🔔 Bật nhận thông báo tự động' },
                { command: 'unsubscribe', description: '🔕 Tắt nhận thông báo tự động' },
                { command: 'report', description: 'Báo cáo Ads' },
                { command: 'hour', description: 'Báo cáo giờ vừa qua' },
                { command: 'today', description: 'Báo cáo hôm nay' },
                { command: 'week', description: 'Báo cáo 7 ngày' },
                { command: 'budget', description: 'Ngân sách' },
                { command: 'help', description: 'Hỗ trợ' },
            ];

            await firstValueFrom(
                this.httpService.post(`https://api.telegram.org/bot${botToken}/setMyCommands`, { commands }),
            );
            return true;
        } catch (error) {
            this.logger.error(`Failed to set bot commands: ${error.message}`);
            return false;
        }
    }

    async setWebhookForBot(botToken: string, botId: number): Promise<{ success: boolean; error?: string }> {
        try {
            // Try to get ngrok URL first (for local development)
            let baseUrl = process.env.BASE_URL || process.env.RAILWAY_PUBLIC_DOMAIN;
            
            // if (!baseUrl) {
            //     try {
            //         const ngrokResponse = await firstValueFrom(
            //             this.httpService.get('http://localhost:4040/api/tunnels')
            //         );
            //         const tunnels = ngrokResponse.data?.tunnels || [];
            //         const httpsTunnel = tunnels.find((t: any) => t.proto === 'https');
            //         if (httpsTunnel?.public_url) {
            //             baseUrl = httpsTunnel.public_url;
            //             this.logger.log(`Detected ngrok URL: ${baseUrl}`);
            //         }
            //     } catch (ngrokError) {
            //         // Ngrok not running, use default
            //         this.logger.debug('Ngrok not detected, using default URL');
            //     }
            // }

            if (!baseUrl) {
                baseUrl = 'https://facebook-ads-sever-production.up.railway.app/api/v1'; // Should be configured in prod
                this.logger.warn(`No BASE_URL configured, using default: ${baseUrl}`);
            }

            const webhookUrl = `${baseUrl}/telegram/webhook/${botId}`;

            const response = await firstValueFrom(
                this.httpService.post(`https://api.telegram.org/bot${botToken}/setWebhook`, {
                    url: webhookUrl,
                    allowed_updates: ['message', 'callback_query'],
                }),
            );

            if (response.data?.ok) {
                this.logger.log(`Webhook registered for bot ${botId}: ${webhookUrl}`);
                return { success: true };
            }
            return { success: false, error: 'Telegram API returned error' };
        } catch (error: any) {
            this.logger.error(`Failed to set webhook for bot ${botId}: ${error.message}`);
            return { success: false, error: error.message };
        }
    }

    // ==================== WEBHOOK PROCESSING ====================

    /**
     * Process incoming webhook update for a specific bot
     */
    async processWebhookUpdate(botId: number, update: any): Promise<void> {
        try {
            this.logger.log(`[Webhook] Received update for botId: ${botId}`, JSON.stringify(update));
            
            const message = update.message;
            if (!message) {
                this.logger.warn(`[Webhook] No message in update for botId: ${botId}`);
                return;
            }

            const chatId = message.chat?.id?.toString();
            const text = message.text || '';
            const firstName = message.from?.first_name || 'User';

            if (!chatId) {
                this.logger.warn(`[Webhook] No chatId in message for botId: ${botId}`);
                return;
            }

            this.logger.log(`[Webhook] Processing command "${text}" for bot ${botId}, chatId: ${chatId}`);

            const bot = await this.prisma.userTelegramBot.findUnique({
                where: { id: botId },
            });

            if (!bot) {
                this.logger.warn(`Bot ${botId} not found`);
                return;
            }

            if (!bot.isActive) {
                this.logger.warn(`Bot ${botId} is not active`);
                return;
            }

            // Auto-register user as subscriber and capture the result
            const subscriber = await this.ensureSubscriber(botId, chatId, firstName);
            this.logger.log(`[Webhook] Subscriber data captured for botId ${botId}, chatId ${chatId}:`, {
                id: subscriber.id,
                receiveNotifications: subscriber.receiveNotifications,
                isActive: subscriber.isActive,
            });

            // Handle commands
            if (text.startsWith('/start')) {
                this.logger.log(`[Webhook] Handling /start command for bot ${botId}, chatId: ${chatId}`);
                await this.handleStartCommand(bot.botToken, botId, chatId, firstName, subscriber);
            } else if (text.startsWith('/subscribe')) {
                this.logger.log(`Handling /subscribe command for bot ${botId}, chatId: ${chatId}`);
                await this.handleSubscribeCommand(bot.botToken, botId, chatId);
            } else if (text.startsWith('/unsubscribe')) {
                this.logger.log(`Handling /unsubscribe command for bot ${botId}, chatId: ${chatId}`);
                await this.handleUnsubscribeCommand(bot.botToken, botId, chatId);
            } else if (text.startsWith('/report')) {
                this.logger.log(`Handling /report command for bot ${botId}, chatId: ${chatId}`);
                await this.handleReportCommand(bot, chatId);
            } else if (text.startsWith('/hour')) {
                this.logger.log(`Handling /hour command for bot ${botId}, chatId: ${chatId}`);
                await this.handleHourCommand(bot, chatId);
            } else if (text.startsWith('/today')) {
                this.logger.log(`Handling /today command for bot ${botId}, chatId: ${chatId}`);
                await this.handleTodayCommand(bot, chatId);
            } else if (text.startsWith('/week')) {
                this.logger.log(`Handling /week command for bot ${botId}, chatId: ${chatId}`);
                await this.handleWeekCommand(bot, chatId);
            } else if (text.startsWith('/budget')) {
                this.logger.log(`Handling /budget command for bot ${botId}, chatId: ${chatId}`);
                await this.handleBudgetCommand(bot, chatId);
            } else if (text.startsWith('/help')) {
                this.logger.log(`Handling /help command for bot ${botId}, chatId: ${chatId}`);
                await this.handleHelpCommand(bot.botToken, chatId);
            }
        } catch (error) {
            this.logger.error(`Error processing update: ${error.message}`, error.stack);
        }
    }

    // ==================== SUBSCRIBER MANAGEMENT ====================

    private async ensureSubscriber(botId: number, chatId: string, name?: string) {
        // Upsert subscriber but don't override receiveNotifications when updating
        // Only set it to true when creating new subscriber
        this.logger.log(`[EnsureSubscriber] Starting upsert for botId ${botId}, chatId ${chatId}, name: ${name || 'not provided'}`);
        
        // First check if subscriber exists to determine if this is create or update
        const existing = await this.prisma.telegramBotSubscriber.findUnique({
            where: { botId_chatId: { botId: Number(botId), chatId: String(chatId) } },
            select: { id: true, receiveNotifications: true, isActive: true },
        });
        
        const isNew = !existing;
        this.logger.log(`[EnsureSubscriber] Subscriber ${isNew ? 'NOT FOUND - will CREATE' : 'FOUND - will UPDATE'}:`, {
            existingId: existing?.id,
            existingReceiveNotifications: existing?.receiveNotifications,
            existingIsActive: existing?.isActive,
        });
        
        const result = await this.prisma.telegramBotSubscriber.upsert({
            where: { botId_chatId: { botId: Number(botId), chatId: String(chatId) } },
            create: { botId: Number(botId), chatId: String(chatId), name, isActive: true, receiveNotifications: true },
            update: { 
                isActive: true, 
                ...(name ? { name } : {}), // Only update name if provided
                // Don't touch receiveNotifications - keep existing value
            },
        });
        
        this.logger.log(`[EnsureSubscriber] Upsert completed for botId ${botId}, chatId ${chatId}:`, {
            id: result.id,
            receiveNotifications: result.receiveNotifications,
            isActive: result.isActive,
            wasNew: isNew,
            receiveNotificationsChanged: isNew ? 'N/A (new)' : (result.receiveNotifications === existing?.receiveNotifications ? 'NO (preserved)' : 'YES'),
        });
        
        return result;
    }

    async getSubscribers(botId: number) {
        const subscribers = await this.prisma.telegramBotSubscriber.findMany({
            where: { 
                botId: Number(botId), 
                isActive: true, 
                receiveNotifications: true 
            },
            select: {
                id: true,
                chatId: true,
                name: true,
                receiveNotifications: true,
                isActive: true,
            },
        });
        this.logger.log(`[GetSubscribers] Found ${subscribers.length} active subscribers with notifications enabled for bot ${botId}`, {
            botId: Number(botId),
            count: subscribers.length,
            chatIds: subscribers.map(s => s.chatId),
        });
        return subscribers;
    }

    // ==================== COMMAND HANDLERS ====================

    private async handleStartCommand(
        botToken: string, 
        botId: number, 
        chatId: string, 
        firstName: string, 
        subscriberData?: { receiveNotifications: boolean; isActive: boolean }
    ): Promise<void> {
        try {
            this.logger.log(`handleStartCommand called for bot ${botId}, chatId: ${chatId}, firstName: ${firstName}`, {
                hasSubscriberData: !!subscriberData,
            });
            
            // Use provided subscriber data if available, otherwise query (fallback)
            let isSubscribed = false;
            
            if (subscriberData) {
                // Use the subscriber data passed from processWebhookUpdate (from ensureSubscriber)
                this.logger.log(`[Start] Using provided subscriber data for botId ${botId}, chatId ${chatId}:`, {
                    receiveNotifications: subscriberData.receiveNotifications,
                    isActive: subscriberData.isActive,
                });
                isSubscribed = subscriberData.receiveNotifications === true && subscriberData.isActive === true;
            } else {
                // Fallback: query if subscriber data not provided (shouldn't happen in normal flow)
                this.logger.warn(`[Start] No subscriber data provided, falling back to query for botId ${botId}, chatId ${chatId}`);
                try {
                    const subscriber = await this.prisma.telegramBotSubscriber.findUnique({
                        where: { 
                            botId_chatId: { 
                                botId: Number(botId), 
                                chatId: String(chatId) 
                            } 
                        },
                        select: {
                            receiveNotifications: true,
                            isActive: true,
                        },
                    });
                    
                    this.logger.log(`[Start] Fallback query result for botId ${botId}, chatId ${chatId}:`, {
                        found: !!subscriber,
                        receiveNotifications: subscriber?.receiveNotifications,
                        isActive: subscriber?.isActive,
                    });
                    
                    isSubscribed = subscriber?.receiveNotifications === true && subscriber?.isActive === true;
                } catch (dbError: any) {
                    this.logger.error(`Failed to query subscriber for botId ${botId}, chatId ${chatId}: ${dbError?.message}`, dbError?.stack);
                    // Default to false if query fails
                }
            }
            
            this.logger.log(`[Start] Final subscription status for botId ${botId}, chatId ${chatId}:`, {
                isSubscribed,
                source: subscriberData ? 'provided_data' : 'fallback_query',
            });

            const statusText = isSubscribed
                ? '✅ Bạn đang nhận thông báo tự động'
                : '⚠️ Bạn chưa bật nhận thông báo tự động. Dùng /subscribe để bật';

            this.logger.log(`[Start] Status text determined for botId ${botId}, chatId ${chatId}:`, {
                isSubscribed,
                statusText: isSubscribed ? 'subscribed' : 'not_subscribed',
            });

            // Escape HTML in firstName to prevent issues
            const safeFirstName = (firstName || 'User').replace(/[<>&"']/g, '');

            const message = `👋 <b>Xin chào ${safeFirstName}!</b>

${statusText}

📌 <b>Các lệnh có sẵn:</b>
/subscribe - 🔔 Bật nhận thông báo tự động
/unsubscribe - 🔕 Tắt nhận thông báo tự động
/report - Báo cáo tổng quan Ads
/hour - Báo cáo giờ vừa qua
/today - Báo cáo hôm nay (từng bài)
/week - Báo cáo 7 ngày (từng bài)
/budget - Xem ngân sách
/help - Hướng dẫn sử dụng`;

            this.logger.log(`[Start] Sending message to botId ${botId}, chatId ${chatId}`);
            const success = await this.sendMessageTo(botToken, chatId, message);
            if (!success) {
                this.logger.error(`[Start] Failed to send start command response to chatId: ${chatId}`);
                // Try to send a simple fallback message
                await this.sendMessageTo(botToken, chatId, '👋 Xin chào! Dùng /help để xem các lệnh có sẵn.');
            } else {
                this.logger.log(`[Start] Successfully sent start command response to chatId: ${chatId} with status: ${isSubscribed ? 'subscribed' : 'not_subscribed'}`);
            }
        } catch (error: any) {
            this.logger.error(`Error in handleStartCommand: ${error?.message || 'Unknown error'}`, error?.stack);
            // Don't throw - let the outer catch handle it
            // Try to send error message, but don't fail if this also fails
            try {
                await this.sendMessageTo(botToken, chatId, '❌ Có lỗi xảy ra khi xử lý lệnh /start. Vui lòng thử lại sau.');
            } catch (sendError) {
                this.logger.error(`Failed to send error message: ${sendError}`);
            }
        }
    }

    private async handleSubscribeCommand(botToken: string, botId: number, chatId: string) {
        try {
            this.logger.log(`[Subscribe] handleSubscribeCommand called for bot ${botId}, chatId: ${chatId}`);
            
            // Ensure subscriber exists first
            await this.ensureSubscriber(botId, chatId);
            
            // Get current state before update
            const beforeUpdate = await this.prisma.telegramBotSubscriber.findUnique({
                where: { botId_chatId: { botId: Number(botId), chatId: String(chatId) } },
                select: { id: true, receiveNotifications: true, isActive: true },
            });
            
            this.logger.log(`[Subscribe] State BEFORE update for botId ${botId}, chatId ${chatId}:`, {
                found: !!beforeUpdate,
                id: beforeUpdate?.id,
                receiveNotifications: beforeUpdate?.receiveNotifications,
                isActive: beforeUpdate?.isActive,
            });
            
            // Update subscriber - explicitly set receiveNotifications to true
            const updated = await this.prisma.telegramBotSubscriber.update({
                where: { botId_chatId: { botId: Number(botId), chatId: String(chatId) } },
                data: { receiveNotifications: true, isActive: true },
            });
            
            this.logger.log(`[Subscribe] Updated subscriber for botId ${botId}, chatId ${chatId}:`, {
                id: updated.id,
                receiveNotifications: updated.receiveNotifications,
                isActive: updated.isActive,
                changed: beforeUpdate ? (beforeUpdate.receiveNotifications !== updated.receiveNotifications) : 'N/A (new)',
            });
            
            // Verify the update was successful - query again to ensure DB persistence
            const verify = await this.prisma.telegramBotSubscriber.findUnique({
                where: { botId_chatId: { botId: Number(botId), chatId: String(chatId) } },
                select: { 
                    id: true,
                    receiveNotifications: true, 
                    isActive: true,
                    updatedAt: true,
                },
            });
            
            this.logger.log(`[Subscribe] Verification query result after update:`, {
                found: !!verify,
                id: verify?.id,
                receiveNotifications: verify?.receiveNotifications,
                isActive: verify?.isActive,
                updatedAt: verify?.updatedAt,
                matchesUpdate: verify?.receiveNotifications === true && verify?.isActive === true,
            });
            
            // Final check: verify subscriber will be included in getSubscribers
            const willReceiveNotifications = verify?.receiveNotifications === true && verify?.isActive === true;
            if (!willReceiveNotifications) {
                this.logger.error(`[Subscribe] WARNING: Subscriber ${chatId} will NOT receive notifications! Verification failed.`);
            } else {
                this.logger.log(`[Subscribe] SUCCESS: Subscriber ${chatId} is properly configured to receive notifications.`);
            }
            
            // Double-check: verify subscriber appears in getSubscribers query (same query used for sending notifications)
            const subscribersList = await this.getSubscribers(botId);
            const isInSubscribersList = subscribersList.some(s => s.chatId === chatId);
            this.logger.log(`[Subscribe] Final verification - Subscriber in getSubscribers list:`, {
                chatId,
                isInList: isInSubscribersList,
                totalSubscribers: subscribersList.length,
            });
            
            if (!isInSubscribersList) {
                this.logger.error(`[Subscribe] CRITICAL: Subscriber ${chatId} is NOT in getSubscribers list! They will NOT receive notifications!`);
            } else {
                this.logger.log(`[Subscribe] CONFIRMED: Subscriber ${chatId} is in getSubscribers list and WILL receive notifications.`);
            }
            
            const success = await this.sendMessageTo(botToken, chatId, `
🔔 <b>Đã bật nhận thông báo tự động!</b>

Bạn sẽ nhận được:
• Báo cáo sync insights theo giờ
• Cảnh báo hệ thống
• Tổng kết hàng ngày

Dùng /unsubscribe để tắt thông báo.
            `);
            
            if (!success) {
                this.logger.error(`Failed to send subscribe command response to chatId: ${chatId}`);
            }
        } catch (error: any) {
            this.logger.error(`Error in handleSubscribeCommand: ${error?.message || 'Unknown error'}`, error?.stack);
            try {
                await this.sendMessageTo(botToken, chatId, '❌ Có lỗi xảy ra. Vui lòng thử lại sau.');
            } catch (sendError) {
                this.logger.error(`Failed to send error message: ${sendError}`);
            }
        }
    }

    private async handleUnsubscribeCommand(botToken: string, botId: number, chatId: string) {
        try {
            this.logger.log(`handleUnsubscribeCommand called for bot ${botId}, chatId: ${chatId}`);
            
            const updated = await this.prisma.telegramBotSubscriber.update({
                where: { botId_chatId: { botId: Number(botId), chatId: String(chatId) } },
                data: { receiveNotifications: false },
            });
            
            this.logger.log(`[Unsubscribe] Updated subscriber for botId ${botId}, chatId ${chatId}:`, {
                id: updated.id,
                receiveNotifications: updated.receiveNotifications,
                isActive: updated.isActive,
            });
            
            // Verify the update
            const verify = await this.prisma.telegramBotSubscriber.findUnique({
                where: { botId_chatId: { botId: Number(botId), chatId: String(chatId) } },
                select: { receiveNotifications: true, isActive: true },
            });
            
            this.logger.log(`[Unsubscribe] Verification query result:`, verify);
            
            const success = await this.sendMessageTo(botToken, chatId, `
🔕 <b>Đã tắt nhận thông báo tự động!</b>

Bạn vẫn có thể dùng các lệnh:
/report /hour /today /week /budget

Dùng /subscribe để bật lại thông báo.
            `);
            
            if (!success) {
                this.logger.error(`Failed to send unsubscribe command response to chatId: ${chatId}`);
            }
        } catch (error: any) {
            this.logger.error(`Error in handleUnsubscribeCommand: ${error?.message || 'Unknown error'}`, error?.stack);
            try {
                await this.sendMessageTo(botToken, chatId, '❌ Có lỗi xảy ra. Vui lòng thử lại sau.');
            } catch (sendError) {
                this.logger.error(`Failed to send error message: ${sendError}`);
            }
        }
    }

    private async handleReportCommand(bot: any, chatId: string) {
        try {
            this.logger.log(`handleReportCommand called for bot ${bot.id}, chatId: ${chatId}`);
            
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            // Get stats for user's ad accounts
            const activeAdsCount = await this.prisma.ad.count({
                where: {
                    effectiveStatus: 'ACTIVE',
                    account: { fbAccount: { userId: bot.userId } },
                },
            });

            const accountCount = await this.prisma.adAccount.count({
                where: { fbAccount: { userId: bot.userId } },
            });

            const todayInsights = await this.prisma.adInsightsDaily.aggregate({
                where: {
                    date: { gte: today },
                    account: { fbAccount: { userId: bot.userId } },
                },
                _sum: {
                    spend: true,
                    impressions: true,
                    clicks: true,
                    reach: true,
                },
            });

            const totalSpend = Number(todayInsights._sum.spend || 0);
            const totalImpressions = Number(todayInsights._sum.impressions || 0);
            const totalClicks = Number(todayInsights._sum.clicks || 0);
            const totalReach = Number(todayInsights._sum.reach || 0);

            const ctr = totalImpressions > 0 ? ((totalClicks / totalImpressions) * 100).toFixed(2) : '0';
            const cpm = totalImpressions > 0 ? ((totalSpend / totalImpressions) * 1000).toFixed(0) : '0';

            const success = await this.sendMessageTo(bot.botToken, chatId, `
📊 <b>Báo cáo tổng quan Ads</b>
📅 ${today.toLocaleDateString('vi-VN')}

📁 Ad Accounts: <b>${accountCount}</b>
🎯 Active Ads: <b>${activeAdsCount}</b>

💰 <b>Hiệu suất hôm nay:</b>
• Chi tiêu: <b>${totalSpend.toLocaleString()} VND</b>
• Impressions: <b>${totalImpressions.toLocaleString()}</b>
• Reach: <b>${totalReach.toLocaleString()}</b>
• Clicks: <b>${totalClicks.toLocaleString()}</b>

📈 <b>Chỉ số:</b>
• CTR: <b>${ctr}%</b>
• CPM: <b>${cpm} VND</b>
            `);
            
            if (!success) {
                this.logger.error(`Failed to send report command response to chatId: ${chatId}`);
            }
        } catch (error) {
            this.logger.error(`Error in handleReportCommand: ${error.message}`, error.stack);
            await this.sendMessageTo(bot.botToken, chatId, '❌ Có lỗi khi lấy báo cáo. Vui lòng thử lại sau.');
        }
    }

    private async handleHourCommand(bot: any, chatId: string) {
        try {
            this.logger.log(`handleHourCommand called for bot ${bot.id}, chatId: ${chatId}`);
            const success = await this.sendMessageTo(bot.botToken, chatId, '⏰ Tính năng báo cáo theo giờ sẽ được cập nhật sớm.');
            if (!success) {
                this.logger.error(`Failed to send hour command response to chatId: ${chatId}`);
            }
        } catch (error) {
            this.logger.error(`Error in handleHourCommand: ${error.message}`, error.stack);
        }
    }

    private async handleTodayCommand(bot: any, chatId: string) {
        try {
            this.logger.log(`handleTodayCommand called for bot ${bot.id}, chatId: ${chatId}`);
            const success = await this.sendMessageTo(bot.botToken, chatId, '📊 Tính năng báo cáo hôm nay sẽ được cập nhật sớm.');
            if (!success) {
                this.logger.error(`Failed to send today command response to chatId: ${chatId}`);
            }
        } catch (error) {
            this.logger.error(`Error in handleTodayCommand: ${error.message}`, error.stack);
        }
    }

    private async handleWeekCommand(bot: any, chatId: string) {
        try {
            this.logger.log(`handleWeekCommand called for bot ${bot.id}, chatId: ${chatId}`);
            const success = await this.sendMessageTo(bot.botToken, chatId, '📊 Tính năng báo cáo 7 ngày sẽ được cập nhật sớm.');
            if (!success) {
                this.logger.error(`Failed to send week command response to chatId: ${chatId}`);
            }
        } catch (error) {
            this.logger.error(`Error in handleWeekCommand: ${error.message}`, error.stack);
        }
    }

    private async handleBudgetCommand(bot: any, chatId: string) {
        try {
            this.logger.log(`handleBudgetCommand called for bot ${bot.id}, chatId: ${chatId}`);
            const success = await this.sendMessageTo(bot.botToken, chatId, '💰 Tính năng xem ngân sách sẽ được cập nhật sớm.');
            if (!success) {
                this.logger.error(`Failed to send budget command response to chatId: ${chatId}`);
            }
        } catch (error) {
            this.logger.error(`Error in handleBudgetCommand: ${error.message}`, error.stack);
        }
    }

    private async handleHelpCommand(botToken: string, chatId: string) {
        try {
            this.logger.log(`handleHelpCommand called for chatId: ${chatId}`);
            const success = await this.sendMessageTo(botToken, chatId, `
📖 <b>Hướng dẫn sử dụng</b>

<b>📋 Các lệnh:</b>
/start - Bắt đầu sử dụng bot
/subscribe - 🔔 Bật nhận thông báo
/unsubscribe - 🔕 Tắt nhận thông báo
/report - Báo cáo tổng quan Ads
/hour - Báo cáo giờ vừa qua
/today - Báo cáo hôm nay
/week - Báo cáo 7 ngày
/budget - Xem ngân sách

<b>🔔 Thông báo tự động:</b>
• Báo cáo sync dữ liệu
• Báo cáo insights theo giờ
• Cảnh báo hệ thống
            `);
            if (!success) {
                this.logger.error(`Failed to send help command response to chatId: ${chatId}`);
            }
        } catch (error) {
            this.logger.error(`Error in handleHelpCommand: ${error.message}`, error.stack);
        }
    }

    // ==================== SEND MESSAGES ====================

    async sendMessageTo(botToken: string, chatId: string, message: string): Promise<boolean> {
        try {
            const response = await firstValueFrom(
                this.httpService.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                    chat_id: chatId,
                    text: message.trim(),
                    parse_mode: 'HTML',
                }),
            );
            
            if (response.data?.ok) {
                this.logger.debug(`Successfully sent message to chatId: ${chatId}`);
                return true;
            } else {
                this.logger.error(`Telegram API returned error for chatId ${chatId}: ${JSON.stringify(response.data)}`);
                return false;
            }
        } catch (error: any) {
            const errorMessage = error?.response?.data?.description || error?.message || 'Unknown error';
            this.logger.error(`Failed to send to ${chatId}: ${errorMessage}`, error?.response?.data);
            return false;
        }
    }

    /**
     * Send message to all subscribers of a bot
     * Checks if bot has notification settings and respects allowed hours
     */
    async sendToAllSubscribers(botId: number, message: string, hour?: number): Promise<number> {
        const bot = await this.prisma.userTelegramBot.findUnique({
            where: { id: botId },
        });

        if (!bot || !bot.isActive) {
            this.logger.warn(`Bot ${botId} not found or not active`);
            return 0;
        }

        // Check if bot has notification settings
        const setting = await this.prisma.userTelegramBotSettings.findFirst({
            where: { userId: bot.userId, botId },
        });

        if (setting) {
            if (!setting.enabled) {
                this.logger.log(`Bot ${botId} notifications disabled, skipping`);
                return 0;
            }

            // Check if current hour is allowed (use provided hour or get current hour)
            const currentHour = hour !== undefined ? hour : getVietnamHour();
            if (!setting.allowedHours.includes(currentHour)) {
                this.logger.log(`Bot ${botId} notifications not allowed at hour ${currentHour}, skipping`);
                return 0;
            }
        }

        const subscribers = await this.getSubscribers(botId);
        this.logger.log(`[SendToAllSubscribers] Sending message to ${subscribers.length} subscribers for bot ${botId}`, {
            botId,
            subscriberCount: subscribers.length,
            chatIds: subscribers.map(s => s.chatId),
        });
        
        if (subscribers.length === 0) {
            this.logger.warn(`[SendToAllSubscribers] No active subscribers with notifications enabled for bot ${botId}`);
        }

        let sent = 0;
        const failedChatIds: string[] = [];

        for (const sub of subscribers) {
            this.logger.debug(`[SendToAllSubscribers] Attempting to send to chatId ${sub.chatId} (bot ${botId})`);
            const success = await this.sendMessageTo(bot.botToken, sub.chatId, message);
            if (success) {
                sent++;
                this.logger.debug(`[SendToAllSubscribers] Successfully sent to chatId ${sub.chatId}`);
            } else {
                failedChatIds.push(sub.chatId);
                this.logger.error(`[SendToAllSubscribers] Failed to send message to subscriber ${sub.chatId} (bot ${botId})`);
            }
        }

        this.logger.log(`[SendToAllSubscribers] Sent ${sent}/${subscribers.length} messages for bot ${botId}`, {
            botId,
            total: subscribers.length,
            sent,
            failed: failedChatIds.length,
            failedChatIds: failedChatIds.length > 0 ? failedChatIds : undefined,
        });
        return sent;
    }

    // ==================== NOTIFICATIONS FOR INSIGHTS ====================

    /**
     * Send insights sync report to all subscribers of bots for this ad account
     * Respects bot notification settings (allowed hours)
     */
    async sendInsightsSyncReportToAdAccount(
        adAccountId: string,
        data: {
            accountName: string;
            date: string;
            adsCount: number;
            totalSpend: number;
            totalImpressions: number;
            totalClicks: number;
            totalReach: number;
            currency: string;
        },
    ) {
        const bots = await this.prisma.userTelegramBot.findMany({
            where: {
                isActive: true,
                OR: [
                    { adAccountId },
                    { adAccountId: null },
                ],
            },
        });

        if (bots.length === 0) return;

        const ctr = data.totalImpressions > 0
            ? ((data.totalClicks / data.totalImpressions) * 100).toFixed(2)
            : '0';
        const cpm = data.totalImpressions > 0
            ? ((data.totalSpend / data.totalImpressions) * 1000).toFixed(0)
            : '0';

        const message = `
📈 <b>Insights Sync Complete</b>

📊 Account: <b>${data.accountName}</b>
📅 Date: <b>${data.date}</b>
🎯 Active Ads: <b>${data.adsCount}</b>

💰 <b>Performance:</b>
• Spend: <b>${data.totalSpend.toLocaleString()} ${data.currency}</b>
• Impressions: <b>${data.totalImpressions.toLocaleString()}</b>
• Reach: <b>${data.totalReach.toLocaleString()}</b>
• Clicks: <b>${data.totalClicks.toLocaleString()}</b>

📊 CTR: <b>${ctr}%</b> | CPM: <b>${cpm}</b>
`;

        for (const bot of bots) {
            await this.sendToAllSubscribers(bot.id, message);
        }
    }

    /**
     * Send message to all bots with hour check
     */
    async sendMessageWithHour(message: string, hour: number): Promise<void> {
        const bots = await this.prisma.userTelegramBot.findMany({
            where: { isActive: true },
        });

        for (const bot of bots) {
            await this.sendToAllSubscribers(bot.id, message, hour);
        }
    }

    /**
     * Send test message to verify bot works
     */
    async sendTestMessage(botToken: string, chatId: string): Promise<{ success: boolean; message: string }> {
        const testMessage = `✅ <b>Test Message</b>\n\nBot is working correctly!\n\n🕐 ${new Date().toLocaleString('vi-VN')}`;
        const success = await this.sendMessageTo(botToken, chatId, testMessage);
        return {
            success,
            message: success ? 'Test message sent!' : 'Failed to send message',
        };
    }

    // ==================== BACKWARD COMPATIBLE METHODS ====================

    /**
     * Send message to all active bots' subscribers (backward compatible)
     * Respects bot notification settings (allowed hours)
     */
    async sendMessage(message: string): Promise<void> {
        const bots = await this.prisma.userTelegramBot.findMany({
            where: { isActive: true },
        });

        for (const bot of bots) {
            await this.sendToAllSubscribers(bot.id, message);
        }
    }

    /**
     * Process incoming update - finds bot by token and processes
     */
    async processUpdate(update: any): Promise<void> {
        // This is called for generic webhook - try to find the bot
        const message = update.message;
        if (!message) return;

        // For now, just log - per-bot webhooks use processWebhookUpdate with botId
        this.logger.log(`Received update from chat ${message.chat?.id}`);
    }

    /**
     * Send daily summary (backward compatible)
     */
    async sendDailySummary(data: {
        date: string;
        accountsSynced: number;
        totalSpend: number;
        totalImpressions: number;
        totalClicks: number;
        topAds: Array<{ name: string; spend: number; clicks: number }>;
        currency: string;
    }): Promise<void> {
        const topAdsText = data.topAds
            .slice(0, 5)
            .map((ad, i) => `${i + 1}. ${ad.name.substring(0, 30)}... - ${ad.spend.toLocaleString()} ${data.currency}`)
            .join('\n');

        const message = `
📊 <b>Daily Summary - ${data.date}</b>

👥 Accounts: <b>${data.accountsSynced}</b>
💰 Total Spend: <b>${data.totalSpend.toLocaleString()} ${data.currency}</b>
👁 Impressions: <b>${data.totalImpressions.toLocaleString()}</b>
👆 Clicks: <b>${data.totalClicks.toLocaleString()}</b>

🏆 <b>Top Performing Ads:</b>
${topAdsText || 'No data'}
`;

        await this.sendMessage(message);
    }

    // ==================== WEBHOOK MANAGEMENT ====================

    /**
     * Set webhook URL for a bot token (uses env TELEGRAM_BOT_TOKEN for backward compat)
     */
    async setWebhook(webhookUrl: string): Promise<{ success: boolean; message: string; info?: any }> {
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        if (!botToken) {
            return { success: false, message: 'No TELEGRAM_BOT_TOKEN configured' };
        }

        try {
            const fullWebhookUrl = webhookUrl.endsWith('/webhook')
                ? webhookUrl
                : `${webhookUrl}/api/telegram/webhook`;

            const response = await firstValueFrom(
                this.httpService.post(`https://api.telegram.org/bot${botToken}/setWebhook`, {
                    url: fullWebhookUrl,
                    allowed_updates: ['message', 'callback_query'],
                }),
            );

            if (response.data?.ok) {
                this.logger.log(`Webhook set to: ${fullWebhookUrl}`);
                return { success: true, message: `Webhook set to ${fullWebhookUrl}` };
            }
            return { success: false, message: 'Failed to set webhook' };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * Get webhook info
     */
    async getWebhookInfo(): Promise<any> {
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        if (!botToken) {
            return { error: 'No TELEGRAM_BOT_TOKEN configured' };
        }

        try {
            const response = await firstValueFrom(
                this.httpService.get(`https://api.telegram.org/bot${botToken}/getWebhookInfo`),
            );
            return response.data?.result || {};
        } catch (error) {
            return { error: error.message };
        }
    }

    /**
     * Delete webhook
     */
    async deleteWebhook(): Promise<{ success: boolean; message: string }> {
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        if (!botToken) {
            return { success: false, message: 'No TELEGRAM_BOT_TOKEN configured' };
        }

        try {
            const response = await firstValueFrom(
                this.httpService.post(`https://api.telegram.org/bot${botToken}/deleteWebhook`),
            );

            if (response.data?.ok) {
                return { success: true, message: 'Webhook deleted' };
            }
            return { success: false, message: 'Failed to delete webhook' };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }
}
