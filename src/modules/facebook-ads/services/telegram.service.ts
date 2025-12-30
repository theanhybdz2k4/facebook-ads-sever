import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '@n-database/prisma/prisma.service';

@Injectable()
export class TelegramService implements OnModuleInit {
    private readonly logger = new Logger(TelegramService.name);
    private readonly botToken = '6799465970:AAEk4TXD6O1n7s35_YsmLaZ2Ak08UBK4tng';
    private readonly apiUrl = `https://api.telegram.org/bot${this.botToken}`;
    private chatIds: Set<string> = new Set();

    constructor(
        private readonly httpService: HttpService,
        private readonly prisma: PrismaService,
    ) { }

    async onModuleInit() {
        // Load chat IDs from database on startup
        await this.loadChatIdsFromDb();
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
                    text: message,
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
