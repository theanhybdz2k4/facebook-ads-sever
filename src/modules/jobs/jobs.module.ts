import { Module } from '@nestjs/common';
import { PrismaModule } from '@n-database/prisma/prisma.module';
import { JobsController } from './jobs.controller';
import { JobsService } from './services/jobs.service';
import { CrawlJobService } from './services/crawl-job.service';

@Module({
  imports: [PrismaModule],
  controllers: [JobsController],
  providers: [JobsService, CrawlJobService],
  exports: [CrawlJobService, JobsService],
})
export class JobsModule {}

