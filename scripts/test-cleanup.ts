
import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
import { CrawlJobService } from './src/modules/jobs/services/crawl-job.service';

async function bootstrap() {
    const app = await NestFactory.createApplicationContext(AppModule);
    const crawlJobService = app.get(CrawlJobService);

    console.log('Testing cleanupOldJobs...');
    const result = await crawlJobService.cleanupOldJobs();
    console.log('Cleanup result:', result);

    await app.close();
}

bootstrap();
