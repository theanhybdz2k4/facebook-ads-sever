import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { PrismaService } from '@n-database/prisma/prisma.service';

@ApiTags('Health')
@Controller('health')
export class HealthController {
    constructor(private readonly prisma: PrismaService) { }

    @Get()
    @ApiOperation({ summary: 'Health check endpoint' })
    async health() {
        try {
            // Check database connectivity
            await this.prisma.$queryRaw`SELECT 1`;
            
            return {
                status: 'ok',
                timestamp: new Date().toISOString(),
                database: 'connected',
            };
        } catch (error) {
            return {
                status: 'error',
                timestamp: new Date().toISOString(),
                database: 'disconnected',
                error: error.message,
            };
        }
    }
}

