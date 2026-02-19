// src/app/api/summarize/route.ts
import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { Buffer } from "buffer";
import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";
import { SummarySource } from "@prisma/client";

export const runtime = "nodejs";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null;
}

/**
 * ✅ UI source -> Prisma Enum
 * "pdf+image" => pdf_image
 */
function toDbSource(source: "pdf" | "image" | "pdf+image"): SummarySource {
    if (source === "pdf") return SummarySource.pdf;
    if (source === "image") return SummarySource.image;
    return SummarySource.pdf_image;
}

/**
 * ✅ Prisma Enum -> UI source
 * pdf_image => "pdf+image"
 */
function toApiSource(source: SummarySource | string): "pdf" | "image" | "pdf+image" {
    return source === "pdf_image" ? "pdf+image" : (source as "pdf" | "image");
}

/**
 * PDF -> text (text layer varsa) | ✅ TÜM SAYFALAR
 */
async function parsePdfToText(buffer: Buffer): Promise<string> {
    const pdfjs: unknown = await import("pdfjs-dist/legacy/build/pdf.mjs");

    if (!isRecord(pdfjs) || typeof (pdfjs as any).getDocument !== "function") {
        throw new Error("pdfjs yüklenemedi (getDocument yok).");
    }

    const getDocument = (pdfjs as any).getDocument as (opts: {
        data: Uint8Array;
        disableWorker: boolean;
    }) => { promise: Promise<unknown> };

    const loadingTask = getDocument({
        data: new Uint8Array(buffer),
        disableWorker: true,
    });

    const pdfUnknown = await loadingTask.promise;

    if (
        !isRecord(pdfUnknown) ||
        typeof (pdfUnknown as any).numPages !== "number" ||
        typeof (pdfUnknown as any).getPage !== "function"
    ) {
        throw new Error("PDF parse başarısız.");
    }

    const pdf = pdfUnknown as {
        numPages: number;
        getPage: (n: number) => Promise<{
            getTextContent: () => Promise<{ items: Array<{ str?: string }> }>;
        }>;
    };

    const texts: string[] = [];
    const maxPages = pdf.numPages;

    for (let i = 1; i <= maxPages; i++) {
        const page = await pdf.getPage(i);
        const tc = await page.getTextContent();
        for (const item of tc.items) if (item?.str) texts.push(item.str);
        texts.push("\n");
    }

    return texts.join(" ").replace(/\s+/g, " ").trim();
}

// ---- JSON parse ----
type SummaryJSON = { title?: string; summary: string; keywords: string[] };

function extractJson(raw: string): string | null {
    const s = raw.indexOf("{");
    const e = raw.lastIndexOf("}");
    if (s < 0 || e <= s) return null;
    return raw.slice(s, e + 1);
}

function normalizeSummary(v: unknown): SummaryJSON | null {
    if (!isRecord(v)) return null;
    if (typeof (v as any).summary !== "string") return null;

    const title = typeof (v as any).title === "string" ? (v as any).title : undefined;

    let keywords: string[] = [];
    if (Array.isArray((v as any).keywords)) {
        keywords = (v as any).keywords.filter((k: unknown) => typeof k === "string") as string[];
    }
    if (keywords.length === 0) keywords = ["summary", "document", "analysis"];

    return { title, summary: (v as any).summary, keywords };
}

function parseSummary(raw: string): SummaryJSON | null {
    try {
        return normalizeSummary(JSON.parse(raw));
    } catch {
        const sliced = extractJson(raw);
        if (!sliced) return null;
        try {
            return normalizeSummary(JSON.parse(sliced));
        } catch {
            return null;
        }
    }
}

