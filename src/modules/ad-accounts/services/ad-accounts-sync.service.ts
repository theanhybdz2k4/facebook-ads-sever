import { Injectable, Logger, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { FacebookApiService } from '../../shared/services/facebook-api.service';
import { TokensService } from '../../tokens/services/tokens.service';
import { CrawlJobService } from '../../jobs/services/crawl-job.service';
import { CrawlJobType } from '@prisma/client';

@Injectable()
export class AdAccountsSyncService {
    private readonly logger = new Logger(AdAccountsSyncService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly facebookApi: FacebookApiService,
        private readonly tokensService: TokensService,
        private readonly crawlJobService: CrawlJobService,
    ) { }

    /**
     * Sync ad accounts for a FB account
     */
    async syncAdAccounts(fbAccountId: number, userId: number) {
        // Verify ownership
        const fbAccount = await this.prisma.fbAccount.findFirst({
            where: { id: fbAccountId, userId },
            include: { tokens: { where: { isDefault: true, isValid: true } } },
        });

        if (!fbAccount) {
            throw new ForbiddenException('FB account not found or access denied');
        }

        const token = fbAccount.tokens[0];
        if (!token) {
            throw new BadRequestException('No valid default token for this FB account');
        }

        this.logger.log('Syncing ad accounts...');
        const accounts = await this.facebookApi.getAdAccounts(token.accessToken);
        const now = new Date();

        // Batch upsert all accounts in single transaction
        if (accounts.length > 0) {
            await this.prisma.$transaction(
                accounts.map((account) =>
                    this.prisma.adAccount.upsert({
                        where: { id: account.id },
                        create: {
                            id: account.id,
                            fbAccountId,
                            name: account.name,
                            accountStatus: account.account_status || 1,
                            currency: account.currency || 'USD',
                            syncedAt: now,
                        },
                        update: {
                            fbAccountId,
                            name: account.name,
                            accountStatus: account.account_status || 1,
                            currency: account.currency || 'USD',
                            syncedAt: now,
                        },
                    })
                )
            );
        }

        this.logger.log(`Synced ${accounts.length} ad accounts`);
        return accounts.length;
    }

    /**
     * Map Facebook API ad account data to Prisma format
     */
    private mapAdAccount(account: any, fbAccountId: number, now: Date) {
        return {
            id: account.id,
            fbAccountId,
            name: account.name,
            accountStatus: account.account_status || 1,
            age: account.age,
            amountSpent: account.amount_spent,
            balance: account.balance,
            businessId: account.business?.id,
            businessName: account.business?.name,
            currency: account.currency || 'USD',
            timezoneName: account.timezone_name,
            timezoneOffsetHoursUtc: account.timezone_offset_hours_utc,
            disableReason: account.disable_reason,
            fundingSource: account.funding_source,
            minCampaignGroupSpendCap: account.min_campaign_group_spend_cap,
            minDailyBudget: account.min_daily_budget,
            spendCap: account.spend_cap,
            owner: account.owner,
            isPrepayAccount: account.is_prepay_account,
            createdTime: account.created_time ? new Date(account.created_time) : null,
            endAdvertiser: account.end_advertiser,
            endAdvertiserName: account.end_advertiser_name,
            rawJson: account,
            syncedAt: now,
        };
    }
}

