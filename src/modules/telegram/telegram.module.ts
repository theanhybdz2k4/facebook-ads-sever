import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PrismaModule } from '@n-database/prisma/prisma.module';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './services/telegram.service';

@Module({
  imports: [PrismaModule, HttpModule],
  controllers: [TelegramController],
  providers: [TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}

