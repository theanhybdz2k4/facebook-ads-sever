/**
 * Ads Analytics & AI Reporting Edge Function — v3
 *
 * Architecture:
 * ┌─────────────────────────────────────────────────────────┐
 * │  FE sends full metrics payload                          │
 * │       ↓                                                 │
 * │  Edge splits into scoped data slices                    │
 * │  (overview / breakdown / leadQuality)                   │
 * │       ↓                                                 │
 * │  Each section gets ONLY its required slice + instruction│
 * │  All sections fire in PARALLEL                          │
 * │       ↓                                                 │
 * │  Synthesis: stitch outputs → final report (no re-inject)│
 * └─────────────────────────────────────────────────────────┘
 *
 * Token savings per section vs v1 (sending full data):
 *   verdict       → -60%  (overview only, no breakdown table)
 *   ads_audit     → -10%  (overview + breakdown, no leadQuality)
 *   funnel        → -60%  (overview only)
 *   action_plan   → -40%  (breakdown only, no overview KPIs)
 *   quality       → -60%  (overview + leadQuality, no breakdown)
 *   scaling       → -10%  (overview + breakdown)
 *   synthesis     → -70%  (section outputs only, no raw data)
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.0";
import { verify } from "https://deno.land/x/djwt@v3.0.1/mod.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const supabase = createClient(supabaseUrl, supabaseKey);

const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-client-info, apikey, x-service-key",
};

const jsonResponse = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: corsHeaders });

async function verifyAuth(req: Request) {
    const authHeader = req.headers.get("Authorization");
    const masterKey = Deno.env.get("MASTER_KEY") || "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const authSecret = Deno.env.get("AUTH_SECRET") || "";
    const JWT_SECRET = Deno.env.get("JWT_SECRET");

    if (authHeader?.startsWith("Bearer ")) {
        const token = authHeader.substring(7).trim();

        // 1. Secret token check
        if ((serviceKey && token === serviceKey) || (masterKey && token === masterKey) || (authSecret && token === authSecret)) {
            return { userId: 1 };
        }

        // 2. PRIORITY: Check custom auth_tokens table
        try {
            const { data: tokenData } = await supabase
                .from("auth_tokens")
                .select("user_id")
                .eq("token", token)
                .eq("is_active", true)
                .gte("expires_at", new Date().toISOString())
                .maybeSingle();
            
            if (tokenData) return { userId: tokenData.user_id };
        } catch (e: any) {
            console.error("[AuthReport] auth_tokens check failed:", e.message);
        }

        // 3. Manual JWT verification
        if (JWT_SECRET) {
            try {
                const encoder = new TextEncoder();
                const key = await crypto.subtle.importKey("raw", encoder.encode(JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
                const payload = await verify(token, key);
                if (payload.role === "service_role") return { userId: 1 };
                const sub = payload.sub as string;
                if (sub) return { userId: /^\d+$/.test(sub) ? parseInt(sub, 10) : sub };
            } catch (e: any) {
                console.error("[AuthReport] JWT verification failed:", e.message);
            }
        }

        // 4. Native Supabase Auth
        try {
            const { data: { user } } = await supabase.auth.getUser(token);
            if (user) return { userId: user.id };
        } catch (e: any) { }
    }
    return null;
}

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────
const GEMINI_MODEL = "gemini-2.0-flash";
const GEMINI_CONFIG = { temperature: 0.4, topP: 0.9, topK: 40 };

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────
type MetricsPayload = Record<string, unknown>;
type DataSlice = "overview" | "breakdown" | "leadQuality";

type SectionDef = {
    id: string;
    title: string;
    label: string;
    slices: DataSlice[];     // which data slices this section needs
    instruction: string;     // what the AI should analyze (no data here)
};

// ─────────────────────────────────────────────────────────────
// Formatters — primitive helpers
// ─────────────────────────────────────────────────────────────
const fmt = {
    number(n: number): string {
        if (!n || isNaN(n)) return "0";
        if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
        if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
        return n.toFixed(n % 1 === 0 ? 0 : 2);
    },
    currency(n: number): string {
        if (!n || isNaN(n)) return "0đ";
        return new Intl.NumberFormat("vi-VN").format(Math.round(n)) + "đ";
    },
};

// ─────────────────────────────────────────────────────────────
// Scoped Data Slice Builders
// Each function returns ONLY the data relevant to its slice.
// ─────────────────────────────────────────────────────────────

/**
 * Slice: OVERVIEW
 * Contains: aggregate KPIs only (spend, impressions, clicks, leads, CTR, CPC, CPL, period)
 * Used by: verdict, funnel, portfolio, quality, branch_health, scaling
 */
