import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MessengerWebhookController } from './controllers/messenger-webhook.controller';
import { MessengerCrawlerService } from './crawler/messenger-crawler.service';
import { PrismaModule } from '../../database/prisma/prisma.module';

@Module({
    imports: [ConfigModule, PrismaModule],
    controllers: [MessengerWebhookController],
    providers: [MessengerCrawlerService],
    exports: [MessengerCrawlerService],
})
export class MessengerModule { }
