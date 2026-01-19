import { Module } from '@nestjs/common';
import { PrismaModule } from '@n-database/prisma/prisma.module';
import { TelegramService } from './telegram.service';
import { TelegramController } from './telegram.controller';

@Module({
    imports: [PrismaModule],
    controllers: [TelegramController],
    providers: [TelegramService],
    exports: [TelegramService],
})
export class TelegramModule { }
