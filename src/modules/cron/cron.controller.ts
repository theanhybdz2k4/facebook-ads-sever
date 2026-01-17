import { Controller, Get, Post, Put, Delete, Param, Body, UseGuards, BadRequestException, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CronSettingsService, CreateCronSettingDto, UpdateCronSettingDto, CronType } from './services/cron-settings.service';
import { CurrentUser } from '../shared/decorators/current-user.decorator';

@ApiTags('Cron Settings')
@Controller('cron')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class CronController {
    constructor(private readonly cronSettingsService: CronSettingsService) { }

    @Get('settings')
    @ApiOperation({ summary: 'Get all cron settings for user' })
    async getSettings(@CurrentUser() user: any) {
        const settings = await this.cronSettingsService.getSettings(user.id);
        const adAccountCount = await this.cronSettingsService.getAdAccountCount(user.id);
        return { settings, adAccountCount };
    }

    @Get('settings/:cronType')
    @ApiOperation({ summary: 'Get specific cron setting' })
    async getSetting(
        @CurrentUser() user: any,
        @Param('cronType') cronType: string,
    ) {
        return this.cronSettingsService.getSetting(user.id, cronType);
    }

    @Post('settings')
    @ApiOperation({ summary: 'Create or update a cron setting (upsert)' })
    async createSetting(
        @CurrentUser() user: any,
        @Body() dto: { cronType: string; allowedHours: number[]; enabled?: boolean },
    ) {
        // Validate cronType
        const validCronTypes: CronType[] = [
            'insight', 
            'insight_daily', 
            'insight_device', 
            'insight_placement', 
            'insight_age_gender', 
            'insight_region', 
            'insight_hourly', 
            'ads', 
            'adset', 
            'campaign', 
            'creative', 
            'ad_account', 
            'full'
        ];
        if (!validCronTypes.includes(dto.cronType as CronType)) {
            throw new BadRequestException(`Invalid cronType. Must be one of: ${validCronTypes.join(', ')}`);
        }
        
        const createDto: CreateCronSettingDto = {
            cronType: dto.cronType as CronType,
            allowedHours: dto.allowedHours,
            enabled: dto.enabled,
        };
        
        // Use upsert instead of create - automatically update if exists, create if not
        return this.cronSettingsService.upsertSetting(user.id, createDto);
    }

    @Put('settings/:cronType')
    @ApiOperation({ summary: 'Update an existing cron setting' })
    async updateSetting(
        @CurrentUser() user: any,
        @Param('cronType') cronType: string,
        @Body() dto: { allowedHours?: number[]; enabled?: boolean },
    ) {
        // Validate cronType
        const validCronTypes: CronType[] = [
            'insight', 
            'insight_daily', 
            'insight_device', 
            'insight_placement', 
            'insight_age_gender', 
            'insight_region', 
            'insight_hourly', 
            'ads', 
            'adset', 
            'campaign', 
            'creative', 
            'ad_account', 
            'full'
        ];
        if (!validCronTypes.includes(cronType as CronType)) {
            throw new BadRequestException(`Invalid cronType. Must be one of: ${validCronTypes.join(', ')}`);
        }

        const updateDto: UpdateCronSettingDto = {
            allowedHours: dto.allowedHours,
            enabled: dto.enabled,
        };

        return this.cronSettingsService.updateSetting(user.id, cronType, updateDto);
    }

    @Delete('settings/:cronType')
    @ApiOperation({ summary: 'Delete cron setting' })
    async deleteSetting(
        @CurrentUser() user: any,
        @Param('cronType') cronType: string,
    ) {
        return this.cronSettingsService.deleteSetting(user.id, cronType);
    }

    @Get('settings/estimated-calls')
    @ApiOperation({ summary: 'Get estimated API calls for user configuration' })
    async getEstimatedApiCalls(@CurrentUser() user: any) {
        return this.cronSettingsService.getEstimatedApiCalls(user.id);
    }
}

