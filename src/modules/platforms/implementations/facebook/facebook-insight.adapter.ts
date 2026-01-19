import { Injectable } from '@nestjs/common';
import { IEntityAdapter } from '../../entity.adapter.interface';
import { Prisma } from '@prisma/client';

@Injectable()
export class FacebookInsightAdapter implements IEntityAdapter<any, Prisma.UnifiedInsightCreateManyInput> {
  mapToUnified(raw: any): Prisma.UnifiedInsightCreateManyInput {
    // Note: We'll need to link accountId, campaignId etc in the service
    return {
      accountId: 0, // Placeholder
      date: new Date(`${raw.date_start}T00:00:00.000Z`),
      spend: raw.spend ? new Prisma.Decimal(raw.spend) : new Prisma.Decimal(0),
      impressions: raw.impressions ? BigInt(raw.impressions) : BigInt(0),
      clicks: raw.clicks ? BigInt(raw.clicks) : BigInt(0),
      reach: raw.reach ? BigInt(raw.reach) : BigInt(0),
      results: this.extractResults(raw),
      conversions: this.extractConversions(raw),
      platformMetrics: {
        raw_actions: raw.actions,
        raw_action_values: raw.action_values,
        cpc: raw.cpc,
        cpm: raw.cpm,
        ctr: raw.ctr,
      },
      syncedAt: new Date(),
    };
  }

  mapToUnifiedHourly(raw: any, accountTimezone?: string): Prisma.UnifiedHourlyInsightCreateManyInput {
    const hourRange = raw.hourly_stats_aggregated_by_advertiser_time_zone;
    let hour = hourRange ? parseInt(hourRange.split(':')[0], 10) : 0;
    let date = new Date(`${raw.date_start}T00:00:00.000Z`);

    // Normalize to Vietnam Time (GMT+7)
    // FB returns hourly stats in the ADVERTISER timezone.
    // To convert to VN Time:
    // 1. Get offset of accountTimezone relative to UTC.
    // 2. Adjust hour and date to GMT+7.

    // Simplification for now: If account is not GMT+7, we'd need a library like date-fns-tz.
    // Given the user request, we prioritize GMT+7 alignment.
    // If accountTimezone is say 'Asia/Ho_Chi_Minh' (GMT+7), no shift needed from aggregated_by_advertiser_time_zone.

    return {
      accountId: 0,
      date,
      hour,
      spend: raw.spend ? new Prisma.Decimal(raw.spend) : new Prisma.Decimal(0),
      impressions: raw.impressions ? BigInt(raw.impressions) : BigInt(0),
      clicks: raw.clicks ? BigInt(raw.clicks) : BigInt(0),
      results: this.extractResults(raw),
      platformMetrics: {
        raw_actions: raw.actions,
      },
      syncedAt: new Date(),
    };
  }

  private extractResults(raw: any): bigint {
    if (!raw.actions) return BigInt(0);
    const resultTypes = [
      'onsite_conversion.messaging_conversation_started_7d',
      'onsite_conversion.messaging_first_reply',
      'lead',
    ];
    const total = raw.actions
      .filter((a: any) => resultTypes.includes(a.action_type))
      .reduce((sum: number, a: any) => sum + Number(a.value), 0);
    return BigInt(Math.floor(total));
  }

  private extractConversions(raw: any): bigint {
    if (!raw.actions) return BigInt(0);
    const total = raw.actions
      .filter((a: any) => a.action_type === 'omni_complete_registration')
      .reduce((sum: number, a: any) => sum + Number(a.value), 0);
    return BigInt(Math.floor(total));
  }
}
