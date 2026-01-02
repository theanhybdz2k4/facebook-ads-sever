import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '@n-database/prisma/prisma.service';

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(TelegramService.name);
    private readonly botToken = process.env.TELEGRAM_BOT_TOKEN || '6799465970:AAEk4TXD6O1n7s35_YsmLaZ2Ak08UBK4tng';
    private readonly apiUrl = `https://api.telegram.org/bot${this.botToken}`;
    private chatIds: Set<string> = new Set();

    // Webhook mode: set to true when using webhook, false for polling
    private readonly useWebhook = process.env.TELEGRAM_USE_WEBHOOK === 'true';
    private readonly webhookUrl = process.env.TELEGRAM_WEBHOOK_URL || '';

    constructor(
        private readonly httpService: HttpService,
        private readonly prisma: PrismaService,
    ) { }

    async onModuleInit() {
        // Load chat IDs from database on startup
        await this.loadChatIdsFromDb();

        // Auto-register webhook if URL is configured
        if (this.useWebhook && this.webhookUrl) {
            this.logger.log('Webhook mode enabled, registering webhook...');
            await this.setWebhook(this.webhookUrl);
        } else {
            this.logger.log('Webhook mode disabled. Use /api/telegram/register-webhook to set up webhook.');
        }

        // Set bot commands menu
        await this.setBotCommands();
    }

    async onModuleDestroy() {
        this.logger.log('Telegram service destroyed');
    }

    // ==================== BOT COMMANDS MENU ====================

    private async setBotCommands() {
        try {
            const commands = [
                { command: 'start', description: 'Bắt đầu' },
                { command: 'report', description: 'Báo cáo Ads' },
                { command: 'hour', description: 'Báo cáo giờ vừa qua' },
                { command: 'today', description: 'Báo cáo hôm nay' },
                { command: 'week', description: 'Báo cáo 7 ngày' },
                { command: 'budget', description: 'Ngân sách' },
                { command: 'help', description: 'Hỗ trợ' },
            ];

            await firstValueFrom(
                this.httpService.post(`${this.apiUrl}/setMyCommands`, { commands }),
            );
            this.logger.log('Bot commands menu set successfully');
        } catch (error) {
            this.logger.error(`Failed to set bot commands: ${error.message}`);
        }
    }

    // ==================== WEBHOOK SETUP ====================

    async setWebhook(webhookUrl: string): Promise<{ success: boolean; message: string; info?: any }> {
        try {
            const fullWebhookUrl = webhookUrl.endsWith('/webhook')
                ? webhookUrl
                : `${webhookUrl}/api/telegram/webhook`;

            const response = await firstValueFrom(
                this.httpService.post(`${this.apiUrl}/setWebhook`, {
                    url: fullWebhookUrl,
                    allowed_updates: ['message', 'callback_query'],
                }),
            );

            if (response.data?.ok) {
                this.logger.log(`Webhook registered successfully: ${fullWebhookUrl}`);
                return {
                    success: true,
                    message: `Webhook registered: ${fullWebhookUrl}`,
                    info: response.data,
                };
            } else {
                throw new Error(response.data?.description || 'Unknown error');
            }
        } catch (error) {
            this.logger.error(`Failed to set webhook: ${error.message}`);
            return {
                success: false,
                message: `Failed to set webhook: ${error.message}`,
            };
        }
    }

    async getWebhookInfo(): Promise<any> {
        try {
            const response = await firstValueFrom(
                this.httpService.get(`${this.apiUrl}/getWebhookInfo`),
            );
            return {
                success: true,
                info: response.data?.result,
            };
        } catch (error) {
            return {
                success: false,
                message: error.message,
            };
        }
    }

    async deleteWebhook(): Promise<{ success: boolean; message: string }> {
        try {
            const response = await firstValueFrom(
                this.httpService.post(`${this.apiUrl}/deleteWebhook`),
            );

            if (response.data?.ok) {
                this.logger.log('Webhook deleted successfully');
                return { success: true, message: 'Webhook deleted successfully' };
            } else {
                throw new Error(response.data?.description || 'Unknown error');
            }
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    // ==================== PROCESS WEBHOOK UPDATE ====================

    async processUpdate(update: any): Promise<void> {
        try {
            const message = update.message;
            if (!message) return;

            const chatId = message.chat?.id?.toString();
            const text = message.text || '';
            const firstName = message.from?.first_name || 'User';

            if (!chatId) return;

            // Auto-register user
            if (!this.chatIds.has(chatId)) {
                await this.saveChatIdToDb(chatId, firstName);
                this.chatIds.add(chatId);
                this.logger.log(`New subscriber: ${chatId} (${firstName})`);
            }

            // Handle commands
            if (text.startsWith('/start')) {
                await this.handleStartCommand(chatId, firstName);
            } else if (text.startsWith('/report')) {
                await this.handleReportCommand(chatId);
            } else if (text.startsWith('/hour')) {
                await this.handleHourCommand(chatId);
            } else if (text.startsWith('/today')) {
                await this.handleTodayCommand(chatId);
            } else if (text.startsWith('/week')) {
                await this.handleWeekCommand(chatId);
            } else if (text.startsWith('/budget')) {
                await this.handleBudgetCommand(chatId);
            } else if (text.startsWith('/help')) {
                await this.handleHelpCommand(chatId);
            }
        } catch (error) {
            this.logger.error(`Error processing update: ${error.message}`);
        }
    }

    // ==================== COMMAND HANDLERS ====================

    private async handleStartCommand(chatId: string, firstName: string) {
        await this.sendMessageTo(chatId, `
👋 <b>Xin chào ${firstName}!</b>

Bạn đã đăng ký nhận thông báo từ <b>Facebook Ads Monitor</b>.

📌 <b>Các lệnh có sẵn:</b>
/report - Báo cáo tổng quan Ads
/hour - Báo cáo giờ vừa qua
/today - Báo cáo hôm nay (từng bài)
/week - Báo cáo 7 ngày (từng bài)
/budget - Xem ngân sách
/help - Hướng dẫn sử dụng
        `);
    }

    private async handleReportCommand(chatId: string) {
        try {
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            // Get summary stats
            const activeAdsCount = await this.prisma.ad.count({ where: { status: 'ACTIVE' } });
            const accountCount = await this.prisma.adAccount.count();

            const todayInsights = await this.prisma.adInsightsDaily.aggregate({
                where: { date: { gte: today } },
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

            await this.sendMessageTo(chatId, `
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
        } catch (error) {
            this.logger.error(`Failed to send report: ${error.message}`);
            await this.sendMessageTo(chatId, '❌ Có lỗi khi lấy báo cáo. Vui lòng thử lại sau.');
        }
    }

    private async handleHourCommand(chatId: string) {
        try {
            const now = new Date();
            const currentMinute = now.getMinutes();
            
            // Determine which hour to show
            // If past 30 mins, show current hour; otherwise show previous hour
            let targetHour: number;
            
            if (currentMinute >= 30) {
                // Show current hour (e.g., at 2:31 show 2:00-3:00)
                targetHour = now.getHours();
            } else {
                // Show previous hour (e.g., at 2:00 show 1:00-2:00)
                targetHour = now.getHours() - 1;
                if (targetHour < 0) targetHour = 23;
            }

            // Format hour for query: "01:00:00 - 01:59:59"
            const hourString = targetHour.toString().padStart(2, '0');
            const hourlyTimeZone = `${hourString}:00:00 - ${hourString}:59:59`;
            const hourLabel = `${targetHour}:00 - ${(targetHour + 1) % 24}:00`;

            // Get hourly insights for this hour
            const insights = await this.prisma.adInsightsHourly.findMany({
                where: {
                    hourlyStatsAggregatedByAdvertiserTimeZone: hourlyTimeZone,
                    date: {
                        gte: new Date(now.getFullYear(), now.getMonth(), now.getDate()),
                    },
                },
                orderBy: { spend: 'desc' },
            });

            // Filter ads with spend > 0
            const insightsWithSpend = insights.filter(i => Number(i.spend || 0) > 0);

            if (insightsWithSpend.length === 0) {
                await this.sendMessageTo(chatId, `
⏰ <b>Báo cáo giờ ${hourLabel}</b>
📅 ${now.toLocaleDateString('vi-VN')}

⚠️ Chưa có dữ liệu chi tiêu cho giờ này.
                `);
                return;
            }

            // Get ad names
            const adIds = [...new Set(insightsWithSpend.map(i => i.adId))];
            const ads = await this.prisma.ad.findMany({
                where: { id: { in: adIds } },
                select: { id: true, name: true },
            });
            const adMap = new Map(ads.map(a => [a.id, a.name]));

            // Calculate totals
            const totalSpend = insightsWithSpend.reduce((sum, i) => sum + Number(i.spend || 0), 0);
            const totalImpressions = insightsWithSpend.reduce((sum, i) => sum + Number(i.impressions || 0), 0);
            const totalClicks = insightsWithSpend.reduce((sum, i) => sum + Number(i.clicks || 0), 0);

            // Send header with totals
            await this.sendMessageTo(chatId, `
⏰ <b>Báo cáo giờ ${hourLabel}</b>
📅 ${now.toLocaleDateString('vi-VN')}

📊 <b>Tổng quan:</b>
💰 Spend: <b>${totalSpend.toLocaleString()} VND</b>
👁 Impr: <b>${totalImpressions.toLocaleString()}</b>
👆 Clicks: <b>${totalClicks.toLocaleString()}</b>
📝 <b>${insightsWithSpend.length} bài có chi tiêu</b>
            `);

            // Send each ad report (max 10)
            const maxAds = Math.min(insightsWithSpend.length, 10);
            for (let i = 0; i < maxAds; i++) {
                const insight = insightsWithSpend[i];
                const spend = Number(insight.spend || 0);
                const impressions = Number(insight.impressions || 0);
                const clicks = Number(insight.clicks || 0);
                const reach = Number(insight.reach || 0);

                const ctr = impressions > 0 ? ((clicks / impressions) * 100).toFixed(2) : '0';
                const cpm = impressions > 0 ? ((spend / impressions) * 1000).toFixed(0) : '0';
                const cpc = clicks > 0 ? (spend / clicks).toFixed(0) : '0';

                const adName = adMap.get(insight.adId) || 'Unknown';
                const shortName = adName.length > 40 ? adName.substring(0, 40) + '...' : adName;

                await this.sendMessageTo(chatId, `
🎯 <b>${i + 1}. ${shortName}</b>

💰 Spend: <b>${spend.toLocaleString()} VND</b>
👁 Impr: <b>${impressions.toLocaleString()}</b> | 📢 Reach: <b>${reach.toLocaleString()}</b>
👆 Clicks: <b>${clicks.toLocaleString()}</b>
📈 CTR: <b>${ctr}%</b> | CPM: <b>${cpm}</b> | CPC: <b>${cpc}</b>
                `);

                await this.delay(100);
            }

            if (insightsWithSpend.length > maxAds) {
                await this.sendMessageTo(chatId, `
➕ Còn <b>${insightsWithSpend.length - maxAds}</b> bài khác có chi tiêu...
                `);
            }
        } catch (error) {
            this.logger.error(`Failed to send hour report: ${error.message}`);
            await this.sendMessageTo(chatId, '❌ Có lỗi khi lấy báo cáo. Vui lòng thử lại sau.');
        }
    }

    private async handleTodayCommand(chatId: string) {
        try {
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            // Get insights for each active ad
            const insights = await this.prisma.adInsightsDaily.findMany({
                where: {
                    date: { gte: today },
                    spend: { gt: 0 },
                },
                include: {
                    ad: { select: { name: true, id: true } },
                },
                orderBy: { spend: 'desc' },
            });

            if (insights.length === 0) {
                await this.sendMessageTo(chatId, `
📊 <b>Báo cáo hôm nay</b>
📅 ${today.toLocaleDateString('vi-VN')}

⚠️ Chưa có dữ liệu chi tiêu cho ngày hôm nay.
                `);
                return;
            }

            // Send header
            await this.sendMessageTo(chatId, `
📊 <b>Báo cáo hôm nay - Từng bài</b>
📅 ${today.toLocaleDateString('vi-VN')}
📝 Tổng: <b>${insights.length} bài có chi tiêu</b>
            `);

            // Send each ad report separately (max 10 to avoid spam)
            const maxAds = Math.min(insights.length, 10);
            for (let i = 0; i < maxAds; i++) {
                const insight = insights[i];
                const spend = Number(insight.spend || 0);
                const impressions = Number(insight.impressions || 0);
                const clicks = Number(insight.clicks || 0);
                const reach = Number(insight.reach || 0);

                const ctr = impressions > 0 ? ((clicks / impressions) * 100).toFixed(2) : '0';
                const cpm = impressions > 0 ? ((spend / impressions) * 1000).toFixed(0) : '0';
                const cpc = clicks > 0 ? (spend / clicks).toFixed(0) : '0';

                const adName = insight.ad?.name || 'Unknown';
                const shortName = adName.length > 40 ? adName.substring(0, 40) + '...' : adName;

                await this.sendMessageTo(chatId, `
🎯 <b>${i + 1}. ${shortName}</b>

💰 Spend: <b>${spend.toLocaleString()} VND</b>
👁 Impr: <b>${impressions.toLocaleString()}</b> | 📢 Reach: <b>${reach.toLocaleString()}</b>
👆 Clicks: <b>${clicks.toLocaleString()}</b>
📈 CTR: <b>${ctr}%</b> | CPM: <b>${cpm}</b> | CPC: <b>${cpc}</b>
                `);

                // Small delay to avoid rate limiting
                await this.delay(100);
            }

            if (insights.length > maxAds) {
                await this.sendMessageTo(chatId, `
➕ Còn <b>${insights.length - maxAds}</b> bài khác có chi tiêu...
                `);
            }
        } catch (error) {
            this.logger.error(`Failed to send today report: ${error.message}`);
            await this.sendMessageTo(chatId, '❌ Có lỗi khi lấy báo cáo. Vui lòng thử lại sau.');
        }
    }

    private async handleWeekCommand(chatId: string) {
        try {
            const today = new Date();
            today.setHours(23, 59, 59, 999);
            const weekAgo = new Date();
            weekAgo.setDate(weekAgo.getDate() - 7);
            weekAgo.setHours(0, 0, 0, 0);

            // Get aggregated insights for each ad over 7 days
            const insights = await this.prisma.adInsightsDaily.groupBy({
                by: ['adId'],
                where: {
                    date: { gte: weekAgo, lte: today },
                },
                _sum: {
                    spend: true,
                    impressions: true,
                    clicks: true,
                    reach: true,
                },
                orderBy: { _sum: { spend: 'desc' } },
            });

            // Filter ads with spend > 0
            const insightsWithSpend = insights.filter(i => Number(i._sum.spend || 0) > 0);

            if (insightsWithSpend.length === 0) {
                await this.sendMessageTo(chatId, `
📊 <b>Báo cáo 7 ngày qua</b>
📅 ${weekAgo.toLocaleDateString('vi-VN')} - ${today.toLocaleDateString('vi-VN')}

⚠️ Chưa có dữ liệu chi tiêu trong 7 ngày qua.
                `);
                return;
            }

            // Get ad names
            const adIds = insightsWithSpend.map(i => i.adId);
            const ads = await this.prisma.ad.findMany({
                where: { id: { in: adIds } },
                select: { id: true, name: true },
            });
            const adMap = new Map(ads.map(a => [a.id, a.name]));

            // Send header
            await this.sendMessageTo(chatId, `
📊 <b>Báo cáo 7 ngày - Từng bài</b>
📅 ${weekAgo.toLocaleDateString('vi-VN')} - ${today.toLocaleDateString('vi-VN')}
📝 Tổng: <b>${insightsWithSpend.length} bài có chi tiêu</b>
            `);

            // Send each ad report (max 10)
            const maxAds = Math.min(insightsWithSpend.length, 10);
            for (let i = 0; i < maxAds; i++) {
                const insight = insightsWithSpend[i];
                const spend = Number(insight._sum.spend || 0);
                const impressions = Number(insight._sum.impressions || 0);
                const clicks = Number(insight._sum.clicks || 0);
                const reach = Number(insight._sum.reach || 0);

                const ctr = impressions > 0 ? ((clicks / impressions) * 100).toFixed(2) : '0';
                const cpm = impressions > 0 ? ((spend / impressions) * 1000).toFixed(0) : '0';
                const cpc = clicks > 0 ? (spend / clicks).toFixed(0) : '0';

                const adName = adMap.get(insight.adId) || 'Unknown';
                const shortName = adName.length > 40 ? adName.substring(0, 40) + '...' : adName;

                await this.sendMessageTo(chatId, `
🎯 <b>${i + 1}. ${shortName}</b>

💰 Spend: <b>${spend.toLocaleString()} VND</b>
👁 Impr: <b>${impressions.toLocaleString()}</b> | 📢 Reach: <b>${reach.toLocaleString()}</b>
👆 Clicks: <b>${clicks.toLocaleString()}</b>
📈 CTR: <b>${ctr}%</b> | CPM: <b>${cpm}</b> | CPC: <b>${cpc}</b>
                `);

                await this.delay(100);
            }

            if (insightsWithSpend.length > maxAds) {
                await this.sendMessageTo(chatId, `
➕ Còn <b>${insightsWithSpend.length - maxAds}</b> bài khác có chi tiêu...
                `);
            }
        } catch (error) {
            this.logger.error(`Failed to send week report: ${error.message}`);
            await this.sendMessageTo(chatId, '❌ Có lỗi khi lấy báo cáo. Vui lòng thử lại sau.');
        }
    }

    private async handleBudgetCommand(chatId: string) {
        try {
            // Get all ad accounts with budget info
            const accounts = await this.prisma.adAccount.findMany({
                select: {
                    id: true,
                    name: true,
                    currency: true,
                    amountSpent: true,
                    balance: true,
                    spendCap: true,
                },
            });

            if (accounts.length === 0) {
                await this.sendMessageTo(chatId, `
💰 <b>Ngân sách</b>

⚠️ Chưa có tài khoản quảng cáo nào.
                `);
                return;
            }

            await this.sendMessageTo(chatId, `
💰 <b>Ngân sách các tài khoản</b>
📊 Tổng: <b>${accounts.length} tài khoản</b>
            `);

            for (const account of accounts) {
                const spent = Number(account.amountSpent || 0);
                const balance = Number(account.balance || 0);
                const spendCap = Number(account.spendCap || 0);
                const currency = account.currency || 'VND';

                const shortName = account.name?.length > 30 
                    ? account.name.substring(0, 30) + '...' 
                    : account.name || 'Unknown';

                let budgetInfo = '';
                if (spendCap > 0) {
                    const remaining = spendCap - spent;
                    const percentUsed = ((spent / spendCap) * 100).toFixed(1);
                    budgetInfo = `
📊 Spend Cap: <b>${spendCap.toLocaleString()} ${currency}</b>
✅ Đã dùng: <b>${spent.toLocaleString()} ${currency}</b> (${percentUsed}%)
📍 Còn lại: <b>${remaining.toLocaleString()} ${currency}</b>`;
                } else {
                    budgetInfo = `
✅ Đã chi: <b>${spent.toLocaleString()} ${currency}</b>
💳 Balance: <b>${balance.toLocaleString()} ${currency}</b>`;
                }

                await this.sendMessageTo(chatId, `
📁 <b>${shortName}</b>
${budgetInfo}
                `);

                await this.delay(100);
            }
        } catch (error) {
            this.logger.error(`Failed to send budget info: ${error.message}`);
            await this.sendMessageTo(chatId, '❌ Có lỗi khi lấy thông tin ngân sách.');
        }
    }

    private async handleHelpCommand(chatId: string) {
        await this.sendMessageTo(chatId, `
📖 <b>Hướng dẫn sử dụng</b>

<b>📋 Các lệnh:</b>
/start - Bắt đầu sử dụng bot
/report - Báo cáo tổng quan Ads
/hour - Báo cáo giờ vừa qua (từng bài quảng cáo)
/today - Báo cáo hôm nay (từng bài quảng cáo)
/week - Báo cáo 7 ngày (từng bài quảng cáo)
/budget - Xem ngân sách các tài khoản
/help - Xem hướng dẫn này

<b>📊 Thông tin báo cáo:</b>
• Spend - Chi phí quảng cáo
• Impressions - Số lần hiển thị
• Reach - Số người tiếp cận
• Clicks - Số lần nhấp
• CTR - Tỷ lệ nhấp (Click-through Rate)
• CPM - Chi phí mỗi 1000 lần hiển thị
• CPC - Chi phí mỗi lần nhấp

<b>🔔 Thông báo tự động:</b>
• Báo cáo sync dữ liệu
• Báo cáo insights theo giờ
• Cảnh báo hệ thống
        `);
    }

    // ==================== DATABASE OPERATIONS ====================

    private async loadChatIdsFromDb() {
        try {
            const subscribers = await this.prisma.telegramSubscriber.findMany({
                where: { isActive: true },
            });
            this.chatIds = new Set(subscribers.map(s => s.chatId));
            this.logger.log(`Loaded ${this.chatIds.size} Telegram subscribers from database`);
        } catch (error) {
            this.logger.warn(`Could not load from DB: ${error.message}`);
        }
    }

    private async saveChatIdToDb(chatId: string, name?: string) {
        try {
            await this.prisma.telegramSubscriber.upsert({
                where: { chatId },
                create: { chatId, name, isActive: true },
                update: { isActive: true },
            });
        } catch (error) {
            this.logger.warn(`Could not save to DB: ${error.message}`);
        }
    }

    // ==================== REFRESH FROM TELEGRAM API ====================

    async refreshChatIds() {
        try {
            const response = await firstValueFrom(
                this.httpService.get(`${this.apiUrl}/getUpdates`),
            );

            const updates = response.data?.result || [];
            for (const update of updates) {
                const chatId = update.message?.chat?.id?.toString();
                const firstName = update.message?.from?.first_name;
                if (chatId && !this.chatIds.has(chatId)) {
                    this.chatIds.add(chatId);
                    await this.saveChatIdToDb(chatId, firstName);
                    this.logger.log(`New subscriber: ${chatId} (${firstName})`);
                }
            }

            this.logger.log(`Total Telegram subscribers: ${this.chatIds.size}`);
        } catch (error) {
            this.logger.error(`Failed to refresh chat IDs: ${error.message}`);
        }
    }

    getChatIds(): string[] {
        return Array.from(this.chatIds);
    }

    addChatId(chatId: string) {
        this.chatIds.add(chatId);
        this.saveChatIdToDb(chatId);
        this.logger.log(`Added chat ID: ${chatId}. Total: ${this.chatIds.size}`);
    }

    // ==================== SEND MESSAGES ====================

    private async sendMessageTo(chatId: string, message: string): Promise<boolean> {
        try {
            await firstValueFrom(
                this.httpService.post(`${this.apiUrl}/sendMessage`, {
                    chat_id: chatId,
                    text: message.trim(),
                    parse_mode: 'HTML',
                }),
            );
            return true;
        } catch (error) {
            this.logger.error(`Failed to send to ${chatId}: ${error.message}`);
            return false;
        }
    }

    async sendMessage(message: string): Promise<void> {
        // Refresh chat IDs from Telegram API to update DB
        await this.refreshChatIds();

        // Get chat IDs from database (source of truth)
        const subscribers = await this.prisma.telegramSubscriber.findMany({
            where: { isActive: true },
            select: { chatId: true },
        });

        if (subscribers.length === 0) {
            this.logger.warn('No subscribers in database. Send any message to the bot first.');
            return;
        }

        const chatIds = subscribers.map(s => s.chatId);
        const promises = chatIds.map(chatId =>
            this.sendMessageTo(chatId, message)
        );
        await Promise.all(promises);
        this.logger.log(`Sent message to ${chatIds.length} subscribers from DB`);
    }

    // ==================== UTILITY ====================

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ==================== MARKETING REPORTS ====================

    async sendEntitySyncReport(data: {
        accountName: string;
        entityType: string;
        count: number;
        duration: number;
    }) {
        const message = `
🔄 <b>Entity Sync Complete</b>

📊 Account: <b>${data.accountName}</b>
📁 Type: <b>${data.entityType}</b>
✅ Synced: <b>${data.count}</b> items
⏱ Duration: <b>${(data.duration / 1000).toFixed(1)}s</b>
`;
        await this.sendMessage(message);
    }

    async sendInsightsSyncReport(data: {
        accountName: string;
        date: string;
        adsCount: number;
        totalSpend: number;
        totalImpressions: number;
        totalClicks: number;
        totalReach: number;
        currency: string;
    }) {
        const ctr = data.totalImpressions > 0
            ? ((data.totalClicks / data.totalImpressions) * 100).toFixed(2)
            : '0';
        const cpm = data.totalImpressions > 0
            ? ((data.totalSpend / data.totalImpressions) * 1000).toFixed(0)
            : '0';
        const cpc = data.totalClicks > 0
            ? (data.totalSpend / data.totalClicks).toFixed(0)
            : '0';

        const message = `
📈 <b>Insights Sync Complete</b>

📊 Account: <b>${data.accountName}</b>
📅 Date: <b>${data.date}</b>
🎯 Active Ads: <b>${data.adsCount}</b>

💰 <b>Performance Metrics:</b>
• Spend: <b>${data.totalSpend.toLocaleString()} ${data.currency}</b>
• Impressions: <b>${data.totalImpressions.toLocaleString()}</b>
• Reach: <b>${data.totalReach.toLocaleString()}</b>
• Clicks: <b>${data.totalClicks.toLocaleString()}</b>

📊 <b>Key Ratios:</b>
• CTR: <b>${ctr}%</b>
• CPM: <b>${cpm} ${data.currency}</b>
• CPC: <b>${cpc} ${data.currency}</b>
`;
        await this.sendMessage(message);
    }

    async sendDailySummary(data: {
        date: string;
        accountsSynced: number;
        totalSpend: number;
        totalImpressions: number;
        totalClicks: number;
        topAds: Array<{ name: string; spend: number; clicks: number }>;
        currency: string;
    }) {
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

    async sendAlert(title: string, message: string, level: 'info' | 'warning' | 'error' = 'info') {
        const emoji = level === 'error' ? '🚨' : level === 'warning' ? '⚠️' : 'ℹ️';
        await this.sendMessage(`${emoji} <b>${title}</b>\n\n${message}`);
    }
}
