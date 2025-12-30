import { IsString, IsOptional, IsEnum, IsDateString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TokenType } from '@prisma/client';

export class CreateTokenDto {
    @ApiProperty({ description: 'Facebook access token' })
    @IsString()
    accessToken: string;

    @ApiPropertyOptional({ description: 'Account ID to associate with token' })
    @IsOptional()
    @IsString()
    accountId?: string;

    @ApiPropertyOptional({ enum: TokenType })
    @IsOptional()
    @IsEnum(TokenType)
    tokenType?: TokenType;

    @ApiPropertyOptional({ description: 'Token expiration date' })
    @IsOptional()
    @IsDateString()
    expiresAt?: string;
}

export class SyncEntitiesDto {
    @ApiPropertyOptional({ description: 'Ad Account ID (e.g., act_123456)' })
    @IsOptional()
    @IsString()
    accountId?: string;

    @ApiPropertyOptional({ description: 'Campaign ID to sync adsets for' })
    @IsOptional()
    @IsString()
    campaignId?: string;

    @ApiPropertyOptional({ description: 'Adset ID to sync ads for' })
    @IsOptional()
    @IsString()
    adsetId?: string;

    @ApiPropertyOptional({
        enum: ['campaigns', 'adsets', 'ads', 'creatives', 'all'],
        default: 'all',
    })
    @IsOptional()
    @IsString()
    entityType?: 'campaigns' | 'adsets' | 'ads' | 'creatives' | 'all';
}

export class SyncInsightsDto {
    @ApiPropertyOptional({ description: 'Ad Account ID' })
    @IsOptional()
    @IsString()
    accountId?: string;

    @ApiPropertyOptional({ description: 'Ad ID to sync insights for' })
    @IsOptional()
    @IsString()
    adId?: string;

    @ApiProperty({ description: 'Start date (YYYY-MM-DD)' })
    @IsDateString()
    dateStart: string;

    @ApiProperty({ description: 'End date (YYYY-MM-DD)' })
    @IsDateString()
    dateEnd: string;

    @ApiPropertyOptional({
        enum: ['daily', 'device', 'placement', 'age_gender', 'region', 'hourly', 'all'],
        default: 'all',
    })
    @IsOptional()
    @IsString()
    breakdown?: 'daily' | 'device' | 'placement' | 'age_gender' | 'region' | 'hourly' | 'all';
}