function buildOverviewSlice(m: MetricsPayload): string {
    const typeName =
        m.type === "campaign" ? "Chiến dịch" :
        m.type === "account"  ? "Tài khoản quảng cáo" :
                                "Cơ sở/Chi nhánh";

    const totalLeads = (m.totalLeads as number) || (m.totalResults as number) || 0;

    return [
        "## DỮ LIỆU: TỔNG QUAN HIỆU SUẤT",
        `Tên       : ${m.campaignName || "N/A"}`,
        `Loại      : ${typeName}`,
        `Giai đoạn : ${m.dateStart} → ${m.dateEnd}`,
        `Chi tiêu  : ${fmt.currency(m.spend as number)}`,
        `Hiển thị  : ${fmt.number(m.impressions as number)}`,
        `Nhấp      : ${fmt.number(m.clicks as number)}`,
        `Leads     : ${fmt.number(totalLeads)}`,
        `CTR       : ${((m.ctr as number) || 0).toFixed(2)}%`,
        `CPC       : ${fmt.currency((m.cpc as number) || 0)}`,
        `CPL       : ${fmt.currency((m.cpl as number) || 0)}`,
    ].join("\n");
}

/**
 * Slice: BREAKDOWN
 * Contains: per-entity table (ads or campaigns) + remaining summary if any
 * Used by: ads_audit, action_plan, portfolio, account_efficiency, scaling
 */
function buildBreakdownSlice(m: MetricsPayload): string {
    const breakdown = m.entityBreakdown as MetricsPayload[] | undefined;
    if (!Array.isArray(breakdown) || breakdown.length === 0) return "";

    const isAds = m.type === "campaign";
    const entityLabel = isAds ? "MẪU QUẢNG CÁO" : "CHIẾN DỊCH";

    const lines = [
        `## DỮ LIỆU: BẢNG CHI TIẾT ${entityLabel} (${breakdown.length} ${isAds ? "mẫu" : "chiến dịch"})`,
        "",
        "| STT | Tên | Chi tiêu | Leads | CPL | CTR |",
        "|-----|-----|----------|-------|-----|-----|",
    ];

    for (const [idx, entity] of breakdown.entries()) {
        const spend = (entity.spend as number) || 0;
        const leads = (entity.leads as number) || 0;
        const cpl   = leads > 0 ? fmt.currency(spend / leads) : "—";
        const ctr   = ((entity.ctr as number) || 0).toFixed(2) + "%";
        const name  = ((entity.name as string) || "N/A").substring(0, 50);
        lines.push(`| ${idx + 1} | ${name} | ${fmt.currency(spend)} | ${leads} | ${cpl} | ${ctr} |`);
    }

    const rs = m.remainingSummary as Record<string, number> | undefined;
    if (rs?.count) {
        lines.push("");
        lines.push(`## DỮ LIỆU: ${rs.count} ${isAds ? "MẪU QC" : "CHIẾN DỊCH"} CÒN LẠI (tổng hợp)`);
        lines.push(`Chi tiêu: ${fmt.currency(rs.spend)} | Leads: ${rs.leads} | CPL tb: ${rs.leads > 0 ? fmt.currency(rs.spend / rs.leads) : "—"}`);
    }

    return lines.join("\n");
}

/**
 * Slice: LEAD QUALITY
 * Contains: lead count, potential count, potential ratio
 * Used by: quality sections across all types
 */
function buildLeadQualitySlice(m: MetricsPayload): string {
    const lq = m.leadQuality as Record<string, number> | undefined;
    if (!lq) return "";

    const ratio = lq.totalCount > 0
        ? ((lq.potentialCount / lq.totalCount) * 100).toFixed(1) + "%"
        : "N/A";

    return [
        "## DỮ LIỆU: CHẤT LƯỢNG KHÁCH HÀNG",
        `Tổng Lead       : ${lq.totalCount || 0}`,
        `Lead tiềm năng  : ${lq.potentialCount || 0}`,
        `Tỷ lệ tiềm năng : ${ratio}`,
    ].join("\n");
}

