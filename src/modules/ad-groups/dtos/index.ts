import { IsString, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SyncAdsetsDto {
    @ApiProperty({ description: 'Ad Account ID' })
    @IsString()
    accountId: string;

    @ApiPropertyOptional({ description: 'Campaign ID (optional)' })
    @IsOptional()
    @IsString()
    campaignId?: string;
}

