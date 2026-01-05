import { IsString, IsOptional, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SyncAdAccountsDto {
    @ApiProperty({ description: 'FB Account ID' })
    @IsString()
    fbAccountId: string;
}