/**
 * Assembles only the requested slices for a section.
 */
function buildScopedData(m: MetricsPayload, slices: DataSlice[]): string {
    const parts: string[] = [];
    for (const slice of slices) {
        let built = "";
        if (slice === "overview")    built = buildOverviewSlice(m);
        if (slice === "breakdown")   built = buildBreakdownSlice(m);
        if (slice === "leadQuality") built = buildLeadQualitySlice(m);
        if (built) parts.push(built);
    }
    return parts.join("\n\n");
}

// ─────────────────────────────────────────────────────────────
// System Instruction
// ─────────────────────────────────────────────────────────────
const SYSTEM_INSTRUCTION = `Bạn là Performance Marketing Director tại Việt Nam.
QUY TẮC CỨNG (không được vi phạm):
1. Chỉ dùng số THỰC TẾ từ dữ liệu. KHÔNG dùng placeholder ([Số tiền], [+/- %], v.v.).
2. Mọi nhận định phải kèm tên thực thể (chiến dịch/mẫu QC) và con số cụ thể.
3. Thiếu trường → bỏ qua phần đó hoàn toàn, không đặt placeholder.
4. Viết tiếng Việt, phong cách sắc bén cho CEO. Markdown: header, bảng, **bold** số quan trọng.
5. Không viết lời dẫn — bắt đầu thẳng bằng nội dung phân tích.`;

// ─────────────────────────────────────────────────────────────
// Section Definitions
// slices  → khai báo data nào được inject vào prompt
// instruction → chỉ mô tả nhiệm vụ phân tích, không chứa data
// ─────────────────────────────────────────────────────────────

const CAMPAIGN_SECTIONS: SectionDef[] = [
    {
        id: "verdict",
        title: "Kết luận điều hành",
        label: "Chẩn đoán trạng thái vận hành...",
        slices: ["overview"],                           // chỉ cần KPIs tổng
        instruction: `# 1️⃣ Kết luận điều hành
Đánh giá trạng thái: **TỐT / TRUNG BÌNH / NGUY HIỂM** dựa trên CPL và CTR.
- Nêu rõ: CPL hiện tại, CTR hiện tại, tổng chi tiêu, tổng leads.
- Benchmark: CPL < 200K = tốt | CTR > 1% = tốt.
- Nhận xét tốc độ đốt ngân sách và khả năng sinh kết quả.`,
    },
    {
        id: "ads_audit",
        title: "Kiểm toán mẫu quảng cáo",
        label: "Phân tích hiệu suất mẫu quảng cáo...",
        slices: ["overview", "breakdown"],              // cần KPIs + bảng từng mẫu
        instruction: `# 2️⃣ Kiểm toán mẫu quảng cáo
Phân tích toàn bộ bảng mẫu QC:
- Tạo bảng phân loại: **"Ngôi sao"** (CPL thấp + CTR cao) vs **"Budget Killer"** (chi nhiều, leads ít).
- Nêu tên, chi tiêu, CPL, CTR của TỪNG mẫu.
- Giải thích tại sao mẫu đó thắng/thua bằng số liệu.
- Đề xuất: tắt mẫu nào, scale mẫu nào và lý do cụ thể.`,
    },
    {
        id: "funnel",
        title: "Chẩn đoán phễu",
        label: "Chẩn đoán điểm gãy của phễu...",
        slices: ["overview"],                           // chỉ cần aggregate CTR/CPL
        instruction: `# 3️⃣ Chẩn đoán phễu chuyển đổi
Phân tích tương quan CTR–CPL để tìm điểm gãy:
- CTR cao + CPL cao → vấn đề ở Landing Page/Form → gợi ý cải thiện cụ thể.
- CTR thấp → hình ảnh/headline yếu → gợi ý thay đổi.
- Tính tỷ lệ chuyển đổi thực tế: Leads / Clicks = bao nhiêu %.
- Xác định điểm gãy rõ nhất và ưu tiên xử lý.`,
    },
    {
        id: "action_plan",
        title: "Kế hoạch hành động 72h",
        label: "Lên lộ trình thực thi 72h...",
        slices: ["breakdown"],                          // chỉ cần tên + số liệu từng mẫu
        instruction: `# 4️⃣ Kế hoạch hành động 72h
Dựa trên hiệu suất từng mẫu QC, lên kế hoạch cụ thể:
- **TẮT ngay**: tên mẫu + lý do bằng số (CPL cao hơn trung bình bao nhiêu?).
- **TĂNG ngân sách**: tên mẫu + % tăng gợi ý + lý do.
- **Cần chỉnh sửa**: mẫu kém → đề xuất thay đổi nội dung/hình ảnh cụ thể.
- Test A/B: mô tả hypothesis và biến thể cần test.`,
    },
    {
        id: "creative_reform",
        title: "Đề xuất cải tiến sáng tạo",
        label: "Phân tích chiến lược nội dung sáng tạo...",
        slices: ["overview", "breakdown"],              // cần KPIs + bảng để phân tích pattern
        instruction: `# 5️⃣ Đề xuất cải tiến sáng tạo
Phân tích xu hướng sáng tạo từ dữ liệu hiệu suất:
- Mẫu QC nào có CTR cao nhất? Phân tích yếu tố sáng tạo có thể đóng góp (tên gợi ý nội dung/góc nhìn).
- Mẫu QC nào CTR thấp nhất? Đề xuất hướng cải tiến headline/hình ảnh cụ thể.
- Đề xuất ít nhất 3 ý tưởng creative mới dựa trên pattern thành công.
- Gợi ý format quảng cáo phù hợp (video, carousel, single image) dựa trên hiệu suất.`,
    },
    {
        id: "risk_summary",
        title: "Rủi ro & Tổng kết CEO",
        label: "Đánh giá rủi ro và tổng kết...",
        slices: ["overview", "breakdown", "leadQuality"],  // cần toàn bộ data để tổng kết
        instruction: `# 6️⃣ Rủi ro chiến lược & Tổng kết CEO
- Xác định TOP 3 rủi ro lớn nhất: ngân sách cháy nhanh, CPL tăng, phụ thuộc 1 mẫu QC, v.v.
- Mỗi rủi ro: mô tả bằng số liệu cụ thể + mức độ nghiêm trọng (CAO/TRUNG BÌNH/THẤP).
- Tóm tắt 5 dòng cho CEO: trạng thái tổng thể, con số then chốt, hành động ưu tiên #1.
- Nếu có dữ liệu lead quality: đánh giá chất lượng khách hàng đổ về.`,
    },
];

