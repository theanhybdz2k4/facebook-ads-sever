import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { CrawlJobStatus, CrawlJobType } from '@prisma/client';

@Injectable()
export class CrawlJobService {
    private readonly logger = new Logger(CrawlJobService.name);

    constructor(private readonly prisma: PrismaService) { }

    /**
     * Create a new crawl job
     */
    async createJob(data: {
        accountId: string;
        jobType: CrawlJobType;
        dateStart?: Date;
        dateEnd?: Date;
        breakdown?: string;
        level?: string;
    }) {
        return this.prisma.crawlJob.create({
            data: {
                accountId: data.accountId,
                jobType: data.jobType,
                status: CrawlJobStatus.PENDING,
                dateStart: data.dateStart,
                dateEnd: data.dateEnd,
                breakdown: data.breakdown,
                level: data.level,
            },
        });
    }

    /**
     * Update job to running
     */
    async startJob(jobId: number) {
        return this.prisma.crawlJob.update({
            where: { id: jobId },
            data: {
                status: CrawlJobStatus.RUNNING,
                startedAt: new Date(),
            },
        });
    }

    /**
     * Update job progress
     */
    async updateProgress(jobId: number, processedRecords: number, totalRecords?: number) {
        return this.prisma.crawlJob.update({
            where: { id: jobId },
            data: {
                processedRecords,
                ...(totalRecords && { totalRecords }),
            },
        });
    }

    /**
     * Complete job successfully
     */
    async completeJob(jobId: number, totalRecords: number) {
        return this.prisma.crawlJob.update({
            where: { id: jobId },
            data: {
                status: CrawlJobStatus.COMPLETED,
                completedAt: new Date(),
                totalRecords,
                processedRecords: totalRecords,
            },
        });
    }

    /**
     * Mark job as failed
     */
    async failJob(jobId: number, errorMessage: string, errorCode?: string) {
        return this.prisma.crawlJob.update({
            where: { id: jobId },
            data: {
                status: CrawlJobStatus.FAILED,
                completedAt: new Date(),
                errorMessage,
                errorCode,
                retryCount: { increment: 1 },
            },
        });
    }

    /**
     * Get recent jobs
     */
    async getRecentJobs(limit = 50) {
        return this.prisma.crawlJob.findMany({
            orderBy: { createdAt: 'desc' },
            take: limit,
            include: {
                account: {
                    select: { id: true, name: true },
                },
            },
        });
    }

    /**
     * Get job by ID
     */
    async getJob(jobId: number) {
        return this.prisma.crawlJob.findUnique({
            where: { id: jobId },
            include: {
                account: {
                    select: { id: true, name: true },
                },
            },
        });
    }

    /**
     * Check if there's a running job for account and type
     */
    async hasRunningJob(accountId: string, jobType: CrawlJobType): Promise<boolean> {
        const job = await this.prisma.crawlJob.findFirst({
            where: {
                accountId,
                jobType,
                status: CrawlJobStatus.RUNNING,
            },
        });
        return !!job;
    }

    /**
     * Cleanup old crawl jobs - keep only last 7 days
     * This prevents database from growing too large for Supabase free tier
     */
    async cleanupOldJobs(): Promise<number> {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - 7);

        const result = await this.prisma.crawlJob.deleteMany({
            where: {
                createdAt: {
                    lt: cutoffDate,
                },
            },
        });

        if (result.count > 0) {
            this.logger.log(`Cleaned up ${result.count} old crawl jobs (keeping last 7 days)`);
        }

        return result.count;
    }
}
