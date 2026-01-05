import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '@n-database/prisma/prisma.module';
import { PgBossModule } from '../../pgboss/pgboss.module';
import { CronController } from './cron.controller';
import { CronSettingsService } from './services/cron-settings.service';
import { CrawlSchedulerService } from './services/cron-scheduler.service';
import { TelegramModule } from '../telegram/telegram.module';

@Module({
  imports: [PrismaModule, ScheduleModule, PgBossModule, TelegramModule],
  controllers: [CronController],
  providers: [CronSettingsService, CrawlSchedulerService],
  exports: [CronSettingsService, CrawlSchedulerService],
})
export class CronModule {}