const ACCOUNT_SECTIONS: SectionDef[] = [
    {
        id: "portfolio",
        title: "Chiến lược danh mục",
        label: "Phân tích sức khỏe danh mục...",
        slices: ["overview", "breakdown"],              // cần overview + bảng chiến dịch
        instruction: `# 1️⃣ Chiến lược danh mục
- Bảng xếp hạng chiến dịch theo CPL: tốt nhất → kém nhất.
- Chiến dịch nào chiếm % ngân sách lớn nhất? CPL/CTR ra sao?
- Có đang phụ thuộc quá mức vào 1 chiến dịch không? Nêu % cụ thể.
- Nhận xét mức độ đa dạng hóa danh mục và rủi ro tập trung.`,
    },
    {
        id: "quality",
        title: "Kiểm toán chất lượng Lead",
        label: "Kiểm toán chất lượng khách hàng...",
        slices: ["overview", "leadQuality"],            // cần KPIs + lead quality
        instruction: `# 2️⃣ Kiểm toán chất lượng khách hàng
- Đánh giá tỷ lệ Lead tiềm năng / Tổng Lead: tốt hay cần cải thiện?
- Benchmark: > 40% tốt | < 20% đáng lo ngại.
- Tính CPL thực cho lead tiềm năng = Spend / Lead tiềm năng.
- Đề xuất điều chỉnh Targeting hoặc phễu lọc nếu tỷ lệ thấp.`,
    },
    {
        id: "scaling",
        title: "Chiến lược scale ngân sách",
        label: "Tối ưu hóa dòng tiền...",
        slices: ["overview", "breakdown"],              // cần tổng quan + chi tiết để so sánh
        instruction: `# 3️⃣ Chiến lược scale ngân sách
- Đề xuất cụ thể: dịch chuyển bao nhiêu đ / % từ chiến dịch kém → tốt.
- Nêu tên chiến dịch nguồn (giảm) và đích (tăng) kèm số tiền gợi ý.
- Cảnh báo rủi ro: learning phase reset, audience fatigue khi scale nhanh.
- Điều kiện scale an toàn: CPL ổn định bao nhiêu ngày liên tiếp.`,
    },
    {
        id: "risk_summary",
        title: "Rủi ro & Tổng kết CEO",
        label: "Đánh giá rủi ro chiến lược tài khoản...",
        slices: ["overview", "breakdown", "leadQuality"],
        instruction: `# 4️⃣ Rủi ro chiến lược & Tổng kết CEO
- TOP 3 rủi ro: phụ thuộc 1 chiến dịch, CPL leo thang, chất lượng lead giảm.
- Mỗi rủi ro → số liệu cụ thể + mức nghiêm trọng (CAO/TRUNG BÌNH/THẤP).
- Tóm tắt 5 dòng cho CEO: tình hình tài khoản, hành động ưu tiên #1.
- Nếu có dữ liệu lead quality: nhận xét chất lượng lead tổng thể.`,
    },
];

