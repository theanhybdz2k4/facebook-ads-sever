import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { CampaignsSyncService } from '../campaigns/campaigns-sync.service';
import { AdsSyncService } from '../ads/services/ads-sync.service';
import { InsightsSyncService } from '../insights/services/insights-sync.service';
import { TelegramService } from '../telegram/telegram.service';

@Injectable()
export class DispatchService {
  private readonly logger = new Logger(DispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly campaignsSync: CampaignsSyncService,
    private readonly adsSync: AdsSyncService,
    private readonly insightsSync: InsightsSyncService,
    private readonly telegramService: TelegramService,
  ) {}

  async dispatch() {
    const now = new Date();
    const currentHour = now.getHours();
    this.logger.log(`Dispatching sync jobs for hour: ${currentHour}`);

    const cronSettings = await this.prisma.cronSetting.findMany({
      where: {
        enabled: true,
        allowedHours: { has: currentHour },
      },
      include: { user: true },
    });

    const results = [];
    for (const setting of cronSettings) {
      try {
        const userResults = await this.processUserSync(setting.userId, setting.cronType);
        results.push({ userId: setting.userId, cronType: setting.cronType, ...userResults });

        // Send Telegram notification if enabled
        if (setting.cronType === 'insight' || setting.cronType === 'insight_hour') {
          await this.sendTelegramReport(setting.userId, userResults);
        }
      } catch (error) {
        this.logger.error(`Failed to dispatch for user ${setting.userId}: ${error.message}`);
      }
    }

    return results;
  }

  private async processUserSync(userId: number, cronType: string) {
    const accounts = await this.prisma.platformAccount.findMany({
      where: { identity: { userId }, accountStatus: 'ACTIVE' },
      include: { platform: true },
    });

    const summary = {
      accounts: accounts.length,
      items: 0,
      errors: 0,
    };

    for (const account of accounts) {
      try {
        let campaignsSynced = false;
        if (cronType === 'campaign' || cronType === 'full') {
          await this.campaignsSync.syncByAccount(account.id, false, true); // skip update
          campaignsSynced = true;
        }
        if (cronType === 'ads' || cronType === 'full') {
          await this.adsSync.syncByAccount(account.id);
        }
        
        // Update syncedAt if we did at least campaigns
        if (campaignsSynced) {
          await this.prisma.platformAccount.update({
            where: { id: account.id },
            data: { syncedAt: new Date() }
          });
        }

        if (cronType === 'insight' || cronType === 'insight_hour' || cronType === 'full') {
          const res = await this.insightsSync.syncAccountInsights(account.id, this.getYesterday(), this.getToday());
          summary.items += res.count;
        }
      } catch (err) {
        summary.errors++;
        this.logger.error(`Error syncing account ${account.id}: ${err.message}`);
      }
    }

    return summary;
  }

  private async sendTelegramReport(userId: number, results: any) {
    const message = `📊 *Sync Report*\n\n` +
      `📅 Time: ${new Date().toLocaleString('vi-VN')}\n` +
      `✅ Accounts: ${results.accounts}\n` +
      `📈 Insights: ${results.items} items\n` +
      `⚠️ Errors: ${results.errors}\n\n` +
      `#AAMS #SyncStatus`;

    await this.telegramService.sendMessage(userId, message, 'Markdown');
  }

  private getToday() {
    return new Date().toISOString().split('T')[0];
  }

  private getYesterday() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().split('T')[0];
  }
}
