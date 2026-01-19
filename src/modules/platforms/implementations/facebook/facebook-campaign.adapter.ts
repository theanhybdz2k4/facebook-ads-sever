import { Injectable, Logger } from '@nestjs/common';
import { IEntityAdapter } from '../../entity.adapter.interface';
import { Prisma, UnifiedStatus } from '@prisma/client';

export type UnifiedCampaignCreateInput = Omit<Prisma.UnifiedCampaignCreateInput, 'account'>;

@Injectable()
export class FacebookCampaignAdapter implements IEntityAdapter<any, UnifiedCampaignCreateInput> {
  private readonly logger = new Logger(FacebookCampaignAdapter.name);
  mapToUnified(raw: any): UnifiedCampaignCreateInput {
    return {
      externalId: raw.id,
      name: raw.name,
      status: this.mapStatus(raw.effective_status || raw.status),
      objective: raw.objective,
      dailyBudget: raw.daily_budget ? new Prisma.Decimal(Number(raw.daily_budget) / 100) : null,
      lifetimeBudget: raw.lifetime_budget ? new Prisma.Decimal(Number(raw.lifetime_budget) / 100) : null,
      startTime: raw.start_time ? new Date(raw.start_time) : null,
      endTime: raw.stop_time ? new Date(raw.stop_time) : null,
      effectiveStatus: raw.effective_status,
      platformData: {
        buying_type: raw.buying_type,
        bid_strategy: raw.bid_strategy,
        issues_info: raw.issues_info,
      },
      syncedAt: new Date(),
    };
  }

  private mapStatus(fbStatus: string): UnifiedStatus {
    const statusMap: Record<string, UnifiedStatus> = {
      'ACTIVE': UnifiedStatus.ACTIVE,
      'PAUSED': UnifiedStatus.PAUSED,
      'DELETED': UnifiedStatus.DELETED,
      'ARCHIVED': UnifiedStatus.ARCHIVED,
      'IN_PROCESS': UnifiedStatus.ACTIVE,
      'WITH_ISSUES': UnifiedStatus.PAUSED,
    };
    const status = statusMap[fbStatus];
    if (!status) {
      this.logger.warn(`Unknown Facebook status: ${fbStatus}. Mapping to UNKNOWN.`);
      return UnifiedStatus.UNKNOWN;
    }
    return status;
  }
}
