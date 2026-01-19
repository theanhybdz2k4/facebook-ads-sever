import { Injectable, Logger } from '@nestjs/common';
import { IEntityAdapter } from '../../entity.adapter.interface';
import { Prisma, UnifiedStatus } from '@prisma/client';

@Injectable()
export class FacebookAdGroupAdapter implements IEntityAdapter<any, Prisma.UnifiedAdGroupCreateManyInput> {
  private readonly logger = new Logger(FacebookAdGroupAdapter.name);
  mapToUnified(raw: any): Prisma.UnifiedAdGroupCreateManyInput {
    return {
      campaignId: '', // To be linked in service
      accountId: 0,   // To be linked in service
      externalId: raw.id,
      name: raw.name,
      status: this.mapStatus(raw.effective_status || raw.status),
      dailyBudget: raw.daily_budget ? new Prisma.Decimal(Number(raw.daily_budget) / 100) : null,
      optimizationGoal: raw.optimization_goal,
      effectiveStatus: raw.effective_status,
      platformData: {
        targeting: raw.targeting,
        bid_amount: raw.bid_amount,
        billing_event: raw.billing_event,
        optimization_goal: raw.optimization_goal,
      },
      syncedAt: new Date(),
    };
  }

  private mapStatus(status: string): UnifiedStatus {
    const statusMap: Record<string, UnifiedStatus> = {
      'ACTIVE': UnifiedStatus.ACTIVE,
      'PAUSED': UnifiedStatus.PAUSED,
      'ARCHIVED': UnifiedStatus.ARCHIVED,
      'DELETED': UnifiedStatus.DELETED,
      'IN_PROCESS': UnifiedStatus.ACTIVE,
      'WITH_ISSUES': UnifiedStatus.PAUSED,
    };
    
    const mapped = statusMap[status];
    if (!mapped) {
      this.logger.warn(`Unknown Facebook ad group status: ${status}. Mapping to UNKNOWN.`);
      return UnifiedStatus.UNKNOWN;
    }
    return mapped;
  }
}
