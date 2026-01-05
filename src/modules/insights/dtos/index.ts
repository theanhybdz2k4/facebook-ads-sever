import { IsString, IsOptional, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SyncInsightsDto {
    @ApiPropertyOptional({ description: 'Ad Account ID' })
    @IsOptional()
    @IsString()
    accountId?: string;

    @ApiPropertyOptional({ description: 'Ad ID (optional)' })
    @IsOptional()
    @IsString()
    adId?: string;

    @ApiProperty({ description: 'Start date (YYYY-MM-DD)' })
    @IsString()
    dateStart: string;

    @ApiProperty({ description: 'End date (YYYY-MM-DD)' })
    @IsString()
    dateEnd: string;

    @ApiPropertyOptional({ description: 'Breakdown type', enum: ['all', 'device_platform', 'hourly_stats_aggregated_by_advertiser_time_zone'] })
    @IsOptional()
    @IsString()
    breakdown?: string;
}

