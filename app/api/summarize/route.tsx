import { NextResponse } from "next/server";

type Source = "text" | "pdf" | "image" | "none";

export async function POST(req: Request) {
    try {
        const form = await req.formData();

        const text = String(form.get("text") || "");
        const pdf = form.get("pdf") as File | null;
        const images = form.getAll("images").filter(Boolean) as File[];

        const source: Source =
            text.trim().length > 0
                ? "text"
                : pdf
                    ? "pdf"
                    : images.length > 0
                        ? "image"
                        : "none";

        if (source === "none") {
            return NextResponse.json(
                { ok: false, error: "Metin veya PDF/Resim göndermelisin." },
                { status: 400 }
            );
        }

        // ✅ DEMO ÖZET (buraya gerçek AI bağlanacak)
        const title =
            source === "text"
                ? "Metin Özeti"
                : source === "pdf"
                    ? `PDF Özeti (${pdf?.name})`
                    : `Görsel Özeti (${images.length} adet)`;

        const summary =
            source === "text"
                ? `Girilen metnin ilk 250 karakteri:\n\n${text.trim().slice(0, 250)}${
                    text.trim().length > 250 ? "..." : ""
                }\n\n(Şu an demo. AI bağlayınca gerçek özet dönecek.)`
                : source === "pdf"
                    ? `PDF alındı: ${pdf?.name}\n\n(Şu an demo. PDF text extract + AI özet eklenecek.)`
                    : `Görsel alındı: ${images.length} adet\n\n(Şu an demo. Vision/OCR + AI özet eklenecek.)`;

        const keywords =
            source === "text"
                ? ["metin", "özet", "anahtar kelime"]
                : source === "pdf"
                    ? ["pdf", "doküman", "özet"]
                    : ["görsel", "analiz", "özet"];

        return NextResponse.json({
            ok: true,
            data: {
                title,
                summary,
                keywords,
                source,
            },
        });
    } catch (e) {
        return NextResponse.json(
            { ok: false, error: "Server hatası (route.ts)." },
            { status: 500 }
        );
    }
}
