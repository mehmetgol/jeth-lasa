"use client";

import { useEffect, useMemo, useState } from "react";

// --- Tipler ---
type ApiSummary = {
    title: string;
    summary: string;
    keywords: string[];
    source: "pdf" | "image" | "pdf+image";
};

type HistoryItem = {
    id: string;
    createdAt: number;
    pdfName?: string;
    imageCount?: number;
    result: ApiSummary;
};

const STORAGE_KEY = "jethulasa_history_v3";

// --- Yardımcı Fonksiyonlar ---
function safeParse<T>(raw: string | null, fallback: T): T {
    try {
        return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
        return fallback;
    }
}

function formatDateTR(ts: number) {
    return new Date(ts).toLocaleString("tr-TR");
}

function clip(s: string, n: number) {
    const t = (s || "").trim().replace(/\s+/g, " ");
    return t.length <= n ? t : t.slice(0, n) + "…";
}

function isApiSummary(v: unknown): v is ApiSummary {
    if (typeof v !== "object" || v === null) return false;
    const o = v as Record<string, unknown>;
    return (
        typeof o.title === "string" &&
        typeof o.summary === "string" &&
        Array.isArray(o.keywords) &&
        o.keywords.every((k) => typeof k === "string") &&
        (o.source === "pdf" || o.source === "image" || o.source === "pdf+image")
    );
}

function isOkResponse(v: unknown): v is { ok: true; data: ApiSummary } {
    if (typeof v !== "object" || v === null) return false;
    const o = v as Record<string, unknown>;
    return o.ok === true && "data" in o && isApiSummary(o.data);
}

function isErrResponse(v: unknown): v is { ok: false; error: string } {
    if (typeof v !== "object" || v === null) return false;
    const o = v as Record<string, unknown>;
    return o.ok === false && typeof o.error === "string";
}

function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * 503 (high demand) gibi geçici hatalarda retry yapan fetch wrapper.
 */
async function fetchWithRetry(
    input: RequestInfo | URL,
    init: RequestInit,
    retries = 3
) {
    let lastErr: unknown = null;

    for (let i = 0; i <= retries; i++) {
        try {
            const res = await fetch(input, init);

            // 503 -> geçici yoğunluk, retry
            if (res.status === 503 && i < retries) {
                const wait = 1200 * Math.pow(2, i);
                await sleep(wait);
                continue;
            }

            return res;
        } catch (e) {
            lastErr = e;
            if (i < retries) {
                const wait = 800 * Math.pow(2, i);
                await sleep(wait);
                continue;
            }
            throw lastErr;
        }
    }

    throw lastErr ?? new Error("Beklenmeyen hata");
}

