import { Controller, Get, Post, Body, Param, Delete, Patch, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@n-modules/auth/guards/jwt-auth.guard';
import { CurrentUser } from '@n-modules/shared/decorators/current-user.decorator';
import { CronSettingsService } from './cron-settings.service';
import { TelegramService } from '../telegram/telegram.service';
import { UpsertCronSettingDto } from './dtos/upsert-cron-setting.dto';
import { UpdateUserBotSettingDto } from './dtos/update-user-bot-setting.dto';

@ApiTags('Cron Settings')
@Controller('cron/settings')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class CronSettingsController {
  constructor(
    private readonly cronSettingsService: CronSettingsService,
    private readonly telegramService: TelegramService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get all cron settings and user info' })
  async getSettings(@CurrentUser('id') userId: number) {
    return this.cronSettingsService.getSettings(userId);
  }

  @Post()
  @ApiOperation({ summary: 'Upsert a cron setting' })
  async upsertSetting(
    @CurrentUser('id') userId: number,
    @Body() dto: UpsertCronSettingDto,
  ) {
    return this.cronSettingsService.upsertSetting(userId, dto);
  }

  @Get('estimated-calls')
  @ApiOperation({ summary: 'Get estimated API calls based on current settings' })
  async getEstimate(@CurrentUser('id') userId: number) {
    return this.cronSettingsService.getEstimate(userId);
  }

  @Delete(':type')
  @ApiOperation({ summary: 'Delete a cron setting' })
  async deleteSetting(
    @CurrentUser('id') userId: number,
    @Param('type') cronType: string,
  ) {
    return this.cronSettingsService.deleteSetting(userId, cronType);
  }

  @Patch('bot')
  @ApiOperation({ summary: 'Update user bot settings for notifications' })
  async updateBotSetting(
    @CurrentUser('id') userId: number,
    @Body() dto: UpdateUserBotSettingDto,
  ) {
    return this.cronSettingsService.updateBotSetting(userId, dto);
  }

  @Post('bot/test')
  @ApiOperation({ summary: 'Test Telegram connection' })
  async testBot(
    @CurrentUser('id') userId: number,
    @Body() dto: { token: string; chatId: string },
  ) {
    return this.telegramService.testConnection(dto.token, dto.chatId);
  }
}
