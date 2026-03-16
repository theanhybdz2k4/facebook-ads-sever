import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma/prisma.service';
import axios from 'axios';

@Injectable()
export class MessengerCrawlerService {
    private readonly logger = new Logger(MessengerCrawlerService.name);

    constructor(private readonly prisma: PrismaService) { }

    /**
     * Resolves a Facebook PSID to a Real UID/Avatar using a session cookie or user token.
     * Mirrored from Supabase fb-webhook resolveAvatarWithCrawler
     */
    async resolveAvatar(psid: string): Promise<string | null> {
        this.logger.log(`[FB-Crawler] Attempting to resolve avatar for PSID: ${psid}...`);

        try {
            // 1. Get the crawler credential from platform_credentials
            const credential = await this.prisma.platformCredential.findFirst({
                where: {
                    credentialType: { in: ['fb_crawler_cookie', 'fb_crawler_user_token'] },
                    isActive: true,
                },
                orderBy: { credentialType: 'desc' }, // Prioritize cookie
            });

            if (!credential) {
                this.logger.warn(`[FB-Crawler] No active crawler cookies/tokens found.`);
                return null;
            }

            if (credential.credentialType === 'fb_crawler_cookie') {
                const cookie = credential.credentialValue;
                this.logger.log(`[FB-Crawler] Using session cookie strategy...`);

                const url = `https://m.facebook.com/${psid}`;
                const response = await axios.get(url, {
                    headers: {
                        'Cookie': cookie,
                        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Mobile/15E148 Safari/604.1',
                        'Accept': 'text/html',
                    },
                    maxRedirects: 5,
                    validateStatus: () => true,
                });

                const html = response.data;
                const finalUrl = response.request.res.responseUrl || url;
                this.logger.log(`[FB-Crawler] Final URL after redirects: ${finalUrl}`);

                // Look for actual Facebook CDN links (scontent)
                const cdnPatterns = [
                    /https:\/\/scontent\.[^"&?]+\/v\/[^"&?]+\.(?:jpg|png|webp)[^"&?]*/gi,
                    /https:\\\/\\\/scontent\.[^"&?]+\/v\/[^"&?]+\.(?:jpg|png|webp)[^"&?]*/gi,
                ];

                for (const pattern of cdnPatterns) {
                    const matches = html.match(pattern);
                    if (matches) {
                        for (let match of matches) {
                            match = match.replace(/\\/g, ''); // Clean up escaped slashes
                            if (match.includes('/v/') && (match.includes('stp=') || match.includes('_n.'))) {
                                this.logger.log(`[FB-Crawler] Found direct CDN avatar: ${match.substring(0, 50)}...`);
                                return match.replace(/&amp;/g, '&');
                            }
                        }
                    }
                }

                // Fallback: search for UID in HTML
                const bodyMatch = html.match(/"entity_id":"(\d+)"/);
                const uid = bodyMatch ? bodyMatch[1] : (html.match(/"userID":"(\d+)"/)?.[1] || null);

                if (uid) {
                    this.logger.log(`[FB-Crawler] Successfully resolved UID as fallback: ${uid}`);
                    return `https://www.facebook.com/search/top/?q=${uid}`;
                }
            } else if (credential.credentialType === 'fb_crawler_user_token') {
                this.logger.log(`[FB-Crawler] Using public user token strategy...`);
                const token = credential.credentialValue;
                const res = await axios.get(`https://graph.facebook.com/${psid}/picture?type=large&redirect=false&access_token=${token}`);
                return res.data?.data?.url || null;
            }

        } catch (error) {
            this.logger.error(`[FB-Crawler] Error during resolution: ${error.message}`);
        }

        return null;
    }
}