// ✅ PDF -> PNG Dönüştürücü (TS uyumlu, GlobalWorkerOptions hatasız)
async function pdfToImages(pdfFile: File, maxPages = 2): Promise<File[]> {
    const pdfjs = (await import(
        "pdfjs-dist/legacy/build/pdf.mjs"
        )) as unknown as {
        version: string;
        GlobalWorkerOptions: { workerSrc: string };
        getDocument: (src: { data: Uint8Array }) => {
            promise: Promise<{
                numPages: number;
                getPage: (n: number) => Promise<any>;
            }>;
        };
    };

    // Worker'ı aynı sürümden çek
    pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/legacy/build/pdf.worker.min.mjs`;

    const ab = await pdfFile.arrayBuffer();
    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(ab) });
    const pdf = await loadingTask.promise;

    const out: File[] = [];
    const pages = Math.min(pdf.numPages, maxPages);

    for (let p = 1; p <= pages; p++) {
        const page = await pdf.getPage(p);
        const viewport = page.getViewport({ scale: 1.6 });

        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;

        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);

        await page.render({ canvasContext: ctx, viewport }).promise;

        const blob = await new Promise<Blob | null>((resolve) =>
            canvas.toBlob((b) => resolve(b), "image/png")
        );

        if (blob) {
            out.push(
                new File([blob], `${pdfFile.name.replace(/\.pdf$/i, "")}-p${p}.png`, {
                    type: "image/png",
                })
            );
        }
    }

    return out;
}

// --- Ana Sayfa ---
export default function Page() {
    const [pdf, setPdf] = useState<File | null>(null);
    const [images, setImages] = useState<File[]>([]);
    const [pdfImages, setPdfImages] = useState<File[]>([]);
    const [pdfConvertStatus, setPdfConvertStatus] = useState("");

    const [summary, setSummary] = useState<ApiSummary | null>(null);
    const [status, setStatus] = useState("");
    const [loading, setLoading] = useState(false);

    const [history, setHistory] = useState<HistoryItem[]>([]);
    const [fileKey, setFileKey] = useState(0);

    // LocalStorage Yükleme
    useEffect(() => {
        const loaded = safeParse<HistoryItem[]>(
            typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null,
            []
        );
        setHistory(loaded);
    }, []);

    // LocalStorage Kaydetme
    useEffect(() => {
        if (typeof window === "undefined") return;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    }, [history]);

    const ordered = useMemo(
        () => [...history].sort((a, b) => b.createdAt - a.createdAt),
        [history]
    );

    const canProcess = !!pdf || images.length > 0;

    // PDF Seçilince Otomatik İşleme
    useEffect(() => {
        let alive = true;

        async function run() {
            setPdfImages([]);
            setPdfConvertStatus("");
            if (!pdf) return;

            setPdfConvertStatus("PDF sayfaları hazırlanıyor...");
            try {
                const imgs = await pdfToImages(pdf, 2);
                if (!alive) return;

                if (imgs.length === 0) {
                    setPdfConvertStatus("PDF içeriği okunamadı (tarama olabilir).");
                } else {
                    setPdfImages(imgs);
                    setPdfConvertStatus(`PDF'den ${imgs.length} sayfa hazırlandı ✅`);
                }
            } catch (e) {
                console.error("PDF İşleme Hatası:", e);
                if (!alive) return;
                setPdfConvertStatus("PDF dönüştürme hatası. Dosyayı kontrol edin.");
            }
        }

        run();
        return () => {
            alive = false;
        };
    }, [pdf]);

    // Özetle
    async function handleSummarize() {
        if (!canProcess) {
            setStatus("Dosya seçilmedi.");
            return;
        }

        setLoading(true);
        setStatus("İşleniyor...");
        setSummary(null);

        try {
            const fd = new FormData();
            if (pdf) fd.append("pdf", pdf);

            // Kullanıcı görsel eklemişse onları, yoksa PDF'den üretilenleri ekle
            const targetImages = images.length > 0 ? images : pdfImages;
            targetImages.forEach((img) => fd.append("images", img));

            const res = await fetchWithRetry(
                "/api/summarize",
                { method: "POST", body: fd },
                3
            );

            let json: unknown = null;
            try {
                json = await res.json();
            } catch {
                // json gelmezse aşağıda generic hata basarız
            }

            if (!res.ok) {
                if (res.status === 429) {
                    setStatus("Kota sınırına ulaşıldı (429). Biraz sonra tekrar deneyin.");
                    return;
                }
                if (res.status === 503) {
                    setStatus("Model şu an yoğun (503). Birkaç saniye sonra tekrar deneyin.");
                    return;
                }
                if (isErrResponse(json)) {
                    setStatus(json.error);
                    return;
                }
                setStatus(`Sunucu hatası (${res.status}).`);
                return;
            }

            if (!isOkResponse(json)) {
                setStatus(isErrResponse(json) ? json.error : "Beklenmeyen cevap formatı.");
                return;
            }

            const data = json.data;
            setSummary(data);

            const entry: HistoryItem = {
                id: crypto.randomUUID(),
                createdAt: Date.now(),
                pdfName: pdf?.name,
                imageCount: fd.getAll("images").length,
                result: data,
            };

            setHistory((prev) => [entry, ...prev]);
            setStatus("Özet başarıyla oluşturuldu ✅");
        } catch (e) {
            console.error(e);
            setStatus("Bağlantı / ağ hatası. İnterneti veya sunucuyu kontrol edin.");
        } finally {
            setLoading(false);
        }
    }

    const clearAll = () => {
        setPdf(null);
        setImages([]);
        setPdfImages([]);
        setPdfConvertStatus("");
        setSummary(null);
        setStatus("Temizlendi.");
        setFileKey((k) => k + 1);
    };

    return (
        <div style={{ display: "flex", gap: 20, padding: 20 }}>
            {/* Sol Panel */}
            <aside style={{ width: 320, borderRight: "1px solid #ddd", paddingRight: 16 }}>
                <h3 style={{ marginTop: 0 }}>Geçmiş</h3>

                <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                    <button onClick={() => setHistory([])} style={{ padding: "6px 10px" }}>
                        Geçmişi Sil
                    </button>
                    <button onClick={clearAll} style={{ padding: "6px 10px" }}>
                        Formu Temizle
                    </button>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {ordered.length === 0 ? (
                        <div style={{ color: "#777", fontSize: 13 }}>Henüz kayıt yok.</div>
                    ) : (
                        ordered.map((item) => (
                            <div
                                key={item.id}
                                style={{
                                    border: "1px solid #e5e5e5",
                                    padding: 10,
                                    borderRadius: 10,
                                    background: "#fff",
                                }}
                            >
                                <button
                                    onClick={() => {
                                        setSummary(item.result);
                                        setStatus("Geçmişten yüklendi");
                                    }}
                                    style={{
                                        background: "none",
                                        border: "none",
                                        textAlign: "left",
                                        cursor: "pointer",
                                        width: "100%",
                                        padding: 0,
                                    }}
                                >
                                    <strong style={{ display: "block" }}>{clip(item.result.title, 60)}</strong>
                                    <p style={{ fontSize: 12, color: "#666", margin: "6px 0 0" }}>
                                        {formatDateTR(item.createdAt)}
                                    </p>
                                    <p style={{ fontSize: 12, color: "#666", margin: "4px 0 0" }}>
                                        {item.pdfName ? `📄 ${clip(item.pdfName, 24)}` : "—"}{" "}
                                        {typeof item.imageCount === "number" ? `• 🖼️ ${item.imageCount}` : ""}
                                    </p>
                                </button>

                                <button
                                    onClick={() => setHistory((h) => h.filter((x) => x.id !== item.id))}
                                    style={{ fontSize: 11, color: "crimson", marginTop: 8 }}
                                >
                                    Sil
                                </button>
                            </div>
                        ))
                    )}
                </div>
            </aside>

            {/* Ana İçerik */}
            <main style={{ flex: 1 }}>
                <header>
                    <h1 style={{ margin: 0 }}>Jethülasa</h1>
                    <p style={{ marginTop: 6, color: "#444" }}>Akıllı PDF ve Görsel Analizörü</p>
                </header>

                <div style={{ marginTop: 20, padding: 20, border: "1px solid #eee", borderRadius: 12 }}>
                    <div key={fileKey} style={{ display: "grid", gap: 16 }}>
                        <div>
                            <label style={{ fontWeight: 600 }}>PDF Dosyası</label>
                            <div style={{ marginTop: 6 }}>
                                <input type="file" accept=".pdf" onChange={(e) => setPdf(e.target.files?.[0] || null)} />
                            </div>
                            <div style={{ fontSize: 12, color: "#0b57d0", marginTop: 6 }}>
                                {pdfConvertStatus}
                            </div>
                        </div>

                        <div>
                            <label style={{ fontWeight: 600 }}>Manuel Görsel Ekle (Opsiyonel)</label>
                            <div style={{ marginTop: 6 }}>
                                <input
                                    type="file"
                                    accept="image/*"
                                    multiple
                                    onChange={(e) => setImages(Array.from(e.target.files || []))}
                                />
                            </div>
                            <div style={{ fontSize: 12, color: "#666", marginTop: 6 }}>
                                Manuel görsel eklemezsen, PDF’den çıkan ilk 2 sayfa otomatik kullanılacak.
                            </div>
                        </div>
                    </div>

                    <div style={{ marginTop: 18, display: "flex", gap: 10 }}>
                        <button
                            onClick={handleSummarize}
                            disabled={loading || !canProcess}
                            style={{ padding: "10px 18px", cursor: loading || !canProcess ? "not-allowed" : "pointer" }}
                        >
                            {loading ? "İşleniyor..." : "Özetle"}
                        </button>
                        <button onClick={clearAll} style={{ padding: "10px 18px" }}>
                            Temizle
                        </button>
                    </div>

                    <div style={{ marginTop: 12, fontWeight: 700, color: "#111" }}>{status}</div>
                </div>

                {/* Sonuç */}
                <div
                    style={{
                        marginTop: 20,
                        padding: 20,
                        background: "#f9f9f9",
                        border: "1px solid #eee",
                        borderRadius: 12,
                    }}
                >
                    {summary ? (
                        <div>
                            <h2 style={{ marginTop: 0, color: "#000" }}>{summary.title}</h2>

                            {/* ✅ Özet siyah */}
                            <p style={{ lineHeight: 1.7, color: "#000", whiteSpace: "pre-wrap" }}>
                                {summary.summary}
                            </p>

                            <div style={{ marginTop: 14, color: "#000" }}>
                                <strong>Anahtar Kelimeler:</strong> {summary.keywords.join(", ")}
                            </div>

                            <div style={{ marginTop: 10, fontSize: 12, color: "#333" }}>
                                Kaynak: <strong>{summary.source}</strong>
                            </div>
                        </div>
                    ) : (
                        <p style={{ color: "#777", margin: 0 }}>Dosya yükleyin ve analiz edin.</p>
                    )}
                </div>
            </main>
        </div>
    );
}
