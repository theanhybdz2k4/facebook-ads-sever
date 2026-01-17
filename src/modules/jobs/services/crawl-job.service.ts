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
     * Complete job successfully - DELETE it to keep DB clean
     */
    async completeJob(jobId: number, totalRecords: number) {
        try {
            return await this.prisma.crawlJob.delete({
                where: { id: jobId },
            });
        } catch (error) {
            // In case it was already deleted or doesn't exist
            this.logger.warn(`Could not delete completed job ${jobId}: ${error.message}`);
            return null;
        }
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
     * Get recent jobs for a user (filter by account ownership)
     */
    async getRecentJobsForUser(userId: number, limit = 50) {
        return this.prisma.crawlJob.findMany({
            where: {
                account: {
                    fbAccount: { userId },
                },
            },
            orderBy: { createdAt: 'desc' },
            take: limit,
            include: {
                account: {
                    select: {
                        id: true,
                        name: true,
                    },
                },
            },
        });
    }

    /**
     * Get job by ID (with ownership check)
     */
    async getJobById(jobId: number, userId: number) {
        return this.prisma.crawlJob.findFirst({
            where: {
                id: jobId,
                account: {
                    fbAccount: { userId },
                },
            },
            include: {
                account: {
                    select: {
                        id: true,
                        name: true,
                    },
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
     * Cleanup old crawl jobs - keep only last 24 hours (primarily for FAILED jobs)
     */
    async cleanupOldJobs(): Promise<number> {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - 1); // Only 1 day retention

        const result = await this.prisma.crawlJob.deleteMany({
            where: {
                createdAt: {
                    lt: cutoffDate,
                },
            },
        });

        if (result.count > 0) {
            this.logger.log(`Cleaned up ${result.count} old crawl jobs (keeping last 24 hours)`);
        }

        return result.count;
    }
}

