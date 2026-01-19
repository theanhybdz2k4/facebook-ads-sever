import { Controller, Get, Post, Body, Param, Delete, UseGuards, ParseIntPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@n-modules/auth/guards/jwt-auth.guard';
import { CurrentUser } from '@n-modules/shared/decorators/current-user.decorator';
import { TelegramService } from './telegram.service';
import { UpsertTelegramBotDto, UpsertBotSettingsDto } from './dtos/upsert-telegram-bot.dto';

@ApiTags('Telegram Bots')
@Controller('telegram/bots')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class TelegramController {
  constructor(private readonly telegramService: TelegramService) {}

  @Get()
  @ApiOperation({ summary: 'Get all telegram bots for user' })
  async getBots(@CurrentUser('id') userId: number) {
    return this.telegramService.getBots(userId);
  }

  @Post()
  @ApiOperation({ summary: 'Upsert a telegram bot' })
  async upsertBot(
    @CurrentUser('id') userId: number,
    @Body() dto: UpsertTelegramBotDto,
  ) {
    return this.telegramService.upsertBot(userId, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a telegram bot' })
  async deleteBot(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser('id') userId: number,
  ) {
    return this.telegramService.deleteBot(id, userId);
  }

  @Get(':botId/settings')
  @ApiOperation({ summary: 'Get notification settings for a bot' })
  async getBotSettings(
    @Param('botId', ParseIntPipe) botId: number,
    @CurrentUser('id') userId: number,
  ) {
    return this.telegramService.getBotSettings(botId, userId);
  }

  @Post(':botId/settings')
  @ApiOperation({ summary: 'Upsert notification settings for a bot' })
  async upsertBotSettings(
    @Param('botId', ParseIntPipe) botId: number,
    @CurrentUser('id') userId: number,
    @Body() dto: UpsertBotSettingsDto,
  ) {
    return this.telegramService.upsertBotSettings(botId, userId, dto);
  }

  @Post(':botId/test')
  @ApiOperation({ summary: 'Send test message to bot subscribers' })
  async testBot(
    @Param('botId', ParseIntPipe) botId: number,
    @CurrentUser('id') userId: number,
  ) {
    return this.telegramService.sendTestMessage(botId, userId);
  }
}
