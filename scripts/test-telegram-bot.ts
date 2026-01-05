import { PrismaClient } from '@prisma/client';
import axios from 'axios';

const prisma = new PrismaClient();

async function testTelegramBot() {
    try {
        // Lấy ngrok URL
        const ngrokResponse = await axios.get('http://localhost:4040/api/tunnels');
        const tunnels = ngrokResponse.data.tunnels;
        const httpsTunnel = tunnels.find((t: any) => t.proto === 'https');
        
        if (!httpsTunnel) {
            console.error('❌ Không tìm thấy HTTPS tunnel từ ngrok');
            process.exit(1);
        }

        const ngrokUrl = httpsTunnel.public_url;
        console.log(`✅ Ngrok URL: ${ngrokUrl}`);

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

        // Cập nhật webhook với ngrok URL
        const webhookUrl = `${ngrokUrl}/api/v1/telegram/webhook/${bot.id}`;
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