// ✅ Görselleri küçült (Gemini'ye yollamadan önce)
async function compressImageToJpegBase64(file: File): Promise<{ mime: string; b64: string }> {
    const ab = await file.arrayBuffer();
    const input = Buffer.from(ab);

    const out = await sharp(input)
        .rotate()
        .resize({ width: 1400, withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();

    return { mime: "image/jpeg", b64: out.toString("base64") };
}

// ✅ Scan PDF için: PDF buffer -> ilk N sayfayı JPEG base64'e çevir (sharp ile)
async function pdfBufferToJpegPagesBase64(
    pdfBuffer: Buffer,
    maxPages = 2
): Promise<Array<{ mime: string; b64: string }>> {
    let totalPages = 1;

    try {
        const meta = await sharp(pdfBuffer, { density: 160 }).metadata();
        if (typeof meta.pages === "number" && meta.pages > 0) totalPages = meta.pages;
    } catch {
        totalPages = 1;
    }

    const pagesToRender = Math.min(totalPages, maxPages);
    const out: Array<{ mime: string; b64: string }> = [];

    for (let i = 0; i < pagesToRender; i++) {
        const jpg = await sharp(pdfBuffer, { density: 160, page: i })
            .rotate()
            .resize({ width: 1400, withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toBuffer();

        out.push({ mime: "image/jpeg", b64: jpg.toString("base64") });
    }

    return out;
}

// ✅ Tüm PDF için: Chunk (map-reduce) özet
function chunkText(s: string, chunkSize = 9000) {
    const t = (s || "").trim();
    if (!t) return [];
    const out: string[] = [];
    for (let i = 0; i < t.length; i += chunkSize) out.push(t.slice(i, i + chunkSize));
    return out;
}

const ACADEMIC_GUIDE = [
    "ONLY return JSON. No markdown fences. No extra text.",
    'Schema: {"title"?:string,"summary":string,"keywords":string[]}',
    "Write in the same language as the document.",
    "Write an ACADEMIC summary suitable for a course assignment.",
    "Use a structured format INSIDE the summary field (Markdown headings are allowed inside the string).",
    "Required structure inside summary:",
    "1) ## Amaç ve Kapsam",
    "2) ## Temel Kavramlar ve Tanımlar (terimleri kısa tanımla: CLR, IL, JIT, CLS/CTS, ASP.NET, ADO.NET, Windows Forms vb.)",
    "3) ## Mimari / Çalışma Mantığı (adım adım: kaynak kod -> IL -> CLR -> JIT -> makine kodu)",
    "4) ## Bileşenler ve Örnekler (servisler, araçlar, kullanım alanları)",
    "5) ## Karşılaştırma (varsa: J2EE vs .NET; JVM vs CLR; portability; tools)",
    "6) ## Sonuç (ana çıkarımlar, neden önemli?)",
    "Avoid tekrar/boş cümle. Teknik terimleri KORU.",
    "keywords: 8-12 adet, ders için anlamlı terimler.",
].join("\n");

async function geminiSummarizeTextChunkAcademic(text: string) {
    const parts = [
        {
            text:
                "ONLY return JSON.\n" +
                'Schema: {"summary":string,"keywords":string[]}\n' +
                "Write in the same language as the text.\n" +
                "Write an ACADEMIC chunk summary.\n" +
                "summary: 10-14 sentences.\n" +
                "Must include key definitions/terms mentioned in this chunk.\n" +
                "keywords: 6-10.\n\n" +
                `TEXT:\n${text}`,
        },
    ];

    const r = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [{ role: "user", parts }],
    });

    return typeof (r as any).text === "string" ? (r as any).text : String((r as any).text ?? "");
}

async function geminiFinalSummaryAcademic(partials: string, summaryLength: string) {
    const parts = [
        {
            text:
                `${ACADEMIC_GUIDE}\n` +
                `Length guidance (sentences): ${summaryLength}.\n` +
                "Merge the chunk summaries into ONE coherent academic summary.\n" +
                "Remove duplicates but keep depth.\n" +
                "If document includes section about comparison (e.g., J2EE vs .NET), 반드시 ekle.\n\n" +
                `CHUNK_SUMMARIES:\n${partials}`,
        },
    ];

    const r = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [{ role: "user", parts }],
    });

    return typeof (r as any).text === "string" ? (r as any).text : String((r as any).text ?? "");
}

async function summarizeFullPdfTextAcademic(pdfText: string, summaryLength: string) {
    const chunks = chunkText(pdfText, 9000);
    if (chunks.length === 0) throw new Error("PDF metni boş.");

    const partialJsons: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
        const raw = await geminiSummarizeTextChunkAcademic(chunks[i]);
        partialJsons.push(`CHUNK_${i + 1}: ${raw}`);
    }

    return await geminiFinalSummaryAcademic(partialJsons.join("\n\n"), summaryLength);
}

