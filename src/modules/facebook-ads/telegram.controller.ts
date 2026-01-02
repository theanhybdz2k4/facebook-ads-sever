import { Controller, Post, Body, Get, Logger, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { TelegramService } from './services/telegram.service';

@ApiTags('Telegram Webhook')
@Controller('telegram')
export class TelegramController {
    private readonly logger = new Logger(TelegramController.name);

    constructor(private readonly telegramService: TelegramService) { }

    /**
     * Webhook endpoint for Telegram Bot updates
     * Telegram will send POST requests to this endpoint
     */
    @Post('webhook')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Receive Telegram webhook updates' })
    async handleWebhook(@Body() update: any): Promise<string> {
        try {
            this.logger.log(`Received webhook update: ${JSON.stringify(update).substring(0, 200)}`);
            // Process update in background, don't await
            this.telegramService.processUpdate(update).catch(err => {
                this.logger.error(`Error processing update: ${err.message}`);
            });
            return 'OK';
        } catch (error) {
            this.logger.error(`Error in webhook handler: ${error.message}`);
            // Always return OK to Telegram to prevent retries
            return 'OK';
        }
    }

    /**
     * Register webhook with Telegram
     * Call this endpoint to set up the webhook URL
     */
    @Get('register-webhook')
    @ApiOperation({ summary: 'Register Telegram webhook URL' })
    async registerWebhook(@Query('url') webhookUrl: string) {
        if (!webhookUrl) {
            return {
                success: false,
                message: 'Please provide webhook URL as query parameter: ?url=https://your-domain.com/api/telegram/webhook',
            };
        }

        const result = await this.telegramService.setWebhook(webhookUrl);
        return result;
    }

    /**
     * Get current webhook info
     */
    @Get('webhook-info')
    @ApiOperation({ summary: 'Get current Telegram webhook info' })
    async getWebhookInfo() {
        return await this.telegramService.getWebhookInfo();
    }

    /**
     * Delete webhook (switch back to polling)
     */
    @Get('delete-webhook')
    @ApiOperation({ summary: 'Delete Telegram webhook' })
    async deleteWebhook() {
        return await this.telegramService.deleteWebhook();
    }
}
