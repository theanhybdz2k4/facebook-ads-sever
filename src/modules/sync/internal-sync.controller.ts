import { Controller, Post, UseGuards, Logger, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiSecurity, ApiProperty } from '@nestjs/swagger';
import { InternalApiKeyGuard } from '@n-modules/auth/guards/internal-api-key.guard';
import { DispatchService } from './dispatch.service';

class DispatchDto {
    @ApiProperty({ required: false })
    dateStart?: string;

    @ApiProperty({ required: false })
    dateEnd?: string;
}

@ApiTags('Internal (n8n)')
@Controller('internal/n8n')
@UseGuards(InternalApiKeyGuard)
@ApiSecurity('x-internal-api-key')
export class InternalSyncController {
    private readonly logger = new Logger(InternalSyncController.name);

    constructor(private readonly dispatchService: DispatchService) { }

    @Post('dispatch')
    @ApiOperation({ summary: 'Dispatch sync jobs for the current hour based on user cron settings' })
    async dispatch(@Body() body: DispatchDto) {
        this.logger.log(`Received dispatch request from n8n${body.dateStart ? ` for range ${body.dateStart} - ${body.dateEnd}` : ''}`);
        const results = await this.dispatchService.dispatch(body.dateStart, body.dateEnd);
        return {
            success: true,
            timestamp: new Date().toISOString(),
            dispatched: results.length,
            results,
        };
    }
}
