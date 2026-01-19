import { IsString, IsOptional, IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateUserBotSettingDto {
    @ApiProperty({ example: 'bot_token_abc' })
    @IsString()
    @IsOptional()
    telegramBotToken?: string;

    @ApiProperty({ example: 'chat_id_123' })
    @IsString()
    @IsOptional()
    telegramChatId?: string;

    @ApiProperty({ example: true })
    @IsBoolean()
    @IsOptional()
    notiEnabled?: boolean;
}
