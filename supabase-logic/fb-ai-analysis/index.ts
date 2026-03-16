
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const supabase = createClient(supabaseUrl, supabaseKey);

const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-service-key",
};

async function analyzeWithGemini(apiKey: string, messages: Array<{ sender: string, content: string, isFromCustomer: boolean, timestamp: string }>) {
    if (!apiKey || messages.length === 0) return null;

    try {
        const conversationText = messages.map(m => {
            const time = new Date(m.timestamp).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
            return `[${time}] ${m.isFromCustomer ? '👤 Khách hàng' : '📄 Page'}: ${m.content}`;
        }).join('\n');
        
        const prompt = `Bạn là chuyên gia phân tích hội thoại bán hàng cho ColorME (trung tâm đào tạo thiết kế). Hãy phân tích cuộc hội thoại (kèm mốc thời gian) và CHẤM ĐIỂM mức độ tiềm năng trên thang 10.

TIÊU CHÍ CHẤM ĐIỂM (Thang 10):
1. Nhu cầu (2đ): Khách hỏi sâu về lộ trình, bài tập, sản phẩm đầu ra, hoặc muốn giải quyết vấn đề cụ thể.
2. Thời gian (2đ): Khách hỏi lịch khai giảng, ca học, hoặc muốn bắt đầu học sớm.
3. Tài chính (2đ): Khách hỏi học phí/ưu đãi VÀ có phản hồi tích cực (không im lặng sau khi biết giá).
4. Liên lạc (2đ): Khách đã để lại SĐT hoặc sẵn sàng cung cấp khi được yêu cầu.
5. Tương tác & Phản hồi (2đ): Khách chủ động trao đổi, phản hồi nhanh. TRỪ ĐIỂM nếu: Khách rep quá chậm (>24h-48h mỗi tin), hoặc đã ngưng tương tác lâu dù Page có nhắn tin (hội thoại bị 'nguội').

QUY TẮC PHẢN HỒI: Dòng đầu tiên PHẢI là "Đánh giá: TIỀM NĂNG" hoặc "Đánh giá: KHÔNG TIỀM NĂNG". Sau đó bắt buộc có phần "Tóm tắt: ..." để hiển thị ở danh sách tin nhắn.

CẤU TRÚC PHẢN HỒI (BẮT BUỘC):
Đánh giá: [TIỀM NĂNG hoặc KHÔNG TIỀM NĂNG]
Tổng điểm: [Số điểm]/10
Chi tiết điểm: [Nhu cầu: xđ, Thời gian: xđ, Tài chính: xđ, Liên lạc: xđ, Tương tác: xđ]
Tóm tắt: [Diễn biến chính: Khách hỏi -> Sale đáp -> Khách phản hồi. Lưu ý về nhịp độ phản hồi của khách]
Giai đoạn: [Nhận thức/Quan tâm/Cân nhắc/Quyết định]
Gợi ý: [Hành động tiếp theo cho Sale]

---
${conversationText}
---`;

        console.log("[fb-ai-analysis] Calling Gemini API...");
        const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" + apiKey, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }]
            })
        });

        const data = await response.json();
        if (data.error) throw new Error(data.error.message);

        const analysis = data.candidates?.[0]?.content?.parts?.[0]?.text || null;
        if (analysis) {
            const lines = analysis.split('\n');
            const firstLine = lines[0].toLowerCase();
            const isPotential = firstLine.includes('tiềm năng') && !firstLine.includes('không tiềm năng');
            const cleanedAnalysis = lines.slice(1).join('\n').trim();
            return { analysis: cleanedAnalysis, isPotential };
        }
        return null;
    } catch (e: any) {
        console.error("[fb-ai-analysis] Gemini error:", e.message);
        return null;
    }
}

Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

    try {
        const { leadId, messages, geminiApiKey } = await req.json();

        if (!leadId || !messages || !geminiApiKey) {
            return new Response(JSON.stringify({ error: "Missing required fields" }), { status: 400, headers: corsHeaders });
        }

        console.log(`[fb-ai-analysis] Starting analysis for lead ${leadId}...`);
        const result = await analyzeWithGemini(geminiApiKey, messages);

        if (result) {
            // Fetch current lead data to merge platform_data
            const { data: currentLead } = await supabase
                .from("leads")
                .select("platform_data, metadata")
                .eq("id", leadId)
                .single();

            const { error: updateErr } = await supabase
                .from("leads")
                .update({
                    ai_analysis: result.analysis,
                    is_potential: result.isPotential,
                    last_analysis_at: new Date().toISOString(),
                    platform_data: {
                        ...(currentLead?.platform_data || {}),
                        last_analysis_message_count: messages.length,
                    },
                    metadata: {
                        ...(currentLead?.metadata || {}),
                        last_analysis_at: new Date().toISOString(),
                        last_crawled_at: new Date().toISOString()
                    }
                })
                .eq("id", leadId);

            if (updateErr) throw updateErr;

            console.log(`[fb-ai-analysis] Analysis completed and saved for lead ${leadId}`);
            return new Response(JSON.stringify({ 
                success: true, 
                isPotential: result.isPotential,
                analysis: result.analysis
            }), { status: 200, headers: corsHeaders });
        }

        return new Response(JSON.stringify({ error: "Analysis failed" }), { status: 500, headers: corsHeaders });

    } catch (err: any) {
        console.error("[fb-ai-analysis] Fatal error:", err.message);
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
    }
});
