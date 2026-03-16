import { Controller, Get, Post, Body, Query, Req, Res, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { VerifyWebhookDto } from '../dto/verify-webhook.dto';
import { MessengerService } from '../services/messenger.service';

@Controller('messenger/webhook')
export class MessengerWebhookController {
    private readonly logger = new Logger(MessengerWebhookController.name);
    private readonly VERIFY_TOKEN: string;

    constructor(
        private readonly configService: ConfigService,
        private readonly messengerService: MessengerService,
    ) {
        this.VERIFY_TOKEN = this.configService.get<string>('FB_WEBHOOK_VERIFY_TOKEN') || 'colorme_webhook_secret';
    }

    @Get()
    verify(@Query() query: VerifyWebhookDto, @Res() res: Response) {
        const mode = query['hub.mode'];
        const token = query['hub.verify_token'];
        const challenge = query['hub.challenge'];

        this.logger.log(`[FB-Webhook] Verification attempt: mode=${mode}, token=${token}`);

        if (mode === 'subscribe' && token === this.VERIFY_TOKEN) {
            this.logger.log('[FB-Webhook] Verification successful!');
            return res.status(200).send(challenge);
        }

        this.logger.error(`[FB-Webhook] Verification failed! Got token "${token}", expected "${this.VERIFY_TOKEN}"`);
        return res.status(403).send('Forbidden');
    }

    @Post()
    async handleEvent(@Body() body: any, @Res() res: Response) {
        this.logger.log('[FB-Webhook] Received webhook event');
        
        // Trả về 200 ngay lập tức để Facebook không retry
        res.status(200).send('EVENT_RECEIVED');

        try {
            if (body.object !== 'page') {
                this.logger.warn(`[FB-Webhook] Ignored non-page object: ${body.object}`);
                return;
            }

            // Logic xử lý sự kiện sẽ được gọi từ MessengerService
            await this.messengerService.processWebhook(body);
            
        } catch (error) {
            this.logger.error(`[FB-Webhook] Error processing event: ${error.message}`);
        }
    }
}
