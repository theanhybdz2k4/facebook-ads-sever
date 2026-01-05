import { Injectable, ForbiddenException } from '@nestjs/common';
import { CrawlJobService } from './crawl-job.service';

@Injectable()
export class JobsService {
    constructor(private readonly crawlJobService: CrawlJobService) { }

    async getJobs(userId: number, limit?: number) {
        return this.crawlJobService.getRecentJobsForUser(userId, limit);
    }

    async getJob(jobId: number, userId: number) {
        const job = await this.crawlJobService.getJobById(jobId, userId);
        if (!job) {
            throw new ForbiddenException('Job not found or access denied');
        }
        return job;
    }
}