const BRANCH_SECTIONS: SectionDef[] = [
    {
        id: "branch_health",
        title: "Sức khỏe tổng thể cơ sở",
        label: "Phân tích hiệu quả chi nhánh...",
        slices: ["overview"],                           // chỉ cần KPIs tổng
        instruction: `# 1️⃣ Sức khỏe tổng thể cơ sở
- Đánh giá: chi tiêu, leads, CPL so với benchmark ngành (CPL < 200K là tốt).
- Kết luận trạng thái: TỐT / TRUNG BÌNH / CẦN CAN THIỆP.
- Nhận xét khả năng sinh lời và xu hướng hiệu quả.`,
    },
    {
        id: "account_efficiency",
        title: "Hiệu quả tài khoản/chiến dịch",
        label: "So sánh hiệu suất các tài khoản...",
        slices: ["overview", "breakdown"],              // cần bảng để so sánh
        instruction: `# 2️⃣ Hiệu quả tài khoản/chiến dịch
- Bảng xếp hạng theo CPL: tốt nhất → kém nhất, nêu tên và số liệu.
- Chênh lệch CPL giữa tốt nhất và kém nhất là bao nhiêu lần/phần trăm?
- Đề xuất tối ưu cụ thể cho từng tài khoản/chiến dịch.`,
    },
    {
        id: "quality",
        title: "Chất lượng Lead cơ sở",
        label: "Kiểm toán chất lượng khách hàng khu vực...",
        slices: ["overview", "leadQuality"],            // chỉ cần overview + lead quality
        instruction: `# 3️⃣ Chất lượng Lead cơ sở
- Đánh giá tỷ lệ lead tiềm năng của toàn bộ cơ sở.
- Benchmark: > 40% tốt | < 20% đáng lo ngại.
- CPL thực cho lead tiềm năng = Spend / Lead tiềm năng.
- Đề xuất cải thiện cụ thể nếu tỷ lệ dưới chuẩn.`,
    },
    {
        id: "risk_summary",
        title: "Rủi ro & Tổng kết CEO",
        label: "Đánh giá rủi ro chiến lược cơ sở...",
        slices: ["overview", "breakdown", "leadQuality"],
        instruction: `# 4️⃣ Rủi ro chiến lược & Tổng kết CEO
- TOP 3 rủi ro lớn nhất: phân bổ ngân sách mất cân đối, CPL leo thang, lead quality giảm.
- Mỗi rủi ro → nêu số liệu cụ thể + mức nghiêm trọng (CAO/TRUNG BÌNH/THẤP).
- Tóm tắt 5 dòng ngắn gọn cho CEO: tình hình cơ sở, hành động ưu tiên #1.
- Đề xuất cụ thể cho kỳ tiếp theo.`,
    },
];

// ─────────────────────────────────────────────────────────────
// Build full prompt for a section
// = scoped data (only needed slices) + instruction
// ─────────────────────────────────────────────────────────────
function buildSectionPrompt(section: SectionDef, metrics: MetricsPayload): string {
    const data = buildScopedData(metrics, section.slices);
    return `${data}\n\n---\nNHIỆM VỤ PHÂN TÍCH:\n${section.instruction}`;
}

