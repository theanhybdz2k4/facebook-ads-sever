import { IsString, IsOptional, IsInt, IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpsertTelegramBotDto {
    @ApiProperty({ example: 'bot_token_abc' })
    @IsString()
    botToken: string;

    @ApiProperty({ example: 'My Ads Bot' })
    @IsString()
    @IsOptional()
    botName?: string;

    @ApiProperty({ example: 123 })
    @IsInt()
    @IsOptional()
    adAccountId?: number;
}

export class UpsertBotSettingsDto {
    @ApiProperty({ example: [7, 12, 18] })
    @IsInt({ each: true })
    allowedHours: number[];

    @ApiProperty({ example: true })
    @IsBoolean()
    @IsOptional()
    enabled?: boolean;
}
