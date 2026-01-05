import { IsString, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SyncAdsDto {
    @ApiProperty({ description: 'Ad Account ID' })
    @IsString()
    accountId: string;

    @ApiPropertyOptional({ description: 'AdSet ID (optional)' })
    @IsOptional()
    @IsString()
    adsetId?: string;
}