// ─────────────────────────────────────────────────────────────
// Synthesis prompt — NO raw data re-injection
// Just the section outputs + merge instruction
// ─────────────────────────────────────────────────────────────
function buildSynthesisPrompt(outputs: string[], campaignName: string): string {
    return `Dưới đây là các phần phân tích riêng lẻ cho báo cáo "${campaignName}":

${outputs.join("\n\n---\n\n")}

---
NHIỆM VỤ: Ghép thành một báo cáo CEO duy nhất, liền mạch.
- Giữ NGUYÊN VẸN toàn bộ số liệu, tên thực thể, bảng biểu — KHÔNG thêm, KHÔNG bớt, KHÔNG suy diễn.
- Chỉ sửa transition giữa các phần để đọc tự nhiên, chuyên nghiệp.
- Header phân cấp rõ ràng (H1 → H2). Bắt đầu thẳng, không lời dẫn.`;
}

// ─────────────────────────────────────────────────────────────
// Gemini API call — with timeout + 1 retry
// ─────────────────────────────────────────────────────────────
const GEMINI_TIMEOUT_MS = 90_000; // 90 seconds per section

async function callGeminiOnce(apiKey: string, prompt: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

    try {
        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                signal: controller.signal,
                body: JSON.stringify({
                    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: GEMINI_CONFIG,
                }),
            }
        );
        if (!res.ok) throw new Error(`Gemini API Error: ${await res.text()}`);
        const data = await res.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    } finally {
        clearTimeout(timer);
    }
}

