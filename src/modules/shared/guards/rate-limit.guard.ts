import { Injectable, CanActivate, ExecutionContext, HttpException, HttpStatus, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export interface RateLimitOptions {
  ttl: number; // Time window in seconds
  limit: number; // Max requests per window
}

export const RATE_LIMIT_KEY = 'rateLimit';

export const RateLimit = (options: RateLimitOptions) => SetMetadata(RATE_LIMIT_KEY, options);

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly requestCounts = new Map<string, { count: number; resetTime: number }>();

  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const options = this.reflector.get<RateLimitOptions>(
      RATE_LIMIT_KEY,
      context.getHandler(),
    );

    if (!options) {
      return true; // No rate limit configured
    }

    const request = context.switchToHttp().getRequest();
    const key = this.getKey(request);
    const now = Date.now();

    const record = this.requestCounts.get(key);

    if (!record || now > record.resetTime) {
      // First request or window expired, reset
      this.requestCounts.set(key, {
        count: 1,
        resetTime: now + options.ttl * 1000,
      });
      return true;
    }

    if (record.count >= options.limit) {
      throw new HttpException(
        {
          message: 'Too many requests, please try again later',
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          errorCode: 'RATE_LIMIT_EXCEEDED',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    record.count++;
    return true;
  }

  private getKey(request: any): string {
    // Use IP address and route path as key
    const ip = request.ip || request.connection?.remoteAddress || 'unknown';
    const path = request.route?.path || request.url;
    return `${ip}:${path}`;
  }
}

