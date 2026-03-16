import {
    Controller,
    Get,
    Patch,
    Post,
    Body,
    Param,
    Query,
    UseGuards,
    Request,
    HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '@n-modules/auth/guards/jwt-auth.guard';
import { LeadsService } from './leads.service';

@ApiTags('Leads')
@Controller('leads')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class LeadsController {
    constructor(private readonly leadsService: LeadsService) { }

    @Get('stats')
    @ApiOperation({ summary: 'Get lead statistics (Spend, Today Leads, Potential Leads ratio)' })
    @ApiQuery({ name: 'branchId', required: false })
    @ApiQuery({ name: 'accountId', required: false })
    @ApiQuery({ name: 'campaignId', required: false })
    @ApiQuery({ name: 'pageId', required: false })
    @ApiQuery({ name: 'dateStart', required: false })
    @ApiQuery({ name: 'dateEnd', required: false })
    async getStats(@Request() req: any, @Query() filters: any) {
        return this.leadsService.getStats(req.user.id, filters);
    }

    @Get()
    @ApiOperation({ summary: 'List all leads with filters and pagination' })
    @ApiQuery({ name: 'page', required: false })
    @ApiQuery({ name: 'limit', required: false })
    @ApiQuery({ name: 'branchId', required: false })
    @ApiQuery({ name: 'accountId', required: false })
    @ApiQuery({ name: 'pageId', required: false })
    @ApiQuery({ name: 'qualified', required: false })
    @ApiQuery({ name: 'potential', required: false })
    @ApiQuery({ name: 'today', required: false })
    @ApiQuery({ name: 'dateStart', required: false })
    @ApiQuery({ name: 'dateEnd', required: false })
    @ApiQuery({ name: 'assignedId', required: false })
    async findAll(@Request() req: any, @Query() filters: any) {
        // userId from JWT for ownership check
        return this.leadsService.findAll(req.user.id, filters);
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get single lead details' })
    async findOne(@Request() req: any, @Param('id') id: string) {
        return this.leadsService.findOne(id, req.user.id);
    }

    @Patch(':id')
    @ApiOperation({ summary: 'Update lead details' })
    async update(
        @Request() req: any,
        @Param('id') id: string,
        @Body() body: any,
    ) {
        return this.leadsService.update(id, req.user.id, body);
    }

    @Get(':id/messages')
    @ApiOperation({ summary: 'Fetch message history from Facebook' })
    async getMessages(@Request() req: any, @Param('id') id: string) {
        return this.leadsService.getMessageHistory(id, req.user.id);
    }

    @Post(':id/assign')
    @ApiOperation({ summary: 'Assign lead to a user' })
    async assign(
        @Request() req: any,
        @Param('id') id: string,
        @Body('assignedToId') assignedToId: number,
    ) {
        return this.leadsService.assign(id, req.user.id, assignedToId);
    }
}
