import { Controller, Get, Param, Query, ParseIntPipe, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { JobsService } from './services/jobs.service';
import { CurrentUser } from '../shared/decorators/current-user.decorator';

@ApiTags('Jobs')
@Controller('jobs')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class JobsController {
    constructor(private readonly jobsService: JobsService) { }

    @Get()
    @ApiOperation({ summary: 'List recent crawl jobs' })
    async getJobs(
        @CurrentUser() user: any,
        @Query('limit') limit?: string,
    ) {
        const limitNum = limit ? parseInt(limit, 10) : 50;
        return this.jobsService.getJobs(user.id, limitNum);
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get job details' })
    async getJob(
        @Param('id', ParseIntPipe) id: number,
        @CurrentUser() user: any,
    ) {
        return this.jobsService.getJob(id, user.id);
    }
}

