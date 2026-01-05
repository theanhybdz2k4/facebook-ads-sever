import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import * as dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

async function testTelegramBot() {
    try {
        // Lấy production URL từ env
        const baseUrl = process.env.BASE_URL || process.env.RAILWAY_PUBLIC_DOMAIN;
        
        if (!baseUrl) {
            console.error('❌ Không tìm thấy BASE_URL hoặc RAILWAY_PUBLIC_DOMAIN trong env');
            console.error('Vui lòng set BASE_URL hoặc RAILWAY_PUBLIC_DOMAIN trong .env');
            process.exit(1);
        }

        console.log(`✅ Base URL: ${baseUrl}`);

        // Tìm bot active đầu tiên
        const bot = await prisma.userTelegramBot.findFirst({
            where: { isActive: true },
            orderBy: { createdAt: 'desc' },
        });

        if (!bot) {
            console.error('❌ Không tìm thấy bot active');
            process.exit(1);
        }

        console.log(`✅ Tìm thấy bot: ${bot.botName} (ID: ${bot.id})`);

        // Cập nhật webhook với production URL - dùng route có botId
        const webhookUrl = `${baseUrl}/api/v1/telegram/webhook/${bot.id}`;
        console.log(`📡 Đang cập nhật webhook: ${webhookUrl}`);

        const webhookResponse = await axios.post(
            `https://api.telegram.org/bot${bot.botToken}/setWebhook`,
            {
                url: webhookUrl,
                allowed_updates: ['message', 'callback_query'],
            }
        );

        if (webhookResponse.data.ok) {
            console.log('✅ Webhook đã được cập nhật thành công!');
            console.log(`\n🤖 Bot: @${bot.botUsername || 'unknown'}`);
            console.log(`🔗 Webhook URL: ${webhookUrl}`);
            console.log(`\n📋 Các lệnh để test:`);
            console.log(`   /start - Bắt đầu sử dụng bot`);
            console.log(`   /subscribe - Bật thông báo`);
            console.log(`   /unsubscribe - Tắt thông báo`);
            console.log(`   /report - Báo cáo tổng quan`);
            console.log(`   /hour - Báo cáo giờ`);
            console.log(`   /today - Báo cáo hôm nay`);
            console.log(`   /week - Báo cáo 7 ngày`);
            console.log(`   /budget - Xem ngân sách`);
            console.log(`   /help - Hướng dẫn`);
        } else {
            console.error('❌ Lỗi khi cập nhật webhook:', webhookResponse.data);
        }

        // Kiểm tra webhook info
        const webhookInfoResponse = await axios.get(
            `https://api.telegram.org/bot${bot.botToken}/getWebhookInfo`
        );
        console.log('\n📊 Webhook Info:');
        console.log(JSON.stringify(webhookInfoResponse.data, null, 2));

    } catch (error: any) {
        console.error('❌ Lỗi:', error.message);
        if (error.response) {
            console.error('Response:', error.response.data);
        }
    } finally {
        await prisma.$disconnect();
    }
}

testTelegramBot();

