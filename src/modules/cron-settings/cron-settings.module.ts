import { Module } from '@nestjs/common';
import { PrismaModule } from '@n-database/prisma/prisma.module';
import { TelegramModule } from '../telegram/telegram.module';
import { CronSettingsController } from './cron-settings.controller';
import { CronSettingsService } from './cron-settings.service';

@Module({
  imports: [PrismaModule, TelegramModule],
  controllers: [CronSettingsController],
  providers: [CronSettingsService],
  exports: [CronSettingsService],
})
export class CronSettingsModule {}