export async function POST(req: Request) {
    try {
        if (!process.env.GEMINI_API_KEY) {
            return NextResponse.json({ ok: false, error: "GEMINI_API_KEY yok (.env.local)." }, { status: 500 });
        }

        const { userId } = await auth();
        if (!userId) {
            return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
        }

        const form = await req.formData();
        const pdfFile = form.get("pdf") as File | null;
        const images = form.getAll("images").filter(Boolean) as File[];

        if (!pdfFile && images.length === 0) {
            return NextResponse.json({ ok: false, error: "PDF veya en az 1 görsel yükle." }, { status: 400 });
        }

        // 1) PDF text çıkar (tüm sayfalar)
        let pdfText = "";
        let pdfBuf: Buffer | null = null;

        if (pdfFile) {
            const ab = await pdfFile.arrayBuffer();
            pdfBuf = Buffer.from(ab);
            try {
                pdfText = await parsePdfToText(pdfBuf);
            } catch {
                pdfText = "";
            }
        }

        // 🔥 Dinamik özet uzunluğu
        let summaryLength = "18-24";
        if (pdfText && pdfText.length > 0) {
            if (pdfText.length < 10000) {
                summaryLength = "16-22";
            } else if (pdfText.length < 40000) {
                summaryLength = "24-34";
            } else {
                summaryLength = "34-45";
            }
        }

        // 2) Taranmış PDF (text yok) + kullanıcı görsel yoksa: PDF’den ilk 2 sayfayı görsele çevir
        let autoPdfImages: Array<{ mime: string; b64: string }> = [];

        if (pdfFile && pdfText.trim().length === 0 && images.length === 0) {
            try {
                const buf = pdfBuf ?? Buffer.from(await pdfFile.arrayBuffer());
                autoPdfImages = await pdfBufferToJpegPagesBase64(buf, 2);

                if (autoPdfImages.length === 0) {
                    return NextResponse.json(
                        {
                            ok: false,
                            error:
                                "Bu PDF taranmış (text layer yok) ve otomatik görsel çıkarma başarısız oldu. Çözüm: PDF sayfasının ekran görüntüsünü / sayfa görselini 'Görsel ekle' ile yükle.",
                        },
                        { status: 400 }
                    );
                }
            } catch (e) {
                console.error("Auto PDF->Image error:", e);
                return NextResponse.json(
                    {
                        ok: false,
                        error:
                            "Bu PDF taranmış (text layer yok). Otomatik sayfa görseli çıkarılamadı. Çözüm: PDF sayfasının ekran görüntüsünü / sayfa görselini 'Görsel ekle' ile yükle (Gemini görselden özet çıkarır).",
                    },
                    { status: 400 }
                );
            }
        }

        const hasAnyImages = images.length > 0 || autoPdfImages.length > 0;

        // 3) Özet üret
        let raw = "";

        if (pdfText && pdfText.length > 12000 && !hasAnyImages) {
            raw = await summarizeFullPdfTextAcademic(pdfText, summaryLength);
        } else {
            const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];

            parts.push({
                text:
                    `${ACADEMIC_GUIDE}\n` +
                    `Length guidance (sentences): ${summaryLength}.\n\n` +
                    (pdfText ? `PDF TEXT:\n${pdfText.slice(0, 12000)}\n\n` : "PDF TEXT: (none / scanned)\n\n") +
                    (hasAnyImages ? "IMAGES attached below.\n" : "IMAGES: (none)\n"),
            });

            for (const img of images.slice(0, 4)) {
                const { mime, b64 } = await compressImageToJpegBase64(img);
                parts.push({ inlineData: { mimeType: mime, data: b64 } });
            }

            for (const a of autoPdfImages.slice(0, 4)) {
                parts.push({ inlineData: { mimeType: a.mime, data: a.b64 } });
            }

            const result = await ai.models.generateContent({
                model: "gemini-3-flash-preview",
                contents: [{ role: "user", parts }],
            });

            raw = typeof (result as any).text === "string" ? (result as any).text : String((result as any).text ?? "");
        }

        const parsed = parseSummary(raw);
        if (!parsed) {
            return NextResponse.json({ ok: false, error: "Model JSON dönmedi.", raw: raw.slice(0, 300) }, { status: 500 });
        }

        const sourceUI: "pdf" | "image" | "pdf+image" =
            pdfFile && hasAnyImages ? "pdf+image" : pdfFile ? "pdf" : "image";

        const sourceDB = toDbSource(sourceUI);

        const saved = await prisma.summary.create({
            data: {
                userId,
                source: sourceDB, // ✅ enum
                title: parsed.title?.slice(0, 140) || "Akademik Özet",
                summary: parsed.summary,
                keywords: parsed.keywords, // ✅ Json/string[] ise parse/stringify yok
                inputText: pdfText || "",
            },
            select: {
                id: true,
                createdAt: true,
                source: true,
                title: true,
                summary: true,
                keywords: true,
            },
        });

        return NextResponse.json({
            ok: true,
            data: {
                ...saved,
                source: toApiSource(saved.source),
                keywords: Array.isArray(saved.keywords) ? (saved.keywords as string[]) : [], // ✅ TS2345 fix
            },
        });
    } catch (e: unknown) {
        const msg =
            isRecord(e) && "message" in e && typeof (e as { message?: unknown }).message === "string"
                ? (e as { message: string }).message
                : "Server error";

        return NextResponse.json({ ok: false, error: msg }, { status: 500 });
    }
}
