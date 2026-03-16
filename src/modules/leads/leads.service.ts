import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@n-database/prisma/prisma.service';
import { FacebookApiService } from '../facebook-ads/api/facebook-api.service';
import { HttpService } from '@nestjs/axios';
import moment from 'moment-timezone';

@Injectable()
export class LeadsService {
    private readonly logger = new Logger(LeadsService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly fbApi: FacebookApiService,
        private readonly httpService: HttpService,
    ) { }

    /**
     * Get Vietnam Day Range for SQL comparison
     */
    private getVnDayRange(date: Date) {
        const start = moment(date).tz('Asia/Ho_Chi_Minh').startOf('day');
        const end = moment(date).tz('Asia/Ho_Chi_Minh').endOf('day');
        return {
            start: start.toISOString(),
            end: end.toISOString(),
            dateStr: start.format('YYYY-MM-DD'),
        };
    }

    /**
     * Get Lead Statistics (Spend, Revenue, Potential Lead Ratio)
     * Ported from Supabase leads/index.ts
     */
    async getStats(userId: number, filters: any) {
        const { branchId, accountId, campaignId, pageId, dateStart, dateEnd, platformCode = 'all' } = filters;

        const now = new Date();
        const todayRange = this.getVnDayRange(now);
        const todayStr = todayRange.dateStr;

        const yesterday = new Date(now.getTime() - 86400000);
        const yesterdayStr = this.getVnDayRange(yesterday).dateStr;

        // 1. Get user's account IDs
        const userAccounts = await this.prisma.platformAccount.findMany({
            where: {
                identity: { userId },
                ...(branchId && branchId !== 'all' ? { branchId } : {}),
                ...(accountId && accountId !== 'all' ? { id: accountId } : {}),
            },
            select: { id: true },
        });

        let accountIds = userAccounts.map(a => a.id);

        if (pageId && pageId !== 'all' && accountIds.length > 0) {
            const pageAccounts = await this.prisma.lead.findMany({
                where: { fbPageId: pageId, platformAccountId: { in: accountIds } },
                select: { platformAccountId: true },
                distinct: ['platformAccountId'],
            });
            accountIds = pageAccounts.map(l => l.platformAccountId);
        }

        // 2. Aggregate Insights (Spend, Revenue)
        let spendTotal = 0, spendToday = 0, spendTodayRaw = 0, yesterdaySpend = 0, revenueTotal = 0, messagingNewFromAds = 0;

        if (accountIds.length > 0) {
            const insights = await this.prisma.unifiedInsight.findMany({
                where: {
                    platformAccountId: { in: accountIds },
                    ...(dateStart ? { date: { gte: dateStart } } : {}),
                    ...(dateEnd ? { date: { lte: dateEnd } } : {}),
                    ...(campaignId && campaignId !== 'all' ? { 
                        OR: [
                            { unifiedCampaignId: campaignId },
                            { campaign: { externalId: campaignId } }
                        ]
                    } : {}),
                },
                select: { spend: true, date: true, purchaseValue: true, messagingNew: true },
            });

            insights.forEach(d => {
                const spRaw = Number(d.spend || 0);
                const sp = spRaw * 1.1; // 10% tax
                const rev = Number(d.purchaseValue || 0);
                const msgNew = Number(d.messagingNew || 0);

                spendTotal += sp;
                revenueTotal += rev;
                messagingNewFromAds += msgNew;

                if (moment(d.date).format('YYYY-MM-DD') === todayStr) {
                    spendToday += sp;
                    spendTodayRaw += spRaw;
                }
                if (moment(d.date).format('YYYY-MM-DD') === yesterdayStr) yesterdaySpend += sp;
            });
        }

        // 3. Lead Stats (Activity-based)
        const startTime = filters.startTime || '00:00:00';
        const endTime = filters.endTime || '23:59:59';
        const rangeStart = dateStart ? moment.tz(`${dateStart}T${startTime}`, 'Asia/Ho_Chi_Minh').toDate() : new Date(todayRange.start);
        const rangeEnd = dateEnd ? moment.tz(`${dateEnd}T${endTime}`, 'Asia/Ho_Chi_Minh').toDate() : new Date(todayRange.end);

        const activeLeads = await this.prisma.lead.findMany({
            where: {
                platformAccountId: { in: accountIds },
                firstContactAt: { gte: rangeStart, lte: rangeEnd },
                ...(pageId && pageId !== 'all' ? { fbPageId: pageId } : {}),
                ...(campaignId && campaignId !== 'all' ? { sourceCampaignId: campaignId } : {}),
            },
            select: { id: true, firstContactAt: true, sourceCampaignId: true, isPotential: true, isManualPotential: true, isQualified: true },
        });

        const rangeNewTotal = activeLeads.length;

        const adsActive = activeLeads.filter(l => l.sourceCampaignId);
        const adsQualified = adsActive.filter(l => l.isQualified);
        const potentialFromAds = adsActive.filter(l => l.isPotential || l.isManualPotential).length;
        const totalActiveAds = adsQualified.length;

        const organicActive = activeLeads.filter(l => !l.sourceCampaignId);
        const organicQualified = organicActive.filter(l => l.isQualified);
        const potentialFromOrganic = organicActive.filter(l => l.isPotential || l.isManualPotential).length;
        const totalActiveOrganic = organicQualified.length;

        const starredCount = await this.prisma.lead.count({
            where: {
                platformAccountId: { in: accountIds },
                OR: [{ isPotential: true }, { isManualPotential: true }],
                ...(pageId && pageId !== 'all' ? { fbPageId: pageId } : {}),
            }
        });

        // Unique messages estimate
        const uniqueLeadsInRange = activeLeads.length;

        let days = 30;
        const effectiveEndDate = dateEnd || todayStr;
        if (dateStart) {
            days = moment(effectiveEndDate).diff(moment(dateStart), 'days') + 1;
        }

        return {
            spendTotal, spendToday, spendTodayRaw, yesterdaySpend,
            todayLeads: rangeNewTotal,
            todayQualified: totalActiveAds,
            messagingNewFromAds,
            todayNewOrganic: totalActiveOrganic,
            potentialFromAds,
            potentialFromOrganic,
            todayMessagesCount: uniqueLeadsInRange,
            starredCount,
            totalLeads: rangeNewTotal,
            totalQualified: totalActiveAds + totalActiveOrganic,
            revenue: revenueTotal,
            avgDailySpend: spendTotal / (days || 1),
            roas: spendTotal > 0 ? Number((revenueTotal / spendTotal).toFixed(2)) : 0,
        };
    }

