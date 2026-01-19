import { IsString, IsArray, IsInt, IsBoolean, Min, Max } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpsertCronSettingDto {
    @ApiProperty({ example: 'insights_hour' })
    @IsString()
    cronType: string;

    @ApiProperty({ example: [7, 12, 18], type: [Number] })
    @IsArray()
    @IsInt({ each: true })
    @Min(0, { each: true })
    @Max(23, { each: true })
    allowedHours: number[];

    @ApiProperty({ example: true })
    @IsBoolean()
    enabled: boolean;
}
