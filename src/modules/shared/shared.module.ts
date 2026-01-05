import { Module, Global } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '@n-database/prisma/prisma.module';
import { RateLimiterService } from './services/rate-limiter.service';
import { FacebookApiService } from './services/facebook-api.service';
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
  providers: [RateLimiterService, FacebookApiService, RateLimitGuard],
  exports: [RateLimiterService, FacebookApiService, RateLimitGuard],
})
export class SharedModule {}