async function callGemini(apiKey: string, prompt: string): Promise<string> {
    try {
        return await callGeminiOnce(apiKey, prompt);
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[AI] First attempt failed (${msg}), retrying in 2s...`);
        await new Promise(r => setTimeout(r, 2000));
        return await callGeminiOnce(apiKey, prompt);
    }
}

// ─────────────────────────────────────────────────────────────
// Stream helper
// ─────────────────────────────────────────────────────────────
const encoder = new TextEncoder();
function streamChunk(ctrl: ReadableStreamDefaultController, payload: unknown) {
    ctrl.enqueue(encoder.encode(JSON.stringify(payload) + "\n"));
}

// ─────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────
async function orchestrate(
    apiKey: string,
    metrics: MetricsPayload,
    ctrl: ReadableStreamDefaultController,
    userId: number | string
) {
    try {
        const sections =
            metrics.type === "branch"  ? BRANCH_SECTIONS  :
            metrics.type === "account" ? ACCOUNT_SECTIONS :
                                         CAMPAIGN_SECTIONS;

        const typeLabel =
            metrics.type === "branch"  ? "cơ sở"     :
            metrics.type === "account" ? "tài khoản"  :
                                         "chiến dịch";

        streamChunk(ctrl, {
            type: "status",
            message: `Đang phân tích ${typeLabel} — ${sections.length} phần tuần tự...`,
        });

        // Debug: log prompt sizes per section
        sections.forEach((s) => {
            const size = buildSectionPrompt(s, metrics).length;
            console.log(`[AI] Section "${s.id}" prompt size: ${size} chars (slices: ${s.slices.join(", ")})`);
        });

        // ── SEQUENTIAL: gọi từng section một để tránh rate-limit ──────
        const results: Array<{ id: string; content: string; success: boolean }> = [];
        for (const section of sections) {
            streamChunk(ctrl, { type: "status", message: section.label });
            try {
                const content = await callGemini(apiKey, buildSectionPrompt(section, metrics));
                streamChunk(ctrl, {
                    type: "status",
                    sectionId: section.id,
                    message: `✅ Đã xong: ${section.title}`,
                });
                results.push({ id: section.id, content, success: true });
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                console.error(`[AI] Section "${section.id}" failed:`, msg);
                results.push({ id: section.id, content: "", success: false });
            }
        }
        // ────────────────────────────────────────────────────────────────

        const successOutputs = results
            .filter((r) => r.success && r.content)
            .map((r) => r.content);

        if (successOutputs.length === 0) {
            throw new Error("Tất cả section đều thất bại, không thể tổng hợp báo cáo.");
        }

        streamChunk(ctrl, { type: "status", message: "Đang tổng hợp báo cáo CEO..." });

        const finalReport = await callGemini(
            apiKey,
            buildSynthesisPrompt(successOutputs, metrics.campaignName as string)
        );

        const lq = metrics.leadQuality as Record<string, number> | undefined;
        const outputMetrics = {
            spend:          metrics.spend,
            impressions:    metrics.impressions,
            clicks:         metrics.clicks,
            totalResults:   lq?.totalCount ?? metrics.totalResults,
            potentialLeads: lq?.potentialCount,
            ctr:            metrics.ctr,
            cpc:            metrics.cpc,
            cpl:            metrics.cpl,
            dateStart:      metrics.dateStart,
            dateEnd:        metrics.dateEnd,
        };

        streamChunk(ctrl, {
            type: "final",
            data: {
                campaignName: metrics.campaignName,
                metrics:      outputMetrics,
                report:       finalReport,
                createdAt:    new Date().toISOString(),
                dateRange:    { start: metrics.dateStart, end: metrics.dateEnd },
            },
        });

        // Fire-and-forget DB save
        supabase.from("ai_reports").insert({
            user_id:        userId,
            type:           metrics.type,
            reference_id:   metrics.referenceId,
            campaign_name:  metrics.campaignName,
            metrics:        outputMetrics,
            report_content: finalReport,
        }).then(({ error }: { error: unknown }) => {
            if (error) console.error("[AI] DB Save Error:", error);
        });

    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[AI] Orchestration error:", msg);
        streamChunk(ctrl, { type: "error", message: msg });
    } finally {
        ctrl.close();
    }
}

// ─────────────────────────────────────────────────────────────
// Main Handler
// ─────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

    const url = new URL(req.url);
    const forceRefresh = url.searchParams.get("force") === "true";

    try {
        if (url.pathname.includes("/report/generate") && req.method === "POST") {
            const body = await req.json();
            const { type, referenceId, campaignName, metrics } = body;

            if (!type || !referenceId || !campaignName || !metrics) {
                return jsonResponse(
                    { success: false, error: "Missing required fields: type, referenceId, campaignName, metrics" },
                    400
                );
            }

            // 1. AUTH CHECK
            const auth = await verifyAuth(req);
            if (!auth) return jsonResponse({ success: false, error: "Unauthorized" }, 401);
            const userId = auth.userId;

            // 2. Cache check
            if (!forceRefresh) {
                const { data: cached, error: cacheErr } = await supabase
                    .from("ai_reports")
                    .select("*")
                    .eq("type", type)
                    .eq("reference_id", referenceId)
                    .filter("user_id", "eq", userId) // Secure cache access
                    .order("created_at", { ascending: false })
                    .limit(1)
                    .maybeSingle();

                if (cacheErr) console.error("[Report] Cache error:", cacheErr);
                if (cached) {
                    return jsonResponse({
                        success: true,
                        data: {
                            campaignName: cached.campaign_name,
                            metrics:      cached.metrics,
                            report:       cached.report_content,
                            createdAt:    cached.created_at,
                        },
                    });
                }
            }

            // 3. Fetch Gemini API Key for THIS user
            const { data: userData, error: userError } = await supabase
                .from("users")
                .select("gemini_api_key")
                .eq("id", userId)
                .not("gemini_api_key", "is", null)
                .maybeSingle();

            if (userError) throw userError;
            if (!userData?.gemini_api_key) {
                return jsonResponse(
                    { success: false, error: "Bạn chưa cấu hình Gemini API Key cho tài khoản này." },
                    400
                );
            }

            // Normalize & compute derived metrics
            const spend        = Number(metrics.spend        || 0);
            const impressions  = Number(metrics.impressions   || 0);
            const clicks       = Number(metrics.clicks        || 0);
            const totalResults = Number(metrics.totalResults  || metrics.totalLeads || metrics.results || 0);

            const geminiMetrics: MetricsPayload = {
                ...metrics,
                referenceId,
                campaignName,
                type,
                spend,
                impressions,
                clicks,
                totalLeads:   totalResults,
                ctr: impressions  > 0 ? (clicks / impressions) * 100 : 0,
                cpc: clicks       > 0 ? spend / clicks               : 0,
                cpl: totalResults > 0 ? spend / totalResults         : 0,
            };

            const stream = new ReadableStream({
                start(ctrl) {
                    orchestrate(userData.gemini_api_key, geminiMetrics, ctrl, userId);
                },
            });

            return new Response(stream, {
                headers: {
                    ...corsHeaders,
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    "Connection":    "keep-alive",
                },
            });
        }

        return jsonResponse({ success: false, error: "Not Found", path: url.pathname }, 404);

    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error("Critical Function Error:", msg);
        return jsonResponse({ success: false, error: msg }, 500);
    }
});
