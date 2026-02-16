"use client";

import { useEffect, useMemo, useState } from "react";

type ApiSummary = {
    title: string;
    summary: string;
    keywords: string[];
    source: "text" | "pdf" | "image" | "none";
};

type HistoryItem = {
    id: string;
    createdAt: number;

    // input meta
    inputText?: string;
    pdfName?: string;
    imageCount?: number;

    // output
    result: ApiSummary;
};

const STORAGE_KEY = "jethulasa_history_v2";

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

export default function Page() {
    // inputs
    const [text, setText] = useState("");
    const [pdf, setPdf] = useState<File | null>(null);
    const [images, setImages] = useState<File[]>([]);

    // outputs
    const [summary, setSummary] = useState<ApiSummary | null>(null);
    const [status, setStatus] = useState("");
    const [loading, setLoading] = useState(false);

    // history
    const [history, setHistory] = useState<HistoryItem[]>([]);
    const [fileKey, setFileKey] = useState(0); // input reset için

    // load history once
    useEffect(() => {
        const loaded = safeParse<HistoryItem[]>(
            typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null,
            []
        );
        setHistory(loaded);
    }, []);

    // persist history
    useEffect(() => {
        if (typeof window === "undefined") return;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    }, [history]);

    const ordered = useMemo(
        () => [...history].sort((a, b) => b.createdAt - a.createdAt),
        [history]
    );

    const canProcess = text.trim().length > 0 || !!pdf || images.length > 0;

    async function handleSummarize() {
        if (!canProcess) {
            setStatus("Metin veya PDF/Resim eklemelisin.");
            return;
        }

        setLoading(true);
        setStatus("");
        setSummary(null);

        try {
            const fd = new FormData();
            fd.append("text", text);

            if (pdf) fd.append("pdf", pdf);
            for (const img of images) fd.append("images", img);

            const res = await fetch("/api/summarize", {
                method: "POST",
                body: fd,
            });

            const json = await res.json();

            if (!res.ok || !json?.ok) {
                setStatus(json?.error || "Özetleme hatası.");
                setLoading(false);
                return;
            }

            const data = json.data as ApiSummary;
            setSummary(data);

            const entry: HistoryItem = {
                id: crypto?.randomUUID ? crypto.randomUUID() : String(Date.now()),
                createdAt: Date.now(),
                inputText: text.trim() ? text.trim() : undefined,
                pdfName: pdf?.name || undefined,
                imageCount: images.length ? images.length : undefined,
                result: data,
            };

            // en üste ekle
            setHistory((prev) => [entry, ...prev]);
            setStatus("Özet hazır ✅ Geçmişe eklendi.");
        } catch (e) {
            setStatus("Bağlantı/Server hatası. (npm run dev açık mı?)");
        } finally {
            setLoading(false);
        }
    }

    function clearAll() {
        setText("");
        setPdf(null);
        setImages([]);
        setSummary(null);
        setStatus("Temizlendi.");
        setFileKey((k) => k + 1); // file input reset
    }

    function loadFromHistory(item: HistoryItem) {
        setSummary(item.result);
        setText(item.inputText ?? "");
        setStatus("Geçmişten yüklendi ✅");

        // tarayıcı güvenliği: file inputları otomatik doldurulamaz
        setPdf(null);
        setImages([]);
        setFileKey((k) => k + 1);
    }

    function deleteHistoryItem(id: string) {
        setHistory((prev) => prev.filter((x) => x.id !== id));
        setStatus("Geçmişten silindi.");
    }

    function clearHistory() {
        setHistory([]);
        setStatus("Geçmiş temizlendi.");
    }

    const HistoryPanel = ({ title }: { title: string }) => (
        <aside className="panel">
            <h3 className="panelTitle">{title}</h3>

            <div className="actions" style={{ marginTop: 0, marginBottom: 10 }}>
                <button className="btn" type="button" onClick={clearHistory}>
                    Geçmişi Temizle
                </button>
            </div>

            <div className="historyList">
                {ordered.length === 0 ? (
                    <div className="small">Henüz geçmiş yok.</div>
                ) : (
                    ordered.map((item) => (
                        <div key={item.id} style={{ display: "grid", gap: 8 }}>
                            <button
                                className="historyItem"
                                type="button"
                                onClick={() => loadFromHistory(item)}
                            >
                                <div className="historyTitle">{item.result.title}</div>
                                <div className="historyPreview">
                                    {clip(item.result.summary, 140)}
                                </div>
                                <div className="pillRow">
                                    <span>{formatDateTR(item.createdAt)}</span>
                                    <span>Kaynak: {item.result.source}</span>
                                    {item.pdfName ? <span>PDF: {item.pdfName}</span> : null}
                                    {item.imageCount ? <span>Resim: {item.imageCount}</span> : null}
                                </div>
                            </button>

                            <button
                                className="btn"
                                type="button"
                                onClick={() => deleteHistoryItem(item.id)}
                            >
                                Sil
                            </button>
                        </div>
                    ))
                )}
            </div>
        </aside>
    );

    return (
        <div className="layout">
            <HistoryPanel title="Geçmiş (Sol)" />

            <main className="center">
                <header className="header">
                    <h1>Jethülasa</h1>
                    <p>Metin / PDF / Görsel → Özetle → Sonucu göster → Otomatik geçmişe kaydet</p>
                </header>

                {/* INPUT */}
                <section className="card">
                    <label className="label" htmlFor="textInput">
                        Metin
                    </label>

                    <textarea
                        id="textInput"
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        placeholder="Buraya metni yaz..."
                    />

                    <div className="uploads" key={fileKey}>
                        <div className="uploadBox">
                            <span className="label">PDF ekle</span>
                            <input
                                className="input"
                                type="file"
                                accept="application/pdf"
                                onChange={(e) => setPdf(e.target.files?.[0] ?? null)}
                            />
                            <div className="small">{pdf ? `Seçildi: ${pdf.name}` : ""}</div>
                        </div>

                        <div className="uploadBox">
                            <span className="label">Görsel ekle</span>
                            <input
                                className="input"
                                type="file"
                                accept="image/*"
                                multiple
                                onChange={(e) => setImages(Array.from(e.target.files ?? []))}
                            />
                            <div className="small">
                                {images.length ? `${images.length} görsel seçildi` : ""}
                            </div>
                        </div>
                    </div>

                    <div className="actions">
                        <button
                            className="btn btnPrimary"
                            type="button"
                            onClick={handleSummarize}
                            disabled={loading}
                        >
                            {loading ? "Özetleniyor..." : "Özetle"}
                        </button>

                        <button className="btn" type="button" onClick={clearAll}>
                            Temizle
                        </button>
                    </div>

                    <div className="status">{status}</div>
                </section>

                {/* OUTPUT */}
                <section className="card">
                    <div className="label">Özet</div>

                    {!summary ? (
                        <div className="small">
                            Henüz özet yok. Metin yaz veya PDF/Görsel yükle → <b>Özetle</b>.
                        </div>
                    ) : (
                        <div style={{ display: "grid", gap: 10 }}>
                            <div style={{ fontWeight: 900, fontSize: 16 }}>
                                {summary.title}
                            </div>

                            <div className="summaryBox">{summary.summary}</div>

                            <div className="small">
                                <b>Anahtar Kelimeler:</b> {summary.keywords.join(", ")}
                            </div>
                        </div>
                    )}
                </section>
            </main>

            <HistoryPanel title="Geçmiş (Sağ)" />
        </div>
    );
}
