import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma/prisma.service';
import axios from 'axios';

@Injectable()
export class ChatbotService {
    private readonly logger = new Logger(ChatbotService.name);
    private readonly FB_BASE_URL = 'https://graph.facebook.com/v21.0';

    constructor(private readonly prisma: PrismaService) { }

    /**
     * Chạy quy trình Chatbot Automation cho một khách hàng
     * Mirror logic từ Supabase fb-chatbot
     */
    async handleAutomation(params: {
        pageId: string;
        customerId: string;
        leadId: string; // Lead ID là String trong Prisma (UUID)
        messageText?: string;
        postbackPayload?: string;
        isNewLead: boolean;
        adId?: string;
    }) {
        const { pageId, customerId, leadId, messageText, postbackPayload, isNewLead, adId } = params;

        this.logger.log(`[Chatbot] Handling auto-reply for customer ${customerId} on page ${pageId}`);

        // 1. Lấy Token của Page
        // Trong PlatformAccount, externalId là pageId, platformId là ID của FB
        const page = await this.prisma.platformAccount.findFirst({
            where: { 
                externalId: pageId,
                // platformId: 1 // Sẽ cần logic động hơn, nhưng tạm thời dùng externalId unique
            },
            include: { 
                identity: { 
                    include: { 
                        credentials: {
                            where: { isActive: true },
                            orderBy: { createdAt: 'desc' },
                            take: 1
                        }
                    } 
                } 
            }
        });

        const pageToken = page?.identity?.credentials?.[0]?.credentialValue;
        if (!pageToken) {
            this.logger.error(`[Chatbot] No access token found for Page ${pageId}`);
            return;
        }

        // 2. Lấy cấu hình Chatbot (ChatbotConfig)
        const config = await this.prisma.chatbotConfig.findFirst({
            where: {
                OR: [
                    { pageId: pageId },
                    { pageId: null }
                ]
            },
            orderBy: { pageId: 'desc' } // Ưu tiên cấu hình đúng Page ID
        });

        if (!config || !config.isEnabled) {
            this.logger.log(`[Chatbot] Config not found or disabled for page ${pageId}`);
            return;
        }

        // 3. Kiểm tra Session & Handoff
        const session = await this.prisma.chatbotSession.findFirst({
            where: { pageId: pageId, customerId: customerId }
        });

        if (session?.handedOff && !postbackPayload) {
            this.logger.log(`[Chatbot] Session handed off to human agent, skipping`);
            return;
        }

        // 4. Tìm Flow phù hợp (Matching Logic)
        const flows = await this.prisma.chatbotFlow.findMany({
            where: { isActive: true },
            orderBy: { sortOrder: 'asc' }
        });

        let matchedFlow = this.matchFlow({ flows, adId, postbackPayload, messageText, isNewLead, session });

        if (!matchedFlow) {
            this.logger.log(`[Chatbot] No matching flow for customer ${customerId}`);
            return;
        }

        // 5. Gửi tin nhắn
        this.logger.log(`[Chatbot] Matched flow: ${matchedFlow.flowKey}. Sending...`);
        const messagePayload = this.buildFBMessage(matchedFlow);
        
        const sent = await this.sendFBMessage(pageToken, customerId, messagePayload);

        // 6. Cập nhật Session
        if (sent) {
            const now = new Date();
            const isHandoff = (matchedFlow.content as any)?.handoff === true;

            if (session) {
                await this.prisma.chatbotSession.update({
                    where: { id: session.id },
                    data: {
                        currentStep: matchedFlow.flowKey,
                        handedOff: isHandoff,
                        lastInteractionAt: now,
                    }
                });
            } else {
                await this.prisma.chatbotSession.create({
                    data: {
                        leadId,
                        pageId: pageId,
                        customerId: customerId,
                        currentStep: matchedFlow.flowKey,
                        handedOff: isHandoff,
                        lastInteractionAt: now,
                    }
                });
            }
        }
    }

    private matchFlow(opts: { flows: any[], adId?: string, postbackPayload?: string, messageText?: string, isNewLead: boolean, session: any }) {
        const { flows, adId, postbackPayload, messageText, isNewLead, session } = opts;
        const payload = postbackPayload;

        // A. Ưu tiên theo Ad ID
        if (adId) {
            const adFlow = flows.find(f => f.linkedAdIds?.includes(adId));
            if (adFlow) return adFlow;
        }

        // B. Theo Payload (nút bấm)
        if (payload) {
            const payloadFlow = flows.find(f => f.triggerPayloads?.includes(payload));
            if (payloadFlow) return payloadFlow;
        }

        // C. Theo Từ khóa
        if (messageText) {
            const lowerText = messageText.toLowerCase().trim();
            const keywordFlow = flows.find(f => 
                f.triggerKeywords?.some(kw => lowerText.includes(kw.toLowerCase()))
            );
            if (keywordFlow) return keywordFlow;
        }

        // D. Fallback cho khách mới / khách quay lại ngày mới
        if (isNewLead || !session) {
            return flows.find(f => f.isEntryPoint);
        }

        return flows.find(f => f.flowKey === 'fallback');
    }

    private buildFBMessage(flow: any): any {
        const content: any = flow.content;
        switch (flow.messageType) {
            case 'text': return { text: content.text };
            case 'quick_reply': return {
                text: content.text,
                quick_replies: content.quick_replies
            };
            case 'buttons': return {
                attachment: {
                    type: 'template',
                    payload: {
                        template_type: 'button',
                        text: content.text,
                        buttons: content.buttons
                    }
                }
            };
            case 'carousel': return {
                attachment: {
                    type: 'template',
                    payload: {
                        template_type: 'generic',
                        elements: content.elements
                    }
                }
            };
            default: return { text: 'Xin chào!' };
        }
    }

    async sendFBMessage(pageToken: string, recipientId: string, message: any): Promise<boolean> {
        try {
            await axios.post(`${this.FB_BASE_URL}/me/messages?access_token=${pageToken}`, {
                recipient: { id: recipientId },
                message,
                messaging_type: 'RESPONSE'
            });
            return true;
        } catch (error) {
            this.logger.error(`[Chatbot] FB API error: ${error.response?.data?.error?.message || error.message}`);
            return false;
        }
    }
}
