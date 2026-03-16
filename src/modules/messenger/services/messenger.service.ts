import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma/prisma.service';
import { MessengerCrawlerService } from '../crawler/messenger-crawler.service';
import { ChatbotService } from './chatbot.service';

@Injectable()
export class MessengerService {
    private readonly logger = new Logger(MessengerService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly crawler: MessengerCrawlerService,
        private readonly chatbot: ChatbotService,
    ) { }

    /**
     * Chế biến dữ liệu Webhook từ Facebook
     * Mirror logic từ Supabase fb-webhook Deno.serve (POST section)
     */
    async processWebhook(body: any) {
        this.logger.log(`[MessengerService] Processing webhook body with ${body.entry?.length} entries`);

        for (const entry of body.entry || []) {
            const pageId = entry.id;

            // Xử lý messaging sự kiện
            for (const messaging of entry.messaging || []) {
                await this.processMessagingEvent(pageId, messaging);
            }
        }
    }

    private async processMessagingEvent(pageId: string, messaging: any) {
        const senderId = messaging.sender?.id;
        const recipientId = messaging.recipient?.id;
        const timestamp = messaging.timestamp;
        const message = messaging.message;
        const referral = messaging.referral || messaging.postback?.referral || messaging.message?.referral;

        const isEcho = message?.is_echo === true;
        const customerId = isEcho ? recipientId : senderId;

        if (!customerId) return;

        this.logger.log(`[MessengerService] Processing message from ${isEcho ? 'PAGE' : 'CUSTOMER'} ${customerId} on Page ${pageId}`);

        // 1. Tìm hoặc tạo Lead (Định danh Lead)
        let lead = await this.prisma.lead.findFirst({
            where: { externalId: customerId },
        });

        const now = new Date();
        const lastMessageAt = new Date(timestamp);

        // Logic attribution adId
        const adId = referral?.ad_id || referral?.campaign_id || referral?.ad_id_key || 
                     messaging.postback?.referral?.ad_id || message?.referral?.ad_id;

        const leadData: any = {
            lastMessageAt,
            fbPageId: pageId,
            isRead: isEcho,
        };

        if (adId && (!lead || !lead.sourceCampaignId)) {
            leadData.sourceCampaignId = adId;
            leadData.isQualified = true;
        }

        if (!lead) {
            // Tạo lead mới
            this.logger.log(`[MessengerService] Creating new lead for customer ${customerId}`);
            
            // Cố gắng cào avatar
            const avatarUrl = await this.crawler.resolveAvatar(customerId);
            
            lead = await this.prisma.lead.create({
                data: {
                    externalId: customerId,
                    platformAccountId: 40, // Default account (Colorme)
                    customerName: 'Khách hàng',
                    customerAvatar: avatarUrl,
                    fbPageId: pageId,
                    ...leadData,
                },
            });
        } else {
            // Cập nhật lead cũ
            lead = await this.prisma.lead.update({
                where: { id: lead.id },
                data: leadData,
            });
        }

        // 2. Cập nhật snippet tin nhắn (để hiển thị danh sách lead)
        const snippet = message?.text || (message?.attachments ? '[Hình ảnh/File]' : 'Tin nhắn mới');
        if (snippet && lead) {
            await this.prisma.lead.update({
                where: { id: lead.id },
                data: {
                    platformData: {
                        ...(lead.platformData as any || {}),
                        snippet: snippet.substring(0, 100),
                    }
                }
            });
        }
        
        // 3. Trigger Chatbot Automation
        if (!isEcho && lead) {
            await this.chatbot.handleAutomation({
                pageId,
                customerId,
                leadId: lead.id, // lead.id là String (UUID)
                messageText: message?.text,
                postbackPayload: messaging.postback?.payload || message?.quick_reply?.payload,
                isNewLead: !lead.createdAt || (new Date().getTime() - lead.createdAt.getTime() < 10000), // Khoảng 10s là khách mới
                adId,
            });
        }
    }
}
