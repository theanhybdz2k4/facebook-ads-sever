import { Injectable, Logger } from '@nestjs/common';
import { IEntityAdapter } from '../../entity.adapter.interface';
import { Prisma, UnifiedStatus } from '@prisma/client';

@Injectable()
export class FacebookAdAdapter implements IEntityAdapter<any, Prisma.UnifiedAdCreateManyInput> {
  private readonly logger = new Logger(FacebookAdAdapter.name);
  mapToUnified(raw: any): Prisma.UnifiedAdCreateManyInput {
    return {
      adGroupId: '', // To be linked in service
      accountId: 0,  // To be linked in service
      externalId: raw.id,
      name: raw.name,
      status: this.mapStatus(raw.effective_status || raw.status),
      effectiveStatus: raw.effective_status,
      platformData: {
        created_time: raw.created_time,
        updated_time: raw.updated_time,
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
      this.logger.warn(`Unknown Facebook ad status: ${status}. Mapping to UNKNOWN.`);
      return UnifiedStatus.UNKNOWN;
    }
    return mapped;
  }
}