    /**
     * List Leads
     */
    async findAll(userId: number, filters: any) {
        const { page = 1, limit = 50, branchId, accountId, pageId, qualified, potential, today, dateStart, dateEnd, startTime = '00:00:00', endTime = '23:59:59', assignedId } = filters;
        const skip = (page - 1) * limit;

        const todayRange = this.getVnDayRange(new Date());
        const rangeStart = dateStart ? moment.tz(`${dateStart}T${startTime}`, 'Asia/Ho_Chi_Minh').toDate() : new Date(todayRange.start);
        const rangeEnd = dateEnd ? moment.tz(`${dateEnd}T${endTime}`, 'Asia/Ho_Chi_Minh').toDate() : new Date(todayRange.end);

        const where: any = {
            account: { identity: { userId } }
        };

        if (branchId && branchId !== 'all') where.account = { ...where.account, branchId };
        if (accountId && accountId !== 'all') where.platformAccountId = Number(accountId);
        if (pageId && pageId !== 'all') where.fbPageId = pageId;
        if (assignedId) where.assignedUserId = Number(assignedId);

        if (today === 'true' || filters.qualifiedToday === 'true' || filters.potentialToday === 'true' || dateStart || dateEnd) {
            where.firstContactAt = {
                ...(rangeStart ? { gte: rangeStart } : {}),
                ...(rangeEnd ? { lte: rangeEnd } : {}),
            };
            if (filters.qualifiedToday === 'true') where.isQualified = true;
            if (filters.potentialToday === 'true') where.isPotential = true;
        }

        if (qualified === 'true') where.isQualified = true;
        else if (qualified === 'false') where.isQualified = false;

        if (potential === 'true') where.isPotential = true;
        else if (potential === 'false') where.isPotential = false;

        const [total, leads] = await Promise.all([
            this.prisma.lead.count({ where }),
            this.prisma.lead.findMany({
                where,
                include: {
                    page: { select: { name: true, avatarUrl: true } }
                },
                orderBy: { lastMessageAt: 'desc' },
                skip,
                take: Number(limit),
            }),
        ]);

        return {
            data: leads,
            pagination: {
                page: Number(page),
                limit: Number(limit),
                total,
                totalPages: Math.ceil(total / Number(limit)),
            }
        };
    }

    /**
     * Get Lead Details
     */
    async findOne(id: string, userId: number) {
        const lead = await this.prisma.lead.findFirst({
            where: {
                id,
                account: { identity: { userId } }
            },
            include: {
                page: { select: { name: true, avatarUrl: true, accessToken: true } }
            }
        });

        if (!lead) throw new NotFoundException('Lead not found');
        return lead;
    }

    /**
     * Update Lead
     */
    async update(id: string, userId: number, data: any) {
        const lead = await this.findOne(id, userId);
        return this.prisma.lead.update({
            where: { id: lead.id },
            data,
        });
    }

    /**
     * Fetch Message History from Facebook
     */
    async getMessageHistory(id: string, userId: number) {
        const lead = await this.findOne(id, userId);
        
        // 1. Get Page Access Token
        let pageToken = lead.page?.accessToken;
        if (!pageToken) {
            // Logic to fetch page token using user token would go here
            // For now, assume it's synced via platform_pages
            const page = await this.prisma.platformPage.findUnique({ where: { id: lead.fbPageId } });
            pageToken = page?.accessToken;
        }

        if (!pageToken) throw new Error('Page access token not found. Please sync your pages.');

        // 2. Resolve Conversation ID
        const convs: any = await this.fbApi.getRaw(`${lead.fbPageId}/conversations`, pageToken, {
            user_id: lead.externalId,
            fields: 'id,updated_time,snippet'
        });

        const convId = convs.data?.[0]?.id;
        if (!convId) return [];

        // 3. Fetch Messages
        const msgs: any = await this.fbApi.getRaw(`${convId}/messages`, pageToken, {
            fields: 'id,message,from,created_time,attachments,shares,sticker',
            limit: '100'
        });

        // 4. Format for frontend
        return (msgs.data || []).map((m: any) => {
            const isFromPage = String(m.from?.id) === String(lead.fbPageId);
            return {
                id: m.id,
                lead_id: lead.id,
                fb_message_id: m.id,
                sender_id: m.from?.id,
                sender_name: m.from?.name,
                message_content: m.message || '',
                attachments: m.attachments?.data,
                sticker: m.sticker,
                sent_at: m.created_time,
                is_from_customer: !isFromPage
            };
        }).reverse();
    }

    /**
     * Assign Lead
     */
    async assign(id: string, userId: number, assignedToId: number) {
        const lead = await this.findOne(id, userId);
        return this.prisma.lead.update({
            where: { id: lead.id },
            data: { assignedUserId: assignedToId }
        });
    }
}
