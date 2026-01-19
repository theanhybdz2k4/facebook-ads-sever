import { Module, Global } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '@n-database/prisma/prisma.module';
import { RateLimiterService } from './services/rate-limiter.service';
import { BulkUpsertService } from './services/bulk-upsert.service';
import { RateLimitGuard } from './guards/rate-limit.guard';
import { HealthController } from './health/health.controller';

@Global()
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    HttpModule.register({
      timeout: 60000,
      maxRedirects: 5,
    }),
  ],
  controllers: [HealthController],
  providers: [RateLimiterService, RateLimitGuard, BulkUpsertService],
  exports: [RateLimiterService, RateLimitGuard, PrismaModule, HttpModule, BulkUpsertService],
})
export class SharedModule { }
