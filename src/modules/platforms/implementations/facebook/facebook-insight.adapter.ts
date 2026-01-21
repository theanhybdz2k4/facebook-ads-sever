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
    // If we want it in Vietnam Time:
    // hour_vn = (hour_advertiser - offset_advertiser) + 7
    // For now, if we don't have a reliable timezone lib on the server,
    // we assume the account is set to a specific timezone or we keep it as is.
    // However, to fix the "yesterday" issues, we should at least ensure the date is correctly associated.

    // If accountTimezone is present (e.g. '7'), we can adjust.
    // For now, let's keep the date as provided by date_start which is the day in advertiser timezone.

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

  mapToDeviceBreakdown(raw: any, unifiedInsightId: string): Prisma.UnifiedInsightDeviceCreateManyInput {
    return {
      unifiedInsightId,
      device: raw.impression_device || 'unknown',
      impressionDevice: raw.impression_device, // redundant but robust
      spend: raw.spend ? new Prisma.Decimal(raw.spend) : new Prisma.Decimal(0),
      impressions: raw.impressions ? BigInt(raw.impressions) : BigInt(0),
      clicks: raw.clicks ? BigInt(raw.clicks) : BigInt(0),
      results: this.extractResults(raw),
    };
  }

  mapToAgeGenderBreakdown(raw: any, unifiedInsightId: string): Prisma.UnifiedInsightAgeGenderCreateManyInput {
    return {
      unifiedInsightId,
      age: raw.age || 'unknown',
      gender: raw.gender || 'unknown',
      spend: raw.spend ? new Prisma.Decimal(raw.spend) : new Prisma.Decimal(0),
      impressions: raw.impressions ? BigInt(raw.impressions) : BigInt(0),
      clicks: raw.clicks ? BigInt(raw.clicks) : BigInt(0),
      results: this.extractResults(raw),
    };
  }

  mapToRegionBreakdown(raw: any, unifiedInsightId: string): Prisma.UnifiedInsightRegionCreateManyInput {
    return {
      unifiedInsightId,
      region: raw.region || 'unknown',
      country: raw.country || 'unknown',
      spend: raw.spend ? new Prisma.Decimal(raw.spend) : new Prisma.Decimal(0),
      impressions: raw.impressions ? BigInt(raw.impressions) : BigInt(0),
      clicks: raw.clicks ? BigInt(raw.clicks) : BigInt(0),
      results: this.extractResults(raw),
    };
  }

  private extractResults(raw: any): bigint {
    if (!raw.actions) return BigInt(0);
    const resultTypes = [
      'onsite_conversion.messaging_conversation_started_7d',
      'onsite_conversion.messaging_first_reply',
      'lead',
      'purchase',
      'mobile_app_install',
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
