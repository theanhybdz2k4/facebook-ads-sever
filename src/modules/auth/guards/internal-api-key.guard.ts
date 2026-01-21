import { Injectable, CanActivate, ExecutionContext, ForbiddenException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Guard for internal API routes (n8n, cron jobs)
 * Validates x-internal-api-key header against INTERNAL_API_KEY env variable
 */
@Injectable()
export class InternalApiKeyGuard implements CanActivate {
    constructor(private readonly configService: ConfigService) { }

    canActivate(context: ExecutionContext): boolean {
        const request = context.switchToHttp().getRequest();
        const apiKey = request.headers['x-internal-api-key'];
        const expectedKey = this.configService.get<string>('INTERNAL_API_KEY');

        if (!expectedKey) {
            Logger.error('Internal API key not configured in environment (INTERNAL_API_KEY)');
            throw new ForbiddenException('Internal API key not configured');
        }

        if (!apiKey || apiKey !== expectedKey) {
            Logger.warn(`Invalid internal API key attempt. Received: "${apiKey}", Expected: "${expectedKey}"`);
            throw new ForbiddenException('Invalid internal API key');
        }

        return true;
    }
}
