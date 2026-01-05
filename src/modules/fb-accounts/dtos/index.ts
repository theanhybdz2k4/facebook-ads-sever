import { IsString, IsOptional, IsBoolean } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AddFbAccountDto {
    @ApiProperty({ description: 'Facebook access token' })
    @IsString()
    accessToken: string;

    @ApiPropertyOptional({ description: 'Name for this FB account' })
    @IsOptional()
    @IsString()
    name?: string;
}

export class AddTokenDto {
    @ApiProperty({ description: 'Facebook access token' })
    @IsString()
    accessToken: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    name?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsBoolean()
    isDefault?: boolean;
}

