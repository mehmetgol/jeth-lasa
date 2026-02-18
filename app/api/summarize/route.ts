import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { Buffer } from "buffer";
import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";

export const runtime = "nodejs";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null;
}

/**
 * PDF -> text (text layer varsa)
 */
async function parsePdfToText(buffer: Buffer): Promise<string> {
    const pdfjs: unknown = await import("pdfjs-dist/legacy/build/pdf.mjs");

    if (!isRecord(pdfjs) || typeof pdfjs.getDocument !== "function") {
        throw new Error("pdfjs yüklenemedi (getDocument yok).");
    }

    const getDocument = pdfjs.getDocument as (opts: {
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
        typeof pdfUnknown.numPages !== "number" ||
        typeof pdfUnknown.getPage !== "function"
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
    const maxPages = Math.min(pdf.numPages, 20);

    for (let i = 1; i <= maxPages; i++) {
        const page = await pdf.getPage(i);
        const tc = await page.getTextContent();
        for (const item of tc.items) if (item?.str) texts.push(item.str);
        texts.push("\n");
    }

    return texts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Scan PDF durumunda:
 * PDF'yi görsele çevirmek için en stabil yöntem:
 * - pdfjs ile sayfayı render etmek (canvas) Next ortamında zor
 * - Bu yüzden: kullanıcıdan PDF sayfasını "görsel" olarak da yüklemesini isteyebiliriz
 *
 * AMA sen “sadece PDF” olsun istiyorsun.
 * O zaman: pdfjs-dist + node-canvas gerekir (Windows'ta uğraştırır).
 *
 * Burada pratik çözüm:
 * - Eğer PDF text yoksa, kullanıcıya “PDF taranmış, lütfen sayfanın ekran görüntüsünü/görselini yükle” diyelim.
 *
 * (İstersen bir sonraki adımda node-canvas ile otomatik PDF->image render da kurarız.)
 */

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
    if (typeof v.summary !== "string") return null;

    const title = typeof v.title === "string" ? v.title : undefined;

    let keywords: string[] = [];
    if (Array.isArray(v.keywords)) {
        keywords = v.keywords.filter((k) => typeof k === "string") as string[];
    }
    if (keywords.length === 0) keywords = ["summary", "document", "analysis"];

    return { title, summary: v.summary, keywords };
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

function toBase64(ab: ArrayBuffer) {
    return Buffer.from(ab).toString("base64");
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

        // 1) PDF text çıkar
        let pdfText = "";
        if (pdfFile) {
            const ab = await pdfFile.arrayBuffer();
            const buf = Buffer.from(ab);
            try {
                pdfText = await parsePdfToText(buf);
            } catch {
                pdfText = "";
            }
        }

        // 2) Eğer text yoksa ama kullanıcı görsel de yüklemediyse -> net mesaj
        if (pdfFile && pdfText.trim().length === 0 && images.length === 0) {
            return NextResponse.json(
                {
                    ok: false,
                    error:
                        "Bu PDF taranmış (text layer yok). Çözüm: PDF sayfasının ekran görüntüsünü / sayfa görselini 'Görsel ekle' ile yükle (Gemini görselden özet çıkarır). İstersen sonraki adımda otomatik PDF→görsel dönüştürme de ekleriz.",
                },
                { status: 400 }
            );
        }

        // 3) Gemini input hazırla
        const parts: Array<
            | { text: string }
            | { inlineData: { mimeType: string; data: string } }
        > = [];

        parts.push({
            text:
                "ONLY return JSON.\n" +
                'Schema: {"title"?:string,"summary":string,"keywords":string[]}\n' +
                "Write summary in the same language as the document.\n" +
                "summary 6-10 sentences, keywords 5-10.\n\n" +
                (pdfText ? `PDF TEXT:\n${pdfText.slice(0, 12000)}\n\n` : "PDF TEXT: (none)\n\n") +
                (images.length ? "IMAGES attached below.\n" : "IMAGES: (none)\n"),
        });

        for (const img of images.slice(0, 4)) {
            // küçük optimize
            const { mime, b64 } = await compressImageToJpegBase64(img);
            parts.push({
                inlineData: { mimeType: mime, data: b64 },
            });
        }

        const result = await ai.models.generateContent({
            model: "gemini-3-flash-preview",
            contents: [{ role: "user", parts }],
        });

        const raw = typeof result.text === "string" ? result.text : String(result.text ?? "");
        const parsed = parseSummary(raw);

        if (!parsed) {
            return NextResponse.json({ ok: false, error: "Model JSON dönmedi.", raw: raw.slice(0, 300) }, { status: 500 });
        }

        const source = pdfFile && images.length ? "pdf+image" : pdfFile ? "pdf" : "image";

        const saved = await prisma.summary.create({
            data: {
                userId,
                source,
                title: (parsed.title?.slice(0, 140) || "Özet"),
                summary: parsed.summary,
                keywords: JSON.stringify(parsed.keywords),
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
                keywords: JSON.parse(saved.keywords) as string[],
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
