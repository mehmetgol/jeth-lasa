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
    id: string; // ✅ artık DB id
    createdAt: number; // ✅ ms timestamp (UI için)
    pdfName?: string;
    imageCount?: number;
    result: ApiSummary;
};

// --- Yardımcı Fonksiyonlar ---
function formatDateTR(ts: number) {
    return new Date(ts).toLocaleString("tr-TR");
}

function clip(s: string, n: number) {
    const t = (s || "").trim().replace(/\s+/g, " ");
    return t.length <= n ? t : t.slice(0, n) + "…";
}

function isOkResponse(v: unknown): v is { ok: true; data: any } {
    if (typeof v !== "object" || v === null) return false;
    const o = v as Record<string, unknown>;
    return o.ok === true && "data" in o;
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
async function fetchWithRetry(input: RequestInfo | URL, init: RequestInit, retries = 3) {
    let lastErr: unknown = null;

    for (let i = 0; i <= retries; i++) {
        try {
            const res = await fetch(input, init);

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

// ✅ DB source -> UI source (kritik!)
function toUiSource(s: unknown): ApiSummary["source"] {
    if (s === "pdf") return "pdf";
    if (s === "image") return "image";
    if (s === "pdf_image" || s === "pdf+image") return "pdf+image";
    return "pdf";
}

// ✅ keywords Json -> string[]
function normalizeKeywords(v: unknown): string[] {
    if (Array.isArray(v)) return v.filter((x) => typeof x === "string") as string[];
    return [];
}

// ✅ PDF -> PNG Dönüştürücü (TS uyumlu, GlobalWorkerOptions hatasız)
async function pdfToImages(pdfFile: File, maxPages = 2): Promise<File[]> {
    const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as {
        version: string;
        GlobalWorkerOptions: { workerSrc: string };
        getDocument: (src: { data: Uint8Array }) => {
            promise: Promise<{
                numPages: number;
                getPage: (n: number) => Promise<any>;
            }>;
        };
    };

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

        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));

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
    const [pdfConvertStatus, setPdfConvertStatus] = useState<string>("");

    const [summary, setSummary] = useState<ApiSummary | null>(null);
    const [status, setStatus] = useState<string>("");
    const [loading, setLoading] = useState<boolean>(false);

    const [history, setHistory] = useState<HistoryItem[]>([]);
    const [fileKey, setFileKey] = useState<number>(0);

    // ✅ DB'den geçmişi çek (multi-tenant: backend userId ile filtreler)
    async function refreshHistory() {
        try {
            const res = await fetch("/api/history", { method: "GET" });
            const json: unknown = await res.json().catch(() => null);

            if (!res.ok) {
                if (res.status === 401) setHistory([]); // giriş yoksa boş
                setStatus(isErrResponse(json) ? json.error : `Geçmiş alınamadı (${res.status}).`);
                return;
            }

            if (!isOkResponse(json)) {
                setStatus("Geçmiş formatı beklenmiyor.");
                return;
            }

            const rows = (json as any).data as any[];
            const mapped: HistoryItem[] = rows.map((x) => {
                const uiSummary: ApiSummary = {
                    title: String(x.title ?? ""),
                    summary: String(x.summary ?? ""),
                    keywords: normalizeKeywords(x.keywords),
                    source: toUiSource(x.source),
                };

                return {
                    id: String(x.id),
                    createdAt: new Date(x.createdAt).getTime(),
                    pdfName: x.pdfName ?? undefined,
                    imageCount: typeof x.imageCount === "number" ? x.imageCount : undefined,
                    result: uiSummary,
                };
            });

            setHistory(mapped);
        } catch (e) {
            console.error(e);
            setStatus("Geçmiş alınamadı (ağ hatası).");
        }
    }

    // ✅ ilk açılışta geçmişi çek
    useEffect(() => {
        refreshHistory();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const ordered = useMemo(() => [...history].sort((a, b) => b.createdAt - a.createdAt), [history]);

    const effectiveImages = images.length > 0 ? images : pdfImages;
    const canProcess = !!pdf || images.length > 0;

    // PDF Seçilince Otomatik İşleme (manuel görsel varsa gerek yok)
    useEffect(() => {
        let alive = true;

        async function run() {
            setPdfImages([]);
            setPdfConvertStatus("");

            if (!pdf) return;

            if (images.length > 0) {
                setPdfConvertStatus("Manuel görsel seçildiği için PDF dönüştürme atlandı.");
                return;
            }

            setPdfConvertStatus("PDF sayfaları hazırlanıyor...");
            try {
                const imgs = await pdfToImages(pdf, 2);
                if (!alive) return;

                if (imgs.length === 0) {
                    setPdfConvertStatus("PDF içeriği okunamadı. Bu PDF taranmış olabilir. (Çözüm: Manuel sayfa görseli ekleyin.)");
                } else {
                    setPdfImages(imgs);
                    setPdfConvertStatus(`PDF'den ${imgs.length} sayfa hazırlandı ✅`);
                }
            } catch (e) {
                console.error("PDF İşleme Hatası:", e);
                if (!alive) return;
                setPdfConvertStatus("PDF dönüştürme hatası. Bu PDF taranmış/korumalı olabilir. (Çözüm: Manuel görsel ekleyin.)");
            }
        }

        run();
        return () => {
            alive = false;
        };
    }, [pdf, images.length]);

    async function handleSummarize() {
        if (!canProcess) {
            setStatus("Dosya seçilmedi.");
            return;
        }

        if (pdf && images.length === 0 && pdfImages.length === 0) {
            setStatus("PDF sayfaları hazırlanmadı / hazırlanamadı. (Taranmış olabilir: Manuel sayfa görseli ekleyin.)");
            return;
        }

        setLoading(true);
        setStatus("İşleniyor...");
        setSummary(null);

        try {
            const fd = new FormData();
            if (pdf) fd.append("pdf", pdf);
            effectiveImages.forEach((img) => fd.append("images", img));

            const res = await fetchWithRetry("/api/summarize", { method: "POST", body: fd }, 3);

            let json: unknown = null;
            try {
                json = await res.json();
            } catch {}

            if (!res.ok) {
                if (res.status === 429) return void setStatus("Kota sınırına ulaşıldı (429). Biraz sonra tekrar deneyin.");
                if (res.status === 503) return void setStatus("Model şu an yoğun (503). Birkaç saniye sonra tekrar deneyin.");
                if (isErrResponse(json)) return void setStatus(json.error);
                return void setStatus(`Sunucu hatası (${res.status}).`);
            }

            if (!isOkResponse(json)) {
                setStatus(isErrResponse(json) ? json.error : "Beklenmeyen cevap formatı.");
                return;
            }

            const data = (json as any).data as any;

            const uiSummary: ApiSummary = {
                title: String(data.title ?? ""),
                summary: String(data.summary ?? ""),
                keywords: normalizeKeywords(data.keywords),
                source: toUiSource(data.source),
            };

            setSummary(uiSummary);

            // ✅ history’ye DB id ile ekle
            const entry: HistoryItem = {
                id: String(data.id),
                createdAt: new Date(data.createdAt).getTime(),
                pdfName: data.pdfName ?? pdf?.name,
                imageCount: typeof data.imageCount === "number" ? data.imageCount : fd.getAll("images").length,
                result: uiSummary,
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

    const clearHistoryDb = async () => {
        try {
            // ✅ Basit yol: tek tek sil (ama sağlamlaştırdık)
            for (const item of history) {
                const r = await fetch(`/api/history/${item.id}`, { method: "DELETE" });
                if (!r.ok && r.status !== 404) {
                    setStatus(`Geçmiş silinirken hata oluştu (${r.status}).`);
                    return;
                }
            }
            await refreshHistory(); // ✅ DB ile senkron
            setStatus("Geçmiş silindi ✅");
        } catch (e) {
            console.error(e);
            setStatus("Geçmiş silinemedi.");
        }
    };

    const isPreparingPdf = !!pdf && images.length === 0 && pdfConvertStatus.includes("hazırlanıyor");

    return (
        <div style={{ display: "flex", gap: 20, padding: 20 }}>
            {/* Sol Panel */}
            <aside style={{ width: 320, borderRight: "1px solid #ddd", paddingRight: 16 }}>
                <h3 style={{ marginTop: 0 }}>Geçmiş</h3>

                <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                    <button onClick={clearHistoryDb} style={{ padding: "6px 10px" }}>
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
                            <div key={item.id} style={{ border: "1px solid #e5e5e5", padding: 10, borderRadius: 10, background: "#fff" }}>
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
                                    <p style={{ fontSize: 12, color: "#666", margin: "6px 0 0" }}>{formatDateTR(item.createdAt)}</p>
                                    <p style={{ fontSize: 12, color: "#666", margin: "4px 0 0" }}>
                                        {item.pdfName ? `📄 ${clip(item.pdfName, 24)}` : "—"}{" "}
                                        {typeof item.imageCount === "number" ? `• 🖼️ ${item.imageCount}` : ""}
                                    </p>
                                </button>

                                <button
                                    onClick={async () => {
                                        const r = await fetch(`/api/history/${item.id}`, { method: "DELETE" });
                                        if (!r.ok && r.status !== 404) {
                                            setStatus(`Silme başarısız (${r.status}).`);
                                            return;
                                        }
                                        setHistory((h) => h.filter((x) => x.id !== item.id));
                                    }}
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
                                <input
                                    type="file"
                                    accept=".pdf"
                                    onChange={(e) => {
                                        setStatus("");
                                        setSummary(null);
                                        setPdf(e.target.files?.[0] || null);
                                    }}
                                />
                            </div>
                            <div style={{ fontSize: 12, color: "#0b57d0", marginTop: 6 }}>{pdfConvertStatus}</div>
                        </div>

                        <div>
                            <label style={{ fontWeight: 600 }}>Manuel Görsel Ekle (Opsiyonel)</label>
                            <div style={{ marginTop: 6 }}>
                                <input
                                    type="file"
                                    accept="image/*"
                                    multiple
                                    onChange={(e) => {
                                        setStatus("");
                                        setSummary(null);
                                        setImages(Array.from(e.target.files || []));
                                    }}
                                />
                            </div>
                            <div style={{ fontSize: 12, color: "#666", marginTop: 6 }}>
                                Manuel görsel eklersen PDF’den otomatik sayfa üretimi kullanılmaz. Manuel eklemezsen, PDF’den çıkan ilk 2 sayfa otomatik kullanılır.
                            </div>
                        </div>
                    </div>

                    <div style={{ marginTop: 18, display: "flex", gap: 10 }}>
                        <button
                            onClick={handleSummarize}
                            disabled={loading || !canProcess || isPreparingPdf}
                            style={{
                                padding: "10px 18px",
                                cursor: loading || !canProcess || isPreparingPdf ? "not-allowed" : "pointer",
                                opacity: loading || !canProcess || isPreparingPdf ? 0.7 : 1,
                            }}
                            title={isPreparingPdf ? "PDF sayfaları hazırlanıyor..." : ""}
                        >
                            {loading ? "İşleniyor..." : isPreparingPdf ? "PDF Hazırlanıyor..." : "Özetle"}
                        </button>
                        <button onClick={clearAll} style={{ padding: "10px 18px" }}>
                            Temizle
                        </button>
                    </div>

                    <div style={{ marginTop: 12, fontWeight: 700, color: "#111" }}>{status}</div>
                </div>

                {/* Sonuç */}
                <div style={{ marginTop: 20, padding: 20, background: "#f9f9f9", border: "1px solid #eee", borderRadius: 12 }}>
                    {summary ? (
                        <div>
                            <h2 style={{ marginTop: 0, color: "#000" }}>{summary.title}</h2>

                            {/* ✅ Özet kısmı SİYAH */}
                            <p style={{ lineHeight: 1.7, color: "#000", whiteSpace: "pre-wrap" }}>{summary.summary}</p>

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