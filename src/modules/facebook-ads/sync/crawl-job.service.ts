import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { SyncJobStatus } from '@prisma/client';

@Injectable()
export class CrawlJobService {
    private readonly logger = new Logger(CrawlJobService.name);

    constructor(private readonly prisma: PrismaService) { }

    /**
     * Tạo job đồng bộ mới
     */
    async createJob(platformAccountId: number, jobType: string) {
        return this.prisma.syncJob.create({
            data: {
                platformAccountId,
                jobType,
                status: SyncJobStatus.PENDING,
            },
        });
    }

    /**
     * Cập nhật trạng thái job
     */
    async updateJobStatus(jobId: number, status: SyncJobStatus, errorMessage?: string) {
        return this.prisma.syncJob.update({
            where: { id: jobId },
            data: {
                status,
                errorMessage,
                startedAt: status === SyncJobStatus.RUNNING ? new Date() : undefined,
                completedAt: (status === SyncJobStatus.COMPLETED || status === SyncJobStatus.FAILED) ? new Date() : undefined,
            },
        });
    }

    /**
     * Lấy danh sách jobs của account
     */
    async getJobsByAccount(platformAccountId: number, limit = 10) {
        return this.prisma.syncJob.findMany({
            where: { platformAccountId },
            orderBy: { createdAt: 'desc' },
            take: limit,
        });
    }

    /**
     * Tìm job đang chạy
     */
    async findActiveJob(platformAccountId: number, jobType: string) {
        return this.prisma.syncJob.findFirst({
            where: {
                platformAccountId,
                jobType,
                status: SyncJobStatus.RUNNING,
            },
        });
    }

    /**
     * Xóa job cũ
     */
    async cleanupOldJobs(days = 7) {
        const date = new Date();
        date.setDate(date.getDate() - days);

        return this.prisma.syncJob.deleteMany({
            where: {
                createdAt: { lt: date },
                status: { in: [SyncJobStatus.COMPLETED, SyncJobStatus.FAILED] },
            },
        });
    }
}
