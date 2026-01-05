import { IsString, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SyncCampaignsDto {
    @ApiProperty({ description: 'Ad Account ID' })
    @IsString()
    accountId: string;
}

