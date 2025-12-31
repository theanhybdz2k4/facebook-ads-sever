import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PgBoss } from 'pg-boss';

interface JobData {
    [key: string]: any;
}

interface Job<T = JobData> {
    id: string;
    name: string;
    data: T;
}

interface SendOptions {
    startAfter?: number | Date;
    retryLimit?: number;
    retryDelay?: number;
    retryBackoff?: boolean;
    expireInSeconds?: number;
    expireInMinutes?: number;
    expireInHours?: number;
    keepUntil?: Date | string;
    singletonKey?: string;
    singletonSeconds?: number;
    singletonMinutes?: number;
    singletonHours?: number;
    singletonNextSlot?: boolean;
    priority?: number;
    onComplete?: boolean;
}

@Injectable()
export class PgBossService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(PgBossService.name);
    private boss: PgBoss;

    async onModuleInit() {
        const connectionString = process.env.DATABASE_URL;
        if (!connectionString) {
            throw new Error('DATABASE_URL is not defined');
        }

        this.boss = new PgBoss(connectionString);

        this.boss.on('error', (error: Error) => {
            this.logger.error('PgBoss error:', error);
        });

        await this.boss.start();
        this.logger.log('PgBoss started successfully');

        // Create queues on startup
        await this.createQueue('fb-entity-sync');
        await this.createQueue('fb-insights-sync');
        this.logger.log('PgBoss queues created');
    }

    async onModuleDestroy() {
        if (this.boss) {
            await this.boss.stop();
            this.logger.log('PgBoss stopped');
        }
    }

    async createQueue(name: string): Promise<void> {
        await this.boss.createQueue(name);
    }

    async addJob<T extends object>(
        queueName: string,
        data: T,
        options?: { startAfter?: number; retryLimit?: number },
    ): Promise<string | null> {
        const jobOptions: SendOptions = {};

        if (options?.startAfter) {
            jobOptions.startAfter = options.startAfter;
        }

        if (options?.retryLimit) {
            jobOptions.retryLimit = options.retryLimit;
        }

        return this.boss.send(queueName, data as object, jobOptions);
    }

    async work<T extends object>(
        queueName: string,
        handler: (job: Job<T>) => Promise<void>,
    ): Promise<string> {
        // pg-boss v10+ passes jobs as an array
        return this.boss.work(queueName, async (jobs: any) => {
            // Handle both array (v10+) and single job formats
            const jobList = Array.isArray(jobs) ? jobs : [jobs];
            for (const job of jobList) {
                await handler(job as Job<T>);
            }
        });
    }

    getBoss(): PgBoss {
        return this.boss;
    }
}
