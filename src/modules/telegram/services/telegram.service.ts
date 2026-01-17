import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { getVietnamHour, getVietnamDateString, getVietnamMoment } from '@n-utils';

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
                { command: 'coso', description: 'Báo cáo theo cơ sở' },
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
            
            if (!baseUrl) {
                try {
                    const ngrokResponse = await firstValueFrom(
                        this.httpService.get('http://localhost:4040/api/tunnels')
                    );
                    const tunnels = ngrokResponse.data?.tunnels || [];
                    const httpsTunnel = tunnels.find((t: any) => t.proto === 'https');
                    if (httpsTunnel?.public_url) {
                        baseUrl = httpsTunnel.public_url;
                        this.logger.log(`Detected ngrok URL: ${baseUrl}`);
                    }
                } catch (ngrokError) {
                    // Ngrok not running, use default
                    this.logger.debug('Ngrok not detected, using default URL');
                }
            }

            if (!baseUrl) {
                baseUrl = 'https://facebook-ads-sever-production.up.railway.app/api/v1'; // Should be configured in prod
                this.logger.warn(`No BASE_URL configured, using default: ${baseUrl}`);
            }

            // Đảm bảo baseUrl có global prefix (api/v1) để trùng với route NestJS
            const globalPrefix = process.env.API_PREFIX || 'api/v1';
            let normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
            const hasGlobalPrefix =
                normalizedBaseUrl.endsWith(`/${globalPrefix}`) ||
                normalizedBaseUrl.includes(`/${globalPrefix}/`);

            if (!hasGlobalPrefix) {
                this.logger.warn(
                    `BASE_URL (${normalizedBaseUrl}) thiếu prefix ${globalPrefix} - tự động bổ sung để webhook khớp route`,
                );
                normalizedBaseUrl = `${normalizedBaseUrl}/${globalPrefix}`;
            }

            const webhookUrl = `${normalizedBaseUrl}/telegram/webhook/${botId}`;

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
            } else if (text.startsWith('/coso')) {
                this.logger.log(`Handling /coso command for bot ${botId}, chatId: ${chatId}`);
                await this.handleBranchCommand(bot, chatId);
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
        const existing = await this.prisma.telegramBotSubscriber.findFirst({
            where: { botId: Number(botId), chatId: String(chatId) },
            select: { id: true, receiveNotifications: true, isActive: true },
        });
        
        const isNew = !existing;
        this.logger.log(`[EnsureSubscriber] Subscriber ${isNew ? 'NOT FOUND - will CREATE' : 'FOUND - will UPDATE'}:`, {
            existingId: existing?.id,
            existingReceiveNotifications: existing?.receiveNotifications,
            existingIsActive: existing?.isActive,
        });
        
        let result;
        if (existing) {
            // Update existing subscriber
            result = await this.prisma.telegramBotSubscriber.update({
                where: { id: existing.id },
                data: { 
                    isActive: true, 
                    ...(name ? { name } : {}),
                },
            });
        } else {
            // Create new subscriber
            result = await this.prisma.telegramBotSubscriber.create({
                data: { botId: Number(botId), chatId: String(chatId), name, isActive: true, receiveNotifications: true },
            });
        }
        
        this.logger.log(`[EnsureSubscriber] Completed for botId ${botId}, chatId ${chatId}:`, {
            id: result.id,
            receiveNotifications: result.receiveNotifications,
            isActive: result.isActive,
            wasNew: isNew,
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
                    const subscriber = await this.prisma.telegramBotSubscriber.findFirst({
                        where: { 
                            botId: Number(botId), 
                            chatId: String(chatId),
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
/coso - Báo cáo theo cơ sở
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
            
            // Find subscriber
            const subscriber = await this.prisma.telegramBotSubscriber.findFirst({
                where: { botId: Number(botId), chatId: String(chatId) },
                select: { id: true, receiveNotifications: true, isActive: true },
            });
            
            if (!subscriber) {
                this.logger.error(`[Subscribe] Subscriber not found after ensureSubscriber for botId ${botId}, chatId ${chatId}`);
                await this.sendMessageTo(botToken, chatId, '❌ Có lỗi xảy ra. Vui lòng thử lại sau.');
                return;
            }
            
            // Update subscriber - explicitly set receiveNotifications to true
            const updated = await this.prisma.telegramBotSubscriber.update({
                where: { id: subscriber.id },
                data: { receiveNotifications: true, isActive: true },
            });
            
            this.logger.log(`[Subscribe] Updated subscriber for botId ${botId}, chatId ${chatId}:`, {
                id: updated.id,
                receiveNotifications: updated.receiveNotifications,
                isActive: updated.isActive,
            });
            
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
            
            // Find subscriber first
            const subscriber = await this.prisma.telegramBotSubscriber.findFirst({
                where: { botId: Number(botId), chatId: String(chatId) },
                select: { id: true },
            });
            
            if (!subscriber) {
                await this.sendMessageTo(botToken, chatId, '⚠️ Bạn chưa đăng ký nhận thông báo.');
                return;
            }
            
            const updated = await this.prisma.telegramBotSubscriber.update({
                where: { id: subscriber.id },
                data: { receiveNotifications: false },
            });
            
            this.logger.log(`[Unsubscribe] Updated subscriber for botId ${botId}, chatId ${chatId}:`, {
                id: updated.id,
                receiveNotifications: updated.receiveNotifications,
                isActive: updated.isActive,
            });
            
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
            const cpm = totalImpressions > 0 ? Math.round((totalSpend / totalImpressions) * 1000).toLocaleString('en-US') : '0';

            const success = await this.sendMessageTo(bot.botToken, chatId, `
📊 <b>Báo cáo tổng quan Ads</b>
📅 ${today.toLocaleDateString('vi-VN')}

📁 Ad Accounts: <b>${accountCount}</b>
🎯 Active Ads: <b>${activeAdsCount}</b>

💰 <b>Hiệu suất hôm nay:</b>
• Chi tiêu: <b>${totalSpend.toLocaleString('en-US')} VND</b>
• Impressions: <b>${totalImpressions.toLocaleString('en-US')}</b>
• Reach: <b>${totalReach.toLocaleString('en-US')}</b>
• Clicks: <b>${totalClicks.toLocaleString('en-US')}</b>

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
            
            const currentHour = getVietnamHour();
            const todayStr = getVietnamDateString();
            
            // Build hour string format: "HH:00:00 - HH:59:59"
            const formatHourString = (h: number) => {
                const hStr = h.toString().padStart(2, '0');
                return `${hStr}:00:00 - ${hStr}:59:59`;
            };
            
            // Get hourly insights for current hour first, fallback to previous hour
            let targetHour = currentHour;
            let hourString = formatHourString(currentHour);
            
            let hourlyData = await this.prisma.adInsightsHourly.findMany({
                where: {
                    date: new Date(todayStr),
                    hourlyStatsAggregatedByAdvertiserTimeZone: hourString,
                    account: { fbAccount: { userId: bot.userId } },
                },
                include: {
                    ad: { select: { name: true } },
                },
                orderBy: { spend: 'desc' },
            });

            // Fallback to previous hour if no data
            if (hourlyData.length === 0 && currentHour > 0) {
                targetHour = currentHour - 1;
                hourString = formatHourString(targetHour);
                hourlyData = await this.prisma.adInsightsHourly.findMany({
                    where: {
                        date: new Date(todayStr),
                        hourlyStatsAggregatedByAdvertiserTimeZone: hourString,
                        account: { fbAccount: { userId: bot.userId } },
                    },
                    include: {
                        ad: { select: { name: true } },
                    },
                    orderBy: { spend: 'desc' },
                });
            }

            if (hourlyData.length === 0) {
                await this.sendMessageTo(bot.botToken, chatId, `
⏰ <b>Báo cáo theo giờ</b>
📅 ${todayStr}

❌ Chưa có dữ liệu cho giờ ${currentHour}:00.
Dữ liệu sẽ có sau khi sync insights.
                `);
                return;
            }

            // Aggregate totals with all metrics
            const totals = hourlyData.reduce((acc, row) => ({
                spend: acc.spend + Number(row.spend || 0),
                impressions: acc.impressions + Number(row.impressions || 0),
                clicks: acc.clicks + Number(row.clicks || 0),
                reach: acc.reach + Number(row.reach || 0),
                results: acc.results + Number(row.results || 0),
                messaging: acc.messaging + Number(row.messagingStarted || 0),
            }), { spend: 0, impressions: 0, clicks: 0, reach: 0, results: 0, messaging: 0 });

            const ctr = totals.impressions > 0 ? ((totals.clicks / totals.impressions) * 100).toFixed(2) : '0';
            const cpc = totals.clicks > 0 ? Math.round(totals.spend / totals.clicks).toLocaleString('en-US') : '0';
            const cpm = totals.impressions > 0 ? Math.round((totals.spend / totals.impressions) * 1000).toLocaleString('en-US') : '0';
            const cpr = totals.results > 0 ? Math.round(totals.spend / totals.results).toLocaleString('en-US') : '0';
            const costPerMsg = totals.messaging > 0 ? Math.round(totals.spend / totals.messaging).toLocaleString('en-US') : '0';

            // Top 3 ads by spend with detailed metrics
            const top3 = hourlyData.slice(0, 3);
            const top3Text = top3.map((row, i) => {
                const adName = row.ad?.name || row.adId;
                const shortName = adName.length > 22 ? adName.slice(0, 19) + '...' : adName;
                const spend = Number(row.spend || 0);
                const impr = Number(row.impressions || 0);
                const clicks = Number(row.clicks || 0);
                const results = Number(row.results || 0);
                const msg = Number(row.messagingStarted || 0);
                return `${i + 1}. ${shortName}
├── 💵 ${spend.toLocaleString('en-US')} | 👁 ${impr.toLocaleString('en-US')} | 👆 ${clicks}
└── 🎯 ${results} | 💬 ${msg}`;
            }).join('\n\n');

            const hourDisplay = `${targetHour.toString().padStart(2, '0')}:00`;
            const success = await this.sendMessageTo(bot.botToken, chatId, `
⏰ <b>Báo cáo giờ ${hourDisplay}</b>
📅 ${todayStr}

💰 <b>TỔNG GIỜ ${hourDisplay}</b>
├── 💵 Spend: <b>${totals.spend.toLocaleString('en-US')} VND</b>
├── 👁 Impressions: ${totals.impressions.toLocaleString('en-US')}
├── 👆 Clicks: ${totals.clicks.toLocaleString('en-US')}
├── 🎯 Results: <b>${totals.results}</b>
├── 💬 New Message: <b>${totals.messaging}</b>
├── 📊 CTR: ${ctr}%
├── 💳 CPC: ${cpc} VND
├── 📈 CPM: ${cpm} VND
├── 🎯 CPR: <b>${cpr} VND</b>
└── 💬 Cost/New Msg: <b>${costPerMsg} VND</b>

🔝 <b>Top ${top3.length} ads:</b>

${top3Text}

📊 Tổng: ${hourlyData.length} ads đang chạy
            `);
            
            if (!success) {
                this.logger.error(`Failed to send hour command response to chatId: ${chatId}`);
            }
        } catch (error) {
            this.logger.error(`Error in handleHourCommand: ${error.message}`, error.stack);
            await this.sendMessageTo(bot.botToken, chatId, '❌ Có lỗi khi lấy báo cáo theo giờ. Vui lòng thử lại sau.');
        }
    }

    private async handleTodayCommand(bot: any, chatId: string) {
        try {
            this.logger.log(`handleTodayCommand called for bot ${bot.id}, chatId: ${chatId}`);
            
            const todayStr = getVietnamDateString();
            const today = new Date(todayStr);

            // Get today's insights grouped by ad
            const dailyInsights = await this.prisma.adInsightsDaily.findMany({
                where: {
                    date: today,
                    account: { fbAccount: { userId: bot.userId } },
                },
                include: {
                    ad: { select: { name: true } },
                },
                orderBy: { spend: 'desc' },
            });

            if (dailyInsights.length === 0) {
                await this.sendMessageTo(bot.botToken, chatId, `
📊 <b>Báo cáo hôm nay</b>
📅 ${todayStr}

❌ Chưa có dữ liệu cho hôm nay.
Dữ liệu sẽ có sau khi sync insights.
                `);
                return;
            }

            // Aggregate totals with all metrics
            const totals = dailyInsights.reduce((acc, row) => ({
                spend: acc.spend + Number(row.spend || 0),
                impressions: acc.impressions + Number(row.impressions || 0),
                clicks: acc.clicks + Number(row.clicks || 0),
                reach: acc.reach + Number(row.reach || 0),
                results: acc.results + Number(row.results || 0),
                messaging: acc.messaging + Number(row.messagingStarted || 0),
            }), { spend: 0, impressions: 0, clicks: 0, reach: 0, results: 0, messaging: 0 });

            const ctr = totals.impressions > 0 ? ((totals.clicks / totals.impressions) * 100).toFixed(2) : '0';
            const cpc = totals.clicks > 0 ? Math.round(totals.spend / totals.clicks).toLocaleString('en-US') : '0';
            const cpm = totals.impressions > 0 ? Math.round((totals.spend / totals.impressions) * 1000).toLocaleString('en-US') : '0';
            const cpr = totals.results > 0 ? Math.round(totals.spend / totals.results).toLocaleString('en-US') : '0';
            const costPerMsg = totals.messaging > 0 ? Math.round(totals.spend / totals.messaging).toLocaleString('en-US') : '0';

            // Top 5 ads by spend with detailed metrics
            const top5 = dailyInsights.slice(0, 5);
            const adsText = top5.map((row, i) => {
                const adName = row.ad?.name || row.adId;
                const shortName = adName.length > 20 ? adName.slice(0, 17) + '...' : adName;
                const spend = Number(row.spend || 0);
                const impr = Number(row.impressions || 0);
                const clicks = Number(row.clicks || 0);
                const results = Number(row.results || 0);
                const msg = Number(row.messagingStarted || 0);
                return `${i + 1}. ${shortName}
├── � ${spend.toLocaleString('en-US')} | 👁 ${impr.toLocaleString('en-US')} | 👆 ${clicks}
└── 🎯 ${results} | 💬 ${msg}`;
            }).join('\n\n');

            const success = await this.sendMessageTo(bot.botToken, chatId, `
📊 <b>Báo cáo hôm nay</b>
📅 ${todayStr}

💰 <b>TỔNG HÔM NAY</b>
├── 💵 Spend: <b>${totals.spend.toLocaleString('en-US')} VND</b>
├── 👁 Impressions: ${totals.impressions.toLocaleString('en-US')}
├── 👆 Clicks: ${totals.clicks.toLocaleString('en-US')}
├── 🎯 Results: <b>${totals.results}</b>
├── 💬 New Message: <b>${totals.messaging}</b>
├── � CTR: ${ctr}%
├── 💳 CPC: ${cpc} VND
├── 📈 CPM: ${cpm} VND
├── 🎯 CPR: <b>${cpr} VND</b>
└── 💬 Cost/New Msg: <b>${costPerMsg} VND</b>

🔝 <b>Top ${top5.length} ads:</b>

${adsText}

📊 Tổng: ${dailyInsights.length} ads có dữ liệu
            `);
            
            if (!success) {
                this.logger.error(`Failed to send today command response to chatId: ${chatId}`);
            }
        } catch (error) {
            this.logger.error(`Error in handleTodayCommand: ${error.message}`, error.stack);
            await this.sendMessageTo(bot.botToken, chatId, '❌ Có lỗi khi lấy báo cáo hôm nay. Vui lòng thử lại sau.');
        }
    }

    private async handleWeekCommand(bot: any, chatId: string) {
        try {
            this.logger.log(`handleWeekCommand called for bot ${bot.id}, chatId: ${chatId}`);
            
            const todayVN = getVietnamMoment();
            const todayStr = todayVN.format('YYYY-MM-DD');
            const sevenDaysAgo = todayVN.clone().subtract(6, 'days');
            const sevenDaysAgoStr = sevenDaysAgo.format('YYYY-MM-DD');

            // Get 7 days of insights
            const weekInsights = await this.prisma.adInsightsDaily.findMany({
                where: {
                    date: {
                        gte: new Date(sevenDaysAgoStr),
                        lte: new Date(todayStr),
                    },
                    account: { fbAccount: { userId: bot.userId } },
                },
                include: {
                    ad: { select: { name: true } },
                },
                orderBy: { date: 'desc' },
            });

            if (weekInsights.length === 0) {
                await this.sendMessageTo(bot.botToken, chatId, `
📊 <b>Báo cáo 7 ngày</b>
📅 ${sevenDaysAgoStr} → ${todayStr}

❌ Chưa có dữ liệu cho 7 ngày qua.
                `);
                return;
            }

            // Aggregate totals with all metrics
            const totals = weekInsights.reduce((acc, row) => ({
                spend: acc.spend + Number(row.spend || 0),
                impressions: acc.impressions + Number(row.impressions || 0),
                clicks: acc.clicks + Number(row.clicks || 0),
                reach: acc.reach + Number(row.reach || 0),
                results: acc.results + Number(row.results || 0),
                messaging: acc.messaging + Number(row.messagingStarted || 0),
            }), { spend: 0, impressions: 0, clicks: 0, reach: 0, results: 0, messaging: 0 });

            const ctr = totals.impressions > 0 ? ((totals.clicks / totals.impressions) * 100).toFixed(2) : '0';
            const cpc = totals.clicks > 0 ? Math.round(totals.spend / totals.clicks).toLocaleString('en-US') : '0';
            const cpm = totals.impressions > 0 ? Math.round((totals.spend / totals.impressions) * 1000).toLocaleString('en-US') : '0';
            const cpr = totals.results > 0 ? Math.round(totals.spend / totals.results).toLocaleString('en-US') : '0';
            const costPerMsg = totals.messaging > 0 ? Math.round(totals.spend / totals.messaging).toLocaleString('en-US') : '0';

            // Aggregate by date
            const byDate: Record<string, { spend: number; impressions: number; clicks: number }> = {};
            weekInsights.forEach(row => {
                const dateKey = row.date.toISOString().split('T')[0];
                if (!byDate[dateKey]) {
                    byDate[dateKey] = { spend: 0, impressions: 0, clicks: 0 };
                }
                byDate[dateKey].spend += Number(row.spend || 0);
                byDate[dateKey].impressions += Number(row.impressions || 0);
                byDate[dateKey].clicks += Number(row.clicks || 0);
            });

            // Sort dates and format
            const sortedDates = Object.keys(byDate).sort().reverse().slice(0, 5);
            const dateText = sortedDates.map(d => {
                const data = byDate[d];
                const shortDate = d.slice(5); // MM-DD
                return `• ${shortDate}: 💰${data.spend.toLocaleString('en-US')} | 👁${data.impressions.toLocaleString('en-US')}`;
            }).join('\n');

            // Top 5 ads by total spend
            const adSpends: Record<string, { name: string; spend: number }> = {};
            weekInsights.forEach(row => {
                const key = row.adId;
                if (!adSpends[key]) {
                    adSpends[key] = { name: row.ad?.name || row.adId, spend: 0 };
                }
                adSpends[key].spend += Number(row.spend || 0);
            });
            
            const topAds = Object.values(adSpends)
                .sort((a, b) => b.spend - a.spend)
                .slice(0, 5);
            
            const topAdsText = topAds.map((ad, i) => {
                const shortName = ad.name.length > 20 ? ad.name.slice(0, 17) + '...' : ad.name;
                return `${i + 1}. ${shortName}: <b>${ad.spend.toLocaleString('en-US')}</b>`;
            }).join('\n');

            const success = await this.sendMessageTo(bot.botToken, chatId, `
📊 <b>Báo cáo 7 ngày</b>
📅 ${sevenDaysAgoStr} → ${todayStr}

💰 <b>TỔNG 7 NGÀY</b>
├── 💵 Spend: <b>${totals.spend.toLocaleString('en-US')} VND</b>
├── 👁 Impressions: ${totals.impressions.toLocaleString('en-US')}
├── 👆 Clicks: ${totals.clicks.toLocaleString('en-US')}
├── 🎯 Results: <b>${totals.results}</b>
├── 💬 New Message: <b>${totals.messaging}</b>
├── 📊 CTR: ${ctr}%
├── � CPC: ${cpc} VND
├── �📈 CPM: ${cpm} VND
├── 🎯 CPR: <b>${cpr} VND</b>
└── 💬 Cost/New Msg: <b>${costPerMsg} VND</b>

📅 <b>Theo ngày:</b>
${dateText}

🔝 <b>Top ${topAds.length} ads:</b>
${topAdsText}
            `);
            
            if (!success) {
                this.logger.error(`Failed to send week command response to chatId: ${chatId}`);
            }
        } catch (error) {
            this.logger.error(`Error in handleWeekCommand: ${error.message}`, error.stack);
            await this.sendMessageTo(bot.botToken, chatId, '❌ Có lỗi khi lấy báo cáo 7 ngày. Vui lòng thử lại sau.');
        }
    }

    private async handleBudgetCommand(bot: any, chatId: string) {
        try {
            this.logger.log(`handleBudgetCommand called for bot ${bot.id}, chatId: ${chatId}`);
            
            // Get ad accounts for user
            const adAccounts = await this.prisma.adAccount.findMany({
                where: {
                    fbAccount: { userId: bot.userId },
                },
                select: {
                    id: true,
                    name: true,
                    balance: true,
                    spendCap: true,
                    amountSpent: true,
                    currency: true,
                    accountStatus: true,
                },
            });

            if (adAccounts.length === 0) {
                await this.sendMessageTo(bot.botToken, chatId, `
💰 <b>Thông tin ngân sách</b>

❌ Chưa có Ad Account nào được liên kết.
                `);
                return;
            }

            // Get active campaigns with budgets
            const campaigns = await this.prisma.campaign.findMany({
                where: {
                    account: { fbAccount: { userId: bot.userId } },
                    effectiveStatus: 'ACTIVE',
                },
                select: {
                    id: true,
                    name: true,
                    dailyBudget: true,
                    lifetimeBudget: true,
                    budgetRemaining: true,
                    spendCap: true,
                },
                orderBy: { createdTime: 'desc' },
                take: 10,
            });

            // Format ad accounts info
            const accountsText = adAccounts.map(acc => {
                const name = acc.name || acc.id;
                const shortName = name.length > 20 ? name.slice(0, 17) + '...' : name;
                const balance = Number(acc.balance || 0);
                const spent = Number(acc.amountSpent || 0);
                const cap = Number(acc.spendCap || 0);
                const statusEmoji = acc.accountStatus === 1 ? '✅' : '⚠️';
                
                let line = `${statusEmoji} <b>${shortName}</b>`;
                if (balance > 0) line += `\n   💵 Số dư: ${balance.toLocaleString('en-US')} ${acc.currency}`;
                if (spent > 0) line += `\n   💸 Đã chi: ${spent.toLocaleString('en-US')} ${acc.currency}`;
                if (cap > 0) line += `\n   🔒 Spend cap: ${cap.toLocaleString('en-US')} ${acc.currency}`;
                
                return line;
            }).join('\n\n');

            // Format campaigns info
            let campaignsText = '';
            if (campaigns.length > 0) {
                const top5Campaigns = campaigns.slice(0, 5);
                campaignsText = top5Campaigns.map(c => {
                    const name = c.name || c.id;
                    const shortName = name.length > 25 ? name.slice(0, 22) + '...' : name;
                    const daily = Number(c.dailyBudget || 0);
                    const lifetime = Number(c.lifetimeBudget || 0);
                    const remaining = Number(c.budgetRemaining || 0);
                    
                    let budgetInfo = '';
                    if (daily > 0) budgetInfo = `Ngày: ${daily.toLocaleString('en-US')}`;
                    else if (lifetime > 0) budgetInfo = `Tổng: ${lifetime.toLocaleString('en-US')}`;
                    if (remaining > 0) budgetInfo += ` | Còn: ${remaining.toLocaleString('en-US')}`;
                    
                    return `• ${shortName}\n   ${budgetInfo || 'Không giới hạn'}`;
                }).join('\n');
            }

            const success = await this.sendMessageTo(bot.botToken, chatId, `
💰 <b>Thông tin ngân sách</b>

📁 <b>Ad Accounts (${adAccounts.length}):</b>

${accountsText}
${campaignsText ? `
🎯 <b>Active Campaigns (${campaigns.length}):</b>

${campaignsText}
` : ''}
            `);
            
            if (!success) {
                this.logger.error(`Failed to send budget command response to chatId: ${chatId}`);
            }
        } catch (error) {
            this.logger.error(`Error in handleBudgetCommand: ${error.message}`, error.stack);
            await this.sendMessageTo(bot.botToken, chatId, '❌ Có lỗi khi lấy thông tin ngân sách. Vui lòng thử lại sau.');
        }
    }

    /**
     * Handle /coso command - Branch-based report
     * Shows stats grouped by branch (cơ sở)
     */
    private async handleBranchCommand(bot: any, chatId: string) {
        try {
            this.logger.log(`handleBranchCommand called for bot ${bot.id}, chatId: ${chatId}`);
            
            const todayStr = getVietnamDateString();
            const today = new Date(todayStr);

            // Get all ad accounts for this user with their branches
            const adAccounts = await this.prisma.adAccount.findMany({
                where: {
                    fbAccount: { userId: bot.userId },
                    accountStatus: 1,
                },
                select: {
                    id: true,
                    name: true,
                    currency: true,
                    branchId: true,
                    branch: { select: { id: true, name: true } },
                },
            });

            if (adAccounts.length === 0) {
                await this.sendMessageTo(bot.botToken, chatId, `
🏢 <b>Báo cáo theo cơ sở</b>
📅 ${todayStr}

❌ Không có tài khoản quảng cáo nào.
                `);
                return;
            }

            // Get today's insights for all accounts
            const insightsByAccount = await this.prisma.adInsightsDaily.groupBy({
                by: ['accountId'],
                where: {
                    date: today,
                    accountId: { in: adAccounts.map(a => a.id) },
                },
                _sum: {
                    spend: true,
                    impressions: true,
                    clicks: true,
                    reach: true,
                    results: true,
                    messagingStarted: true,
                },
                _count: {
                    adId: true,
                },
            });

            // Create a map for quick lookup
            const insightsMap = new Map(insightsByAccount.map(i => [i.accountId, i]));

            // Group accounts by branch
            const branchMap = new Map<string, {
                branchName: string;
                accounts: Array<{
                    name: string;
                    currency: string;
                    spend: number;
                    impressions: number;
                    clicks: number;
                    results: number;
                    messaging: number;
                    adsCount: number;
                }>;
            }>();

            for (const account of adAccounts) {
                const branchKey = account.branch?.name || 'Chưa gán cơ sở';
                const insights = insightsMap.get(account.id);

                if (!branchMap.has(branchKey)) {
                    branchMap.set(branchKey, { branchName: branchKey, accounts: [] });
                }

                branchMap.get(branchKey)!.accounts.push({
                    name: account.name,
                    currency: account.currency || 'VND',
                    spend: Number(insights?._sum?.spend || 0),
                    impressions: Number(insights?._sum?.impressions || 0),
                    clicks: Number(insights?._sum?.clicks || 0),
                    results: Number(insights?._sum?.results || 0),
                    messaging: Number(insights?._sum?.messagingStarted || 0),
                    adsCount: insights?._count?.adId || 0,
                });
            }

            // Build message for each branch
            let message = `🏢 <b>Báo cáo theo cơ sở</b>\n📅 ${todayStr}\n\n`;

            let totalSpend = 0;
            let totalResults = 0;
            let totalMessaging = 0;

            for (const [branchName, branchData] of branchMap) {
                const branchSpend = branchData.accounts.reduce((sum, a) => sum + a.spend, 0);
                const branchResults = branchData.accounts.reduce((sum, a) => sum + a.results, 0);
                const branchMessaging = branchData.accounts.reduce((sum, a) => sum + a.messaging, 0);
                const branchAds = branchData.accounts.reduce((sum, a) => sum + a.adsCount, 0);

                totalSpend += branchSpend;
                totalResults += branchResults;
                totalMessaging += branchMessaging;

                const cpr = branchResults > 0 ? Math.round(branchSpend / branchResults).toLocaleString('en-US') : '0';
                const cpm = branchMessaging > 0 ? Math.round(branchSpend / branchMessaging).toLocaleString('en-US') : '0';

                message += `🏬 <b>${branchName}</b>\n`;
                message += `├── 💵 Spend: <b>${branchSpend.toLocaleString('en-US')} VND</b>\n`;
                message += `├── 🎯 Results: <b>${branchResults}</b> (CPR: ${cpr})\n`;
                message += `├── 💬 New Msg: <b>${branchMessaging}</b> (Cost: ${cpm})\n`;
                message += `└── 📊 Ads: ${branchAds} | Accounts: ${branchData.accounts.length}\n\n`;
            }

            // Add totals
            const totalCpr = totalResults > 0 ? Math.round(totalSpend / totalResults).toLocaleString('en-US') : '0';
            message += `💰 <b>TỔNG CỘNG</b>\n`;
            message += `├── 💵 Spend: <b>${totalSpend.toLocaleString('en-US')} VND</b>\n`;
            message += `├── 🎯 Results: <b>${totalResults}</b> (CPR: ${totalCpr})\n`;
            message += `└── 💬 New Msg: <b>${totalMessaging}</b>`;

            const success = await this.sendMessageTo(bot.botToken, chatId, message);
            
            if (!success) {
                this.logger.error(`Failed to send branch command response to chatId: ${chatId}`);
            }
        } catch (error) {
            this.logger.error(`Error in handleBranchCommand: ${error.message}`, error.stack);
            await this.sendMessageTo(bot.botToken, chatId, '❌ Có lỗi khi lấy báo cáo theo cơ sở. Vui lòng thử lại sau.');
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
/coso - Báo cáo theo cơ sở
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
            branchName?: string | null;
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
            ? Math.round((data.totalSpend / data.totalImpressions) * 1000).toLocaleString('en-US')
            : '0';

        const message = `
📈 <b>Insights Sync Complete</b>

📊 Account: <b>${data.accountName}</b>
🏢 Cơ sở: <b>${data.branchName || 'Chưa gán'}</b>
📅 Date: <b>${data.date}</b>
🎯 Active Ads: <b>${data.adsCount}</b>

💰 <b>Performance:</b>
• Spend: <b>${data.totalSpend.toLocaleString('en-US')} ${data.currency}</b>
• Impressions: <b>${data.totalImpressions.toLocaleString('en-US')}</b>
• Reach: <b>${data.totalReach.toLocaleString('en-US')}</b>
• Clicks: <b>${data.totalClicks.toLocaleString('en-US')}</b>

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
            .map((ad, i) => `${i + 1}. ${ad.name.substring(0, 30)}... - ${ad.spend.toLocaleString('en-US')} ${data.currency}`)
            .join('\n');

        const message = `
📊 <b>Daily Summary - ${data.date}</b>

👥 Accounts: <b>${data.accountsSynced}</b>
💰 Total Spend: <b>${data.totalSpend.toLocaleString('en-US')} ${data.currency}</b>
👁 Impressions: <b>${data.totalImpressions.toLocaleString('en-US')}</b>
👆 Clicks: <b>${data.totalClicks.toLocaleString('en-US')}</b>

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
