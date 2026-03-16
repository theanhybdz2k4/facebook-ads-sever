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
    private botId: number | null = null;

    constructor(
        private readonly httpService: HttpService,
        private readonly prisma: PrismaService,
    ) { }

    async onModuleInit() {
        await this.ensureBotInDb();
        await this.loadChatIdsFromDb();
    }

    private async ensureBotInDb() {
        try {
            const bot = await this.prisma.telegramBot.upsert({
                where: { botToken: this.botToken },
                create: { 
                    botToken: this.botToken, 
                    botName: 'FaceBook Ads Bot',
                    userId: 1 // Default root user
                },
                update: { isActive: true }
            });
            this.botId = bot.id;
        } catch (error) {
            this.logger.warn(`Could not ensure bot in DB: ${error.message}`);
        }
    }

    private async loadChatIdsFromDb() {
        try {
            const subscribers = await this.prisma.telegramSubscriber.findMany({
                where: { isActive: true, telegramBotId: this.botId || undefined },
            });
            this.chatIds = new Set(subscribers.map(s => s.chatId));
            this.logger.log(`Loaded ${this.chatIds.size} Telegram subscribers from database`);
        } catch (error) {
            this.logger.warn(`Could not load from DB: ${error.message}`);
        }
    }

    private async saveChatIdToDb(chatId: string, name?: string) {
        if (!this.botId) return;
        try {
            const existing = await this.prisma.telegramSubscriber.findFirst({
                where: { chatId, telegramBotId: this.botId }
            });

            if (existing) {
                await this.prisma.telegramSubscriber.update({
                    where: { id: existing.id },
                    data: { isActive: true, name }
                });
            } else {
                await this.prisma.telegramSubscriber.create({
                    data: { 
                        chatId, 
                        name, 
                        isActive: true, 
                        bot: { connect: { id: this.botId } }
                    },
                });
            }
        } catch (error) {
            this.logger.warn(`Could not save to DB: ${error.message}`);
        }
    }

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
        } catch (error) {
            this.logger.error(`Failed to refresh chat IDs: ${error.message}`);
        }
    }

    async sendMessage(message: string): Promise<void> {
        await this.refreshChatIds();

        const subscribers = await this.prisma.telegramSubscriber.findMany({
            where: { isActive: true, telegramBotId: this.botId || undefined },
            select: { chatId: true },
        });

        if (subscribers.length === 0) return;

        const promises = subscribers.map(s =>
            firstValueFrom(this.httpService.post(`${this.apiUrl}/sendMessage`, {
                chat_id: s.chatId,
                text: message,
                parse_mode: 'HTML',
            })).catch(e => this.logger.error(`Send error: ${e.message}`))
        );
        await Promise.all(promises);
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

    async sendEntitySyncReport(data: any) { /* implementation similar to old */ }
    async sendInsightsSyncReport(data: any) { /* implementation similar to old */ }
}
